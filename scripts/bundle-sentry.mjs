// The packages are built with `vsce package --no-dependencies`, so the one
// runtime dependency (@sentry/core) is bundled into the file that uses it:
// out/src/errors/sentry.js, replacing what tsc wrote. Runs as vscode:prepublish.
import { build } from 'esbuild';

const file = 'out/src/errors/sentry.js';
const source = 'src/errors/sentry.ts';
await build({
  entryPoints: [source],          // from source: Sentry's ES modules, so unused parts drop out
  outfile: file,
  allowOverwrite: true,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',              // VS Code 1.85's extension host
  minify: true,
  sourcemap: false,
  legalComments: 'inline',       // keep the SDK's license notice
  logLevel: 'warning',
});
console.log(`bundled @sentry/core into ${file}`);
