// A pane showing one of the simulator's pages (brain screen, device
// dashboard, field view) in an iframe. The pages are served by the robot sim
// on http://localhost:8765+N; asExternalUri forwards the port when VS Code
// runs remotely (Remote-WSL, SSH, Codespaces).
import * as vscode from 'vscode';

import { Running } from '../simInstance';
import { viewUrl } from '../settings';
import { waitForPage } from '../waitForPage';

export type Page = 'screen' | 'dashboard' | 'controller' | '';

const TITLES: Record<Page, string> = {
  screen: 'V5 Brain', dashboard: 'V5 Devices', controller: 'V5 Controller', '': 'V5 Field',
};

/** What a pane shows: an instance, one starting, or none. */
export type PaneTarget = Running | 'starting' | undefined;

export class WebPanel {
  private static panels = new Map<Page, WebPanel>();
  /** A pane's page stopped answering (the instance may be gone). */
  static onPageDown?: (target: Running) => void;

  static show(page: Page, target: PaneTarget, column = vscode.ViewColumn.Beside): void {
    const existing = WebPanel.panels.get(page);
    if (existing) {
      existing.panel.reveal(undefined, true);
      void existing.load(target);
      return;
    }
    const panel = vscode.window.createWebviewPanel(`v5sim.${page || 'field'}`, TITLES[page],
      { viewColumn: column, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true });
    const p = new WebPanel(page, panel);
    WebPanel.panels.set(page, p);
    void p.load(target);
  }

  /** Point every open pane at the instance (or show that none runs). */
  static refreshAll(target: PaneTarget): void {
    for (const p of WebPanel.panels.values()) void p.load(target);
  }

  private shown?: string;
  private target?: Running;
  private loads = 0;                 // a newer load() supersedes a waiting one

  private constructor(readonly page: Page, readonly panel: vscode.WebviewPanel) {
    panel.onDidDispose(() => {
      // a load awaiting the page must not touch the disposed webview: a
      // newer load count makes it (and waitForPage's polling) stop
      this.loads++;
      if (WebPanel.panels.get(page) === this) WebPanel.panels.delete(page);
    });
    panel.webview.onDidReceiveMessage(m => {
      // the only command a pane's buttons run (never one named by the page)
      if (m?.type === 'command') void vscode.commands.executeCommand('v5sim.start');
      if (m?.type === 'reload') { this.shown = undefined; void this.load(this.target); }
      if (m?.type === 'browser' && this.target) {
        void vscode.env.openExternal(viewUrl(this.target.viewPort, this.page));
      }
    });
  }

  private async load(next: PaneTarget): Promise<void> {
    const load = ++this.loads;
    if (next === 'starting') {
      this.target = undefined;
      this.shown = undefined;
      this.panel.title = TITLES[this.page];
      this.panel.webview.html = this.message('The simulator is starting...', []);
      return;
    }
    const target = next;
    this.target = target;
    if (!target) {
      this.shown = undefined;
      this.panel.title = TITLES[this.page];
      this.panel.webview.html = this.message('No simulator is running.', [['Start the simulator', 'command']]);
      return;
    }
    const uri = await vscode.env.asExternalUri(viewUrl(target.viewPort, this.page));
    if (load !== this.loads) return;   // superseded, or the pane was closed
    const url = uri.toString(true);
    this.panel.title = `${TITLES[this.page]} (${target.id})`;
    if (url === this.shown) return;
    // the robot sim's web server comes up a few seconds after the instance
    // is announced: load the page only once it answers
    this.shown = undefined;
    this.panel.webview.html = this.message('Starting the simulator...', []);
    const up = await waitForPage(`http://127.0.0.1:${target.viewPort}/${this.page}`, 60_000, 500,
      () => load === this.loads);
    if (load !== this.loads) return;
    if (!up) {
      WebPanel.onPageDown?.(target);
      this.panel.webview.html = this.message(
        `The simulator's page (port ${target.viewPort}) isn't answering. See V5 Sim: Show Log.`,
        [['Retry', 'reload'], ['Open in browser', 'browser']]);
      return;
    }
    this.shown = url;
    this.panel.webview.html = this.frame(url, `${uri.scheme}://${uri.authority}`);
  }

  private frame(url: string, origin: string): string {
    const nonce = newNonce();
    const csp = `default-src 'none'; frame-src ${origin} http://localhost:* http://127.0.0.1:*; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#14161a}
iframe{border:0;width:100%;height:100%;display:block}
#bar{position:fixed;top:6px;right:6px;display:flex;gap:4px;opacity:.35;transition:opacity .15s}
#bar:hover{opacity:1}
#bar button{font:12px system-ui,sans-serif;background:#2a2e35;color:#e8eaed;border:1px solid #3b4049;
  border-radius:4px;padding:2px 8px;cursor:pointer}</style></head>
<body><iframe src="${escapeAttr(url)}" allow="gamepad; clipboard-write"></iframe>
<div id="bar"><button data-m="reload" title="Load the page again">Reload</button>
<button data-m="browser" title="Open this page in your web browser">Open in browser</button></div>
<script nonce="${nonce}">const vs = acquireVsCodeApi();
document.querySelectorAll('#bar button').forEach(b => b.onclick = () => vs.postMessage({ type: b.dataset.m }));</script>
</body></html>`;
  }

  /** A message with buttons: [label, 'command' (start) | 'reload' | 'browser'] */
  private message(text: string, buttons: [string, string][]): string {
    const nonce = newNonce();
    const html = buttons.map(([label, m]) => `<button data-m="${m}">${escapeAttr(label)}</button>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);
display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;gap:12px;text-align:center}
div.b{display:flex;gap:8px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:6px 14px;cursor:pointer}
button:hover{background:var(--vscode-button-hoverBackground)}</style></head>
<body><div>${escapeAttr(text)}</div><div class="b">${html}</div>
<script nonce="${nonce}">const vs = acquireVsCodeApi();
document.querySelectorAll('button').forEach(b => b.onclick = () => b.dataset.m === 'command'
  ? vs.postMessage({ type: 'command' }) : vs.postMessage({ type: b.dataset.m }));</script>
</body></html>`;
  }
}

function newNonce(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
