import type { MessagePage, PaginationOptions, StoredMessage } from '@quadra-a/protocol';

export function isInboxMessageVisible(
  message: StoredMessage,
  blockedDids: ReadonlySet<string>,
): boolean {
  return !(message.direction === 'inbound' && blockedDids.has(message.envelope.from));
}

export function paginateVisibleInboxMessages(
  messages: StoredMessage[],
  blockedDids: Iterable<string>,
  pagination: PaginationOptions = {},
): MessagePage {
  const { limit = 50, offset = 0 } = pagination;
  const blocked = blockedDids instanceof Set ? blockedDids : new Set(blockedDids);
  const visible = messages.filter((message) => isInboxMessageVisible(message, blocked));
  const page = visible.slice(offset, offset + limit);

  return {
    messages: page,
    total: visible.length,
    hasMore: visible.length > offset + page.length,
  };
}
