#!/usr/bin/env node
// The extension's bundled-mode code path, without VS Code, against a built
// runtime: unpack it with installScript (into a fresh HOME), fetch VEXos with
// fetch_firmware.sh, start v5brain.sh as SimInstance does, read the instance
// line, check /screen.png and /touch, stop with v5fleet.sh. Only the system's
// own folders are on PATH, as on a Mac or WSL without Homebrew or apt extras.
//   npx tsc -p . && node bundle/ext-smoke.js out/runtime-<plat>.tar.gz
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Runner } = require('../out/src/runner');
const { installScript, parseInstallOutput, bundledEnv } = require('../out/src/runtimeCore');
const { parseInstanceLine } = require('../out/src/instanceLine');

const tgz = path.resolve(process.argv[2]);
process.env.HOME = fs.mkdtempSync('/tmp/v5home-');
process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
process.env.V5SIM_NO_BROWSER = '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const setup = new Runner(path.dirname(tgz), 'unused');
  const inst = await setup.shell(installScript(tgz, 'ci'), 180000);
  console.log(inst.stdout, inst.stderr);
  const paths = parseInstallOutput(inst.stdout);
  if (inst.code !== 0 || !paths) throw new Error('install failed');
  const { env, pathPrefix } = bundledEnv(paths);
  const root = `${paths.runtime}/sim`;
  const runner = new Runner(root, 'unused', { unixRoot: root, env, pathPrefix });

  const fw = await runner.runScript('fetch_firmware.sh', [], 300000);
  console.log(fw.stdout, fw.stderr);
  if (fw.code !== 0) throw new Error('firmware failed');

  const proc = await runner.spawnScript('v5brain.sh',
    ['--id', 'auto', '--headless', '--usb', '--robot', `@${root}/sim/robots/competition.args`]);
  let buf = '';
  const onData = d => { process.stdout.write(d); buf += d.toString(); };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  const closed = new Promise(r => proc.on('close', r));

  let running;
  for (let i = 0; i < 600 && !running; i++) {
    running = parseInstanceLine(buf.slice(0, buf.lastIndexOf('\n') + 1));
    await sleep(100);
  }
  if (!running) throw new Error('no instance line');
  console.log('instance', JSON.stringify(running));
  if (!running.ttySys) throw new Error('no USB serial ports in the instance line');
  // ...and the ports themselves: the USB bridge (v5usb_pty.py) makes them
  // once QEMU's USB sockets are up
  for (const tty of [running.ttySys, running.ttyUser]) {
    let ok = false;
    for (let i = 0; i < 300 && !ok; i++) { ok = fs.existsSync(tty); if (!ok) await sleep(100); }
    if (!ok) throw new Error(`USB serial port ${tty} never appeared`);
    console.log('usb port', tty, '->', fs.realpathSync(tty));
  }

  const base = `http://localhost:${running.viewPort}`;
  let png;
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch(`${base}/screen.png`); if (r.ok) { png = Buffer.from(await r.arrayBuffer()); break; } } catch {}
    await sleep(1000);
  }
  await sleep(6000);
  png = Buffer.from(await (await fetch(`${base}/screen.png`)).arrayBuffer());
  if (png.readUInt32BE(16) !== 480 || png.readUInt32BE(20) !== 272) throw new Error('bad screen.png');
  fs.writeFileSync('smoke-screen.png', png);
  for (const down of [true, false]) {
    const r = await fetch(`${base}/touch`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ x: 240, y: 136, down }) });
    if (r.status !== 204) throw new Error(`touch: ${r.status}`);
  }
  console.log('screen 480x272, touch ok');

  const stop = await runner.runScript('v5fleet.sh', ['stop', String(running.id)]);
  console.log(stop.stdout, stop.stderr);
  await Promise.race([closed, sleep(20000)]);
  if (proc.exitCode === null) throw new Error('v5brain.sh still running after stop');
  console.log('EXT SMOKE OK');
}

main().catch(e => { console.error('EXT SMOKE FAILED:', e); process.exit(1); });
