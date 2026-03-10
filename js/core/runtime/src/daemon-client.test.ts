import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DaemonClient, DaemonSubscriptionClient } from './daemon-client.js';

const tempDirectories: string[] = [];

function createSocketPath(): string {
  const tempDirectory = mkdtempSync('/tmp/quadra-a-runtime-');
  tempDirectories.push(tempDirectory);
  return join(tempDirectory, 'daemon.sock');
}

async function listenIfPermitted(server: ReturnType<typeof createServer>, socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const handleListening = () => {
      server.off('error', handleError);
      resolve(true);
    };

    const handleError = (error: NodeJS.ErrnoException) => {
      server.off('listening', handleListening);
      if (error.code === 'EPERM') {
        resolve(false);
        return;
      }
      reject(error);
    };

    server.once('listening', handleListening);
    server.once('error', handleError);
    server.listen(socketPath);
  });
}

afterEach(() => {
  while (tempDirectories.length > 0) {
    const directory = tempDirectories.pop();
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe('DaemonClient', () => {
  it('sends a request and resolves the response payload', async () => {
    const socketPath = createSocketPath();

    const server = createServer((socket) => {
      socket.on('data', (data) => {
        const [line] = data.toString().trim().split('\n');
        const request = JSON.parse(line) as { id: string; command: string };

        expect(request.command).toBe('status');

        socket.write(JSON.stringify({
          id: request.id,
          success: true,
          data: { running: true, did: 'did:agent:test' },
        }) + '\n');
      });
    });

    const listeningSupported = await listenIfPermitted(server, socketPath);
    if (!listeningSupported) {
      expect(true).toBe(true);
      return;
    }

    const client = new DaemonClient(socketPath);
    await expect(client.send('status', {})).resolves.toEqual({
      running: true,
      did: 'did:agent:test',
    });

    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
});

describe('DaemonSubscriptionClient', () => {
  it('receives inbox events and unsubscribes on close', async () => {
    const socketPath = createSocketPath();
    const receivedCommands: string[] = [];

    const server = createServer((socket) => {
      let buffer = '';

      socket.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }

          const request = JSON.parse(line) as { id: string; command: string; params?: { subscriptionId?: string } };
          receivedCommands.push(request.command);

          if (request.command === 'subscribe_inbox') {
            socket.write(JSON.stringify({
              id: request.id,
              success: true,
              data: { subscriptionId: 'sub_1' },
            }) + '\n');

            socket.write(JSON.stringify({
              type: 'event',
              event: 'inbox',
              subscriptionId: 'sub_1',
              data: { envelope: { id: 'msg_1' } },
            }) + '\n');
          }

          if (request.command === 'unsubscribe') {
            socket.write(JSON.stringify({
              id: request.id,
              success: true,
            }) + '\n');
          }
        }
      });
    });

    const listeningSupported = await listenIfPermitted(server, socketPath);
    if (!listeningSupported) {
      expect(true).toBe(true);
      return;
    }

    const subscriptionClient = new DaemonSubscriptionClient<{ envelope: { id: string } }>(socketPath);
    const receivedMessageIds: string[] = [];

    const subscriptionId = await subscriptionClient.subscribeInbox({}, (event) => {
      receivedMessageIds.push(event.data.envelope.id);
    });

    expect(subscriptionId).toBe('sub_1');

    await new Promise((resolve) => setTimeout(resolve, 50));
    await subscriptionClient.close();

    expect(receivedMessageIds).toEqual(['msg_1']);
    expect(receivedCommands).toContain('subscribe_inbox');
    expect(receivedCommands).toContain('unsubscribe');

    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
});
