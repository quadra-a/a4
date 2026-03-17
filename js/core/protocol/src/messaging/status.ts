import type { MessageStatus, StoredMessage } from './types.js';

export function storedMessageStatus(message: StoredMessage): MessageStatus {
  if (message.status === 'archived') {
    return 'archived';
  }

  if (message.status === 'failed' || message.e2e?.deliveries.some((delivery) => delivery.state === 'failed')) {
    return 'failed';
  }

  if (message.direction === 'inbound') {
    return message.readAt != null ? 'delivered' : 'pending';
  }

  if (
    message.status === 'delivered'
    || message.e2e?.deliveries.some((delivery) => delivery.state === 'sent' || delivery.state === 'received')
  ) {
    return 'delivered';
  }

  return 'pending';
}
