import { build } from 'esbuild';

await build({
  entryPoints: ['src/main/server.ts'],
  outdir: 'dist-server',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['sql.js', 'classic-level'],
  sourcemap: true,
});
