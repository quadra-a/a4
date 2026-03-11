import type { StoredMessage } from './types.js';

export const MAX_MESSAGE_SORT_SKEW_MS = 5 * 60 * 1000;

type MessageTimestampSource = Pick<StoredMessage, 'receivedAt' | 'sentAt' | 'envelope'>;

function normalizeTimestamp(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function getMessageLocalTimestamp(message: Pick<StoredMessage, 'receivedAt' | 'sentAt'>): number | null {
  return normalizeTimestamp(message.receivedAt) ?? normalizeTimestamp(message.sentAt);
}

export function getMessageEnvelopeTimestamp(message: Pick<StoredMessage, 'envelope'>): number | null {
  return normalizeTimestamp(message.envelope?.timestamp);
}

export function getMessageSortTimestamp(
  message: MessageTimestampSource,
  maxSkewMs = MAX_MESSAGE_SORT_SKEW_MS,
): number {
  const localTimestamp = getMessageLocalTimestamp(message);
  const envelopeTimestamp = getMessageEnvelopeTimestamp(message);

  if (envelopeTimestamp !== null) {
    if (localTimestamp !== null && Math.abs(localTimestamp - envelopeTimestamp) > maxSkewMs) {
      return localTimestamp;
    }

    return envelopeTimestamp;
  }

  return localTimestamp ?? 0;
}

export function compareMessagesBySortTimestamp(left: StoredMessage, right: StoredMessage): number {
  const leftSortTimestamp = getMessageSortTimestamp(left);
  const rightSortTimestamp = getMessageSortTimestamp(right);

  if (leftSortTimestamp !== rightSortTimestamp) {
    return leftSortTimestamp - rightSortTimestamp;
  }

  const leftLocalTimestamp = getMessageLocalTimestamp(left) ?? 0;
  const rightLocalTimestamp = getMessageLocalTimestamp(right) ?? 0;
  if (leftLocalTimestamp !== rightLocalTimestamp) {
    return leftLocalTimestamp - rightLocalTimestamp;
  }

  const leftEnvelopeTimestamp = getMessageEnvelopeTimestamp(left) ?? 0;
  const rightEnvelopeTimestamp = getMessageEnvelopeTimestamp(right) ?? 0;
  if (leftEnvelopeTimestamp !== rightEnvelopeTimestamp) {
    return leftEnvelopeTimestamp - rightEnvelopeTimestamp;
  }

  return left.envelope.id.localeCompare(right.envelope.id);
}
