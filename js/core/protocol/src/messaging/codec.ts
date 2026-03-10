import { encode, decode } from 'cbor-x';
import type { MessageEnvelope } from './envelope.js';
import { normalizeEnvelope } from './envelope.js';
import { MessagingError } from '../utils/errors.js';

export function encodeMessage(envelope: MessageEnvelope): Uint8Array {
  try {
    return encode(envelope);
  } catch (error) {
    throw new MessagingError('Failed to encode message', error);
  }
}

export function decodeMessage(data: Uint8Array): MessageEnvelope {
  try {
    const decoded = decode(data);
    const normalized = normalizeEnvelope(decoded);

    if (!normalized) {
      throw new MessagingError('Decoded message envelope is invalid');
    }

    return normalized;
  } catch (error) {
    if (error instanceof MessagingError) {
      throw error;
    }
    throw new MessagingError('Failed to decode message', error);
  }
}

export function encodeMessageJSON(envelope: MessageEnvelope): string {
  try {
    return JSON.stringify(envelope, null, 2);
  } catch (error) {
    throw new MessagingError('Failed to encode message to JSON', error);
  }
}

export function decodeMessageJSON(json: string): MessageEnvelope {
  try {
    const decoded = JSON.parse(json);
    const normalized = normalizeEnvelope(decoded);

    if (!normalized) {
      throw new MessagingError('Decoded JSON envelope is invalid');
    }

    return normalized;
  } catch (error) {
    if (error instanceof MessagingError) {
      throw error;
    }
    throw new MessagingError('Failed to decode message from JSON', error);
  }
}
