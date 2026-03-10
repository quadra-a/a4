import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  noExternal: ['@quadra-a/protocol'],
  external: [
    'level',
    'classic-level',
    'cbor-x',
    /^node:.*/,
  ],
});
