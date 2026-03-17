#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function parseArg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalize(report) {
  return report.results.map((result) => ({
    subject: result.subject,
    id: result.id,
    actual: result.actual,
  }));
}

const jsPath = parseArg('--js');
const rustPath = parseArg('--rust');

if (!jsPath || !rustPath) {
  throw new Error('Usage: compare-results.mjs --js <path> --rust <path>');
}

const [jsReport, rustReport] = await Promise.all([
  readFile(jsPath, 'utf8').then(JSON.parse),
  readFile(rustPath, 'utf8').then(JSON.parse),
]);

assert.deepEqual(normalize(jsReport), normalize(rustReport));
process.stdout.write('Conformance outputs match.\n');
