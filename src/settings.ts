import * as fs from 'node:fs';
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
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    for (const dir of [f.uri.fsPath, path.join(f.uri.fsPath, 'v5-sim'), path.join(path.dirname(f.uri.fsPath), 'v5-sim')]) {
      if (isRepo(dir)) return dir;
    }
  }
  if (!ask) return undefined;
  const pick = await vscode.window.showWarningMessage(
    'Where is your v5-sim checkout? (the folder with scripts/v5brain.sh)', 'Locate...');
  if (pick !== 'Locate...') return undefined;
  const dirs = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false,
    openLabel: 'Use this v5-sim checkout' });
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

export function viewUrl(port: number, page: '' | 'screen' | 'dashboard'): vscode.Uri {
  return vscode.Uri.parse(`http://localhost:${port}/${page}`);
}
