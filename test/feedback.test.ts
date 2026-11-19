import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { crc32, safeEntryName, zip } from '../src/feedback/zip';
import { unzip } from './zipRead';
import { LIMITS, classify, scanProject } from '../src/feedback/projectFiles';
import { buildReport, bundleEntries, githubIssueUrl, readForm, redact, redactValue } from '../src/feedback/report';
import { LogBuffer, teeLog } from '../src/feedback/logBuffer';
import { SubmitError, submitReport } from '../src/feedback/submit';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v5sim-fb-'));

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('zip round-trips text, binary, empty and incompressible files', () => {
  const random = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 2654435761) >>> 24));
  const files = new Map<string, Buffer>([
    ['report.json', Buffer.from(JSON.stringify({ a: 'x'.repeat(5000) }))],
    ['project/src/main.cpp', Buffer.from('int main() { return 0; }\n')],
    ['project/ünïcødé.txt', Buffer.from('名前\n')],
    ['empty.txt', Buffer.alloc(0)],
    ['random.bin', random],
  ]);
  const out = unzip(zip([...files].map(([name, data]) => ({ name, data }))));
  assert.deepEqual([...out.keys()], [...files.keys()]);
  for (const [name, data] of files) assert.ok(out.get(name)!.equals(data), name);
});

test('zip is readable by Python\'s zipfile when Python is around', (t) => {
  const py = process.env.V5SIM_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
  const dir = tmp();
  const file = path.join(dir, 'b.zip');
  fs.writeFileSync(file, zip([{ name: 'a/b.txt', data: 'hello '.repeat(100) }, { name: 'c.txt', data: 'x' }]));
  const r = spawnSync(py, ['-c',
    'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(",".join(z.namelist()))', file],
    { encoding: 'utf8' });
  if (r.error || (r.status !== 0 && /not found|not recognized/i.test(r.stderr))) { t.skip('no python'); return; }
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'a/b.txt,c.txt');
});

test('zip entry names cannot escape the folder they unpack into', () => {
  assert.equal(safeEntryName('../../etc/passwd'), 'etc/passwd');
  assert.equal(safeEntryName('project\\src\\..\\main.cpp'), 'project/src/main.cpp');
  assert.equal(safeEntryName('/abs/x'), 'abs/x');
  assert.throws(() => safeEntryName('..'));
  assert.throws(() => zip([{ name: 'a', data: '' }, { name: './a', data: '' }]), /duplicate/);
});

test('secrets and build output are classified out', () => {
  for (const f of ['.env', '.env.local', 'deploy.pem', 'id_rsa', 'id_ed25519.pub', '.npmrc', 'aws_credentials',
    'secrets.json', 'github-token.txt', '.vscode/settings.json', 'robotA/.vscode/settings.json']) {
    assert.equal(classify(f), 'possible secret', f);
  }
  for (const f of ['bin/monolith.bin', 'main.o', 'libpros.a', 'out.elf']) assert.equal(classify(f), 'build output', f);
  for (const f of ['src/main.cpp', 'include/robot-config.h', 'tokenizer.cpp', 'project.pros', '.vscode/vex_project_settings.json',
    'src/main.py']) {
    assert.equal(classify(f), undefined, f);
  }
});

test('scanProject keeps source, skips excluded folders, secrets, big files and symlinks', async () => {
  const root = tmp();
  const w = (rel: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), data);
  };
  w('src/main.cpp', 'int main(){}');
  w('include/robot.h', '#pragma once');
  w('project.pros', '{}');
  w('.git/HEAD', 'ref');
  w('node_modules/x/index.js', '');
  w('bin/monolith.bin', 'x');
  w('build/a.o', 'x');
  w('.env', 'KEY=1');
  w('big.txt', Buffer.alloc(LIMITS.fileBytes + 1));
  let linked = true;
  try { fs.symlinkSync(path.join(root, 'src'), path.join(root, 'link'), 'junction'); } catch { linked = false; }

  const scan = await scanProject(root);
  assert.deepEqual(scan.files.map(f => f.rel), ['include/robot.h', 'project.pros', 'src/main.cpp']);
  const reasons = Object.fromEntries(scan.skipped.map(s => [s.rel, s.reason]));
  assert.equal(reasons['.git'], 'excluded folder');
  assert.equal(reasons['node_modules'], 'excluded folder');
  assert.equal(reasons['bin'], 'excluded folder');
  assert.equal(reasons['build'], 'excluded folder');
  assert.equal(reasons['.env'], 'possible secret');
  assert.equal(reasons['big.txt'], 'too large');
  if (linked) assert.equal(reasons['link'], 'symlink');
  assert.equal(scan.totalBytes, scan.files.reduce((n, f) => n + f.size, 0));
});

test('scanProject stops at the first limit and says so in one line', async () => {
  const root = tmp();
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x'.repeat(10));
  const base = { ...LIMITS, fileBytes: 100 };
  const bySize = await scanProject(root, { ...base, totalBytes: 25 });
  assert.equal(bySize.files.length, 2);
  assert.deepEqual(bySize.skipped, [{ rel: '(the rest of the folder: over 0 MB)', reason: 'limit reached' }]);
  const byCount = await scanProject(root, { ...base, files: 3 });
  assert.equal(byCount.files.length, 3);
  assert.deepEqual(byCount.skipped.map(s => s.reason), ['limit reached']);
});

test('scanProject stops walking a huge folder and keeps the skipped list short', async () => {
  const root = tmp();
  for (let d = 0; d < 20; d++) {
    fs.mkdirSync(path.join(root, `d${d}`, 'node_modules'), { recursive: true });
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, `d${d}`, `.env.${i}`), '');
  }
  const scan = await scanProject(root, { ...LIMITS, entries: 100, skippedListed: 10 });
  assert.equal(scan.files.length, 0);
  assert.equal(scan.skipped.length, 12);
  assert.match(scan.skipped[10].rel, /^\(\d+ more not listed\)$/);
  assert.deepEqual(scan.skipped[11], { rel: '(the rest of the folder: more than 100 files and folders)', reason: 'limit reached' });
});

test('readForm checks the webview\'s form', () => {
  const ok = { kind: 'bug', summary: ' Motor stalls ', description: 'd', contact: '', includeLog: true, includeProject: false };
  assert.deepEqual(readForm(ok), { ...ok, summary: 'Motor stalls' });
  assert.match(readForm({ ...ok, kind: 'rant' }) as string, /kind/);
  assert.match(readForm({ ...ok, summary: '   ' }) as string, /summary/);
  assert.match(readForm({ ...ok, summary: 'x'.repeat(201) }) as string, /200/);
  assert.match(readForm({ ...ok, description: 'x'.repeat(20001) }) as string, /description/);
  assert.equal(readForm(null), 'No form.');
  // only a real true opts in
  assert.equal((readForm({ ...ok, includeProject: 'yes' }) as any).includeProject, false);
});

test('redact takes out the home folder and user name in every spelling', () => {
  const winHome = 'C:\\Users\\kevin';
  assert.equal(redact('C:\\Users\\kevin\\proj\\main.cpp', winHome, 'kevin'), '~\\proj\\main.cpp');
  assert.equal(redact('c:/users/KEVIN/proj', winHome, 'kevin'), '~/proj');
  assert.equal(redact('wsl: /home/kevin/.v5-simulacrum', winHome, 'kevin'), 'wsl: /home/<user>/.v5-simulacrum');
  // WSL's user need not be the Windows one
  assert.equal(redact('> v5brain.sh --robot @/home/jsmith/robot.args', winHome, 's123456'),
    '> v5brain.sh --robot @/home/<user>/robot.args');
  assert.equal(redact('cd /home/jsmith && ls "/home/jsmith/x"', winHome, 'x'), 'cd /home/<user> && ls "/home/<user>/x"');
  assert.equal(redact('see project/home/notes.txt', winHome, 'x'), 'see project/home/notes.txt');
  assert.equal(redact('/Users/kevin/x and /Users/kevinb/y', '/Users/kevin', 'kevin'), '~/x and /Users/kevinb/y');
  assert.equal(redact('kevin wrote this', winHome, 'kevin'), 'kevin wrote this');
  assert.deepEqual(redactValue({ a: ['C:\\Users\\kevin\\a'], n: 1, b: null }, winHome, 'kevin'),
    { a: ['~\\a'], n: 1, b: null });
});

test('the environment goes into the report only with the log', () => {
  const form = { kind: 'bug' as const, summary: 's', description: '', contact: '', includeLog: false, includeProject: false };
  assert.deepEqual(buildReport(form, { os: 'win32' }).environment, {});
  assert.deepEqual(buildReport({ ...form, includeLog: true }, { os: 'win32' }).environment, { os: 'win32' });
});

test('bundleEntries holds the report, log and project files', () => {
  const report = buildReport({ kind: 'bug', summary: 's', description: 'd', contact: '', includeLog: true,
    includeProject: true }, { os: 'x' });
  const scan = { root: '/p', totalBytes: 2, files: [{ rel: 'src/a.cpp', abs: '/p/src/a.cpp', size: 2 }],
    skipped: [{ rel: '.env', reason: 'possible secret' as const }] };
  const entries = bundleEntries(report, 'log\n', scan, () => Buffer.from('ab'));
  assert.deepEqual(entries.map(e => e.name), ['report.json', 'log.txt', 'project-skipped.txt', 'project/src/a.cpp']);
  assert.equal(String(entries[2].data), '.env\tpossible secret\n');
  assert.deepEqual(bundleEntries(report, undefined, undefined, () => Buffer.alloc(0)).map(e => e.name), ['report.json']);
});

test('githubIssueUrl prefills title and body and stays short', () => {
  const report = { kind: 'bug' as const, summary: 'Crash & burn', description: 'x'.repeat(10000), contact: '',
    environment: { extension: '0.3.13', settings: { a: 1 } } };
  const url = new URL(githubIssueUrl('https://github.com/o/r/', report, 'v5sim-report.zip'));
  assert.equal(url.origin + url.pathname, 'https://github.com/o/r/issues/new');
  assert.equal(url.searchParams.get('title'), '[bug] Crash & burn');
  assert.ok(url.toString().length <= 7500);
});

test("githubIssueUrl stays under GitHub's limit once encoded, for any text", () => {
  for (const text of ['名前'.repeat(3000), '&?#%'.repeat(2000), '🤖'.repeat(4000)]) {
    const report = { kind: 'bug' as const, summary: 's', description: text, contact: '', environment: {} };
    const url = githubIssueUrl('https://github.com/o/r', report, 'r.zip');
    assert.ok(url.length <= 7500, `${url.length}`);
    const body = new URL(url).searchParams.get('body')!;
    assert.match(body, /cut short/);
    assert.ok(body.length > 300, 'still carries a good part of the description');
    assert.ok(!body.includes('�'), 'no broken characters');
  }
  const short = { kind: 'idea' as const, summary: 's', description: 'short', contact: '', environment: {} };
  assert.doesNotMatch(new URL(githubIssueUrl('https://github.com/o/r', short)).searchParams.get('body')!, /cut short/);
});

test('LogBuffer keeps the newest text within its size', () => {
  const b = new LogBuffer(10);
  b.append('12345');
  b.append('67890');
  b.append('abc');
  assert.equal(b.text(), '67890abc');
  b.append('x'.repeat(25));
  assert.equal(b.text(), 'x'.repeat(10));
});

test('teeLog copies channel writes into the buffer', () => {
  const lines: string[] = [];
  const ch = { name: 'V5 Sim', appendLine: (s: string) => lines.push(s), append: (s: string) => lines.push(s),
    clear: () => lines.splice(0), replace: (s: string) => lines.splice(0, lines.length, s) };
  const b = new LogBuffer();
  const log = teeLog(ch as any, b);
  log.appendLine('one');
  log.append('two');
  assert.equal(b.text(), 'one\ntwo');
  assert.deepEqual(lines, ['one', 'two']);
  log.replace('three');
  assert.equal(b.text(), 'three');
  log.clear();
  assert.equal(b.text(), '');
  assert.equal(log.name, 'V5 Sim');
});

test('submitReport posts multipart and returns the id', async () => {
  let seen: { url: string; form: FormData } | undefined;
  const fakeFetch = (async (url: URL, init: RequestInit) => {
    seen = { url: url.toString(), form: init.body as FormData };
    return new Response(JSON.stringify({ ok: true, id: '2026-11-20/abc' }), { status: 201 });
  }) as unknown as typeof fetch;
  const report = { kind: 'bug' as const, summary: 's', description: '', contact: '', environment: {} };
  const r = await submitReport('https://fb.example.dev', report, Buffer.from('PK\x03\x04'), 'ua', fakeFetch);
  assert.equal(r.id, '2026-11-20/abc');
  assert.equal(seen!.url, 'https://fb.example.dev/report');
  assert.deepEqual(JSON.parse(seen!.form.get('report') as string), report);
  assert.equal((seen!.form.get('bundle') as Blob).size, 4);
});

test('submitReport turns server and network failures into SubmitError', async () => {
  const report = { kind: 'bug' as const, summary: 's', description: '', contact: '', environment: {} };
  const answer = (status: number, body: string) =>
    (async () => new Response(body, { status })) as unknown as typeof fetch;
  await assert.rejects(submitReport('https://x.dev', report, undefined, 'ua', answer(429, '{"ok":false,"error":"too many"}')),
    (e: SubmitError) => e.status === 429 && /too many/.test(e.message));
  await assert.rejects(submitReport('https://x.dev', report, undefined, 'ua', answer(502, '<html>')), /502/);
  await assert.rejects(submitReport('https://x.dev', report, undefined, 'ua',
    (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch), /reach.*ENOTFOUND/);
  await assert.rejects(submitReport('http://evil.example', report, undefined, 'ua'), /https/);
  await assert.rejects(submitReport('not a url', report, undefined, 'ua'), /not a URL/);
});
