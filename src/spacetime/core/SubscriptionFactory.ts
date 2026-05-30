import type { DbConnection, ErrorContext, SubscriptionEventContext } from '../generated';
import type { ConnectionManager } from './ConnectionManager';
import type { Logger } from '../types';

export interface SubscriptionHandle {
  unsubscribe(): void;
}

export interface TableLike<TRow> {
  iter(): Iterable<TRow>;
  onInsert(handler: (ctx: unknown, row: TRow) => void): void;
  onDelete(handler: (ctx: unknown, row: TRow) => void): void;
  onUpdate(handler: (ctx: unknown, oldRow: TRow, newRow: TRow) => void): void;
  removeOnInsert(handler: (ctx: unknown, row: TRow) => void): void;
  removeOnDelete(handler: (ctx: unknown, row: TRow) => void): void;
  removeOnUpdate(handler: (ctx: unknown, oldRow: TRow, newRow: TRow) => void): void;
}

export interface SubscriptionConfig<TRow, TResult> {
  readonly sql: string;
  readonly getTable: (db: DbConnection['db']) => TableLike<TRow>;
  readonly mapRow: (row: TRow) => TResult;
  readonly sortFn?: (a: TResult, b: TResult) => number;
}

export interface SingleRowSubscriptionConfig<TRow, TResult> {
  readonly sql: string;
  readonly getTable: (db: DbConnection['db']) => TableLike<TRow>;
  readonly mapRow: (row: TRow) => TResult;
}

export class SubscriptionFactory {
  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly logger: Logger = () => undefined
  ) {}

  /**
   * Create a subscription that emits an array of results whenever the underlying data changes.
   */
  public async createArraySubscription<TRow, TResult>(
    config: SubscriptionConfig<TRow, TResult>,
    onUpdate: (results: TResult[]) => void
  ): Promise<SubscriptionHandle> {
    const connection = await this.connectionManager.ensureConnection();
    const table = config.getTable(connection.db);

    const emitRows = (): void => {
      let results = Array.from(table.iter()).map(config.mapRow);
      if (config.sortFn) {
        results = results.sort(config.sortFn);
      }
      onUpdate(results);
    };

    const handleChange = (): void => {
      emitRows();
    };

    table.onInsert(handleChange);
    table.onDelete(handleChange);
    table.onUpdate(handleChange);

    // Initial emit
    emitRows();

    const builder = connection.subscriptionBuilder();

    return new Promise((resolve, reject) => {
      let handle: ReturnType<typeof builder.subscribe> | null = null;
      let listenersRemoved = false;

      const cleanup = (): void => {
        if (listenersRemoved) return;
        listenersRemoved = true;
        table.removeOnInsert(handleChange);
        table.removeOnDelete(handleChange);
        table.removeOnUpdate(handleChange);
      };

      builder
        .onApplied(() => {
          try {
            emitRows();
            resolve({
              unsubscribe: () => {
                cleanup();
                handle?.unsubscribe();
              }
            });
          } catch (error) {
            cleanup();
            handle?.unsubscribe();
            reject(error as Error);
          }
        })
        .onError((ctx: ErrorContext) => {
          const error = ctx.event ?? new Error('Subscription failed');
          cleanup();
          handle?.unsubscribe();
          reject(error);
        });

      handle = builder.subscribe(config.sql);
    });
  }

  /**
   * Create a subscription that emits a single result (or null) whenever the underlying data changes.
   */
  public async createSingleRowSubscription<TRow, TResult>(
    config: SingleRowSubscriptionConfig<TRow, TResult>,
    onUpdate: (result: TResult | null) => void
  ): Promise<SubscriptionHandle> {
    const connection = await this.connectionManager.ensureConnection();
    const table = config.getTable(connection.db);

    const emitRow = (): void => {
      const rows = Array.from(table.iter());
      const row = rows[0];
      const result = row ? config.mapRow(row) : null;
      onUpdate(result);
    };

    const handleChange = (): void => {
      emitRow();
    };

    table.onInsert(handleChange);
    table.onDelete(handleChange);
    table.onUpdate(handleChange);

    // Initial emit
    emitRow();

    const builder = connection.subscriptionBuilder();

    return new Promise((resolve, reject) => {
      let handle: ReturnType<typeof builder.subscribe> | null = null;
      let listenersRemoved = false;

      const cleanup = (): void => {
        if (listenersRemoved) return;
        listenersRemoved = true;
        table.removeOnInsert(handleChange);
        table.removeOnDelete(handleChange);
        table.removeOnUpdate(handleChange);
      };

      builder
        .onApplied(() => {
          try {
            emitRow();
            resolve({
              unsubscribe: () => {
                cleanup();
                handle?.unsubscribe();
              }
            });
          } catch (error) {
            cleanup();
            handle?.unsubscribe();
            reject(error as Error);
          }
        })
        .onError((ctx: ErrorContext) => {
          const error = ctx.event ?? new Error('Subscription failed');
          cleanup();
          handle?.unsubscribe();
          reject(error);
        });

      handle = builder.subscribe(config.sql);
    });
  }

  /**
   * Run a one-time query and return the results (unsubscribes immediately after).
   */
  public async runOneTimeQuery<TRow, TResult>(
    config: SubscriptionConfig<TRow, TResult>
  ): Promise<TResult[]> {
    const connection = await this.connectionManager.ensureConnection();

    return new Promise<TResult[]>((resolve, reject) => {
      const builder = connection.subscriptionBuilder();
      type Handle = ReturnType<typeof builder.subscribe>;
      let handle: Handle | null = null;
      let settled = false;

      builder
        .onApplied((ctx: SubscriptionEventContext) => {
          try {
            const table = config.getTable(ctx.db);
            let results = Array.from(table.iter()).map(config.mapRow);
            if (config.sortFn) {
              results = results.sort(config.sortFn);
            }
            settled = true;
            if (handle?.unsubscribeThen) {
              handle.unsubscribeThen(() => resolve(results));
            } else {
              handle?.unsubscribe();
              resolve(results);
            }
          } catch (error) {
            settled = true;
            handle?.unsubscribe();
            reject(error as Error);
          }
        })
        .onError((ctx: ErrorContext) => {
          const error = ctx.event ?? new Error('Subscription query failed');
          if (!settled) {
            settled = true;
            handle?.unsubscribe();
            reject(error);
          }
        });

      handle = builder.subscribe(config.sql);
    });
  }
}
