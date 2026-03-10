/**
 * JSON-LD Schema Definitions for Agent Cards
 *
 * Defines the quadra-a vocabulary and integrates with Schema.org
 * for semantic interoperability.
 */

export const QUADRA_A_CONTEXT = 'https://quadra-a.org/context/v1';
export const SCHEMA_ORG_CONTEXT = 'https://schema.org';

/**
 * quadra-a JSON-LD Context
 * Defines the vocabulary for Agent Cards and Capabilities
 */
export const quadraAContext = {
  '@context': {
    '@vocab': QUADRA_A_CONTEXT,
    'schema': SCHEMA_ORG_CONTEXT,
    'AgentCard': 'schema:SoftwareApplication',
    'Capability': 'schema:Action',
    'did': '@id',
    'name': 'schema:name',
    'description': 'schema:description',
    'version': 'schema:softwareVersion',
    'capabilities': {
      '@id': 'schema:potentialAction',
      '@type': '@id',
      '@container': '@list'
    },
    'endpoints': {
      '@id': 'schema:url',
      '@container': '@list'
    },
    'peerId': 'quadra-a:peerId',
    'trust': 'quadra-a:trustScore',
    'metadata': 'schema:additionalProperty',
    'timestamp': 'schema:dateModified',
    'signature': 'quadra-a:signature',
    'parameters': {
      '@id': 'schema:object',
      '@container': '@list'
    }
  }
};

/**
 * Capability Type Definitions
 * Common capability types with semantic meaning
 */
export const CapabilityTypes = {
  TRANSLATION: 'TranslationService',
  CODE_REVIEW: 'CodeReviewService',
  DATA_ANALYSIS: 'DataAnalysisService',
  TEXT_GENERATION: 'TextGenerationService',
  IMAGE_GENERATION: 'ImageGenerationService',
  SEARCH: 'SearchService',
  COMPUTATION: 'ComputationService',
  STORAGE: 'StorageService',
  MESSAGING: 'MessagingService',
  AUTHENTICATION: 'AuthenticationService',
} as const;

/**
 * Parameter Type Definitions
 */
export const ParameterTypes = {
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  OBJECT: 'object',
  ARRAY: 'array',
} as const;

/**
 * Get JSON-LD context for Agent Card
 */
export function getAgentCardContext(): string[] {
  return [SCHEMA_ORG_CONTEXT, QUADRA_A_CONTEXT];
}

/**
 * Validate JSON-LD context
 */
export function isValidContext(context: unknown): boolean {
  if (!Array.isArray(context)) return false;
  return context.every(c => typeof c === 'string');
}
