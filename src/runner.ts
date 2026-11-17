// Runs v5-sim's bash scripts where the simulator lives: through wsl.exe from
// Windows, or directly when VS Code itself runs in WSL/Linux (Remote-WSL).
import { ChildProcess, execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const isWindows = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

/** The environment for the scripts. VS Code started from the macOS Dock gets
 *  a minimal PATH, without Homebrew (where the simulator's tools live). */
function scriptEnv(): NodeJS.ProcessEnv {
  if (!isMac) return process.env;
  const extra = ['/opt/homebrew/bin', '/usr/local/bin'];
  const path = (process.env.PATH ?? '/usr/bin:/bin').split(':');
  return { ...process.env, PATH: [...extra.filter(p => !path.includes(p)), ...path].join(':') };
}

/** POSIX shell quoting. */
export function sh(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** `K=V ... ` assignments in front of a command in bash -c (they reach the
 *  script in WSL too, where WSLENV wouldn't carry them). */
export function envPrefix(opts: RunnerOptions): string {
  const parts = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${sh(v)}`);
  if (opts.pathPrefix) parts.push(`PATH=${sh(opts.pathPrefix)}:"$PATH"`);
  return parts.length ? parts.join(' ') + ' ' : '';
}

export interface RunResult { code: number; stdout: string; stderr: string }

export interface RunnerOptions {
  /** the simulator's root as its Linux/macOS sees it (else toUnix(repo)) */
  unixRoot?: string;
  /** variables for the scripts (bundled mode) */
  env?: Record<string, string>;
  /** a folder put first on the scripts' PATH (the bundled Python) */
  pathPrefix?: string;
}

export class Runner {
  private unixRepo?: Promise<string>;

  /** repo: the simulator's root (scripts/, sim/) as this host sees it */
  constructor(readonly repo: string, readonly distro: string, readonly opts: RunnerOptions = {}) {}

  /** argv for running a shell command line in the simulator's Linux. */
  private argv(command: string): [string, string[]] {
    return isWindows
      ? ['wsl.exe', ['-d', this.distro, '-e', 'bash', '-c', command]]
      : ['bash', ['-c', command]];
  }

  /** A host path as the simulator sees it (wslpath on Windows). */
  async toUnix(p: string): Promise<string> {
    if (!isWindows) return path.resolve(p);
    const r = await this.exec(['wslpath', '-a', p]);
    if (r.code !== 0 || !r.stdout.trim()) {
      throw new Error(`wslpath couldn't convert ${p}: ${r.stderr.trim() || 'is WSL installed?'}`);
    }
    return r.stdout.trim();
  }

  repoUnix(): Promise<string> {
    if (this.opts.unixRoot) return Promise.resolve(this.opts.unixRoot);
    if (!this.unixRepo) {
      this.unixRepo = this.toUnix(this.repo);
      this.unixRepo.catch(() => (this.unixRepo = undefined));
    }
    return this.unixRepo;
  }

  async scriptCommand(script: string, args: string[]): Promise<string> {
    const repo = await this.repoUnix();
    return envPrefix(this.opts) + ['bash', `${repo}/scripts/${script}`, ...args].map(sh).join(' ');
  }

  /** Start a long-running script; output streams through the process. */
  async spawnScript(script: string, args: string[]): Promise<ChildProcess> {
    const [cmd, argv] = this.argv(await this.scriptCommand(script, args));
    return spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: scriptEnv() });
  }

  /** Run a script to completion. */
  async runScript(script: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
    return this.shell(await this.scriptCommand(script, args), timeoutMs);
  }

  /** Run argv (already split) in the simulator's Linux. */
  exec(argv: string[], timeoutMs = 30_000): Promise<RunResult> {
    return this.shell(argv.map(sh).join(' '), timeoutMs);
  }

  shell(command: string, timeoutMs = 30_000): Promise<RunResult> {
    const [cmd, argv] = this.argv(command);
    return new Promise(resolve => {
      execFile(cmd, argv, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20, env: scriptEnv() },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : '')) });
        });
    });
  }
}

/** usbip-win2's client, as the host sees it (Windows, or /mnt/c from WSL). */
export function usbipExe(): string | undefined {
  if (isMac) return undefined;
  const exe = isWindows
    ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'USBip', 'usbip.exe')
    : '/mnt/c/Program Files/USBip/usbip.exe';
  return fs.existsSync(exe) ? exe : undefined;
}

/** Whether a command is on the scripts' PATH (e.g. pros). */
export function onPath(command: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile(isWindows ? 'where' : 'sh', isWindows ? [command] : ['-c', `command -v ${sh(command)}`],
      { timeout: 10_000, windowsHide: true, env: scriptEnv() }, err => resolve(!err));
  });
}

/** The environment terminals for the sim's tools get (Homebrew on macOS). */
export function terminalEnv(): { [key: string]: string } | undefined {
  return isMac ? { PATH: scriptEnv().PATH ?? '' } : undefined;
}

/** Whether a V5 brain (USB 2888:0501) is already attached through usbip-win2:
 *  a second attach can crash its driver (see v5-sim's V5Sim.cmd). */
export function usbipBrainAttached(exe: string): Promise<boolean> {
  return new Promise(resolve => {
    execFile(exe, ['port'], { timeout: 10_000, windowsHide: true }, (_err, stdout) =>
      resolve(/2888:0501/i.test(String(stdout ?? ''))));
  });
}
