import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CACHE_NAME, Release, cachedRuntime, download, fetchRuntime, installKey, needsCheck, pickRuntime, runtimePlatform, sumFor } from '../src/runtimeDownload';

test('the runtime for each computer', () => {
  assert.equal(runtimePlatform('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(runtimePlatform('darwin', 'x64'), 'darwin-x64');
  assert.equal(runtimePlatform('win32', 'x64'), 'linux-x64');     // runs in WSL
  assert.equal(runtimePlatform('linux', 'x64'), 'linux-x64');     // VS Code in WSL
  assert.equal(runtimePlatform('win32', 'arm64'), undefined);
  assert.equal(runtimePlatform('linux', 'arm64'), undefined);
});

const rel = (tag: string, names: string[], draft = false): Release => ({
  tag_name: tag, draft,
  assets: names.map(name => ({ name, browser_download_url: `https://x/${tag}/${name}`, size: 10 })),
});

test('this version\'s release, else the newest with the runtime and its sums', () => {
  const releases = [
    rel('v0.3.14', ['runtime-darwin-arm64.tar.gz', 'SHA256SUMS'], true),             // a draft
    rel('v0.3.13', ['v5-simulacrum-vscode-darwin-arm64.vsix']),                         // no runtime
    rel('v0.3.12', ['runtime-darwin-arm64.tar.gz', 'runtime-linux-x64.tar.gz', 'SHA256SUMS']),
    rel('v0.3.11', ['runtime-darwin-arm64.tar.gz', 'SHA256SUMS']),
    rel('v0.3.10', ['runtime-linux-x64.tar.gz']),                                       // no sums
  ];
  assert.equal(pickRuntime(releases, '0.3.11', 'darwin-arm64')?.tag, 'v0.3.11');
  assert.equal(pickRuntime(releases, '0.3.13', 'darwin-arm64')?.tag, 'v0.3.12');
  assert.equal(pickRuntime(releases, '0.3.10', 'linux-x64')?.tag, 'v0.3.12');
  assert.equal(pickRuntime(releases, '0.3.12', 'darwin-x64'), undefined);
  const s = pickRuntime(releases, '0.3.12', 'linux-x64')!;
  assert.equal(s.url, 'https://x/v0.3.12/runtime-linux-x64.tar.gz');
  assert.equal(s.sumsUrl, 'https://x/v0.3.12/SHA256SUMS');
});

test('a hash from a sha256sum listing', () => {
  const a = 'a'.repeat(64), b = 'B'.repeat(64);
  const sums = `${a}  runtime-darwin-arm64.tar.gz\r\n${b} *runtime-linux-x64.tar.gz\n`;
  assert.equal(sumFor(sums, 'runtime-darwin-arm64.tar.gz'), a);
  assert.equal(sumFor(sums, 'runtime-linux-x64.tar.gz'), 'b'.repeat(64));
  assert.equal(sumFor(sums, 'runtime-darwin-x64.tar.gz'), undefined);
});

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'v5sim-rt-'));

/** A runtime downloaded earlier, as fetchRuntime leaves it. */
function cache(dir: string, tag: string, plat = 'linux-x64') {
  const file = `${tag}-runtime-${plat}.tar.gz`;
  fs.writeFileSync(path.join(dir, file), 'tarball');
  fs.writeFileSync(path.join(dir, CACHE_NAME), JSON.stringify({ tag, file }));
  return path.join(dir, file);
}

/** Runs fn with fetch counting calls and failing like a network that's down. */
async function offline<T>(fn: () => Promise<T>): Promise<{ result?: T; error?: Error; calls: number }> {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('getaddrinfo ENOTFOUND api.github.com'); }) as typeof fetch;
  try {
    return { result: await fn(), calls };
  } catch (e) {
    return { error: e as Error, calls };
  } finally {
    globalThis.fetch = real;
  }
}

test('cachedRuntime finds the earlier download, only if its file is there and for this computer', () => {
  const dir = tmpDir();
  assert.equal(cachedRuntime(dir, 'linux-x64'), undefined);
  const file = cache(dir, 'v0.3.13');
  assert.deepEqual(cachedRuntime(dir, 'linux-x64'), { file, tag: 'v0.3.13' });
  assert.equal(cachedRuntime(dir, 'darwin-arm64'), undefined, 'another platform\'s');
  fs.rmSync(file);
  assert.equal(cachedRuntime(dir, 'linux-x64'), undefined, 'file gone');
  fs.writeFileSync(path.join(dir, CACHE_NAME), '{not json');
  assert.equal(cachedRuntime(dir, 'linux-x64'), undefined);
});

test('GitHub is asked only when this version\'s runtime isn\'t downloaded, or when repairing', () => {
  const mine = { file: 'f', tag: 'v0.3.13' };
  assert.equal(needsCheck(mine, '0.3.13', false), false);
  assert.equal(needsCheck(mine, '0.3.13', true), true, 'Repair');
  assert.equal(needsCheck({ file: 'f', tag: 'v0.3.12' }, '0.3.13', false), true, 'a stand-in from another release');
  assert.equal(needsCheck(undefined, '0.3.13', false), true);
});

test('a runtime from another release unpacks into its own folder', () => {
  assert.equal(installKey('0.3.13', 'v0.3.13'), '0.3.13');
  assert.equal(installKey('0.3.13', undefined), '0.3.13');
  assert.equal(installKey('0.3.13', 'v0.3.12'), '0.3.13-v0.3.12');
});

test('offline, an installed runtime starts without the network', async () => {
  const dir = tmpDir();
  const file = cache(dir, 'v0.3.13');
  const lines: string[] = [];
  const r = await offline(() => fetchRuntime(dir, '0.3.13', 'linux-x64', () => {}, l => lines.push(l)));
  assert.deepEqual(r.result, { file, tag: 'v0.3.13' });
  assert.equal(r.calls, 0, 'no request at all');
});

test('offline, a stand-in runtime is still used; with nothing downloaded it fails with the reason', async () => {
  const dir = tmpDir();
  const file = cache(dir, 'v0.3.12');
  const lines: string[] = [];
  const r = await offline(() => fetchRuntime(dir, '0.3.13', 'linux-x64', () => {}, l => lines.push(l)));
  assert.deepEqual(r.result, { file, tag: 'v0.3.12' });
  assert.equal(r.calls, 1, 'it did try to find this version\'s');
  assert.ok(lines.some(l => /couldn't check GitHub.*ENOTFOUND.*using the one from v0.3.12/.test(l)), lines.join('\n'));
  const none = await offline(() => fetchRuntime(tmpDir(), '0.3.13', 'linux-x64', () => {}, () => {}));
  assert.match(none.error!.message, /ENOTFOUND/);
});

/** A local server whose handler decides how each download behaves. */
async function server(handler: http.RequestListener): Promise<{ url: string; close(): void }> {
  const s = http.createServer(handler);
  await new Promise<void>(ok => s.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}/rt.tar.gz`,
    close: () => { s.closeAllConnections(); s.close(); } };
}

test('download gives up when the connection stalls, and leaves no partial file behind it claims', async () => {
  const srv = await server((_req, res) => { res.writeHead(200, { 'content-length': '1000' }); res.write('x'.repeat(10)); });
  try {
    const file = path.join(tmpDir(), 'rt.part');
    await assert.rejects(download(srv.url, file, 1000, () => {}, 300), /stalled \(nothing for 0.3 s\)/);
  } finally {
    srv.close();
  }
});

test('download reports a file it can\'t write instead of waiting forever', async () => {
  const srv = await server((_req, res) => { res.end('x'.repeat(100)); });
  try {
    const file = path.join(tmpDir(), 'no-such-folder', 'rt.part');
    await assert.rejects(download(srv.url, file, 100, () => {}, 5000), /ENOENT/);
  } finally {
    srv.close();
  }
});

test('download streams the file and returns its hash', async () => {
  const srv = await server((_req, res) => { res.end('hello'); });
  try {
    const file = path.join(tmpDir(), 'rt.part');
    const seen: number[] = [];
    const hash = await download(srv.url, file, 5, n => seen.push(n), 5000);
    assert.equal(hash, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
    assert.equal(seen.at(-1), 5);
  } finally {
    srv.close();
  }
});
