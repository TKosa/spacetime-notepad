import {
  DbConnection,
  DbConnectionBuilder,
  reducers,
  type ReducerEventContext
} from '../generated';
import type { SpaceTimeConfig } from '../config';
import type { Logger } from '../types';
import type { ProductType } from 'spacetimedb';

type BuilderFactory = () => DbConnectionBuilder;

export interface ConnectionManagerOptions {
  readonly config: SpaceTimeConfig;
  readonly moduleName?: string;
  readonly builderFactory?: BuilderFactory;
  readonly logger?: Logger;
  readonly authTokenStorage?: 'local' | 'session';
}

export class ConnectionManager {
  private static readonly SESSION_HEARTBEAT_INTERVAL_MS = 15_000;
  private static readonly AUTH_TOKEN_STORAGE_PREFIX = 'mmo.spacetime.auth_token';

  private readonly config: SpaceTimeConfig;
  private readonly defaultModuleName: string;
  private readonly builderFactory: BuilderFactory;
  private readonly logger: Logger;
  private readonly authTokenStorage: 'local' | 'session';

  private connection: DbConnection | null = null;
  private connectPromise: Promise<DbConnection> | null = null;
  private disconnectExpected = false;
  private disconnectCleanupInFlight = false;
  private sessionHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private connectedIdentity: string | null = null;

  constructor(options: ConnectionManagerOptions) {
    this.config = options.config;
    this.defaultModuleName = options.moduleName ?? options.config.schema;
    this.logger = options.logger ?? (() => undefined);
    this.builderFactory = options.builderFactory ?? (() => DbConnection.builder());
    this.authTokenStorage = options.authTokenStorage ?? 'local';
  }

  public static clearStoredAuthTokens(): void {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key?.startsWith(ConnectionManager.AUTH_TOKEN_STORAGE_PREFIX)) {
          keysToRemove.push(key);
        }
      }
      for (const key of keysToRemove) {
        localStorage.removeItem(key);
      }
    } catch {
      // Ignore storage failures.
    }
  }

  public getConfig(): SpaceTimeConfig {
    return this.config;
  }

  public getPlayerId(): string | null {
    return this.config.playerId ?? null;
  }

  private resolveModuleName(): string {
    return this.config.schema || this.defaultModuleName;
  }

  private authTokenStorageKey(): string {
    return `${ConnectionManager.AUTH_TOKEN_STORAGE_PREFIX}.${this.config.endpoint}.${this.resolveModuleName()}`;
  }

  private loadStoredAuthToken(): string | null {
    try {
      const storage = this.authTokenStorage === 'session' ? sessionStorage : localStorage;
      return storage.getItem(this.authTokenStorageKey());
    } catch {
      return null;
    }
  }

  private persistAuthToken(token: string | undefined): void {
    if (!token) {
      return;
    }

    try {
      const storage = this.authTokenStorage === 'session' ? sessionStorage : localStorage;
      storage.setItem(this.authTokenStorageKey(), token);
    } catch {
      // Ignore storage failures and continue with the current in-memory identity.
    }
  }

  private clearStoredAuthToken(): void {
    try {
      const storage = this.authTokenStorage === 'session' ? sessionStorage : localStorage;
      storage.removeItem(this.authTokenStorageKey());
    } catch {
      // Ignore storage failures.
    }
  }

  public async connect(): Promise<void> {
    await this.ensureConnection();
  }

  public async disconnect(options?: { skipLogout?: boolean }): Promise<void> {
    this.connectPromise = null;
    this.stopSessionHeartbeat();

    if (!options?.skipLogout) {
      try {
        await this.sendLogoutSignal();
      } catch (error) {
        this.logger('logout_before_disconnect_failed', {
          message: (error as Error).message
        });
      } finally {
        this.clearStoredAuthToken();
      }
    }

    if (this.connection?.isActive) {
      this.disconnectExpected = true;
      try {
        this.connection.disconnect();
      } finally {
        this.connection = null;
        this.disconnectExpected = false;
      }
    } else {
      this.connection = null;
    }
  }

  public isConnected(): boolean {
    return Boolean(this.connection?.isActive);
  }

  public async ensureConnection(): Promise<DbConnection> {
    if (this.connection?.isActive) {
      return this.connection;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<DbConnection>((resolve, reject) => {
      const builder = this.builderFactory();
      let settled = false;

      builder
        .withUri(this.config.endpoint)
        .withDatabaseName(this.resolveModuleName());

      const authToken = this.config.walletPrivateKey ?? this.loadStoredAuthToken() ?? undefined;
      if (authToken) {
        builder.withToken(authToken);
      }

      builder
        .onConnect((connection, identity, token) => {
          this.connectedIdentity = String(identity);
          this.persistAuthToken(token);
          this.installDbAccessorAliases(connection);
          this.subscribeToCoreTables(connection)
            .then(() => {
              settled = true;
              this.connection = connection;
              resolve(connection);
            })
            .catch((error) => {
              if (!settled) {
                settled = true;
                reject(error);
              }
            });
        })
        .onConnectError((_ctx, error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        })
        .onDisconnect((_ctx, error) => {
          this.connection = null;
          this.connectedIdentity = null;
          if (error) {
            this.logger('spacetime_disconnect', { message: error.message });
          }
          void this.handleUnexpectedDisconnect();
        });

      try {
        builder.build();
      } catch (error) {
        this.connectPromise = null;
        reject(error as Error);
      }
    })
      .finally(() => {
        this.connectPromise = null;
      });

    return this.connectPromise;
  }

  public async withEphemeralConnection<T>(task: (connection: DbConnection) => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const builder = this.builderFactory();
      let settled = false;

      builder
        .withUri(this.config.endpoint)
        .withDatabaseName(this.resolveModuleName());

      if (this.config.walletPrivateKey) {
        builder.withToken(this.config.walletPrivateKey);
      }

      builder
        .onConnect(async (connection) => {
          try {
            this.installDbAccessorAliases(connection);
            await this.subscribeToCoreTables(connection);
            settled = true;
            const result = await task(connection);
            connection.disconnect();
            resolve(result);
          } catch (error) {
            connection.disconnect();
            reject(error as Error);
          }
        })
        .onConnectError((_ctx, error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });

      try {
        builder.build();
      } catch (error) {
        reject(error as Error);
      }
    });
  }

  public requirePlayerId(): string {
    const playerId = this.config.playerId;
    if (!playerId) {
      throw new Error('Missing playerId in SpaceTime config');
    }
    return playerId;
  }

  public getIdentity(): string | null {
    return this.connectedIdentity;
  }

  public startSessionHeartbeat(): void {
    this.stopSessionHeartbeat();
    this.sessionHeartbeatTimer = setInterval(() => {
      void this.refreshSessionLease();
    }, ConnectionManager.SESSION_HEARTBEAT_INTERVAL_MS);
  }

  public stopSessionHeartbeat(): void {
    if (this.sessionHeartbeatTimer !== null) {
      clearInterval(this.sessionHeartbeatTimer);
      this.sessionHeartbeatTimer = null;
    }
  }

  private async sendLogoutSignal(): Promise<void> {
    const connection = this.connection?.isActive ? this.connection : null;
    if (!connection) return;

    try {
      const payload = this.formatReducerArgs(reducers.logout.paramsType, {});
      await connection.callReducerWithParams('logout', reducers.logout.paramsType, payload);
    } catch (error) {
      throw error as Error;
    }
  }

  private async sendGameplaySessionEndSignal(): Promise<void> {
    const connection = this.connection?.isActive ? this.connection : null;
    if (!connection) return;

    try {
      const payload = this.formatReducerArgs(reducers.endGameplaySession.paramsType, {});
      await connection.callReducerWithParams(
        'end_gameplay_session',
        reducers.endGameplaySession.paramsType,
        payload
      );
    } catch (error) {
      throw error as Error;
    }
  }

  private async refreshSessionLease(): Promise<void> {
    const connection = this.connection?.isActive ? this.connection : null;
    if (!connection) {
      return;
    }

    try {
      const payload = this.formatReducerArgs(reducers.refreshSessionLease.paramsType, {});
      await connection.callReducerWithParams(
        'refresh_session_lease',
        reducers.refreshSessionLease.paramsType,
        payload
      );
    } catch (error) {
      this.logger('session_heartbeat_failed', {
        message: (error as Error).message
      });
    }
  }

  private async subscribeToCoreTables(connection: DbConnection): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const builder = connection.subscriptionBuilder();

      builder
        .onApplied(() => {
          resolve();
        })
        .onError((ctx) => {
          reject(ctx.event ?? new Error('Core subscription failed'));
        });

      builder.subscribe([
        'SELECT * FROM my_player',
        'SELECT * FROM game_state',
        'SELECT * FROM game_tick_config',
        'SELECT * FROM my_chat_feed'
      ]);
    });
  }

  private async handleUnexpectedDisconnect(): Promise<void> {
    if (this.disconnectExpected || this.disconnectCleanupInFlight) {
      this.disconnectExpected = false;
      this.stopSessionHeartbeat();
      return;
    }

    this.disconnectCleanupInFlight = true;
    this.stopSessionHeartbeat();
    try {
      await this.sendGameplaySessionEndSignal();
    } catch (error) {
      this.logger('gameplay_session_end_on_disconnect_failed', {
        message: (error as Error).message
      });
    } finally {
      this.disconnectCleanupInFlight = false;
    }
  }

  private formatReducerArgs(paramsType: ProductType, args: Record<string, unknown>): Record<string, unknown> {
    const elements = paramsType.elements ?? [];
    if (elements.length === 1 && elements[0]?.name === 'args') {
      return { args };
    }
    return args;
  }

  private installDbAccessorAliases(connection: DbConnection): void {
    const dbRecord = connection.db as Record<string, unknown>;
    for (const [key, value] of Object.entries(dbRecord)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      if (!(camelKey in dbRecord)) {
        dbRecord[camelKey] = value;
      }
    }
  }
}
