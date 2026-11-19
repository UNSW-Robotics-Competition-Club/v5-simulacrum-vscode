// V5 Sim: Report a Problem. A form (media/feedback.*) for a bug, idea or
// question; with the user's say-so it adds the V5 Sim log, the environment
// and a project folder. The bundle goes to the feedback Worker
// (v5sim.feedbackEndpoint); when that's not set or fails, it's saved as a zip
// and a prefilled GitHub issue opens.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { mode } from '../runtime';
import { cfg } from '../settings';
import { SimInstance } from '../simInstance';
import { LogBuffer } from './logBuffer';
import { ProjectRead, ProjectScan, readProjectFiles, scanProject } from './projectFiles';
import { FeedbackForm, Report, buildReport, bundleEntries, githubIssueUrl, readForm, redact, redactValue } from './report';
import { SubmitError, submitReport } from './submit';
import { zip } from './zip';
import { reportError } from '../errors/errorReporting';

const ISSUES_REPO = 'https://github.com/UNSW-Robotics-Competition-Club/v5-simulacrum-vscode';

export interface FeedbackDeps {
  context: vscode.ExtensionContext;
  sim: SimInstance;
  log: LogBuffer;
}

/** What the webview shows of a project scan. */
/** A report's contents, collected once and zipped for sending or saving. */
interface Parts { report: Report; log: string | undefined; project: ProjectRead | undefined }

interface ScanView { folder: string; files: { rel: string; size: number }[]; skipped: { rel: string; reason: string }[];
  totalBytes: number }

export class FeedbackPanel {
  private static current?: FeedbackPanel;

  static open(deps: FeedbackDeps, initial?: Partial<FeedbackForm>): void {
    if (FeedbackPanel.current) { FeedbackPanel.current.panel.reveal(); return; }
    const panel = vscode.window.createWebviewPanel('v5sim.feedback', 'V5 Sim: Report a Problem',
      vscode.ViewColumn.Active, {
        enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(deps.context.extensionUri, 'media')],
      });
    FeedbackPanel.current = new FeedbackPanel(deps, panel, initial ?? {});
  }

  /** Folders the user may send: the workspace's and any they picked. Only
   *  these are accepted back from the webview. */
  private readonly folders = new Map<string, string>();
  private folder?: string;
  private scan?: Promise<ProjectScan>;
  private busy = false;

  private constructor(private readonly deps: FeedbackDeps, readonly panel: vscode.WebviewPanel,
                      private readonly initial: Partial<FeedbackForm>) {
    for (const f of vscode.workspace.workspaceFolders ?? []) this.folders.set(f.uri.fsPath, f.name);
    const active = vscode.window.activeTextEditor?.document.uri;
    this.folder = (active && vscode.workspace.getWorkspaceFolder(active)?.uri.fsPath) ?? this.folders.keys().next().value;
    panel.webview.html = this.html();
    panel.onDidDispose(() => (FeedbackPanel.current = undefined));
    panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => {
      reportError('feedback', e);
      this.busy = false;
      this.post({ type: 'error', message: (e as Error).message });
    }));
  }

  private post(m: unknown): void { void this.panel.webview.postMessage(m); }

  /** The current folder's scan (started once per folder). */
  private scanFolder(): Promise<ProjectScan> | undefined {
    if (!this.folder) return undefined;
    this.scan ??= scanProject(this.folder);
    return this.scan;
  }

  /** Sends the current folder's scan, unless the folder changed meanwhile. */
  private async postScan(): Promise<void> {
    const folder = this.folder;
    const scan = await this.scanFolder();
    if (folder !== this.folder) return;
    const view: ScanView | null = scan ? {
      folder: scan.root,
      files: scan.files.map(f => ({ rel: f.rel, size: f.size })),
      skipped: scan.skipped,
      totalBytes: scan.totalBytes,
    } : null;
    this.post({ type: 'scan', scan: view });
  }

  private async onMessage(m: any): Promise<void> {
    switch (m?.type) {
      case 'ready':
        this.post({ type: 'init', initial: this.initial,
          folders: [...this.folders].map(([p, name]) => ({ path: p, name })), folder: this.folder ?? null,
          endpoint: endpointHost() ?? null });
        break;
      case 'scan':                              // the project box was ticked, or the folder changed
        if (typeof m.folder === 'string' && this.folders.has(m.folder) && m.folder !== this.folder) {
          this.folder = m.folder;
          this.scan = undefined;
        }
        await this.postScan();
        break;
      case 'pickFolder': {
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false,
          openLabel: 'Include this project folder' });
        const dir = picked?.[0]?.fsPath;
        if (dir) {
          this.folders.set(dir, path.basename(dir));
          this.folder = dir;
          this.scan = undefined;
        }
        this.post({ type: 'folders', folders: [...this.folders].map(([p, name]) => ({ path: p, name })),
          folder: this.folder ?? null });
        await this.postScan();
        break;
      }
      case 'showLog':
        void vscode.commands.executeCommand('v5sim.showLog');
        break;
      case 'submit':
        await this.submit(m.form);
        break;
    }
  }

  private async submit(raw: unknown): Promise<void> {
    if (this.busy) return;
    const form = readForm(raw);
    if (typeof form === 'string') { this.post({ type: 'error', message: form }); return; }
    if (form.includeProject && !this.folder) {
      this.post({ type: 'error', message: 'Choose a project folder, or untick "Include my project".' });
      return;
    }
    this.busy = true;                // until the end, dialogs included: no second report
    try {
      this.post({ type: 'progress', message: 'Packing the report…' });
      const parts = await this.collect(form);
      const { report } = parts;
      const bundle = zip(bundleEntries(parts.report, parts.log, parts.project));
      const url = endpoint();
      let failure = 'No feedback server is set (v5sim.feedbackEndpoint).';
      while (url) {
        this.post({ type: 'progress', message: `Sending (${formatBytes(bundle.length)})…` });
        try {
          const { id } = await submitReport(url, report, bundle, `v5sim-vscode/${extensionVersion(this.deps.context)}`);
          this.post({ type: 'sent', id });
          void vscode.window.showInformationMessage(`Thanks! Your report was sent (reference ${id.split('/').pop()?.slice(0, 8)}).`);
          return;
        } catch (e) {
          failure = e instanceof SubmitError ? e.message : (e as Error).message;
        }
        this.post({ type: 'progress', message: `Couldn't send: ${failure}` });
        // modal: a toast can go unseen (Do Not Disturb), leaving the form disabled
        const pick = await vscode.window.showWarningMessage(
          `${failure} Try again, or save the report as a zip and attach it to a GitHub issue? (GitHub issues are public.)`,
          { modal: true }, 'Try Again', 'Save for GitHub');
        if (pick === 'Try Again') continue;
        if (pick !== 'Save for GitHub') { this.post({ type: 'error', message: failure }); return; }
        await this.saveAndOpenIssue(form, parts, failure, true);
        return;
      }
      await this.saveAndOpenIssue(form, parts, failure, false);
    } finally {
      this.busy = false;
    }
  }

  /** What goes in the report, read once: home folder and user name taken
   *  out of the log and environment (project files are sent as they are).
   *  The folder is scanned again now, so the files sent are the files as
   *  they are, and the form's list is brought up to date. */
  private async collect(form: FeedbackForm): Promise<Parts> {
    const home = os.homedir();
    const user = safeUserName();
    const host = os.hostname();
    const environment = redactValue(collectEnvironment(this.deps), home, user, host);
    const report = buildReport(form, environment);
    const log = form.includeLog ? redact(this.deps.log.text(), home, user, host) : undefined;
    let project: ProjectRead | undefined;
    if (form.includeProject) {
      this.scan = undefined;
      const scan = await this.scanFolder();
      await this.postScan();
      if (scan) project = await readProjectFiles(scan);
    }
    return { report, log, project };
  }

  /** The fallback: a zip for a public GitHub issue, so without the contact
   *  the user gave for a private reply. */
  private async saveAndOpenIssue(form: FeedbackForm, parts: Parts, why: string, agreed: boolean): Promise<void> {
    const pick = agreed ? 'Save & Open GitHub' : await vscode.window.showWarningMessage(
      `${why} The report will be saved as a zip for you to attach to a GitHub issue. GitHub issues are public: ` +
      'anyone can see the description' + (form.includeProject ? " and your project's code" : '') + '.',
      { modal: true }, 'Save & Open GitHub');
    if (pick !== 'Save & Open GitHub') { this.post({ type: 'error', message: 'Not saved.' }); return; }
    const report: Report = { ...parts.report, contact: '' };
    const bundle = zip(bundleEntries(report, parts.log, parts.project));
    const name = `v5sim-report-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}.zip`;
    const downloads = path.join(os.homedir(), 'Downloads');
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(fs.existsSync(downloads) ? downloads : os.homedir(), name)),
      filters: { 'Zip archive': ['zip'] },
      saveLabel: 'Save report',
    });
    if (!target) { this.post({ type: 'error', message: 'Not saved.' }); return; }
    await vscode.workspace.fs.writeFile(target, bundle);
    void vscode.commands.executeCommand('revealFileInOS', target);
    await vscode.env.openExternal(vscode.Uri.parse(githubIssueUrl(ISSUES_REPO, report, path.basename(target.fsPath))));
    this.post({ type: 'saved', file: target.fsPath });
  }

  private html(): string {
    const w = this.panel.webview;
    const media = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.deps.context.extensionUri, 'media', f));
    const nonce = randomBytes(16).toString('hex');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media('feedback.css')}">
<title>Report a Problem</title></head><body>
<main id="app"></main>
<script nonce="${nonce}" src="${media('feedback.js')}"></script>
</body></html>`;
  }
}

/** v5sim.feedbackEndpoint, or nothing when it's been emptied. */
function endpoint(): string | undefined {
  return cfg().get<string>('feedbackEndpoint', '').trim() || undefined;
}

/** Where reports go, as the form shows it. */
function endpointHost(): string | undefined {
  const url = endpoint();
  if (!url) return undefined;
  try { return new URL(url).host; } catch { return url; }
}

function extensionVersion(context: vscode.ExtensionContext): string {
  return String(context.extension.packageJSON?.version ?? 'unknown');
}

function safeUserName(): string {
  try { return os.userInfo().username; } catch { return process.env.USERNAME ?? process.env.USER ?? ''; }
}

const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB`
  : `${(n / 1048576).toFixed(1)} MB`);

function collectEnvironment({ context, sim }: FeedbackDeps): Record<string, unknown> {
  const settings = cfg();
  const v5sim: Record<string, unknown> = {};
  for (const key of ['repoPath', 'wslDistro', 'preset', 'program', 'slot', 'instanceId', 'extraRobotArgs', 'usb',
    'runOnBuild', 'showBrainWindow', 'openBrainOnStart', 'feedbackEndpoint']) {
    v5sim[key] = settings.get(key);
  }
  return {
    extension: extensionVersion(context),
    vscode: vscode.version,
    appName: vscode.env.appName,
    uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
    remoteName: vscode.env.remoteName ?? null,
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 1073741824),
    language: vscode.env.language,
    simulator: mode(),
    simState: sim.state,
    simInstance: sim.current?.id ?? null,
    workspaceFolders: vscode.workspace.workspaceFolders?.length ?? 0,
    settings: v5sim,
  };
}
