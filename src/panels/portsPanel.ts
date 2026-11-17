// The port map editor: a robot preset (.args) as the brain's 21 smart ports
// and its 3-wire ports. Edits stay in the pane until saved; "Apply & Restart"
// saves, makes it the v5sim.preset and restarts the simulator with it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { Issue, RobotConfig, options, parse, serialize, tokenize, validate } from '../robotConfig';
import { SimInstance } from '../simInstance';
import { mode, simRunner } from '../runtime';
import { cfg, presetFile, presetSetting } from '../settings';

interface Preset { label: string; description: string; file: string }

export class PortsPanel {
  private static current?: PortsPanel;

  static async open(context: vscode.ExtensionContext, sim: SimInstance, file?: string): Promise<void> {
    const repo = (await simRunner())?.repo;
    if (!repo) return;
    const target = file ?? presetFile(repo);
    if (PortsPanel.current) {
      PortsPanel.current.panel.reveal();
      if (file && file !== PortsPanel.current.file) await PortsPanel.current.openFile(file);
      return;
    }
    const panel = vscode.window.createWebviewPanel('v5sim.ports', 'V5 Ports',
      vscode.ViewColumn.Active, {
        enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      });
    PortsPanel.current = new PortsPanel(context, sim, repo, panel);
    await PortsPanel.current.openFile(fs.existsSync(target) ? target : undefined);
  }

  private file?: string;              // undefined: a new, unsaved preset
  private config: RobotConfig = parse('').config;
  private parseIssues: Issue[] = [];
  private originalText = '';
  private dirty = false;

  private constructor(private readonly context: vscode.ExtensionContext,
                      private readonly sim: SimInstance,
                      private readonly repo: string,
                      readonly panel: vscode.WebviewPanel) {
    panel.webview.html = this.html();
    panel.onDidDispose(() => (PortsPanel.current = undefined));
    panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e =>
      vscode.window.showErrorMessage(`V5 Ports: ${(e as Error).message}`)));
  }

  private load = (ref: string) => {
    try { return fs.readFileSync(path.join(this.repo, 'sim', ref), 'utf8'); } catch { return undefined; }
  };

  private async openFile(file: string | undefined): Promise<void> {
    if (this.dirty && !(await this.confirmDiscard())) { this.post(true); return; }
    this.file = file;
    this.originalText = file ? fs.readFileSync(file, 'utf8') : '';
    const parsed = parse(this.originalText, this.load);
    this.config = parsed.config;
    this.parseIssues = parsed.issues;
    this.dirty = false;
    this.post(true);
  }

  private async confirmDiscard(): Promise<boolean> {
    const pick = await vscode.window.showWarningMessage('Discard the unsaved port map changes?', { modal: true }, 'Discard');
    return pick === 'Discard';
  }

  private presets(): Preset[] {
    const out: Preset[] = [];
    const robots = path.join(this.repo, 'sim', 'robots');
    for (const f of safeReaddir(robots).filter(f => f.endsWith('.args')).sort()) {
      out.push({ label: path.basename(f, '.args'), description: 'v5-sim preset', file: path.join(robots, f) });
    }
    return out;
  }

  private post(reload: boolean): void {
    const issues = [...this.parseIssues, ...validate(this.config)];
    void this.panel.webview.postMessage({
      type: reload ? 'load' : 'update',
      config: this.config,
      issues,
      text: serialize(this.config),
      file: this.file ?? null,
      name: this.file ? path.basename(this.file) : 'untitled.args',
      dirty: this.dirty,
      presets: this.presets(),
      active: this.file ? path.resolve(presetFile(this.repo)) === path.resolve(this.file) : false,
    });
    this.panel.title = `V5 Ports: ${this.file ? path.basename(this.file, '.args') : 'untitled'}${this.dirty ? ' ●' : ''}`;
  }

  private async onMessage(m: any): Promise<void> {
    switch (m?.type) {
      case 'ready':
        this.post(true);
        break;
      case 'change':
        this.config = m.config;
        this.parseIssues = [];
        this.dirty = true;
        this.post(false);
        break;
      case 'extraText': {
        // free-form options: parse them like the file (device options among
        // them become ports)
        const config: RobotConfig = { ...m.config, extra: options(tokenize(m.text)) };
        const parsed = parse(serialize(config), this.load);
        this.config = parsed.config;
        this.parseIssues = parsed.issues;
        this.dirty = true;
        this.post(true);
        break;
      }
      case 'open': {
        if (m.file) { await this.openFile(m.file); break; }
        const picked = await vscode.window.showOpenDialog({ filters: { 'Robot preset': ['args'] },
          defaultUri: vscode.Uri.file(path.join(this.repo, 'sim', 'robots')) });
        if (picked?.[0]) await this.openFile(picked[0].fsPath);
        else this.post(true);
        break;
      }
      case 'new':
        await this.openFile(undefined);
        break;
      case 'save':
        await this.save(false);
        break;
      case 'saveAs':
        await this.save(true);
        break;
      case 'apply':
        if (await this.save(false)) await this.apply();
        break;
      case 'openText':
        if (this.file) await vscode.window.showTextDocument(vscode.Uri.file(this.file), { viewColumn: vscode.ViewColumn.Beside });
        break;
    }
  }

  /** Write the file. Returns false if nothing was saved. */
  private async save(as: boolean): Promise<boolean> {
    const errors = validate(this.config).filter(i => i.severity === 'error');
    if (errors.length) {
      const pick = await vscode.window.showWarningMessage(
        `The port map has ${errors.length} problem(s) the simulator will refuse: ${errors[0].message}`,
        { modal: true }, 'Save anyway');
      if (pick !== 'Save anyway') return false;
    }
    let file = as ? undefined : this.file;
    const shipped = file && path.dirname(path.resolve(file)) === path.resolve(this.repo, 'sim', 'robots');
    if (file && shipped && mode() === 'bundled') {
      // the bundled presets are replaced on each extension update
      file = undefined;
    } else if (file && shipped && this.dirty) {
      const pick = await vscode.window.showWarningMessage(
        `${path.basename(file)} is one of v5-sim's shipped presets. Overwrite it, or save a copy?`,
        { modal: true }, 'Overwrite', 'Save a copy...');
      if (!pick) return false;
      if (pick !== 'Overwrite') file = undefined;
    }
    if (!file) {
      const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.join(this.repo, 'sim', 'robots');
      const uri = await vscode.window.showSaveDialog({ filters: { 'Robot preset': ['args'] },
        defaultUri: vscode.Uri.file(path.join(base, this.file ? path.basename(this.file) : 'robot.args')) });
      if (!uri) return false;
      file = uri.fsPath;
    }
    const text = serialize(this.config);
    if (file === this.file && droppedComments(this.originalText)) {
      const key = 'v5sim.commentsWarned';
      if (!this.context.globalState.get(key)) {
        const pick = await vscode.window.showWarningMessage(
          'Saving rewrites the file from the port map: the comment block at the top is kept, comments further down are dropped.',
          { modal: true }, 'Save', "Save, don't ask again");
        if (!pick) return false;
        if (pick !== 'Save') await this.context.globalState.update(key, true);
      }
    }
    fs.writeFileSync(file, text);
    this.file = file;
    this.originalText = text;
    this.dirty = false;
    this.post(false);
    return true;
  }

  private async apply(): Promise<void> {
    if (!this.file) return;
    const value = presetSetting(this.repo, this.file);
    const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await cfg().update('preset', value, target);
    this.post(false);
    await (this.sim.state === 'stopped' ? this.sim.start() : this.sim.restart());
  }

  private html(): string {
    const w = this.panel.webview;
    const media = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media('ports.css')}">
<title>V5 Ports</title></head><body>
<header id="toolbar"></header>
<main>
  <section id="brain"><div id="grid"></div><div id="adi22"></div><div id="drive"></div></section>
  <section id="editor"></section>
</main>
<section id="bottom"></section>
<script nonce="${nonce}" src="${media('ports.js')}"></script>
</body></html>`;
  }
}

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

/** Whether the text has comments past its header (they don't survive a save). */
function droppedComments(text: string): boolean {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i].trim() === '' || lines[i].trim().startsWith('#'))) i++;
  return lines.slice(i).some(l => l.includes('#'));
}
