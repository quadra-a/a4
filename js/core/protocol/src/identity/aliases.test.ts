/**
 * Unit tests for alias functions (CVP-0014)
 */

import { describe, it, expect } from 'vitest';
import {
  validateAliasName,
  resolveDid,
  reverseAlias,
  formatDidWithAlias,
  formatDidWithAliasDetailed,
  type AliasMap,
} from './aliases.js';

describe('validateAliasName', () => {
  it('should accept valid lowercase alphanumeric aliases', () => {
    expect(validateAliasName('translator').valid).toBe(true);
    expect(validateAliasName('gpu-worker').valid).toBe(true);
    expect(validateAliasName('agent123').valid).toBe(true);
    expect(validateAliasName('my-agent-2').valid).toBe(true);
  });

  it('should reject empty aliases', () => {
    const result = validateAliasName('');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('empty');
  });

  it('should reject aliases longer than 32 characters', () => {
    const result = validateAliasName('a'.repeat(33));
    expect(result.valid).toBe(false);
    expect(result.error).toContain('32 characters');
  });

  it('should reject aliases starting with "did:"', () => {
    const result = validateAliasName('did:agent:abc');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('did:');
  });

  it('should reject aliases with uppercase letters', () => {
    const result = validateAliasName('MyAgent');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('lowercase');
  });

  it('should reject aliases with special characters', () => {
    expect(validateAliasName('agent_123').valid).toBe(false);
    expect(validateAliasName('agent@123').valid).toBe(false);
    expect(validateAliasName('agent.123').valid).toBe(false);
    expect(validateAliasName('agent 123').valid).toBe(false);
  });

  it('should reject aliases starting with hyphen', () => {
    const result = validateAliasName('-agent');
    expect(result.valid).toBe(false);
  });

  it('should accept aliases ending with hyphen', () => {
    expect(validateAliasName('agent-').valid).toBe(true);
  });

  it('should accept single character aliases', () => {
    expect(validateAliasName('a').valid).toBe(true);
    expect(validateAliasName('1').valid).toBe(true);
  });
});

describe('resolveDid', () => {
  const aliases: AliasMap = {
    'translator': 'did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
    'reviewer': 'did:agent:z6Mkk7yqnGF3YwTrLpqrW6PGsKci7dGb6rkBfHSGRJSwJ8tD',
    'gpu-worker': 'did:agent:z6MkpTHR8VNs5nt1aFMwNEVqFPRrRUE7dprGEYqgLTz5kqVn',
  };

  it('should return DID as-is if input starts with "did:"', () => {
    const did = 'did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    expect(resolveDid(did, aliases)).toBe(did);
  });

  it('should resolve alias to DID', () => {
    expect(resolveDid('translator', aliases)).toBe(
      'did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
    );
    expect(resolveDid('reviewer', aliases)).toBe(
      'did:agent:z6Mkk7yqnGF3YwTrLpqrW6PGsKci7dGb6rkBfHSGRJSwJ8tD'
    );
    expect(resolveDid('gpu-worker', aliases)).toBe(
      'did:agent:z6MkpTHR8VNs5nt1aFMwNEVqFPRrRUE7dprGEYqgLTz5kqVn'
    );
  });

  it('should return undefined for unknown alias', () => {
    expect(resolveDid('unknown-agent', aliases)).toBeUndefined();
  });

  it('should return undefined for empty input', () => {
    expect(resolveDid('', aliases)).toBeUndefined();
  });

  it('should work with empty alias map', () => {
    const did = 'did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    expect(resolveDid(did, {})).toBe(did);
    expect(resolveDid('translator', {})).toBeUndefined();
  });
});

describe('reverseAlias', () => {
  const aliases: AliasMap = {
    'translator': 'did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
    'reviewer': 'did:agent:z6Mkk7yqnGF3YwTrLpqrW6PGsKci7dGb6rkBfHSGRJSwJ8tD',
    'gpu-worker': 'did:agent:z6MkpTHR8VNs5nt1aFMwNEVqFPRrRUE7dprGEYqgLTz5kqVn',
  };

  it('should find alias for DID', () => {
    expect(
      reverseAlias('did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', aliases)
    ).toBe('translator');
    expect(
      reverseAlias('did:agent:z6Mkk7yqnGF3YwTrLpqrW6PGsKci7dGb6rkBfHSGRJSwJ8tD', aliases)
    ).toBe('reviewer');
  });

  it('should return undefined for DID without alias', () => {
    expect(
      reverseAlias('did:agent:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH', aliases)
    ).toBeUndefined();
  });

  it('should return undefined for empty alias map', () => {
    expect(
      reverseAlias('did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', {})
    ).toBeUndefined();
  });

  it('should return first matching alias if multiple aliases point to same DID', () => {
    const duplicateAliases: AliasMap = {
      'translator': 'did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      'translator2': 'did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
    };
    const result = reverseAlias(
      'did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      duplicateAliases
    );
    expect(['translator', 'translator2']).toContain(result);
  });
});

describe('formatDidWithAlias', () => {
  const aliases: AliasMap = {
    'translator': 'did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
  };

  it('should return alias if exists', () => {
    expect(
      formatDidWithAlias('did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', aliases)
    ).toBe('translator');
  });

  it('should return full DID if no alias exists', () => {
    const did = 'did:agent:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';
    expect(formatDidWithAlias(did, aliases)).toBe(did);
  });

  it('should work with empty alias map', () => {
    const did = 'did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    expect(formatDidWithAlias(did, {})).toBe(did);
  });
});

describe('formatDidWithAliasDetailed', () => {
  const aliases: AliasMap = {
    'translator': 'did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
  };

  it('should return "alias (did)" format if alias exists', () => {
    expect(
      formatDidWithAliasDetailed(
        'did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        aliases
      )
    ).toBe('translator (did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK)');
  });

  it('should return full DID if no alias exists', () => {
    const did = 'did:agent:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';
    expect(formatDidWithAliasDetailed(did, aliases)).toBe(did);
  });

  it('should truncate long DIDs when truncate=true and alias exists', () => {
    const result = formatDidWithAliasDetailed(
      'did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
      aliases,
      true
    );
    expect(result).toContain('translator');
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(70);
  });

  it('should truncate long DIDs when truncate=true and no alias exists', () => {
    const did = 'did:agent:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH';
    const result = formatDidWithAliasDetailed(did, aliases, true);
    expect(result).toContain('...');
    expect(result.length).toBeLessThan(did.length);
  });

  it('should not truncate short DIDs', () => {
    const shortDid = 'did:example:123';
    expect(formatDidWithAliasDetailed(shortDid, aliases, true)).toBe(shortDid);
  });

  it('should work with empty alias map', () => {
    const did = 'did:agent:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
    expect(formatDidWithAliasDetailed(did, {})).toBe(did);
  });
});
