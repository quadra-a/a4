import { MessagingError } from '../utils/errors.js';

export type LegacyMessageEnvelopeType = 'request' | 'response' | 'notification';
export type MessageEnvelopeType = 'message' | 'reply';
export type AnyMessageEnvelopeType = MessageEnvelopeType | LegacyMessageEnvelopeType;

export interface MessageEnvelope {
  id: string;
  from: string;
  to: string;
  type: MessageEnvelopeType;
  protocol: string;
  payload: unknown;
  timestamp: number;
  signature: string;
  replyTo?: string;
  threadId?: string;
  groupId?: string;
}

export function normalizeEnvelopeType(type: string): MessageEnvelopeType | undefined {
  if (type === 'message' || type === 'notification' || type === 'request') {
    return 'message';
  }

  if (type === 'reply' || type === 'response') {
    return 'reply';
  }

  return undefined;
}

export function normalizeEnvelope(msg: unknown): MessageEnvelope | undefined {
  if (typeof msg !== 'object' || msg === null) {
    return undefined;
  }

  const envelope = msg as Partial<MessageEnvelope> & { type?: string };
  const normalizedType = envelope.type ? normalizeEnvelopeType(envelope.type) : undefined;

  if (
    typeof envelope.id !== 'string' ||
    typeof envelope.from !== 'string' ||
    !envelope.from.startsWith('did:agent:') ||
    typeof envelope.to !== 'string' ||
    !envelope.to.startsWith('did:agent:') ||
    !normalizedType ||
    typeof envelope.protocol !== 'string' ||
    envelope.payload === undefined ||
    typeof envelope.timestamp !== 'number' ||
    typeof envelope.signature !== 'string'
  ) {
    return undefined;
  }

  if (normalizedType === 'reply' && typeof envelope.replyTo !== 'string') {
    return undefined;
  }

  return {
    id: envelope.id,
    from: envelope.from,
    to: envelope.to,
    type: normalizedType,
    protocol: envelope.protocol,
    payload: envelope.payload,
    timestamp: envelope.timestamp,
    signature: envelope.signature,
    replyTo: typeof envelope.replyTo === 'string' ? envelope.replyTo : undefined,
    threadId: typeof envelope.threadId === 'string' ? envelope.threadId : undefined,
    groupId: typeof envelope.groupId === 'string' ? envelope.groupId : undefined,
  };
}

export function createEnvelope(
  from: string,
  to: string,
  type: AnyMessageEnvelopeType,
  protocol: string,
  payload: unknown,
  replyTo?: string,
  threadId?: string,
  groupId?: string,
): Omit<MessageEnvelope, 'signature'> {
  const normalizedType = normalizeEnvelopeType(type);

  if (!normalizedType) {
    throw new MessagingError(`Invalid message type: ${type}`);
  }

  if (normalizedType === 'reply' && !replyTo) {
    throw new MessagingError('Reply envelopes must include replyTo');
  }

  return {
    id: generateMessageId(),
    from,
    to,
    type: normalizedType,
    protocol,
    payload,
    timestamp: Date.now(),
    ...(replyTo ? { replyTo } : {}),
    ...(threadId ? { threadId } : {}),
    ...(groupId ? { groupId } : {}),
  };
}

export async function signEnvelope(
  envelope: Omit<MessageEnvelope, 'signature'>,
  signFn: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<MessageEnvelope> {
  try {
    const envelopeJson = JSON.stringify(envelope);
    const envelopeBytes = new TextEncoder().encode(envelopeJson);
    const signature = await signFn(envelopeBytes);

    return {
      ...envelope,
      signature: Buffer.from(signature).toString('hex'),
    };
  } catch (error) {
    throw new MessagingError('Failed to sign envelope', error);
  }
}

export async function verifyEnvelope(
  envelope: MessageEnvelope,
  verifyFn: (signature: Uint8Array, data: Uint8Array) => Promise<boolean>,
): Promise<boolean> {
  try {
    const normalized = normalizeEnvelope(envelope);
    if (!normalized) {
      return false;
    }

    const { signature, ...envelopeWithoutSig } = normalized;
    const envelopeJson = JSON.stringify(envelopeWithoutSig);
    const envelopeBytes = new TextEncoder().encode(envelopeJson);
    const signatureBytes = Buffer.from(signature, 'hex');

    return await verifyFn(signatureBytes, envelopeBytes);
  } catch (error) {
    throw new MessagingError('Failed to verify envelope', error);
  }
}

export function validateEnvelope(msg: unknown): msg is MessageEnvelope {
  const normalized = normalizeEnvelope(msg);
  return normalized !== undefined;
}

function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

export function generateThreadId(): string {
  return `thread_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}
