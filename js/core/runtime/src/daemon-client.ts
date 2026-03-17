import { connect, type Socket } from 'node:net';
import {
  DAEMON_REQUEST_TIMEOUT_MS,
  DAEMON_SOCKET_PATH,
  getDaemonSocketClientCandidates,
} from './constants.js';
import type {
  DaemonCommand,
  DaemonRequest,
  DaemonResponse,
  DaemonSubscriptionEvent,
  SubscribeInboxParams,
  UnsubscribeParams,
} from './daemon-types.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

interface SocketAttemptError {
  socketPath: string;
  error: Error;
}

const MAX_DAEMON_CONNECT_ATTEMPTS = 4;
const DAEMON_CONNECT_RETRY_BASE_MS = 40;

function createRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableSocketError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT'
    || code === 'ECONNREFUSED'
    || code === 'ECONNRESET'
    || code === 'EPIPE'
    || code === 'ETIMEDOUT';
}

function summarizeSocketAttemptErrors(errors: SocketAttemptError[]): string {
  return errors
    .map(({ socketPath, error }) => {
      const code = (error as NodeJS.ErrnoException).code;
      return `${socketPath}${code ? ` (${code})` : ''}: ${error.message}`;
    })
    .join('; ');
}

function buildDaemonConnectionError(errors: SocketAttemptError[]): Error {
  if (errors.length === 0) {
    return new Error('Failed to connect to daemon');
  }

  return new Error(`Failed to connect to daemon. Tried: ${summarizeSocketAttemptErrors(errors)}`);
}

export class DaemonClient {
  private socketPaths: string[];

  constructor(socketPath: string = DAEMON_SOCKET_PATH) {
    this.socketPaths = socketPath === DAEMON_SOCKET_PATH
      ? getDaemonSocketClientCandidates('js')
      : [socketPath];
  }

  async send<TData = unknown, TParams = Record<string, unknown>>(
    command: DaemonCommand,
    params: TParams,
  ): Promise<TData> {
    const errors: SocketAttemptError[] = [];

    for (let attempt = 0; attempt < MAX_DAEMON_CONNECT_ATTEMPTS; attempt += 1) {
      errors.length = 0;

      for (const socketPath of this.socketPaths) {
        try {
          return await this.sendViaSocketPath<TData, TParams>(socketPath, command, params);
        } catch (error) {
          errors.push({ socketPath, error: error as Error });
        }
      }

      const shouldRetry = attempt < MAX_DAEMON_CONNECT_ATTEMPTS - 1
        && errors.length > 0
        && errors.every(({ error }) => isRetriableSocketError(error));
      if (!shouldRetry) {
        break;
      }

      await sleep(DAEMON_CONNECT_RETRY_BASE_MS * (attempt + 1));
    }

    throw buildDaemonConnectionError(errors);
  }

  async isDaemonRunning(): Promise<boolean> {
    try {
      await this.send('status', {});
      return true;
    } catch {
      return false;
    }
  }

  private async sendViaSocketPath<TData = unknown, TParams = Record<string, unknown>>(
    socketPath: string,
    command: DaemonCommand,
    params: TParams,
  ): Promise<TData> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath);
      const requestId = createRequestId();

      let responseReceived = false;
      let buffer = '';

      socket.on('connect', () => {
        const request: DaemonRequest<TParams> = { id: requestId, command, params };
        socket.write(JSON.stringify(request) + '\n');
      });

      socket.on('data', (data) => {
        try {
          buffer += data.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) {
              continue;
            }

            const response = JSON.parse(line) as DaemonResponse<TData> | DaemonSubscriptionEvent<TData>;
            if (!('id' in response) || response.id !== requestId) {
              continue;
            }

            responseReceived = true;
            socket.end();

            if (response.success) {
              resolve(response.data as TData);
            } else {
              reject(new Error(response.error));
            }
            return;
          }
        } catch (error) {
          reject(new Error(`Failed to parse response: ${(error as Error).message}`));
        }
      });

      socket.on('error', (error) => {
        if (!responseReceived) {
          reject(error);
        }
      });

      socket.setTimeout(DAEMON_REQUEST_TIMEOUT_MS, () => {
        if (!responseReceived) {
          socket.destroy();
          reject(new Error('Request timeout'));
        }
      });
    });
  }
}

export class DaemonSubscriptionClient<TData = unknown> {
  private socketPaths: string[];
  private socket: Socket | null = null;
  private buffer = '';
  private pendingRequests = new Map<string, PendingRequest>();
  private subscriptionId: string | null = null;

  constructor(socketPath: string = DAEMON_SOCKET_PATH) {
    this.socketPaths = socketPath === DAEMON_SOCKET_PATH
      ? getDaemonSocketClientCandidates('js')
      : [socketPath];
  }

  async subscribeInbox(
    params: SubscribeInboxParams,
    onEvent: (event: DaemonSubscriptionEvent<TData>) => void,
  ): Promise<string> {
    if (this.socket) {
      throw new Error('Subscription client already connected');
    }

    const socket = await this.connectToFirstAvailableSocket();
    this.socket = socket;

    socket.on('data', (data) => {
      this.buffer += data.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }

        const parsed = JSON.parse(line) as DaemonResponse<{ subscriptionId: string }> | DaemonSubscriptionEvent<TData>;

        if ('type' in parsed && parsed.type === 'event') {
          onEvent(parsed);
          continue;
        }

        if (!('id' in parsed)) {
          continue;
        }

        const pending = this.pendingRequests.get(parsed.id);
        if (!pending) {
          continue;
        }

        this.pendingRequests.delete(parsed.id);
        if (parsed.success) {
          pending.resolve('data' in parsed ? parsed.data : undefined);
        } else {
          pending.reject(new Error(parsed.error));
        }
      }
    });

    socket.on('close', () => {
      this.socket = null;
      this.subscriptionId = null;
      for (const pending of this.pendingRequests.values()) {
        pending.reject(new Error('Subscription socket closed'));
      }
      this.pendingRequests.clear();
    });

    const response = await this.sendStreamingRequest<{ subscriptionId: string }, SubscribeInboxParams>(
      'subscribe_inbox',
      params,
    );
    this.subscriptionId = response.subscriptionId;
    return response.subscriptionId;
  }

  async close(): Promise<void> {
    if (!this.socket) {
      return;
    }

    const currentSocket = this.socket;

    if (this.subscriptionId) {
      try {
        const params: UnsubscribeParams = { subscriptionId: this.subscriptionId };
        await this.sendStreamingRequest('unsubscribe', params);
      } catch {
        // Ignore unsubscribe errors during cleanup
      }
    }

    currentSocket.end();
    this.socket = null;
    this.subscriptionId = null;
  }

  private async sendStreamingRequest<TData = unknown, TParams = Record<string, unknown>>(
    command: DaemonCommand,
    params: TParams,
  ): Promise<TData> {
    if (!this.socket) {
      throw new Error('Subscription socket not connected');
    }

    const requestId = createRequestId();
    const request: DaemonRequest<TParams> = { id: requestId, command, params };

    const responsePromise = new Promise<TData>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve: (value) => resolve(value as TData),
        reject,
      });
    });

    this.socket.write(JSON.stringify(request) + '\n');
    return responsePromise;
  }

  private async connectToFirstAvailableSocket(): Promise<Socket> {
    const errors: SocketAttemptError[] = [];

    for (let attempt = 0; attempt < MAX_DAEMON_CONNECT_ATTEMPTS; attempt += 1) {
      errors.length = 0;

      for (const socketPath of this.socketPaths) {
        try {
          return await new Promise<Socket>((resolve, reject) => {
            const socket = connect(socketPath);
            socket.once('connect', () => resolve(socket));
            socket.once('error', (error) => {
              socket.destroy();
              reject(error);
            });
          });
        } catch (error) {
          errors.push({ socketPath, error: error as Error });
        }
      }

      const shouldRetry = attempt < MAX_DAEMON_CONNECT_ATTEMPTS - 1
        && errors.length > 0
        && errors.every(({ error }) => isRetriableSocketError(error));
      if (!shouldRetry) {
        break;
      }

      await sleep(DAEMON_CONNECT_RETRY_BASE_MS * (attempt + 1));
    }

    throw buildDaemonConnectionError(errors);
  }
}
