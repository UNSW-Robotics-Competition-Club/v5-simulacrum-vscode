import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export function cfg() {
  return vscode.workspace.getConfiguration('v5sim');
}

const isRepo = (dir: string) => fs.existsSync(path.join(dir, 'scripts', 'v5brain.sh'));

/** The v5-sim checkout: the setting, else a workspace folder holding it
 *  (or its parent's v5-sim folder), else ask for it once. */
export async function repoPath(ask = true): Promise<string | undefined> {
  const set = cfg().get<string>('repoPath', '').trim();
  if (set) {
    if (isRepo(set)) return set;
    if (!ask) return undefined;
    vscode.window.showErrorMessage(`v5sim.repoPath (${set}) has no scripts/v5brain.sh.`);
  }
  const names = ['v5-simulacrum', 'v5-sim'];
  const candidates: string[] = [];
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    candidates.push(f.uri.fsPath);
    for (const n of names) candidates.push(path.join(f.uri.fsPath, n), path.join(path.dirname(f.uri.fsPath), n));
  }
  // a clone in the home folder (a Mac, or VS Code in WSL)
  if (process.platform !== 'win32') for (const n of names) candidates.push(path.join(os.homedir(), n));
  for (const dir of candidates) if (isRepo(dir)) return dir;
  if (!ask) return undefined;
  const pick = await vscode.window.showWarningMessage(
    'Where is your v5-simulacrum (or v5-sim) checkout? (the folder with scripts/v5brain.sh)', 'Locate...');
  if (pick !== 'Locate...') return undefined;
  const dirs = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false,
    openLabel: 'Use this simulator checkout' });
  const dir = dirs?.[0]?.fsPath;
  if (!dir) return undefined;
  if (!isRepo(dir)) {
    vscode.window.showErrorMessage(`${dir} has no scripts/v5brain.sh.`);
    return undefined;
  }
  await cfg().update('repoPath', dir, vscode.ConfigurationTarget.Global);
  return dir;
}

/** A host path for the preset setting: a name in sim/robots/ or a path
 *  (relative ones from the first workspace folder). */
export function presetFile(repo: string, preset = cfg().get<string>('preset', 'competition')): string {
  const p = preset.trim() || 'competition';
  if (/[\\/]/.test(p) || p.endsWith('.args')) {
    if (path.isAbsolute(p)) return p;
    const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? repo;
    return path.resolve(base, p);
  }
  return path.join(repo, 'sim', 'robots', `${p}.args`);
}

/** What to store in v5sim.preset for a file: its name if it's a shipped one. */
export function presetSetting(repo: string, file: string): string {
  const robots = path.join(repo, 'sim', 'robots');
  return path.dirname(path.resolve(file)) === path.resolve(robots) ? path.basename(file, '.args') : file;
}

/** v5sim.slot, kept to 1..8 (settings.json can hold anything). */
export function slotSetting(): number {
  const n = Math.trunc(Number(cfg().get<number>('slot', 1)));
  return n >= 1 && n <= 8 ? n : 1;
}

/** A WSL distribution name, as wsl.exe -d takes it (it also goes into a
 *  terminal command line, so nothing else gets through). */
export function wslDistro(): string | undefined {
  const d = cfg().get<string>('wslDistro', 'Ubuntu-24.04').trim();
  return /^[\w.-]+$/.test(d) ? d : undefined;
}

export function viewUrl(port: number, page: '' | 'screen' | 'dashboard' | 'controller'): vscode.Uri {
  return vscode.Uri.parse(`http://localhost:${port}/${page}`);
}
