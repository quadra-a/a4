/**
 * CVP-0011 / CVP-0015 / CVP-0017 / CVP-0018: Relay server implementation
 *
 * UPDATED: Now uses RelayAgent - proper agent implementation that participates
 * in the network as a first-class agent while maintaining relay functionality.
 */

import { RelayAgent, type RelayAgentConfig } from './relay-agent.js';

// Re-export RelayAgentConfig as RelayConfig for backward compatibility
export type RelayConfig = RelayAgentConfig;

// Re-export RelayAgent as RelayServer for backward compatibility
export class RelayServer extends RelayAgent {
  constructor(config: RelayConfig = {}) {
    console.warn('RelayServer is deprecated. Use RelayAgent instead for proper agent functionality.');
    super(config);
  }
}

// Export the new RelayAgent as the primary class
export { RelayAgent, type RelayAgentConfig } from './relay-agent.js';
