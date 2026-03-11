import type { MessageEnvelope } from './envelope.js';
import type { RelayClient } from '../transport/relay-client.js';
import { encodeMessage, decodeMessage } from './codec.js';
import { validateEnvelope, verifyEnvelope } from './envelope.js';
import { createLogger } from '../utils/logger.js';
import { MessagingError } from '../utils/errors.js';
import { extractPublicKey } from '../identity/did.js';
import { verify } from '../identity/keys.js';

const logger = createLogger('router');

export type MessageHandler = (
  envelope: MessageEnvelope,
) => Promise<MessageEnvelope | void>;

export interface MessageRouter {
  registerHandler: (protocol: string, handler: MessageHandler) => void;
  unregisterHandler: (protocol: string) => void;
  registerCatchAllHandler: (handler: MessageHandler) => void;
  sendMessage: (envelope: MessageEnvelope) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface MessageRouterOptions {
  acceptEnvelope?: (envelope: MessageEnvelope) => boolean | Promise<boolean>;
}

export function createMessageRouter(
  relayClient: RelayClient,
  verifyFn: (signature: Uint8Array, data: Uint8Array) => Promise<boolean>,
  options: MessageRouterOptions = {},
): MessageRouter {
  const handlers = new Map<string, MessageHandler>();
  let catchAllHandler: MessageHandler | undefined;

  return {
    registerHandler: (protocol: string, handler: MessageHandler) => {
      handlers.set(protocol, handler);
      logger.info('Registered message handler', { protocol });
    },

    unregisterHandler: (protocol: string) => {
      handlers.delete(protocol);
      logger.info('Unregistered message handler', { protocol });
    },

    registerCatchAllHandler: (handler: MessageHandler) => {
      catchAllHandler = handler;
      logger.info('Registered catch-all message handler');
    },

    sendMessage: async (envelope: MessageEnvelope) => {
      try {
        if (!validateEnvelope(envelope)) {
          throw new MessagingError('Invalid message envelope');
        }

        const encoded = encodeMessage(envelope);
        await relayClient.sendEnvelope(envelope.to, encoded);

        logger.info('Message sent via relay', {
          id: envelope.id,
          from: envelope.from,
          to: envelope.to,
          protocol: envelope.protocol,
          type: envelope.type,
        });
      } catch (error) {
        if (error instanceof MessagingError) throw error;
        throw new MessagingError('Failed to send message', error);
      }
    },

    start: async () => {
      relayClient.onDeliver(async (deliverMsg) => {
        try {
          const envelope = decodeMessage(deliverMsg.envelope);

          if (!validateEnvelope(envelope)) {
            logger.warn('Received invalid message envelope');
            return;
          }

          const isValidSignature = await verifyEnvelope(envelope, async (signature, data) => {
            const senderPublicKey = extractPublicKey(envelope.from);
            return verify(signature, data, senderPublicKey);
          });
          if (!isValidSignature) {
            logger.warn('Received message with invalid signature', {
              id: envelope.id,
              from: envelope.from,
            });
            return;
          }

          try {
            const { signature, ...envelopeWithoutSig } = envelope;
            const dataBytes = new TextEncoder().encode(JSON.stringify(envelopeWithoutSig));
            const signatureBytes = Buffer.from(signature, 'hex');
            const hookValid = await verifyFn(signatureBytes, dataBytes);
            if (!hookValid) {
              logger.warn('Message rejected by custom verifier', {
                id: envelope.id,
                from: envelope.from,
              });
              return;
            }
          } catch (error) {
            logger.warn('Custom verification hook failed', {
              id: envelope.id,
              from: envelope.from,
              error: (error as Error).message,
            });
            return;
          }

          try {
            if (options.acceptEnvelope && !(await options.acceptEnvelope(envelope))) {
              logger.info('Envelope rejected by acceptance hook', {
                id: envelope.id,
                from: envelope.from,
                protocol: envelope.protocol,
                groupId: envelope.groupId,
              });
              return;
            }
          } catch (error) {
            logger.warn('Envelope acceptance hook failed', {
              id: envelope.id,
              from: envelope.from,
              error: (error as Error).message,
            });
            return;
          }

          logger.info('Received message', {
            id: envelope.id,
            from: envelope.from,
            to: envelope.to,
            protocol: envelope.protocol,
            type: envelope.type,
          });

          const handler = handlers.get(envelope.protocol);
          let response: MessageEnvelope | void = undefined;

          if (handler) {
            response = await handler(envelope);
          } else if (catchAllHandler) {
            logger.debug('Using catch-all handler for protocol', { protocol: envelope.protocol });
            response = await catchAllHandler(envelope);
          } else {
            logger.warn('No handler for protocol', { protocol: envelope.protocol });
          }

          if (response) {
            const encoded = encodeMessage(response);
            await relayClient.sendEnvelope(response.to, encoded);
            logger.info('Sent reply back to sender', {
              responseId: response.id,
              replyTo: response.replyTo,
            });
          }
        } catch (error) {
          logger.error('Error handling incoming message', error);
        }
      });

      logger.info('Message router started');
    },

    stop: async () => {
      handlers.clear();
      catchAllHandler = undefined;
      logger.info('Message router stopped');
    },
  };
}
