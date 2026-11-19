// End-to-end check of automatic error reports through VS Code's real
// telemetry path. VS Code never sends extension telemetry during extension
// tests (it only logs it), so this opens a downloaded VS Code with V5 Sim
// and test/e2e/probe loaded but no test runner. The probe sends reports,
// switches reporting off two ways and quits; a fake Sentry records what
// arrives.
//   npx tsc -p . && npm run vscode:prepublish && node out/test/e2e/runErrorReports.js
// (vscode:prepublish bundles Sentry as the package does; E2E_VSCODE picks the version.)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

import { startFakeSentry } from './fakeSentry';

const QUIT_TIMEOUT_MS = 120_000;

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..', '..', '..');
  const probe = path.join(root, 'test', 'e2e', 'probe');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'v5sim-errors-'));
  const out = path.join(work, 'probe.txt');
  const sentry = await startFakeSentry();
  try {
    const exe = await downloadAndUnzipVSCode(process.env.E2E_VSCODE ?? 'stable');
    const code = await new Promise<number | null>((resolve, reject) => {
      const p = spawn(exe, [
        work,
        `--extensionDevelopmentPath=${root}`,
        `--extensionDevelopmentPath=${probe}`,
        '--disable-extensions',
        `--user-data-dir=${path.join(work, 'user')}`,
        `--extensions-dir=${path.join(work, 'extensions')}`,
        '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window',
      ], { env: { ...process.env, V5SIM_SENTRY_DSN: sentry.dsn, PROBE_OUT: out }, stdio: 'ignore' });
      const timer = setTimeout(() => { p.kill(); reject(new Error('VS Code did not quit')); }, QUIT_TIMEOUT_MS);
      p.on('exit', c => { clearTimeout(timer); resolve(c); });
      p.on('error', reject);
    });
    const steps = fs.readFileSync(out, 'utf8');
    console.log(`VS Code exited ${code}; probe:\n${steps}`);
    assert.match(steps, /done$/, 'probe finished');

    const events = sentry.events();
    assert.equal(events.length, 2, `two reports, none while switched off (got ${events.map(e => e.exception?.values?.[0]?.value)})`);
    const [start, setup] = events;
    const home = os.homedir();
    assert.equal(start.tags.stage, 'start');
    assert.equal(start.exception.values[0].type, 'V5Sim start failed');
    // VS Code's own cleaning may take the path out before ours does
    assert.match(start.exception.values[0].value,
      /^probe: the simulator never said which instance it is \((~[\\/]robot|<REDACTED: user-file-path>)\)$/);
    assert.equal(start.tags.os, process.platform);
    assert.match(start.tags.vscode, /^\d+\.\d+\.\d+/);
    assert.match(start.release, /^v5sim-vscode@\d+\.\d+\.\d+/);
    assert.equal(typeof start.extra?.log, 'string', 'a failed start carries the log tail');
    assert.equal(setup.extra?.log, undefined, 'other reports do not');
    assert.deepEqual(setup.fingerprint.slice(0, 2), ['setup', 'Error']);
    const text = JSON.stringify(events);
    assert.ok(!text.toLowerCase().includes(home.toLowerCase()), 'home folder never sent');
    assert.ok(!text.toLowerCase().includes(os.hostname().toLowerCase()), 'computer name never sent');
    assert.ok(!text.includes(os.userInfo().username + '\\') && !text.includes(`/${os.userInfo().username}/`), 'user name never sent');
    for (const e of events) {
      assert.equal(e.server_name, undefined);
      assert.equal(e.user, undefined);
      for (const f of e.exception.values[0].stacktrace?.frames ?? []) {
        assert.ok(f.in_app ? f.filename.startsWith('app:///') : !/[\\/]/.test(f.filename ?? ''), JSON.stringify(f));
      }
    }
    // VS Code blanks every path in error telemetry; ours must still name our own files
    const startFrames: any[] = start.exception.values[0].stacktrace.frames;
    assert.ok(startFrames.some(f => f.in_app && f.filename === 'app:///out/src/errors/errorReporting.js'), JSON.stringify(startFrames));
    assert.ok(!JSON.stringify(startFrames).includes('REDACTED'), JSON.stringify(startFrames));
    const setupFrames: any[] = setup.exception.values[0].stacktrace.frames;
    // (the probe sits inside this repo, so its file counts as ours here)
    assert.ok(setupFrames.some(f => f.filename === 'app:///test/e2e/probe/extension.js'), JSON.stringify(setupFrames));
    console.log('start frames:', startFrames.map(f => `${f.filename}:${f.lineno}`).join(' <- '));
    console.log('ERROR REPORTS OK');
  } finally {
    sentry.close();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
