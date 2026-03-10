/**
 * Agent Aliases - CVP-0014 Part 1
 *
 * Local petname-to-DID mapping for easier agent addressing.
 * Aliases are stored in ~/.quadra-a/config.json under the "aliases" key.
 *
 * Note: This module provides the core logic. The actual config storage
 * is handled by the CLI layer (packages/cli/src/config.ts).
 */

export interface AliasMap {
  [alias: string]: string; // alias -> DID
}

/**
 * Validate alias name according to CVP-0014 rules:
 * - Lowercase alphanumeric + hyphens: [a-z0-9][a-z0-9-]*
 * - Max 32 characters
 * - Cannot start with "did:" (reserved for DID prefix detection)
 */
export function validateAliasName(alias: string): { valid: boolean; error?: string } {
  if (!alias || alias.length === 0) {
    return { valid: false, error: 'Alias cannot be empty' };
  }

  if (alias.length > 32) {
    return { valid: false, error: 'Alias must be 32 characters or less' };
  }

  if (alias.startsWith('did:')) {
    return { valid: false, error: 'Alias cannot start with "did:" (reserved for DID prefix)' };
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(alias)) {
    return { valid: false, error: 'Alias must be lowercase alphanumeric with hyphens, starting with alphanumeric' };
  }

  return { valid: true };
}

/**
 * Resolve a DID from various input formats:
 * 1. If input starts with "did:" → return as-is
 * 2. If input matches a local alias → return the mapped DID (caller must provide aliases)
 * 3. Otherwise → return undefined (caller can attempt discovery)
 */
export function resolveDid(input: string, aliases: AliasMap): string | undefined {
  if (!input) {
    return undefined;
  }

  // Already a DID
  if (input.startsWith('did:')) {
    return input;
  }

  // Try alias lookup
  const did = aliases[input];
  if (did) {
    return did;
  }

  // Not found - caller should attempt discovery
  return undefined;
}

/**
 * Reverse lookup: find alias for a DID
 * Returns the first matching alias, or undefined if no alias exists
 */
export function reverseAlias(did: string, aliases: AliasMap): string | undefined {
  for (const [alias, aliasDid] of Object.entries(aliases)) {
    if (aliasDid === did) {
      return alias;
    }
  }

  return undefined;
}

/**
 * Format DID for display with optional alias
 * Returns: "alias" if alias exists, otherwise full DID
 */
export function formatDidWithAlias(did: string, aliases: AliasMap): string {
  const alias = reverseAlias(did, aliases);
  return alias || did;
}

/**
 * Format DID for detailed display with alias
 * Returns: "alias (did:...)" if alias exists, otherwise full DID
 */
export function formatDidWithAliasDetailed(
  did: string,
  aliases: AliasMap,
  truncate: boolean = false
): string {
  const alias = reverseAlias(did, aliases);

  if (alias) {
    if (truncate && did.length > 40) {
      const truncated = did.substring(0, 20) + '...' + did.substring(did.length - 10);
      return `${alias} (${truncated})`;
    }
    return `${alias} (${did})`;
  }

  if (truncate && did.length > 40) {
    return did.substring(0, 20) + '...' + did.substring(did.length - 10);
  }

  return did;
}

