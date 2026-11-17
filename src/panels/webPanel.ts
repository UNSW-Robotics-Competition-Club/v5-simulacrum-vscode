// A pane showing one of the simulator's pages (brain screen, device
// dashboard, field view) in an iframe. The pages are served by the robot sim
// on http://localhost:8765+N; asExternalUri forwards the port when VS Code
// runs remotely (Remote-WSL, SSH, Codespaces).
import * as vscode from 'vscode';

import { Running } from '../simInstance';
import { viewUrl } from '../settings';

export type Page = 'screen' | 'dashboard' | '';

const TITLES: Record<Page, string> = { screen: 'V5 Brain', dashboard: 'V5 Devices', '': 'V5 Field' };

export class WebPanel {
  private static panels = new Map<Page, WebPanel>();

  static show(page: Page, target: Running | undefined, column = vscode.ViewColumn.Beside): void {
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
  static refreshAll(target: Running | undefined): void {
    for (const p of WebPanel.panels.values()) void p.load(target);
  }

  private shown?: string;

  private constructor(readonly page: Page, readonly panel: vscode.WebviewPanel) {
    panel.onDidDispose(() => WebPanel.panels.delete(page));
    panel.webview.onDidReceiveMessage(m => {
      if (m?.type === 'command') void vscode.commands.executeCommand(m.command);
    });
  }

  private async load(target: Running | undefined): Promise<void> {
    if (!target) {
      this.shown = undefined;
      this.panel.title = TITLES[this.page];
      this.panel.webview.html = this.message();
      return;
    }
    const uri = await vscode.env.asExternalUri(viewUrl(target.viewPort, this.page));
    const url = uri.toString(true);
    this.panel.title = `${TITLES[this.page]} (${target.id})`;
    if (url === this.shown) return;
    this.shown = url;
    this.panel.webview.html = this.frame(url, `${uri.scheme}://${uri.authority}`);
  }

  private frame(url: string, origin: string): string {
    const csp = `default-src 'none'; frame-src ${origin} http://localhost:* http://127.0.0.1:*; style-src 'unsafe-inline';`;
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#14161a}
iframe{border:0;width:100%;height:100%;display:block}</style></head>
<body><iframe src="${escapeAttr(url)}" allow="gamepad; clipboard-write"></iframe></body></html>`;
  }

  private message(): string {
    const nonce = Math.random().toString(36).slice(2);
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);
display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;gap:12px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:6px 14px;cursor:pointer}
button:hover{background:var(--vscode-button-hoverBackground)}</style></head>
<body><div>No simulator is running.</div><button id="go">Start the simulator</button>
<script nonce="${nonce}">const vs = acquireVsCodeApi();
document.getElementById('go').onclick = () => vs.postMessage({ type: 'command', command: 'v5sim.start' });</script>
</body></html>`;
  }
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
