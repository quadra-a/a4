import {
  normalizeEnvelope,
  signEnvelope,
  verifyEnvelope,
  type MessageEnvelope,
} from '../messaging/envelope.js';
import { extractPublicKey } from '../identity/did.js';
import { verify } from '../identity/keys.js';
import { EncryptionError } from '../utils/errors.js';
import {
  buildInitiatorPreKeyMessage,
  consumeResponderPreKeyMessage,
  loadLocalSession,
  storeLocalSession,
} from './bootstrap.js';
import {
  decodePreKeyMessage,
  decodeSessionMessage,
  encodePreKeyMessage,
  encodeSessionMessage,
} from './messages.js';
import { decryptRatchetMessage, encryptRatchetMessage } from './ratchet.js';
import {
  bytesToHex,
  hexToBytes,
} from './x25519.js';
import type { AgentCard } from '../discovery/agent-card-types.js';
import type {
  ClaimedPreKeyBundle,
  E2EMessageType,
  LocalE2EConfig,
  PreKeyMessage,
  PublishedDeviceDirectoryEntry,
  SessionMessage,
} from './types.js';

export const E2E_APPLICATION_ENVELOPE_PROTOCOL = '/agent/e2e/1.0.0';
export const E2E_APPLICATION_ENVELOPE_KIND = 'quadra-a-e2e';
export const E2E_APPLICATION_ENVELOPE_VERSION = 1 as const;
export const E2E_APPLICATION_ENVELOPE_ENCODING = 'hex' as const;

export interface EncryptedApplicationEnvelopePayload {
  kind: typeof E2E_APPLICATION_ENVELOPE_KIND;
  version: typeof E2E_APPLICATION_ENVELOPE_VERSION;
  encoding: typeof E2E_APPLICATION_ENVELOPE_ENCODING;
  messageType: E2EMessageType;
  senderDeviceId: string;
  receiverDeviceId: string;
  sessionId: string;
  wireMessage: string;
}

export interface EncryptApplicationEnvelopeInput {
  e2eConfig: LocalE2EConfig;
  applicationEnvelope: MessageEnvelope;
  recipientDevice: PublishedDeviceDirectoryEntry;
  claimedBundle?: ClaimedPreKeyBundle;
}

export interface EncryptApplicationEnvelopeResult {
  payload: EncryptedApplicationEnvelopePayload;
  e2eConfig: LocalE2EConfig;
  transport: 'prekey' | 'session';
}

export interface DecryptApplicationEnvelopeInput {
  e2eConfig: LocalE2EConfig;
  receiverDid: string;
  transportEnvelope: MessageEnvelope;
  now?: number;
}

export interface DecryptApplicationEnvelopeResult {
  applicationEnvelope: MessageEnvelope;
  e2eConfig: LocalE2EConfig;
  transport: 'prekey' | 'session';
  senderDeviceId: string;
  receiverDeviceId: string;
  sessionId: string;
  usedSkippedMessageKey: boolean;
}

export interface SignEncryptedTransportEnvelopeInput {
  applicationEnvelope: MessageEnvelope;
  payload: EncryptedApplicationEnvelopePayload;
  signFn: (data: Uint8Array) => Promise<Uint8Array>;
}

function serializeSignedApplicationEnvelope(envelope: MessageEnvelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelope));
}

export function deserializeSignedApplicationEnvelope(bytes: Uint8Array): MessageEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new EncryptionError('Failed to parse signed application envelope JSON', error);
  }

  const normalized = normalizeEnvelope(parsed);
  if (!normalized) {
    throw new EncryptionError('Decrypted application envelope is invalid');
  }

  return normalized;
}

function assertEncryptedApplicationEnvelopePayload(
  payload: unknown,
): asserts payload is EncryptedApplicationEnvelopePayload {
  const record = payload as Partial<EncryptedApplicationEnvelopePayload> | null;
  if (
    !record
    || record.kind !== E2E_APPLICATION_ENVELOPE_KIND
    || record.version !== E2E_APPLICATION_ENVELOPE_VERSION
    || record.encoding !== E2E_APPLICATION_ENVELOPE_ENCODING
    || (record.messageType !== 'PREKEY_MESSAGE' && record.messageType !== 'SESSION_MESSAGE')
    || typeof record.senderDeviceId !== 'string'
    || typeof record.receiverDeviceId !== 'string'
    || typeof record.sessionId !== 'string'
    || typeof record.wireMessage !== 'string'
  ) {
    throw new EncryptionError('Invalid encrypted application envelope payload');
  }
}

function buildEncryptedApplicationEnvelopePayload(
  messageType: E2EMessageType,
  message: PreKeyMessage | SessionMessage,
  wireMessage: Uint8Array,
): EncryptedApplicationEnvelopePayload {
  return {
    kind: E2E_APPLICATION_ENVELOPE_KIND,
    version: E2E_APPLICATION_ENVELOPE_VERSION,
    encoding: E2E_APPLICATION_ENVELOPE_ENCODING,
    messageType,
    senderDeviceId: message.senderDeviceId,
    receiverDeviceId: message.receiverDeviceId,
    sessionId: message.sessionId,
    wireMessage: bytesToHex(wireMessage),
  };
}

function assertTransportEnvelopeMatchesMessage(
  transportEnvelope: MessageEnvelope,
  payload: EncryptedApplicationEnvelopePayload,
  message: PreKeyMessage | SessionMessage,
): void {
  if (transportEnvelope.protocol !== E2E_APPLICATION_ENVELOPE_PROTOCOL) {
    throw new EncryptionError('Transport envelope protocol is not the E2E application protocol', {
      expected: E2E_APPLICATION_ENVELOPE_PROTOCOL,
      actual: transportEnvelope.protocol,
    });
  }

  if (transportEnvelope.from !== message.senderDid || transportEnvelope.to !== message.receiverDid) {
    throw new EncryptionError('Transport envelope DID routing does not match encrypted message', {
      transportFrom: transportEnvelope.from,
      transportTo: transportEnvelope.to,
      messageFrom: message.senderDid,
      messageTo: message.receiverDid,
    });
  }

  if (transportEnvelope.id !== message.messageId) {
    throw new EncryptionError('Transport envelope id does not match encrypted message id', {
      transportEnvelopeId: transportEnvelope.id,
      messageId: message.messageId,
    });
  }

  if (
    payload.messageType !== message.type
    || payload.senderDeviceId !== message.senderDeviceId
    || payload.receiverDeviceId !== message.receiverDeviceId
    || payload.sessionId !== message.sessionId
  ) {
    throw new EncryptionError('Transport envelope metadata does not match encrypted message payload', {
      payload,
      messageType: message.type,
      senderDeviceId: message.senderDeviceId,
      receiverDeviceId: message.receiverDeviceId,
      sessionId: message.sessionId,
    });
  }
}

function assertApplicationEnvelopeMatchesMessage(
  applicationEnvelope: MessageEnvelope,
  message: PreKeyMessage | SessionMessage,
): void {
  if (
    applicationEnvelope.id !== message.messageId
    || applicationEnvelope.from !== message.senderDid
    || applicationEnvelope.to !== message.receiverDid
  ) {
    throw new EncryptionError('Decrypted application envelope does not match encrypted message routing', {
      applicationEnvelopeId: applicationEnvelope.id,
      applicationEnvelopeFrom: applicationEnvelope.from,
      applicationEnvelopeTo: applicationEnvelope.to,
      messageId: message.messageId,
      messageFrom: message.senderDid,
      messageTo: message.receiverDid,
    });
  }
}

export function assertPublishedSenderDeviceMatchesPreKeyMessage(
  senderCard: Pick<AgentCard, 'did' | 'devices'>,
  message: PreKeyMessage,
): void {
  const devices = Array.isArray(senderCard.devices) ? senderCard.devices : [];
  const matchingDevices = devices.filter((device) => device.deviceId === message.senderDeviceId);
  if (matchingDevices.length === 0) {
    throw new EncryptionError(
      `Sender ${message.senderDid}:${message.senderDeviceId} is not published in current Agent Card`,
    );
  }

  if (matchingDevices.length > 1) {
    throw new EncryptionError(
      `Sender ${message.senderDid} publishes duplicate E2E device ${message.senderDeviceId}`,
    );
  }

  if (matchingDevices[0].identityKeyPublic !== bytesToHex(message.initiatorIdentityKey)) {
    throw new EncryptionError(
      `Sender ${message.senderDid}:${message.senderDeviceId} published identity key does not match PREKEY_MESSAGE`,
    );
  }
}

async function assertEnvelopeSignature(envelope: MessageEnvelope, label: string): Promise<void> {
  const isValid = await verifyEnvelope(
    envelope,
    async (signature, data) => verify(signature, data, extractPublicKey(envelope.from)),
  );

  if (!isValid) {
    throw new EncryptionError(`${label} signature verification failed`, {
      envelopeId: envelope.id,
      from: envelope.from,
    });
  }
}

export function decodeEncryptedApplicationEnvelopePayload(
  payload: unknown,
): PreKeyMessage | SessionMessage {
  assertEncryptedApplicationEnvelopePayload(payload);
  const wireMessage = hexToBytes(payload.wireMessage);
  return payload.messageType === 'PREKEY_MESSAGE'
    ? decodePreKeyMessage(wireMessage)
    : decodeSessionMessage(wireMessage);
}

export function encryptApplicationEnvelope(
  input: EncryptApplicationEnvelopeInput,
): EncryptApplicationEnvelopeResult {
  const plaintext = serializeSignedApplicationEnvelope(input.applicationEnvelope);
  const currentDeviceId = input.e2eConfig.currentDeviceId;
  const existingSession = loadLocalSession(
    input.e2eConfig,
    currentDeviceId,
    input.applicationEnvelope.to,
    input.recipientDevice.deviceId,
  );

  if (existingSession) {
    const encrypted = encryptRatchetMessage({
      session: existingSession,
      plaintext,
      senderDid: input.applicationEnvelope.from,
      receiverDid: input.applicationEnvelope.to,
      messageId: input.applicationEnvelope.id,
    });

    return {
      payload: buildEncryptedApplicationEnvelopePayload(
        'SESSION_MESSAGE',
        encrypted.message,
        encodeSessionMessage(encrypted.message),
      ),
      e2eConfig: storeLocalSession(input.e2eConfig, currentDeviceId, encrypted.session),
      transport: 'session',
    };
  }

  if (!input.claimedBundle) {
    throw new EncryptionError('Missing claimed pre-key bundle for first encrypted send', {
      to: input.applicationEnvelope.to,
      receiverDeviceId: input.recipientDevice.deviceId,
    });
  }

  const bootstrap = buildInitiatorPreKeyMessage({
    e2eConfig: input.e2eConfig,
    senderDid: input.applicationEnvelope.from,
    receiverDid: input.applicationEnvelope.to,
    recipientDevice: input.recipientDevice,
    claimedBundle: input.claimedBundle,
    plaintext,
    messageId: input.applicationEnvelope.id,
  });

  return {
    payload: buildEncryptedApplicationEnvelopePayload(
      'PREKEY_MESSAGE',
      bootstrap.message,
      encodePreKeyMessage(bootstrap.message),
    ),
    e2eConfig: bootstrap.e2eConfig,
    transport: 'prekey',
  };
}

export async function decryptApplicationEnvelope(
  input: DecryptApplicationEnvelopeInput,
): Promise<DecryptApplicationEnvelopeResult> {
  await assertEnvelopeSignature(input.transportEnvelope, 'Encrypted transport envelope');
  if (input.transportEnvelope.protocol !== E2E_APPLICATION_ENVELOPE_PROTOCOL) {
    throw new EncryptionError('Transport envelope protocol is not the E2E application protocol', {
      expected: E2E_APPLICATION_ENVELOPE_PROTOCOL,
      actual: input.transportEnvelope.protocol,
    });
  }
  assertEncryptedApplicationEnvelopePayload(input.transportEnvelope.payload);
  const payload = input.transportEnvelope.payload;
  const decodedMessage = decodeEncryptedApplicationEnvelopePayload(payload);
  assertTransportEnvelopeMatchesMessage(input.transportEnvelope, payload, decodedMessage);

  const decryptResult = decodedMessage.type === 'PREKEY_MESSAGE'
    ? (() => {
        const consumed = consumeResponderPreKeyMessage({
          e2eConfig: input.e2eConfig,
          receiverDid: input.receiverDid,
          message: decodedMessage,
          now: input.now,
        });
        return {
          plaintext: consumed.plaintext,
          e2eConfig: consumed.e2eConfig,
          transport: 'prekey' as const,
          usedSkippedMessageKey: false,
        };
      })()
    : (() => {
        const session = loadLocalSession(
          input.e2eConfig,
          decodedMessage.receiverDeviceId,
          decodedMessage.senderDid,
          decodedMessage.senderDeviceId,
        );

        if (!session) {
          throw new EncryptionError('Missing local E2E session for SESSION_MESSAGE', {
            receiverDeviceId: decodedMessage.receiverDeviceId,
            senderDid: decodedMessage.senderDid,
            senderDeviceId: decodedMessage.senderDeviceId,
            sessionId: decodedMessage.sessionId,
          });
        }

        if (session.sessionId !== decodedMessage.sessionId) {
          throw new EncryptionError('SESSION_MESSAGE session id does not match local ratchet state', {
            expected: session.sessionId,
            actual: decodedMessage.sessionId,
          });
        }

        const decrypted = decryptRatchetMessage({
          session,
          message: decodedMessage,
          now: input.now,
        });

        return {
          plaintext: decrypted.plaintext,
          e2eConfig: storeLocalSession(input.e2eConfig, decodedMessage.receiverDeviceId, decrypted.session),
          transport: 'session' as const,
          usedSkippedMessageKey: decrypted.usedSkippedMessageKey,
        };
      })();

  const applicationEnvelope = deserializeSignedApplicationEnvelope(decryptResult.plaintext);
  assertApplicationEnvelopeMatchesMessage(applicationEnvelope, decodedMessage);
  await assertEnvelopeSignature(applicationEnvelope, 'Decrypted application envelope');

  return {
    applicationEnvelope,
    e2eConfig: decryptResult.e2eConfig,
    transport: decryptResult.transport,
    senderDeviceId: decodedMessage.senderDeviceId,
    receiverDeviceId: decodedMessage.receiverDeviceId,
    sessionId: decodedMessage.sessionId,
    usedSkippedMessageKey: decryptResult.usedSkippedMessageKey,
  };
}

export async function signEncryptedTransportEnvelope(
  input: SignEncryptedTransportEnvelopeInput,
): Promise<MessageEnvelope> {
  return signEnvelope(
    {
      id: input.applicationEnvelope.id,
      from: input.applicationEnvelope.from,
      to: input.applicationEnvelope.to,
      type: 'message',
      protocol: E2E_APPLICATION_ENVELOPE_PROTOCOL,
      payload: input.payload,
      timestamp: input.applicationEnvelope.timestamp,
    },
    input.signFn,
  );
}
