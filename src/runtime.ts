// Where the simulator comes from:
// - repo mode: a v5-simulacrum (or v5-sim) checkout set up with setup.sh
//   (v5sim.repoPath, or found next to the workspace), for developers;
// - bundled mode: the runtime shipped inside this platform's .vsix
//   (runtime/runtime.tar.gz: headless QEMU, a standalone Python and the
//   simulator's scripts), unpacked on first start into ~/.v5-simulacrum
//   (inside WSL on Windows), with VEXos downloaded from VEX next to it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { Runner, isWindows } from './runner';
import { cfg, repoPath } from './settings';

import { DATA_DIR, Mode, bundledEnv, chooseMode, installScript, parseInstallOutput, parseWslList } from './runtimeCore';
export { DATA_DIR };

// ------------------------------------------------------------------ state

let context: vscode.ExtensionContext | undefined;
let log: vscode.OutputChannel | undefined;
let ready: Promise<Runner | undefined> | undefined;
let currentMode: Mode['kind'] = 'none';

export function initRuntime(ctx: vscode.ExtensionContext, out: vscode.OutputChannel): void {
  context = ctx;
  log = out;
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('v5sim.repoPath') || e.affectsConfiguration('v5sim.wslDistro')) ready = undefined;
  }));
}

export function bundledTarball(): string | undefined {
  if (!context) return undefined;
  const t = path.join(context.extensionPath, 'runtime', 'runtime.tar.gz');
  return fs.existsSync(t) ? t : undefined;
}

/** 'repo' | 'bundled' | 'none', as of the last simRunner() call. */
export function mode(): Mode['kind'] { return currentMode; }

/** The Runner for the simulator's scripts, setting the bundle up first if
 *  needed (once per session; force = reinstall). */
export function simRunner(force = false): Promise<Runner | undefined> {
  if (force || !ready) {
    ready = resolve(force).catch(e => {
      ready = undefined;
      vscode.window.showErrorMessage(`V5 simulator: ${(e as Error).message}`);
      log?.appendLine(`[v5sim] ${(e as Error).stack ?? e}`);
      return undefined;
    });
  }
  return ready;
}

async function resolve(force: boolean): Promise<Runner | undefined> {
  const distro = cfg().get<string>('wslDistro', 'Ubuntu-24.04');
  const tarball = bundledTarball();
  const m = chooseMode(await repoPath(false), tarball);
  currentMode = m.kind;
  if (m.kind === 'repo') return new Runner(m.repo, distro);
  if (m.kind === 'none') {
    // a runtime-free .vsix: ask for a checkout, as before
    const repo = await repoPath(true);
    if (repo) currentMode = 'repo';
    return repo ? new Runner(repo, distro) : undefined;
  }
  if (isWindows && !(await wslReady(distro))) return undefined;
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'V5 simulator', cancellable: false,
  }, async progress => {
    // a Runner just for setup: no root yet
    const setup = new Runner(path.dirname(m.tarball), distro);
    progress.report({ message: 'unpacking...' });
    const version = context?.extension.packageJSON.version ?? '0';
    const r = await setup.shell(installScript(await setup.toUnix(m.tarball), version, force), 180_000);
    log?.append(r.stdout + r.stderr);
    const paths = parseInstallOutput(r.stdout);
    if (r.code !== 0 || !paths) throw new Error(`couldn't unpack the simulator (${r.stderr.trim() || `exit ${r.code}`}); see V5 Sim: Show Log`);
    const { env, pathPrefix } = bundledEnv(paths);
    const unixRoot = `${paths.runtime}/sim`;
    const hostRoot = isWindows ? (await setup.exec(['wslpath', '-w', unixRoot])).stdout.trim() : unixRoot;
    const runner = new Runner(hostRoot, distro, { unixRoot, env, pathPrefix });
    progress.report({ message: 'checking VEXos (downloads it from VEX the first time)...' });
    const fw = await runner.runScript('fetch_firmware.sh', [], 300_000);
    log?.append(fw.stdout + fw.stderr);
    if (fw.code !== 0) {
      throw new Error(`couldn't get VEXos from VEX: ${lastLine(fw.stderr || fw.stdout)}. Check the internet connection, then V5 Sim: Repair Simulator`);
    }
    log?.appendLine(`[v5sim] bundled simulator ready: ${paths.runtime}`);
    return runner;
  });
}

function lastLine(s: string): string {
  return s.trim().split(/\r?\n/).pop() ?? '';
}

/** Windows: WSL and the distro must be there; offer to install them. */
async function wslReady(distro: string): Promise<boolean> {
  const { execFile } = await import('node:child_process');
  const list = await new Promise<string[] | undefined>(res =>
    execFile('wsl.exe', ['-l', '-q'], { encoding: 'buffer', windowsHide: true, timeout: 20_000 },
      (err, stdout) => res(err ? undefined : parseWslList(stdout as Buffer))));
  if (list?.some(d => d.toLowerCase() === distro.toLowerCase())) return true;
  const what = list ? `the WSL distribution ${distro}` : 'WSL (Windows Subsystem for Linux)';
  const pick = await vscode.window.showWarningMessage(
    `The V5 simulator runs in ${what}, which isn't installed. Install it once (Windows may ask for a restart, and Ubuntu asks for a user name and password), then start the simulator again.`,
    'Install', 'Use another distribution...');
  if (pick === 'Install') {
    const term = vscode.window.createTerminal({ name: 'Install WSL' });
    term.show();
    term.sendText(`wsl --install -d ${distro}`);
  } else if (pick) {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'v5sim.wslDistro');
  }
  return false;
}
