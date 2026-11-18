import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Release, pickRuntime, runtimePlatform, sumFor } from '../src/runtimeDownload';

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
