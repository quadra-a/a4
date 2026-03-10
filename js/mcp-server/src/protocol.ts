/**
 * JSON-RPC request identifier accepted by the stdio transport.
 */
export type JsonRpcId = string | number | null;

/**
 * One inbound JSON-RPC request frame.
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

type JsonRpcEnvelope = JsonRpcSuccess | JsonRpcError | JsonRpcRequest;

/**
 * Minimal JSON-RPC 2.0 server over stdio for MCP-compatible clients.
 */
export class StdioJsonRpcServer {
  private buffer = Buffer.alloc(0);
  private readonly requestHandler: (message: JsonRpcRequest) => Promise<void>;

  constructor(requestHandler: (message: JsonRpcRequest) => Promise<void>) {
    this.requestHandler = requestHandler;
  }

  start(): void {
    process.stdin.on('data', (chunk: Buffer) => {
      void this.handleChunk(chunk);
    });
    process.stdin.resume();
  }

  sendResponse(id: JsonRpcId, result: unknown): void {
    this.writeMessage({ jsonrpc: '2.0', id, result });
  }

  sendError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
    this.writeMessage({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        data,
      },
    });
  }

  sendNotification(method: string, params?: unknown): void {
    this.writeMessage({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  private writeMessage(message: JsonRpcEnvelope): void {
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`;
    process.stdout.write(header + body);
  }

  private async handleChunk(chunk: Buffer): Promise<void> {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return;
      }

      const headerText = this.buffer.slice(0, headerEnd).toString('utf8');
      const contentLengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        this.sendError(null, -32600, 'Missing Content-Length header');
        this.buffer = Buffer.alloc(0);
        return;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const frameLength = headerEnd + 4 + contentLength;
      if (this.buffer.length < frameLength) {
        return;
      }

      const body = this.buffer.slice(headerEnd + 4, frameLength).toString('utf8');
      this.buffer = this.buffer.slice(frameLength);

      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(body) as JsonRpcRequest;
      } catch (error) {
        this.sendError(null, -32700, 'Invalid JSON', (error as Error).message);
        continue;
      }

      if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
        this.sendError(parsed.id ?? null, -32600, 'Invalid request');
        continue;
      }

      try {
        await this.requestHandler(parsed);
      } catch (error) {
        this.sendError(parsed.id ?? null, -32603, (error as Error).message);
      }
    }
  }
}
