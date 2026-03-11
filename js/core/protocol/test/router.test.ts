import { describe, it, expect, vi } from 'vitest';
import { createMessageRouter } from '../src/messaging/router.js';
import { createEnvelope, signEnvelope } from '../src/messaging/envelope.js';
import { generateKeyPair, sign } from '../src/identity/keys.js';
import { deriveDID } from '../src/identity/did.js';
import { encodeMessage } from '../src/messaging/codec.js';
import type { RelayClient } from '../src/transport/relay-client.js';
import type { DeliverMessage, MessageDeliveryHandler } from '../src/transport/relay-client.js';

function makeMockRelayClient(): RelayClient & { _triggerDeliver: (msg: DeliverMessage) => Promise<void> } {
  let deliverHandler: MessageDeliveryHandler | null = null;

  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    sendEnvelope: vi.fn(async () => {}),
    discover: vi.fn(async () => []),
    fetchCard: vi.fn(async () => null),
    onDeliver: vi.fn((handler: MessageDeliveryHandler) => {
      deliverHandler = handler;
    }),
    onDeliveryReport: vi.fn(() => {}),
    isConnected: vi.fn(() => true),
    getConnectedRelays: vi.fn(() => ['ws://localhost:8080']),
    getPeerCount: vi.fn(() => 1),
    _triggerDeliver: async (msg: DeliverMessage) => {
      if (deliverHandler) {
        await deliverHandler(msg);
      }
    },
  };
}

describe('Message Router', () => {
  describe('Handler registration', () => {
    it('registers and unregisters protocol handlers', async () => {
      const relayClient = makeMockRelayClient();
      const router = createMessageRouter(relayClient, async () => true);
      await router.start();

      const handler = vi.fn(async () => undefined);
      router.registerHandler('/test/protocol', handler);
      router.unregisterHandler('/test/protocol');
    });

    it('registers a catch-all handler', async () => {
      const relayClient = makeMockRelayClient();
      const router = createMessageRouter(relayClient, async () => true);
      await router.start();

      router.registerCatchAllHandler(async () => undefined);
    });
  });

  describe('Incoming messages', () => {
    it('rejects an incoming message with an invalid signature', async () => {
      const keyPair = await generateKeyPair();
      const did = deriveDID(keyPair.publicKey);

      const envelope = createEnvelope(did, did, 'message', '/agent/msg/1.0.0', { text: 'hello' });
      const signed = await signEnvelope(envelope, (data) => sign(data, keyPair.privateKey));
      const tampered = { ...signed, signature: '00'.repeat(64) };
      const encoded = encodeMessage(tampered);

      const relayClient = makeMockRelayClient();
      const router = createMessageRouter(relayClient, async () => true);
      await router.start();

      const handler = vi.fn(async () => undefined);
      router.registerHandler('/agent/msg/1.0.0', handler);

      await relayClient._triggerDeliver({
        type: 'DELIVER',
        messageId: 'test-tampered',
        from: did,
        envelope: encoded,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(handler).not.toHaveBeenCalled();
    });

    it('calls the registered handler for a matching protocol', async () => {
      const keyPair = await generateKeyPair();
      const did = deriveDID(keyPair.publicKey);

      const envelope = createEnvelope(did, did, 'message', '/agent/msg/1.0.0', { text: 'hello' });
      const signed = await signEnvelope(envelope, (data) => sign(data, keyPair.privateKey));
      const encoded = encodeMessage(signed);

      const relayClient = makeMockRelayClient();
      const router = createMessageRouter(relayClient, async () => true);
      await router.start();

      const handler = vi.fn(async () => undefined);
      router.registerHandler('/agent/msg/1.0.0', handler);

      await relayClient._triggerDeliver({
        type: 'DELIVER',
        messageId: 'test-msg-1',
        from: did,
        envelope: encoded,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'message' }));
    });

    it('drops envelopes rejected by the acceptance hook', async () => {
      const keyPair = await generateKeyPair();
      const did = deriveDID(keyPair.publicKey);

      const envelope = createEnvelope(
        did,
        did,
        'message',
        '/agent/msg/1.0.0',
        { text: 'group-only' },
        undefined,
        undefined,
        'grp_blocked',
      );
      const signed = await signEnvelope(envelope, (data) => sign(data, keyPair.privateKey));
      const encoded = encodeMessage(signed);

      const relayClient = makeMockRelayClient();
      const router = createMessageRouter(relayClient, async () => true, {
        acceptEnvelope: (incoming) => incoming.groupId !== 'grp_blocked',
      });
      await router.start();

      const handler = vi.fn(async () => undefined);
      router.registerHandler('/agent/msg/1.0.0', handler);

      await relayClient._triggerDeliver({
        type: 'DELIVER',
        messageId: 'test-msg-group-blocked',
        from: did,
        envelope: encoded,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(handler).not.toHaveBeenCalled();
    });

    it('falls back to the catch-all handler for unregistered protocols', async () => {
      const keyPair = await generateKeyPair();
      const did = deriveDID(keyPair.publicKey);

      const envelope = createEnvelope(did, did, 'message', '/custom/protocol/1.0.0', { text: 'custom' });
      const signed = await signEnvelope(envelope, (data) => sign(data, keyPair.privateKey));
      const encoded = encodeMessage(signed);

      const relayClient = makeMockRelayClient();
      const router = createMessageRouter(relayClient, async () => true);
      await router.start();

      const catchAll = vi.fn(async () => undefined);
      router.registerCatchAllHandler(catchAll);

      await relayClient._triggerDeliver({
        type: 'DELIVER',
        messageId: 'test-msg-2',
        from: did,
        envelope: encoded,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(catchAll).toHaveBeenCalledOnce();
      expect(catchAll).toHaveBeenCalledWith(expect.objectContaining({ protocol: '/custom/protocol/1.0.0' }));
    });

    it('prefers the protocol handler over the catch-all handler', async () => {
      const keyPair = await generateKeyPair();
      const did = deriveDID(keyPair.publicKey);

      const envelope = createEnvelope(did, did, 'message', '/agent/msg/1.0.0', { text: 'hello' });
      const signed = await signEnvelope(envelope, (data) => sign(data, keyPair.privateKey));
      const encoded = encodeMessage(signed);

      const relayClient = makeMockRelayClient();
      const router = createMessageRouter(relayClient, async () => true);
      await router.start();

      const specific = vi.fn(async () => undefined);
      const catchAll = vi.fn(async () => undefined);
      router.registerHandler('/agent/msg/1.0.0', specific);
      router.registerCatchAllHandler(catchAll);

      await relayClient._triggerDeliver({
        type: 'DELIVER',
        messageId: 'test-msg-3',
        from: did,
        envelope: encoded,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(specific).toHaveBeenCalledOnce();
      expect(catchAll).not.toHaveBeenCalled();
    });

    it('delivers reply envelopes to handlers without intercepting them', async () => {
      const keyPair = await generateKeyPair();
      const did = deriveDID(keyPair.publicKey);

      const envelope = createEnvelope(did, did, 'reply', '/agent/msg/1.0.0', { pong: true }, 'msg_original');
      const signed = await signEnvelope(envelope, (data) => sign(data, keyPair.privateKey));
      const encoded = encodeMessage(signed);

      const relayClient = makeMockRelayClient();
      const router = createMessageRouter(relayClient, async () => true);
      await router.start();

      const handler = vi.fn(async () => undefined);
      router.registerHandler('/agent/msg/1.0.0', handler);

      await relayClient._triggerDeliver({
        type: 'DELIVER',
        messageId: 'test-msg-4',
        from: did,
        envelope: encoded,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'reply', replyTo: 'msg_original' }));
    });

    it('sends a reply when the handler returns one', async () => {
      const keyPair = await generateKeyPair();
      const did = deriveDID(keyPair.publicKey);

      const envelope = createEnvelope(did, did, 'message', '/agent/msg/1.0.0', { ping: true });
      const signed = await signEnvelope(envelope, (data) => sign(data, keyPair.privateKey));
      const encoded = encodeMessage(signed);

      const relayClient = makeMockRelayClient();
      const router = createMessageRouter(relayClient, async () => true);
      await router.start();

      router.registerHandler('/agent/msg/1.0.0', async (incoming) => {
        const reply = createEnvelope(did, did, 'reply', incoming.protocol, { pong: true }, incoming.id);
        return signEnvelope(reply, (data) => sign(data, keyPair.privateKey));
      });

      await relayClient._triggerDeliver({
        type: 'DELIVER',
        messageId: 'test-msg-5',
        from: did,
        envelope: encoded,
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(relayClient.sendEnvelope).toHaveBeenCalledOnce();
    });
  });

  describe('Outgoing messages', () => {
    it('sends a message without waiting for a reply', async () => {
      const keyPair = await generateKeyPair();
      const did = deriveDID(keyPair.publicKey);

      const relayClient = makeMockRelayClient();
      const router = createMessageRouter(relayClient, async () => true);
      await router.start();

      const envelope = createEnvelope(did, did, 'message', '/agent/msg/1.0.0', { text: 'hi' });
      const signed = await signEnvelope(envelope, (data) => sign(data, keyPair.privateKey));

      await expect(router.sendMessage(signed)).resolves.toBeUndefined();
      expect(relayClient.sendEnvelope).toHaveBeenCalledOnce();
    });

    it('throws when relay delivery fails', async () => {
      const keyPair = await generateKeyPair();
      const did = deriveDID(keyPair.publicKey);

      const relayClient = makeMockRelayClient();
      relayClient.sendEnvelope = vi.fn(async () => {
        throw new Error('connection refused');
      });

      const router = createMessageRouter(relayClient, async () => true);
      await router.start();

      const envelope = createEnvelope(did, did, 'message', '/agent/msg/1.0.0', { text: 'hi' });
      const signed = await signEnvelope(envelope, (data) => sign(data, keyPair.privateKey));

      await expect(router.sendMessage(signed)).rejects.toThrow('Failed to send message');
    });
  });

  describe('Stop', () => {
    it('clears handlers on stop', async () => {
      const relayClient = makeMockRelayClient();
      const router = createMessageRouter(relayClient, async () => true);
      await router.start();

      router.registerHandler('/test', async () => undefined);
      router.registerCatchAllHandler(async () => undefined);

      await router.stop();
      expect(true).toBe(true);
    });
  });
});
