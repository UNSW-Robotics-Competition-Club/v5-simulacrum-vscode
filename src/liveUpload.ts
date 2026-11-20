// Run on Sim without a restart: install the program on the running brain
// and start it, through the brain's USB system port (the simulator's
// v5upload.py, via v5usb_share.py's upload socket). Works with or without
// the Windows USB driver, and on a Mac; a simulator started elsewhere too.
// Simulators from before the upload socket fall back to a restart.
import * as vscode from 'vscode';

import { Program, describe } from './programs';
import { Runner } from './runner';
import { Running, SimInstance } from './simInstance';

/** A big cold package or Python VM takes seconds; give up well after. */
const UPLOAD_TIMEOUT_MS = 3 * 60_000;

export type LiveResult = 'done' | 'unavailable' | 'failed';

/** The running instance's upload socket: from its instance line, else where
 *  v5brain.sh puts it for that instance id (one started elsewhere), if
 *  it's there (older simulators have none). */
async function uploadSocket(runner: Runner, target: Running): Promise<string | undefined> {
  const sock = target.uploadSock ?? (target.id === 0 ? '/tmp/v5usb-host.sock' : `/tmp/v5sim${target.id}/v5usb-host.sock`);
  const r = await runner.exec(['test', '-S', sock], 10_000);
  return r.code === 0 ? sock : undefined;
}

/** v5upload.py's exit status when nothing answers at the socket. */
const EXIT_NO_PORT = 3;

/** One upload at a time: a second would take the brain's port from the
 *  first mid-transfer (v5usb_share.py gives it to the newest uploader). */
let queue: Promise<unknown> = Promise.resolve();

export function runOnRunning(sim: SimInstance, program: Program, slot: number, log: vscode.OutputChannel): Promise<LiveResult> {
  const next = queue.then(() => upload(sim, program, slot, log));
  queue = next.catch(() => undefined);
  return next;
}

async function upload(sim: SimInstance, program: Program, slot: number, log: vscode.OutputChannel): Promise<LiveResult> {
  const target = sim.state === 'running' ? sim.current : undefined;
  if (!target) return 'unavailable';
  const runner = await sim.runner();
  if (!runner) return 'unavailable';
  const sock = await uploadSocket(runner, target);
  if (!sock) {
    log.appendLine(`[v5sim] instance ${target.id} has no upload socket (an older simulator): restarting it with the program`);
    return 'unavailable';
  }
  const args = [sock, await runner.stage(program.file), '--slot', String(slot)];
  if (program.kind !== 'bin') args.push('--link', await runner.stage(program.link));
  const command = await runner.pythonCommand('v5upload.py', args);
  log.appendLine(`> v5upload.py ${args.join(' ')}`);
  const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
    title: `Running ${describe(program)} on the simulator (slot ${slot})` }, async progress => {
    let shown = 0;
    return runner.shellLines(command, line => {
      log.appendLine(`[v5upload] ${line}`);
      const m = /^upload (\S+) (\d+)\/(\d+)$/.exec(line);
      if (!m) return;
      const pct = Math.floor((100 * +m[2]) / Math.max(1, +m[3]));
      progress.report({ message: `${m[1]} ${pct}%`, increment: pct < shown ? 0 : pct - shown });
      shown = pct >= 100 ? 0 : pct;            // the next file starts over
    }, UPLOAD_TIMEOUT_MS);
  });
  if (r.code === 0) return 'done';
  log.appendLine(`[v5upload] ${r.code === EXIT_NO_PORT ? 'no answer' : 'failed'}: ${r.stderr.trim() || `exit ${r.code}`}`);
  // nothing at the socket (a stale one, an older simulator): restart instead
  return r.code === EXIT_NO_PORT ? 'unavailable' : 'failed';
}
