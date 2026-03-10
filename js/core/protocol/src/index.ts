/**
 * quadra-a Core - Main Export
 */

// Identity
export * from './identity/keys.js';
export * from './identity/did.js';
export * from './identity/signer.js';
export * from './identity/aliases.js';
export * from './identity/index.js';

// Transport (CVP-0011: relay-based)
export * from './transport/relay-client.js';
export * from './transport/relay-types.js';

// Discovery
export * from './discovery/agent-card.js';
export * from './discovery/agent-card-types.js';
export * from './discovery/agent-card-schema.js';
export * from './discovery/agent-card-encoder.js';
export * from './discovery/relay-index.js';

// Messaging
export * from './messaging/envelope.js';
export * from './messaging/codec.js';
export * from './messaging/router.js';
export * from './messaging/types.js';
export * from './messaging/storage.js';
export * from './messaging/queue.js';
export * from './messaging/defense.js';
export * from './messaging/rate-limiter.js';

// Trust (Phase 2)
export * from './trust/index.js';

// Utils
export * from './utils/logger.js';
export * from './utils/errors.js';
