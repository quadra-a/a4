/**
 * CVP-0011: Relay wire protocol types (shared between relay server and relay client)
 */

import type { AgentCard } from '../discovery/agent-card-types.js';
import type { ClaimedPreKeyBundle, PublishedPreKeyBundle } from '../e2e/types.js';

export const RELAY_PROTOCOL_VERSION = 1;

export type RelayMessageType =
  | 'HELLO'
  | 'WELCOME'
  | 'SEND'
  | 'DELIVER'
  | 'DISCOVER'
  | 'DISCOVERED'
  | 'PING'
  | 'PONG'
  | 'ACK'
  | 'DELIVERY_REPORT'
  | 'FETCH_CARD'
  | 'CARD'
  | 'GOODBYE'
  | 'INDEX_SYNC'
  | 'ROUTE'
  | 'SYNC_HELLO'
  | 'SYNC_REQUEST'
  | 'SYNC_RESPONSE'
  | 'SYNC_PUSH'
  | 'SYNC_RECONCILE'
  | 'ENDORSE'
  | 'ENDORSE_ACK'
  | 'TRUST_QUERY'
  | 'TRUST_RESULT'
  | 'PUBLISH_CARD'
  | 'UNPUBLISH_CARD'
  | 'PUBLISH_PREKEYS'
  | 'PREKEYS_PUBLISHED'
  | 'FETCH_PREKEY_BUNDLE'
  | 'PREKEY_BUNDLE';

export interface HelloMessage {
  type: 'HELLO';
  protocolVersion: number;
  did: string;
  card: AgentCard;
  timestamp: number;
  signature: Uint8Array;
  extensions?: string[];
  inviteToken?: string;
}

export interface WelcomeMessage {
  type: 'WELCOME';
  protocolVersion: number;
  relayId: string;
  peers: number;
  federatedRelays: string[];
  yourAddr: string;
  realm?: string;
}

export interface SendMessage {
  type: 'SEND';
  to: string;
  envelope: Uint8Array;
}

export interface DeliverMessage {
  type: 'DELIVER';
  messageId: string;
  from: string;
  envelope: Uint8Array;
}

export interface DiscoverMessage {
  type: 'DISCOVER';
  query?: string;
  capability?: string;
  minTrust?: number;
  limit?: number;
}

export interface DiscoveredAgent {
  did: string;
  card: AgentCard;
  online: boolean;
  homeRelay?: string;
}

export interface DiscoveredMessage {
  type: 'DISCOVERED';
  agents: DiscoveredAgent[];
}

export interface AckMessage {
  type: 'ACK';
  messageId: string;
}

export interface DeliveryReportMessage {
  type: 'DELIVERY_REPORT';
  messageId: string;
  status: 'accepted' | 'delivered' | 'expired' | 'queue_full' | 'unknown_recipient';
  timestamp: number;
}

export interface PingMessage {
  type: 'PING';
}

export interface PongMessage {
  type: 'PONG';
  peers: number;
}

export interface FetchCardMessage {
  type: 'FETCH_CARD';
  did: string;
}

export interface CardMessage {
  type: 'CARD';
  did: string;
  card: AgentCard | null;
}

export interface GoodbyeMessage {
  type: 'GOODBYE';
  reconnectAfter?: number;  // CVP-0011 §2.6: Milliseconds to wait before reconnecting
}

export interface PresenceProof {
  did: string;
  homeRelay: string;
  expiry: number;
  signature: Uint8Array;
}

export interface SyncEvent {
  seq: number;
  type: 'JOIN' | 'LEAVE' | 'UPDATE';
  did: string;
  homeRelay: string;
  cardHash?: string;
  capabilityKeys?: string[];
  online: boolean;
  ts: number;
  presenceProof?: PresenceProof;
}

export interface IndexSyncMessage {
  type: 'INDEX_SYNC';
  events: SyncEvent[];
}

export interface RouteMessage {
  type: 'ROUTE';
  to: string;
  envelope: Uint8Array;
  ttl: number;
}

export interface SyncHelloMessage {
  type: 'SYNC_HELLO';
  relayId: string;
  seq: number;
}

export interface SyncRequestMessage {
  type: 'SYNC_REQUEST';
  fromSeq: number;
}

export interface SyncResponseMessage {
  type: 'SYNC_RESPONSE';
  events: SyncEvent[];
}

export interface SyncPushMessage {
  type: 'SYNC_PUSH';
  event: SyncEvent;
}

export interface SyncReconcileMessage {
  type: 'SYNC_RECONCILE';
  dids: string[];
}

// CVP-0017: Trust query messages
export interface TrustQueryMessage {
  type: 'TRUST_QUERY';
  target: string;
  domain?: string;
  since?: number;
  cursor?: string;
}

export interface TrustResultEndorsement {
  version: 2;
  from: string;
  to: string;
  score: number;
  domain?: string;
  reason: string;
  timestamp: number;
  expires?: number;
  signature: string;
}

export interface TrustResultMessage {
  type: 'TRUST_RESULT';
  target: string;
  endorsements: TrustResultEndorsement[];
  endorsementCount: number;
  averageScore: number;
  nextCursor?: string;
}

// CVP-0018: Publish/unpublish card messages
export interface PublishCardMessage {
  type: 'PUBLISH_CARD';
  card?: AgentCard;
}

export interface UnpublishCardMessage {
  type: 'UNPUBLISH_CARD';
}

export interface PublishPreKeysMessage {
  type: 'PUBLISH_PREKEYS';
  bundles: PublishedPreKeyBundle[];
}

export interface PreKeysPublishedMessage {
  type: 'PREKEYS_PUBLISHED';
  did: string;
  deviceCount: number;
}

export interface FetchPreKeyBundleMessage {
  type: 'FETCH_PREKEY_BUNDLE';
  did: string;
  deviceId: string;
  requestId?: string;
  requesterRealm?: string;
}

export interface PreKeyBundleMessage {
  type: 'PREKEY_BUNDLE';
  did: string;
  deviceId: string;
  bundle: ClaimedPreKeyBundle | null;
  requestId?: string;
}

export type RelayMessage =
  | HelloMessage
  | WelcomeMessage
  | SendMessage
  | DeliverMessage
  | DiscoverMessage
  | DiscoveredMessage
  | AckMessage
  | DeliveryReportMessage
  | PingMessage
  | PongMessage
  | FetchCardMessage
  | CardMessage
  | GoodbyeMessage
  | IndexSyncMessage
  | RouteMessage
  | SyncHelloMessage
  | SyncRequestMessage
  | SyncResponseMessage
  | SyncPushMessage
  | SyncReconcileMessage
  | TrustQueryMessage
  | TrustResultMessage
  | PublishCardMessage
  | UnpublishCardMessage
  | PublishPreKeysMessage
  | PreKeysPublishedMessage
  | FetchPreKeyBundleMessage
  | PreKeyBundleMessage;
