import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import type { VectorManifest } from './types.js';
import { EncryptionError } from '../utils/errors.js';

export function validateVectorManifest(data: unknown, schema: object): data is VectorManifest {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (!valid) {
    throw new EncryptionError('Invalid vector manifest', validate.errors ?? []);
  }

  return true;
}

export async function loadVectorManifest(manifestPath: string, schemaPath: string): Promise<VectorManifest> {
  const [manifestJson, schemaJson] = await Promise.all([
    readFile(manifestPath, 'utf8'),
    readFile(schemaPath, 'utf8'),
  ]);

  const manifest = JSON.parse(manifestJson) as unknown;
  const schema = JSON.parse(schemaJson) as object;
  validateVectorManifest(manifest, schema);
  return manifest as VectorManifest;
}
