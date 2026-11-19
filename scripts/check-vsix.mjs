// Checks that each packaged .vsix carries a working error reporter: its
// out/src/errors/sentry.js must load and send without node_modules (the
// packages are built with --no-dependencies, so @sentry/core has to be
// bundled into it). A broken bundle would otherwise only turn reporting off,
// silently, in every install.
//   node scripts/check-vsix.mjs dist/*.vsix
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: check-vsix.mjs <file.vsix>...');
  process.exit(2);
}

let failed = 0;
for (const vsix of files) {
  try {
    // a folder with no node_modules anywhere above it that could help
    const dir = mkdtempSync(path.join(tmpdir(), 'v5sim-vsix-'));
    const unzip = spawnSync('unzip', ['-p', vsix, 'extension/out/src/errors/sentry.js'], { maxBuffer: 64 * 1024 * 1024 });
    if (unzip.status !== 0 || !unzip.stdout.length) throw new Error(`no out/src/errors/sentry.js (${unzip.stderr})`);
    const file = path.join(dir, 'sentry.js');
    writeFileSync(file, unzip.stdout);
    const src = unzip.stdout.toString('utf8');
    if (/require\(["']@sentry\//.test(src)) throw new Error('sentry.js still requires @sentry/*: not bundled');

    const { createSentry } = createRequire(file)(file);
    const sent = [];
    const sentry = createSentry({
      dsn: 'https://key@o1.ingest.example.invalid/1', release: 'check', environment: 'check',
      beforeSend: e => e,
      fetchFn: async (_url, init) => { sent.push(String(init.body)); return new Response('{}'); },
    });
    sentry.capture(new Error('vsix check'));
    await sentry.flush(5000);
    if (sent.length !== 1 || !sent[0].includes('vsix check')) throw new Error('nothing sent');
    console.log(`ok   ${vsix}: bundled error reporter loads and sends (${(unzip.stdout.length / 1024).toFixed(0)} KB)`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${vsix}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
