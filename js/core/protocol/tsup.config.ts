import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  shims: true,
  noExternal: [],
  external: [
    'ws',
    'better-sqlite3',
    'level',
    'classic-level',
    /^node:.*/,  // All Node.js built-in modules
  ],
});
