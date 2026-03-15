function normalizeCanonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeCanonicalJsonValue(entry));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => (
        leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
      ))
      .map(([key, entryValue]) => [key, normalizeCanonicalJsonValue(entryValue)]);
    return Object.fromEntries(entries);
  }

  return value;
}

export function stringifyCanonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalJsonValue(value));
}

export function encodeCanonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(stringifyCanonicalJson(value));
}

export function encodeLegacyJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function encodeJsonSignaturePayloads(value: unknown): Uint8Array[] {
  const canonical = encodeCanonicalJson(value);
  const legacy = encodeLegacyJson(value);

  if (
    canonical.length === legacy.length
    && canonical.every((entry, index) => entry === legacy[index])
  ) {
    return [canonical];
  }

  return [canonical, legacy];
}
