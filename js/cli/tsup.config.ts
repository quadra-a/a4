import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  shims: true,
  noExternal: ['@quadra-a/protocol'],
  external: [
    'classic-level',
    'level',
    'abstract-level',
    'level-transcoder',
    'ws',
    'better-sqlite3',
    /^node:.*/,  // All Node.js built-in modules
  ],
});
