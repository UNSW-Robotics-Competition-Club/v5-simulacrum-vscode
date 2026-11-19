// Runs inside VS Code (see runE2E.ts). Drives the Report a Problem panel's
// host side with the messages its webview sends, against a real feedback
// Worker, then checks what the Worker stored.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { unzip } from '../zipRead';

const endpoint = process.env.E2E_ENDPOINT!;
const token = process.env.E2E_TOKEN!;
const work = process.env.E2E_WORK!;

type Msg = { type: string; [k: string]: any };

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms))]);
}

/** The open panel, with what it posts to the webview recorded. */
async function openPanel(extPath: string) {
  await vscode.commands.executeCommand('v5sim.reportIssue');
  // the module the extension loaded (on Windows its path may differ from
  // ours in the drive letter's case, which would load a second copy)
  const want = path.join(extPath, 'out', 'src', 'feedback', 'feedbackPanel.js').toLowerCase();
  const key = Object.keys(require.cache).find(k => k.toLowerCase() === want);
  assert.ok(key, 'feedbackPanel module loaded by the extension');
  const { FeedbackPanel } = require.cache[key]!.exports;
  const panel = FeedbackPanel.current;
  assert.ok(panel, 'the command opened the panel');
  const posted: Msg[] = [];
  const waiters: [string, (m: Msg) => void][] = [];
  panel.post = (m: Msg) => {
    posted.push(m);
    for (const [i, [type, resolve]] of [...waiters.entries()].reverse()) {
      if (type === m.type) { waiters.splice(i, 1); resolve(m); }
    }
  };
  const send = (m: Msg) => panel.onMessage(m);
  const next = (type: string, ms = 30_000) =>
    within(new Promise<Msg>(resolve => waiters.push([type, resolve])), ms, `panel message ${type}`);
  return { panel, posted, send, next };
}

async function adminGet(p: string): Promise<Response> {
  const res = await fetch(`${endpoint}/admin/reports${p}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200, `admin GET ${p}`);
  return res;
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'v5-simulacrum-vscode');
  assert.ok(ext, 'extension loaded');
  await ext.activate();
  const settings = vscode.workspace.getConfiguration('v5sim');
  assert.equal(settings.inspect('feedbackEndpoint')?.defaultValue, 'https://v5sim-feedback.unsw-rcc.workers.dev');
  await settings.update('feedbackEndpoint', endpoint, vscode.ConfigurationTarget.Global);
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('v5sim.reportIssue'), 'command registered');

  // 1. send a bug with the log and the project
  const { send, next, panel } = await openPanel(ext.extensionPath);
  const init = next('init');
  await send({ type: 'ready' });
  const i = await init;
  assert.equal(i.endpoint, new URL(endpoint).host);
  // (the project's .vscode/settings.json sets it to attacker.invalid: ignored)
  const project = vscode.workspace.workspaceFolders![0].uri.fsPath;
  assert.equal(i.folder, project);

  const scanned = next('scan');
  await send({ type: 'scan', folder: project });
  const { scan } = await scanned;
  assert.deepEqual(scan.files.map((f: any) => f.rel), ['include/main.h', 'project.pros', 'src/main.cpp']);
  assert.ok(scan.skipped.some((s: any) => s.rel === '.env' && s.reason === 'possible secret'));
  assert.ok(scan.skipped.some((s: any) => s.rel === '.vscode/settings.json' && s.reason === 'possible secret'));

  // a folder the webview made up is ignored
  const rescanned = next('scan');
  await send({ type: 'scan', folder: os.homedir() });
  assert.equal((await rescanned).scan.folder, project);

  // a form that doesn't check out comes back as an error, nothing sent
  const err = next('error');
  await send({ type: 'submit', form: { kind: 'bug', summary: '  ', description: '', contact: '', includeLog: true, includeProject: true } });
  assert.match((await err).message, /summary/);

  // something in the log to find again, with the home folder in it
  await vscode.commands.executeCommand('v5sim.showLog');
  const marker = `e2e-marker-${Date.now()}`;
  const outputLine = `${marker} at ${path.join(os.homedir(), 'secret-place')}`;
  // the extension's own channel is internal: write through its tee via a log line the extension makes
  (panel.deps.log as { append(s: string): void }).append(`${outputLine}\n`);

  const sent = next('sent', 60_000);
  await send({ type: 'submit', form: { kind: 'bug', summary: '[e2e] report from VS Code', description: 'It broke.',
    contact: 'e2e@example.com', includeLog: true, includeProject: true } });
  const { id } = await sent;
  assert.match(id, /^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}$/);

  const stored = await (await adminGet(`/${id}/report.json`)).json() as any;
  assert.equal(stored.summary, '[e2e] report from VS Code');
  assert.equal(stored.contact, 'e2e@example.com');
  assert.equal(stored.environment.vscode, vscode.version);
  assert.equal(stored.environment.settings.feedbackEndpoint, endpoint);
  const files = unzip(Buffer.from(await (await adminGet(`/${id}/bundle.zip`)).arrayBuffer()));
  assert.deepEqual([...files.keys()].sort(), ['log.txt', 'project-skipped.txt', 'project/include/main.h',
    'project/project.pros', 'project/src/main.cpp', 'report.json']);
  assert.match(files.get('project/src/main.cpp')!.toString(), /e2e/);
  const log = files.get('log.txt')!.toString();
  assert.ok(log.includes(marker), 'log has the line');
  assert.ok(!log.toLowerCase().includes(os.homedir().toLowerCase()), 'home folder redacted from the log');
  assert.ok(!files.has('project/.env'), '.env not sent');
  assert.match(files.get('project-skipped.txt')!.toString(), /^\.env\tpossible secret$/m);
  panel.panel.dispose();

  // 2. without log or project: report.json only, no environment
  const two = await openPanel(ext.extensionPath);
  const sent2 = two.next('sent', 60_000);
  await two.send({ type: 'submit', form: { kind: 'idea', summary: '[e2e] idea only', description: '', contact: '',
    includeLog: false, includeProject: false } });
  const id2 = (await sent2).id;
  const stored2 = await (await adminGet(`/${id2}/report.json`)).json() as any;
  assert.deepEqual(stored2.environment, {});
  const files2 = unzip(Buffer.from(await (await adminGet(`/${id2}/bundle.zip`)).arrayBuffer()));
  assert.deepEqual([...files2.keys()], ['report.json']);
  two.panel.panel.dispose();

  // 3. server unreachable: offered the zip + GitHub issue instead
  await settings.update('feedbackEndpoint', 'http://127.0.0.1:9', vscode.ConfigurationTarget.Global);
  const saveTo = vscode.Uri.file(path.join(work, 'saved-report.zip'));
  const opened: string[] = [];
  const win = vscode.window as any;
  const realWarn = win.showWarningMessage, realSave = win.showSaveDialog;
  const realOpen = vscode.env.openExternal;
  const realExec = vscode.commands.executeCommand;
  win.showWarningMessage = async (msg: string) => { opened.push(`warn:${msg}`); return 'Save for GitHub'; };
  win.showSaveDialog = async () => saveTo;
  (vscode.env as any).openExternal = async (u: vscode.Uri) => { opened.push(u.toString(true)); return true; };
  (vscode.commands as any).executeCommand = async (c: string, ...a: unknown[]) =>
    c === 'revealFileInOS' ? undefined : realExec(c, ...a);
  try {
    const three = await openPanel(ext.extensionPath);
    const saved = three.next('saved', 60_000);
    await three.send({ type: 'submit', form: { kind: 'bug', summary: '[e2e] offline', description: 'no network',
      contact: 'student@school.example', includeLog: true, includeProject: true } });
    assert.equal((await saved).file, saveTo.fsPath);
    assert.match(opened[0], /^warn:Couldn't reach the feedback server.*public/);
    assert.equal(opened.filter(o => o.startsWith('warn:')).length, 1, 'one question, not two');
    const issue = new URL(opened[1]);
    assert.equal(issue.pathname, '/UNSW-Robotics-Competition-Club/v5-simulacrum-vscode/issues/new');
    assert.equal(issue.searchParams.get('title'), '[bug] [e2e] offline');
    assert.match(issue.searchParams.get('body')!, /saved-report\.zip/);
    const files3 = unzip(fs.readFileSync(saveTo.fsPath));
    assert.ok(files3.has('project/src/main.cpp') && files3.has('log.txt'));
    assert.equal(JSON.parse(files3.get('report.json')!.toString()).contact, '', 'no contact in a zip for a public issue');
    three.panel.panel.dispose();
  } finally {
    win.showWarningMessage = realWarn;
    win.showSaveDialog = realSave;
    (vscode.env as any).openExternal = realOpen;
    (vscode.commands as any).executeCommand = realExec;
  }
  console.log('E2E OK', id, id2);
}
