import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';

import { Fs, compareVersions, project, projectRoot, prosProject, pythonVm, vexProject } from '../src/programs';

/** A fake file system: path -> [mtime, contents]; folders are implied. */
function fakeFs(files: Record<string, [number, string?]>): Fs {
  const norm = (p: string) => path.normalize(p);
  const all = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return {
    exists: p => all.has(norm(p)) || [...all.keys()].some(k => k.startsWith(norm(p) + path.sep)),
    mtime: p => all.get(norm(p))?.[0] ?? 0,
    read: p => all.get(norm(p))?.[1],
    list: dir => [...new Set([...all.keys()].filter(k => k.startsWith(norm(dir) + path.sep))
      .map(k => k.slice(norm(dir).length + 1).split(path.sep)[0]))],
  };
}

const prosJson = JSON.stringify({ 'py/state': { templates: { kernel: { 'py/state': { metadata: {
  output: 'bin/monolith.bin', hot_output: 'bin/hot.package.bin', cold_output: 'bin/cold.package.bin',
  hot_addr: '125829120', cold_addr: '58720256' } } } } } });

test('PROS: hot/cold when newer than the monolith, else the monolith', () => {
  const r = path.join('w', 'robot');
  const fs = fakeFs({
    [path.join(r, 'project.pros')]: [1, prosJson],
    [path.join(r, 'bin', 'hot.package.bin')]: [20],
    [path.join(r, 'bin', 'cold.package.bin')]: [10],
    [path.join(r, 'bin', 'monolith.bin')]: [5],
  });
  const p = prosProject(r, fs)!;
  assert.equal(p.program?.kind, 'hotcold');
  assert.equal(p.program?.file, path.join(r, 'bin', 'hot.package.bin'));
  assert.equal((p.program as { link: string }).link, path.join(r, 'bin', 'cold.package.bin'));
  assert.match(p.label, /hot\/cold/);

  const older = fakeFs({
    [path.join(r, 'project.pros')]: [1, prosJson],
    [path.join(r, 'bin', 'hot.package.bin')]: [3],
    [path.join(r, 'bin', 'cold.package.bin')]: [3],
    [path.join(r, 'bin', 'monolith.bin')]: [5],
  });
  assert.deepEqual(prosProject(r, older)!.program, { kind: 'bin', file: path.join(r, 'bin', 'monolith.bin') });

  const unbuilt = fakeFs({ [path.join(r, 'project.pros')]: [1, '{}'] });
  assert.equal(prosProject(r, unbuilt)!.program, undefined);
  assert.match(prosProject(r, unbuilt)!.problem!, /build/);
  assert.equal(prosProject(path.join('w', 'none'), unbuilt), undefined);
});

const vexSettings = (language: string, extra = {}) => JSON.stringify({ project: {
  name: 'Bot', slot: 3, platform: 'V5', language, sdkVersion: 'V5_1_0_1_19', ...extra } });

test('VEXcode C++: the newest build/*.bin, in the project slot', () => {
  const r = path.join('w', 'cpp');
  const fs = fakeFs({
    [path.join(r, '.vscode', 'vex_project_settings.json')]: [1, vexSettings('cpp')],
    [path.join(r, 'build', 'old.bin')]: [5],
    [path.join(r, 'build', 'Bot.bin')]: [9],
    [path.join(r, 'build', 'Bot.elf')]: [9],
  });
  const p = vexProject(r, fs, undefined)!;
  assert.deepEqual(p.program, { kind: 'bin', file: path.join(r, 'build', 'Bot.bin') });
  assert.equal(p.slot, 3);
});

test('VEXcode Python: main.py with the SDK VM (project version, else newest)', () => {
  const r = path.join('w', 'py'), sdk = path.join('g', 'sdk', 'python');
  const vm = (v: string) => path.join(sdk, 'V5', v, 'vexv5', 'vm', 'python_vm.bin');
  const fs = fakeFs({
    [path.join(r, '.vscode', 'vex_project_settings.json')]: [1, vexSettings('python')],
    [path.join(r, 'src', 'main.py')]: [2],
    [vm('V5_1_0_1_9')]: [1], [vm('V5_1_0_1_19')]: [1], [vm('V5_1_0_1_25')]: [1],
  });
  assert.deepEqual(vexProject(r, fs, sdk)!.program, { kind: 'python', file: path.join(r, 'src', 'main.py'), link: vm('V5_1_0_1_19') });
  assert.equal(pythonVm(sdk, 'V5_9_9', fs), vm('V5_1_0_1_25'));           // not installed: the newest
  const noSdk = vexProject(r, fs, undefined)!;
  assert.equal(noSdk.program, undefined);
  assert.match(noSdk.problem!, /Python runtime/);
});

test('VEXcode Python: the settings main path; a missing main.py; not V5', () => {
  const r = path.join('w', 'py2'), sdk = path.join('g', 'sdk', 'python');
  const fs = fakeFs({
    [path.join(r, '.vscode', 'vex_project_settings.json')]: [1, vexSettings('python', { python: { main: 'robot.py' } })],
    [path.join(r, 'robot.py')]: [2],
    [path.join(sdk, 'V5', 'V5_1_0_1_25', 'vexv5', 'vm', 'python_vm.bin')]: [1],
  });
  assert.equal(vexProject(r, fs, sdk)!.program?.file, path.join(r, 'robot.py'));
  const missing = fakeFs({ [path.join(r, '.vscode', 'vex_project_settings.json')]: [1, vexSettings('python')] });
  assert.match(vexProject(r, missing, sdk)!.problem!, /main\.py/);
  const iq = fakeFs({ [path.join(r, '.vscode', 'vex_project_settings.json')]: [1, vexSettings('cpp', { platform: 'IQ2' })] });
  assert.match(vexProject(r, iq, sdk)!.problem!, /IQ2/);
});

test('a file\'s project: the folder with project.pros or VEX settings above it', () => {
  const r = path.join('w', 'robot');
  const fs = fakeFs({ [path.join(r, 'project.pros')]: [1, prosJson], [path.join(r, 'bin', 'hot.package.bin')]: [2] });
  assert.equal(projectRoot(path.join(r, 'bin', 'hot.package.bin'), fs), r);
  assert.equal(projectRoot(path.join('elsewhere', 'x.bin'), fs), undefined);
  assert.equal(project(r, fs, undefined)?.label, 'PROS project robot');
});

test('SDK versions compare by number', () => {
  assert.ok(compareVersions('V5_1_0_1_25', 'V5_1_0_1_9') > 0);
  assert.ok(compareVersions('V5_1_0_2', 'V5_1_0_1_99') > 0);
  assert.equal(compareVersions('V5_1_0_1', 'V5_1_0_1'), 0);
});
