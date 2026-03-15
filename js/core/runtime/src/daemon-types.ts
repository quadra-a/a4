import type { MessageFilter } from '@quadra-a/protocol';
import type { ReachabilityPolicy, ReachabilityPolicyOverrides, ReachabilityStatus } from './reachability.js';

export type DaemonCommand =
  | 'send'
  | 'discover'
  | 'status'
  | 'messages'
  | 'shutdown'
  | 'inbox'
  | 'get_message'
  | 'mark_read'
  | 'delete_message'
  | 'outbox'
  | 'retry_message'
  | 'block'
  | 'unblock'
  | 'allowlist'
  | 'queue_stats'
  | 'sessions'
  | 'session_messages'
  | 'archive_session'
  | 'unarchive_session'
  | 'search_sessions'
  | 'export_session'
  | 'session_stats'
  | 'get_card'
  | 'query_agent_card'
  | 'publish_card'
  | 'list_peers'
  | 'subscribe_inbox'
  | 'unsubscribe'
  | 'trust_score'
  | 'create_endorsement'
  | 'query_endorsements'
  | 'get_reachability_policy'
  | 'set_reachability_policy'
  | 'reset_reachability_policy'
  | 'get_reachability_status'
  | 'query-card'
  | 'e2e-reset-notify'
  | 'reload-e2e';

export interface DaemonRequest<TParams = Record<string, any>> {
  id: string;
  command: DaemonCommand;
  params: TParams;
}

export type DaemonResponse<TData = unknown> =
  | {
      id: string;
      success: true;
      data?: TData;
    }
  | {
      id: string;
      success: false;
      error: string;
    };

export interface ListPeersParams {
  query?: string;
  capability?: string;
  minTrust?: number;
  limit?: number;
}

export interface PublishCardParams {
  name?: string;
  description?: string;
  capabilities?: string[];
}

export interface QueryAgentCardParams {
  did: string;
}

export interface SubscribeInboxParams {
  filter?: MessageFilter;
}

export interface UnsubscribeParams {
  subscriptionId: string;
}

export interface DaemonSubscriptionEvent<TData = unknown> {
  type: 'event';
  event: 'inbox';
  subscriptionId: string;
  data: TData;
}

export interface SetReachabilityPolicyParams {
  policy?: ReachabilityPolicyOverrides;
}

export interface ReachabilityPolicyResponse {
  policy: ReachabilityPolicy;
  status: ReachabilityStatus;
}

export interface E2EResetNotifyParams {
  peers: string[];
}
