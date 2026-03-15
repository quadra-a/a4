/**
 * CVP-0011: Relay server wire protocol types
 * (mirrors packages/core/src/transport/relay-types.ts but without the core dep)
 */

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
  | 'SUBSCRIBE'
  | 'SUBSCRIBE_ACK'
  | 'UNSUBSCRIBE'
  | 'EVENT'
  | 'ENDORSE'
  | 'ENDORSE_ACK'
  | 'TRUST_QUERY'
  | 'TRUST_RESULT'
  | 'PUBLISH_CARD'
  | 'UNPUBLISH_CARD'
  | 'PUBLISH_PREKEYS'
  | 'PREKEYS_PUBLISHED'
  | 'FETCH_PREKEY_BUNDLE'
  | 'PREKEY_BUNDLE'
  | 'FEDERATION_HELLO'
  | 'FEDERATION_WELCOME'
  | 'FEDERATION_ADMITTED'
  | 'AGENT_JOINED'
  | 'AGENT_LEFT'
  | 'ROUTE_REQUEST'
  | 'ROUTE_RESPONSE'
  | 'FEDERATION_HEALTH_CHECK'
  | 'FEDERATION_HEALTH_RESPONSE';

export interface AgentCardCapability {
  id: string;
  name: string;
  description: string;
  parameters?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface AgentCardPublishedDevice {
  deviceId: string;
  identityKeyPublic: string;
  signedPreKeyPublic: string;
  signedPreKeyId: number;
  signedPreKeySignature: string;
  oneTimePreKeyCount: number;
  lastResupplyAt: number;
}

export interface PublishedOneTimePreKey {
  keyId: number;
  publicKey: string;
}

export interface PublishedPreKeyBundle extends AgentCardPublishedDevice {
  oneTimePreKeys: PublishedOneTimePreKey[];
}

export interface ClaimedPreKeyBundle extends AgentCardPublishedDevice {
  oneTimePreKey?: PublishedOneTimePreKey;
  remainingOneTimePreKeyCount: number;
}

export interface AgentCard {
  did: string;
  name: string;
  description: string;
  version: string;
  capabilities: AgentCardCapability[];
  endpoints: string[];
  devices?: AgentCardPublishedDevice[];
  peerId?: string;
  trust?: unknown;
  metadata?: Record<string, unknown>;
  timestamp: number;
  signature: string;
}

export interface HelloMessage {
  type: 'HELLO';
  protocolVersion: number;
  did: string;
  card: AgentCard;
  timestamp: number;
  signature: Uint8Array | number[];
  extensions?: string[];
  inviteToken?: string;  // CVP-0015: required for private relay domains
}

export interface WelcomeMessage {
  type: 'WELCOME';
  protocolVersion: number;
  relayId: string;
  peers: number;
  federatedRelays: string[];
  yourAddr: string;
  realm?: string;  // CVP-0015: realm the agent was admitted to
}

export interface SendMessage {
  type: 'SEND';
  to: string;
  envelope: Uint8Array | number[];
}

export interface DeliverMessage {
  type: 'DELIVER';
  messageId: string;
  from: string;
  envelope: Uint8Array | number[];
}

export interface DiscoverMessage {
  type: 'DISCOVER';
  query?: string;
  capability?: string;
  minTrust?: number;
  limit?: number;
  cursor?: string;
}

export interface TrustSummary {
  endorsementCount: number;
  averageScore: number;
  oldestEndorsement: number;
  verified?: boolean;
}

export interface DiscoveredAgent {
  did: string;
  card: AgentCard;
  online: boolean;
  lastSeen?: number;
  homeRelay?: string;
  trust?: TrustSummary;
}

export interface DiscoveredMessage {
  type: 'DISCOVERED';
  agents: DiscoveredAgent[];
  cursor?: string;
  total?: number;
}

export interface SubscribeMessage {
  type: 'SUBSCRIBE';
  events: Array<'join' | 'leave' | 'update' | 'publish' | 'unpublish'>;
  realm?: string;
}

export interface SubscribeAckMessage {
  type: 'SUBSCRIBE_ACK';
  subscriptionId?: string;
  realm?: string;
  error?: string;
}

export interface UnsubscribeMessage {
  type: 'UNSUBSCRIBE';
  subscriptionId: string;
}

export interface EventMessage {
  type: 'EVENT';
  subscriptionId: string;
  event: 'join' | 'leave' | 'update' | 'publish' | 'unpublish';
  did: string;
  card?: AgentCard;
  realm: string;
  timestamp?: number;
}

export interface EndorseMessage {
  type: 'ENDORSE';
  endorsement: {
    version: 2;
    from: string;
    to: string;
    score: number;
    domain?: string;
    reason: string;
    timestamp: number;
    expires?: number;
    signature: string;
  };
}

export interface EndorseAckMessage {
  type: 'ENDORSE_ACK';
  id?: string;
  stored: boolean;
  error?: string;
}

export interface TrustQueryMessage {
  type: 'TRUST_QUERY';
  target: string;
  domain?: string;
  since?: number;
  cursor?: string;
}

export interface TrustResultMessage {
  type: 'TRUST_RESULT';
  target: string;
  endorsements: EndorseMessage['endorsement'][];
  endorsementCount: number;
  averageScore: number;
  nextCursor?: string;
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

// CVP-0018: Decouple connection from discoverability
export interface PublishCardMessage {
  type: 'PUBLISH_CARD';
  card?: AgentCard;  // If omitted, uses the card from HELLO
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

// Federation message types for relay-to-relay communication
export interface FederationHelloMessage {
  type: 'FEDERATION_HELLO';
  relayDid: string;
  relayCard: AgentCard;
  endpoints: string[];
  devices?: AgentCardPublishedDevice[];
  timestamp: number;
  signature: Uint8Array | number[];
}

export interface FederationWelcomeMessage {
  type: 'FEDERATION_WELCOME';
  relayDid: string;
  peers: string[];  // Other known relay DIDs
  protocolVersion: number;
  relayCard?: AgentCard;
  endpoints?: string[];
}

export interface FederationAdmittedMessage {
  type: 'FEDERATION_ADMITTED';
  relayDid: string;
  protocolVersion: number;
  timestamp: number;
}

export interface AgentJoinedMessage {
  type: 'AGENT_JOINED';
  agentDid: string;
  agentCard: AgentCard;
  realm: string;
  timestamp: number;
}

export interface AgentLeftMessage {
  type: 'AGENT_LEFT';
  agentDid: string;
  realm: string;
  timestamp: number;
}

export interface RouteRequestMessage {
  type: 'ROUTE_REQUEST';
  targetDid: string;
  envelope: Uint8Array | number[];
  fromRelay: string;
  hopCount: number;
  messageId: string;
}

export interface RouteResponseMessage {
  type: 'ROUTE_RESPONSE';
  messageId: string;
  status: 'delivered' | 'not_found' | 'hop_limit_exceeded';
  targetRelay?: string;
}

export interface FederationHealthCheckMessage {
  type: 'FEDERATION_HEALTH_CHECK';
  timestamp: number;
}

export interface FederationHealthResponseMessage {
  type: 'FEDERATION_HEALTH_RESPONSE';
  uptime: number;
  connectedAgents: number;
  queuedMessages: number;
  timestamp: number;
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
  | SubscribeMessage
  | SubscribeAckMessage
  | UnsubscribeMessage
  | EventMessage
  | EndorseMessage
  | EndorseAckMessage
  | TrustQueryMessage
  | TrustResultMessage
  | PublishCardMessage
  | UnpublishCardMessage
  | PublishPreKeysMessage
  | PreKeysPublishedMessage
  | FetchPreKeyBundleMessage
  | PreKeyBundleMessage
  | FederationHelloMessage
  | FederationWelcomeMessage
  | FederationAdmittedMessage
  | AgentJoinedMessage
  | AgentLeftMessage
  | RouteRequestMessage
  | RouteResponseMessage
  | FederationHealthCheckMessage
  | FederationHealthResponseMessage;
