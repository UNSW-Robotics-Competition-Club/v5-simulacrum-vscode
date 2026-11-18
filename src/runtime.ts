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
import { repoPath, wslDistro } from './settings';
import { fetchRuntime, runtimePlatform } from './runtimeDownload';

import { DATA_DIR, Mode, UnpackProgress, bundledEnv, chooseMode, installScript, parseInstallOutput, parseWslList } from './runtimeCore';
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
    // Only a Runner is kept: a setup that stopped short (WSL not installed
    // yet, the checkout prompt dismissed) runs again on the next start.
    const p: Promise<Runner | undefined> = resolve(force).then(r => {
      if (!r && ready === p) ready = undefined;
      return r;
    }, e => {
      if (ready === p) ready = undefined;
      vscode.window.showErrorMessage(`V5 simulator: ${(e as Error).message}`);
      log?.appendLine(`[v5sim] ${(e as Error).stack ?? e}`);
      return undefined;
    });
    ready = p;
  }
  return ready;
}

async function resolve(force: boolean): Promise<Runner | undefined> {
  const distro = wslDistro() ?? '';         // not used off Windows
  if (isWindows && !distro) {
    throw new Error('v5sim.wslDistro must be a WSL distribution name (letters, digits, ".", "-", "_"), e.g. Ubuntu-24.04');
  }
  const tarball = bundledTarball();
  const m = chooseMode(await repoPath(false), tarball);
  currentMode = m.kind;
  if (m.kind === 'repo') return new Runner(m.repo, distro);
  // no simulator in this .vsix (the platform-neutral package): download the
  // one for this computer from the extension's releases
  const plat = runtimePlatform(process.platform, process.arch);
  if (m.kind === 'none' && !plat) {
    throw new Error(`there's no simulator for ${process.platform} ${process.arch} (Windows x64 with WSL, and Macs, are supported)`);
  }
  currentMode = 'bundled';
  if (isWindows && !(await wslReady(distro))) return undefined;
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'V5 simulator', cancellable: false,
  }, async progress => {
    const steps = stepper(progress);
    const version = context?.extension.packageJSON.version ?? '0';
    let tarball: string;
    let base = 0;                               // the bar's part done before unpacking
    if (m.kind === 'bundled') {
      tarball = m.tarball;
    } else {
      steps.step('downloading the simulator (once)...');
      log?.show(true);
      let tenth = 0;
      const mb = (n: number) => (n / 1e6).toFixed(0);
      tarball = await fetchRuntime(path.join(context!.globalStorageUri.fsPath, 'runtime'), version, plat!,
        (got, total) => {
          const f = total ? got / total : 0;
          steps.update(`downloading the simulator (once): ${mb(got)}${total ? ` of ${mb(total)}` : ''} MB...`, f * DOWNLOAD_SHARE);
          if (Math.floor(f * 10) > tenth) { tenth = Math.floor(f * 10); log?.appendLine(`[v5sim]   ${tenth * 10}%: ${mb(got)} MB`); }
        }, line => log?.appendLine(line))
        .catch((e: Error) => {
          throw new Error(`couldn't download the simulator (${e.message}). Check the internet connection, then V5 Sim: Repair Simulator`);
        });
      log?.appendLine(`[v5sim] downloaded in ${steps.end()} s: ${tarball}`);
      base = DOWNLOAD_SHARE;
    }
    // a Runner just for setup: no root yet
    const setup = new Runner(path.dirname(tarball), distro);
    steps.step('getting the simulator ready...', base);
    const unpack = new UnpackProgress();
    const tail: string[] = [];                  // the last lines, for an error
    log?.appendLine(`[v5sim] setting up the bundled simulator ${version}`);
    let logged = 0;                             // the last tenth logged
    const t0 = Date.now();
    const r = await setup.shellLines(installScript(await setup.toUnix(tarball), version, force), line => {
      tail.push(line);
      if (tail.length > 5) tail.shift();
      if (!unpack.feed(line)) { log?.appendLine(line); return; }
      if (unpack.done === 0) {
        // the first start after an install or update: show the log too
        log?.appendLine(`[v5sim] unpacking the simulator: ${unpack.total} files (once per install or update)`);
        log?.show(true);
        steps.step('unpacking the simulator (once per install or update)...', base);
        logged = 0;
        return;
      }
      const tenth = Math.floor(unpack.fraction * 10);
      if (tenth > logged) {
        logged = tenth;
        log?.appendLine(`[v5sim]   ${tenth * 10}%: ${unpack.done} of ${unpack.total} files, ${Math.round((Date.now() - t0) / 1000)} s`);
      }
      steps.update(`unpacking the simulator (once per install or update): ${unpack.done} of ${unpack.total} files...`,
        base + unpack.fraction * (UNPACK_SHARE - base));
    }, UNPACK_TIMEOUT_MS);
    if (r.stderr) log?.append(r.stderr);
    const unpacked = steps.end();
    if (unpack.total) log?.appendLine(`[v5sim] unpacked ${unpack.done} files in ${unpacked} s`);
    const paths = parseInstallOutput(r.stdout);
    if (r.code !== 0 || !paths) {
      const why = r.stderr.trim() || tail.filter(l => l.startsWith('F ')).pop()?.slice(2) || `exit ${r.code}`;
      throw new Error(`couldn't unpack the simulator (${why}); see V5 Sim: Show Log`);
    }
    const { env, pathPrefix } = bundledEnv(paths);
    const unixRoot = `${paths.runtime}/sim`;
    const hostRoot = isWindows ? (await setup.exec(['wslpath', '-w', unixRoot])).stdout.trim() : unixRoot;
    const runner = new Runner(hostRoot, distro, { unixRoot, env, pathPrefix });
    steps.step('checking VEXos (downloads it from VEX the first time)...', UNPACK_SHARE);
    log?.appendLine('[v5sim] checking VEXos (downloads it from VEX the first time)');
    const fw = await runner.runScript('fetch_firmware.sh', [], 300_000);
    log?.append(fw.stdout + fw.stderr);
    log?.appendLine(`[v5sim] VEXos checked in ${steps.end()} s`);
    if (fw.code !== 0) {
      throw new Error(`couldn't get VEXos from VEX: ${lastLine(fw.stderr || fw.stdout)}. Check the internet connection, then V5 Sim: Repair Simulator`);
    }
    log?.appendLine(`[v5sim] bundled simulator ready: ${paths.runtime}`);
    return runner;
  });
}

/** Unpacking may take minutes where every new file is scanned (antivirus on
 *  a managed Mac or PC). */
const UNPACK_TIMEOUT_MS = 600_000;
/** The progress bar: a download (when there is one) fills it to
 *  DOWNLOAD_SHARE, unpacking to UNPACK_SHARE, checking VEXos the rest. */
const DOWNLOAD_SHARE = 0.35;
const UNPACK_SHARE = 0.8;

type Progress = vscode.Progress<{ message?: string; increment?: number }>;

/** Progress messages with the seconds so far, refreshed every second, so a
 *  slow step visibly moves; the bar is filled to a fraction (0..1). */
function stepper(progress: Progress) {
  let text = '';
  let started = Date.now();
  let filled = 0;          // percent reported so far
  let target = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const show = () => {
    const increment = Math.max(0, Math.round(target * 100) - filled);
    filled += increment;
    progress.report({ message: `${text} (${Math.round((Date.now() - started) / 1000)} s)`, increment });
  };
  return {
    /** A new step: its text, the timer from 0, the bar at least at fraction. */
    step(t: string, fraction = target) {
      text = t;
      target = Math.max(target, fraction);
      started = Date.now();
      clearInterval(timer);
      show();
      timer = setInterval(show, 1_000);
    },
    /** New text and fraction, shown at the next refresh. */
    update(t: string, fraction = target) {
      text = t;
      target = Math.max(target, fraction);
    },
    /** Stop refreshing; the step's seconds. */
    end(): number {
      clearInterval(timer);
      timer = undefined;
      return Math.round((Date.now() - started) / 1000);
    },
  };
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
