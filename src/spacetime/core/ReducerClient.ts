import type { ProductType } from 'spacetimedb';
import { logReducerCall } from '../reducerLogger';
import type { ConnectionManager } from './ConnectionManager';
import type { Logger } from '../types';

/**
 * Options accepted by {@link ReducerClient.callAndConfirm}. The promise
 * returned by `callReducerWithParams` already resolves when the server
 * commits the reducer (and rejects with a `SenderError` carrying the
 * server-side `Err(String)` message), so all we need is the reducer name,
 * its param schema, and the args. `failureMessage` is used only as a
 * fallback when the SDK rejects without a message of its own.
 */
export interface ReducerConfirmationOptions<TArgs extends Record<string, unknown>> {
  readonly reducerName: string;
  readonly paramsType: ProductType;
  readonly args: TArgs;
  readonly failureMessage: string;
}

export class ReducerClient {
  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly logger: Logger = () => undefined
  ) {}

  /**
   * Call a reducer and resolve once the server has committed it. If the
   * reducer returns `Err(String)` the resulting promise rejects with an
   * Error whose message is the server's error string verbatim — callers
   * can surface that directly to the user.
   */
  public async callAndConfirm<TArgs extends Record<string, unknown>>(
    options: ReducerConfirmationOptions<TArgs>
  ): Promise<void> {
    try {
      await this.callFireAndForget(options.reducerName, options.paramsType, options.args);
      logReducerCall(options.reducerName, 'success');
    } catch (error) {
      const message = error instanceof Error && error.message.length > 0
        ? error.message
        : options.failureMessage;
      logReducerCall(options.reducerName, 'error', message);
      throw new Error(message);
    }
  }

  public async callFireAndForget(
    reducerName: string,
    paramsType: ProductType,
    args: Record<string, unknown>
  ): Promise<void> {
    const connection = await this.connectionManager.ensureConnection();
    const serializedArgs = this.formatReducerArgs(paramsType, args);
    await connection.callReducerWithParams(reducerName, paramsType, serializedArgs);
  }

  private formatReducerArgs(paramsType: ProductType, args: Record<string, unknown>): Record<string, unknown> {
    const elements = paramsType.elements ?? [];
    if (elements.length === 1 && elements[0]?.name === 'args') {
      return { args };
    }
    return args;
  }
}
