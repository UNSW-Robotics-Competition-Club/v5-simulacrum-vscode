// One simulator instance: started by this extension (a child process running
// scripts/v5brain.sh), or one already running that we attach the panes to.
//
// Stopping is always the graceful `v5fleet.sh stop <id>` (QEMU quits through
// QMP and the USB/IP brain detaches from Windows): killing the processes can
// crash usbip-win2's driver (v5-sim README, "Cautions").
import { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as vscode from 'vscode';

import { Running, parseInstanceLine } from './instanceLine';
import { Runner, isWindows, usbipBrainAttached, usbipExe } from './runner';
import { mode, simRunner } from './runtime';
import { cfg, presetFile, slotSetting } from './settings';
import { OutputBudget } from './outputBudget';
import { offerUsbDriver } from './usbDriver';
import { INTEROP_REPAIR, attachBrain, attachedVport, detachBrain, usbipPorts } from './usbip';

/** How long stop() waits for an attach still in flight before going on. */
const ATTACH_WAIT_ON_STOP_MS = 5_000;
/** How long start() waits for v5brain.sh to say which instance it is. */
const START_TIMEOUT_MS = 120_000;
/** Instance N's USB/IP server is on localhost:BASE+N (v5brain.sh, v5fleet.sh). */
const USBIP_BASE_PORT = 3300;

export type State = 'stopped' | 'starting' | 'running' | 'stopping';

export type { Running };

/** A program to install and run for this start only (not saved to settings);
 *  link: what it is linked to (a PROS cold package, VEX's Python VM). */
export interface RunOnce { program: string; slot: number; link?: string }

export class SimInstance implements vscode.Disposable {
  state: State = 'stopped';
  current?: Running;
  private proc?: ChildProcess;
  private exited?: Promise<void>;
  /** WSL can't run usbip.exe, so we attach the brain from Windows ourselves */
  private attachFromWindows = false;
  /** the Windows usbip port we attached the brain to (we detach it) */
  private vport?: number;
  /** our attach while it runs: stop and exit wait for it, then detach */
  private attaching?: Promise<void>;
  private readonly changed = new vscode.EventEmitter<SimInstance>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly log: vscode.OutputChannel) {}

  private set(state: State, current = this.current) {
    this.state = state;
    this.current = current;
    this.changed.fire(this);
  }

  runner(): Promise<Runner | undefined> {
    return simRunner();
  }

  get owned(): boolean { return !!this.proc; }

  async start(once?: RunOnce): Promise<void> {
    if (this.state !== 'stopped') {
      vscode.window.showInformationMessage(`The simulator is already ${this.state}.`);
      return;
    }
    const runner = await this.runner();
    if (!runner) return;
    const c = cfg();
    const preset = presetFile(runner.repo);
    if (!fs.existsSync(preset)) {
      vscode.window.showErrorMessage(`No robot preset ${preset}. Set v5sim.preset, or make one with "V5 Sim: Configure Ports".`);
      return;
    }
    this.set('starting', undefined);
    try {
      const args = ['--id', c.get<string>('instanceId', 'auto') || 'auto'];
      // the bundled QEMU has no window of its own: its screen is the VS Code pane
      if (mode() === 'bundled' || !c.get<boolean>('showBrainWindow', false)) args.push('--headless');
      this.attachFromWindows = false;
      const usb = await this.usbOption(c.get<string>('usb', 'auto'), runner);
      if (usb) args.push(usb);
      const extra = c.get<string>('extraRobotArgs', '').trim();
      args.push('--robot', `@${await runner.stage(preset)}${extra ? ' ' + extra : ''}`);
      const program = once?.program ?? c.get<string>('program', '').trim();
      if (program) {
        if (!fs.existsSync(program)) throw new Error(`no such program: ${program}`);
        const slot = once?.slot ?? slotSetting();
        args.push('--run', await runner.stage(program), '--slot', String(slot));
        if (once?.link) {
          if (!fs.existsSync(once.link)) throw new Error(`no such file: ${once.link}`);
          args.push('--link', await runner.stage(once.link));
        }
      }
      this.log.appendLine(`> v5brain.sh ${args.join(' ')}`);
      const proc = await runner.spawnScript('v5brain.sh', args);
      this.proc = proc;
      let buffer = '';
      const budget = new OutputBudget();
      const timer = setTimeout(() => this.abandonStart(proc,
        `it didn't say which instance it is within ${START_TIMEOUT_MS / 1000} s`), START_TIMEOUT_MS);
      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        const shown = budget.take(text, Date.now());
        if (shown) this.log.append(shown);
        buffer = (buffer + text).slice(-4096);
        // whole lines only: the instance line can arrive in two chunks
        const running = parseInstanceLine(buffer.slice(0, buffer.lastIndexOf('\n') + 1));
        if (running && this.state === 'starting' && this.proc === proc) {
          clearTimeout(timer);
          buffer = '';
          this.set('running', running);
          if (this.attachFromWindows && running.usbipPort) {
            this.attaching = this.attachUsb(running.usbipPort, runner, proc);
          }
        }
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      this.exited = new Promise(resolve => proc.on('close', (code, signal) => {
        clearTimeout(timer);
        this.log.appendLine(`[v5sim] the simulator exited (${signal ?? `code ${code}`})`);
        if (this.proc === proc) {
          this.proc = undefined;
          this.set('stopped', undefined);
        }
        // The USB/IP server is gone with the sim, so a port we attached is
        // NOT detached now (detaching after the server is gone can bugcheck
        // usbip-win2); stop() detaches before the sim quits.
        void Promise.resolve(this.attaching)
          .catch(() => undefined)
          .then(() => this.forgetUsb('the simulator exited before its brain was taken off Windows USB'))
          .finally(() => resolve());
      }));
      proc.on('error', e => {
        // 'close' need not follow a failed spawn: don't stay 'starting'
        clearTimeout(timer);
        this.abandonStart(proc, e.message);
      });
    } catch (e) {
      this.set('stopped', undefined);
      vscode.window.showErrorMessage(`Couldn't start the simulator: ${(e as Error).message}`);
    }
  }

  /** Give up on a start that never announced its instance (or couldn't
   *  spawn). The process isn't killed (see the top of this file); if it comes
   *  up later, its panes can still be opened from the menu. */
  private abandonStart(proc: ChildProcess, why: string): void {
    this.log.appendLine(`[v5sim] couldn't start: ${why}`);
    if (this.proc !== proc || this.state !== 'starting') return;
    this.proc = undefined;
    this.set('stopped', undefined);
    const show = 'Show log';
    void vscode.window.showErrorMessage(`Couldn't start the simulator: ${why}.`, show).then(pick => {
      if (pick === show) this.log.show();
    });
  }

  /** --usbip / --usb / nothing, as V5Sim.cmd picks it. */
  private async usbOption(mode: string, runner: Runner): Promise<string | undefined> {
    if (mode === 'none') return undefined;
    if (mode === 'pty') return '--usb';
    const exe = usbipExe();
    if (isWindows && !exe) void offerUsbDriver(); // not awaited: starting goes on
    if (mode === 'usbip') {
      if (isWindows && !exe) {
        this.log.appendLine(`[v5sim] v5sim.usb is "usbip", but usbip-win2 isn't installed: using WSL serial ports`);
        return '--usb';
      }
      return this.usbip(exe, runner);
    }
    if (!exe) return '--usb';
    if (await usbipBrainAttached(exe)) {
      this.log.appendLine('[v5sim] a V5 brain is already on Windows USB (usbip-win2 takes one at a time): using WSL serial ports');
      return '--usb';
    }
    return this.usbip(exe, runner);
  }

  /** --usbip; when WSL can't run usbip.exe (interop unregistered, e.g. by
   *  systemd-binfmt), v5brain.sh can't attach the brain, so we will. */
  private async usbip(exe: string | undefined, runner: Runner): Promise<string> {
    if (isWindows && exe && !(await runner.canRunWindowsExe(exe))) {
      this.log.appendLine("[v5sim] WSL can't run Windows programs (WSL interop is off), so v5brain.sh can't attach the brain: attaching it from Windows");
      this.attachFromWindows = true;
    }
    return '--usbip';
  }

  /** Attach the run's brain to Windows USB from here (usbip-win2). The port
   *  is recorded even if a stop began meanwhile: stop() and the exit handler
   *  wait for this, then detach it while the USB/IP server still answers. */
  private async attachUsb(tcpPort: number, runner: Runner, proc: ChildProcess): Promise<void> {
    const exe = usbipExe();
    if (!exe) return;
    this.log.appendLine(`> usbip attach -r localhost -b 1-1 (port ${tcpPort})`);
    const r = await attachBrain(exe, tcpPort, () => this.proc === proc && this.state === 'running');
    this.log.appendLine(`[v5sim] Windows: ${r.output}`);
    if (r.vport === undefined) {
      if (this.proc === proc && this.state === 'running') {
        vscode.window.showErrorMessage(`The simulated brain isn't on Windows USB: ${r.output}`);
      }
      return;
    }
    if (this.proc !== proc) {
      // this run is over (or a newer one started) and its server with it:
      // leave the port alone rather than detach it from a dead server
      this.log.appendLine(`[v5sim] attached usbip port ${r.vport} after the simulator had exited; left as is`);
      return;
    }
    this.vport = r.vport;
    if (this.state === 'running') void this.offerInteropRepair(runner, exe);
  }

  /** Drop a port we can no longer detach safely, saying so. */
  private forgetUsb(why: string): void {
    if (this.vport === undefined) return;
    this.log.appendLine(`[v5sim] ${why} (usbip port ${this.vport}); left as is`);
    this.vport = undefined;
  }

  /** Take the instance's brain off Windows USB before it quits, while its
   *  USB/IP server still answers. The port is the one we attached, else
   *  looked up: one attached by v5brain.sh, or by us before a window reload
   *  (when WSL can't run usbip.exe, nothing else would detach it). */
  private async detachUsb(cur: Running): Promise<void> {
    const exe = usbipExe();
    let vport = this.vport;
    this.vport = undefined;
    if (!exe || !isWindows) return;
    if (vport === undefined) {
      vport = attachedVport(await usbipPorts(exe), cur.usbipPort ?? USBIP_BASE_PORT + cur.id);
    }
    if (vport === undefined) return;
    this.log.appendLine(`> usbip detach -p ${vport}`);
    const r = await detachBrain(exe, vport);
    this.log.appendLine(`[v5sim] Windows: ${r.output}`);
  }

  private async offerInteropRepair(runner: Runner, exe: string): Promise<void> {
    const fix = 'Fix WSL';
    const pick = await vscode.window.showWarningMessage(
      `WSL in ${runner.distro} can't run Windows programs (WSL interop is off, usually after systemd-binfmt resets it at boot). ` +
      'The extension attached the simulated brain to USB itself. Fix WSL so the simulator can do it, now and after reboots?',
      fix);
    if (pick !== fix) return;
    const r = await runner.rootShell(INTEROP_REPAIR);
    this.log.appendLine(`> wsl -u root: ${INTEROP_REPAIR}`);
    if (r.stdout || r.stderr) this.log.append(r.stdout + r.stderr);
    if (r.code === 0 && await runner.canRunWindowsExe(exe)) {
      vscode.window.showInformationMessage('WSL interop fixed (and set up to stay on after reboots).');
    } else {
      vscode.window.showErrorMessage(`Couldn't fix WSL interop: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}. See the V5 Sim output.`);
    }
  }

  /** Graceful stop: QMP quit through v5fleet.sh, then wait for our child. */
  async stop(): Promise<void> {
    if (this.state === 'starting') {
      // wait for the instance line, so we know its id
      await new Promise<void>(resolve => {
        const t = setTimeout(() => { d.dispose(); resolve(); }, 30_000);
        const d = this.onDidChange(() => {
          if (this.state !== 'starting') { clearTimeout(t); d.dispose(); resolve(); }
        });
      });
    }
    const cur = this.current;
    if (!cur) {
      if (this.proc) {
        vscode.window.showWarningMessage('The simulator never said which instance it is; stop it with `v5sim stop <id>`.');
      }
      return;
    }
    const runner = await this.runner();
    if (!runner) return;
    this.set('stopping');
    // Detach before QEMU quits, while the USB/IP server still answers; an
    // attach still in flight finishes first so its port is detached too.
    // Bounded: on a window reload VS Code allows deactivate() only seconds.
    await Promise.race([
      Promise.resolve(this.attaching).catch(() => undefined),
      new Promise(ok => setTimeout(ok, ATTACH_WAIT_ON_STOP_MS)),
    ]);
    await this.detachUsb(cur);
    this.log.appendLine(`> v5fleet.sh stop ${cur.id}`);
    const r = await runner.runScript('v5fleet.sh', ['stop', String(cur.id)]);
    this.log.append(r.stdout + r.stderr);
    if (this.proc && this.exited) {
      await Promise.race([this.exited, new Promise(ok => setTimeout(ok, 20_000))]);
    }
    if (this.proc) {
      this.log.appendLine('[v5sim] still running after stop; leaving it (never killed: see v5-sim README)');
      this.set('running', cur);
    } else {
      this.set('stopped', undefined);
    }
  }

  async restart(once?: RunOnce): Promise<void> {
    if (this.state !== 'stopped') await this.stop();
    if (this.state === 'stopped') await this.start(once);
  }

  /** Instances running now (ours or started elsewhere): v5fleet.sh list. */
  async list(): Promise<Running[]> {
    const runner = await this.runner();
    if (!runner) return [];
    const r = await runner.runScript('v5fleet.sh', ['list'], 20_000);
    const out: Running[] = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = /^(\d+)\s+up\s+(\d+)/.exec(line.trim());
      if (m) out.push({ id: +m[1], viewPort: +m[2] });
    }
    return out;
  }

  /** The instance the panes should show: ours, or pick a running one. */
  async target(): Promise<Running | undefined> {
    if (this.current) return this.current;
    if (this.state === 'starting') {
      vscode.window.showInformationMessage('The simulator is still starting.');
      return undefined;
    }
    const running = await this.list();
    if (running.length === 1) return this.attach(running[0]);
    if (running.length === 0) {
      const pick = await vscode.window.showInformationMessage('No simulator is running.', 'Start one');
      if (pick) await this.start();
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      running.map(r => ({ label: `Instance ${r.id}`, description: `http://localhost:${r.viewPort}/`, r })),
      { placeHolder: 'Which simulator?' });
    return pick ? this.attach(pick.r) : undefined;
  }

  private attach(r: Running): Running {
    this.set('running', r);
    return r;
  }

  /** Forget an attached instance that has gone away. */
  detach(): void {
    if (!this.proc) this.set('stopped', undefined);
  }

  dispose(): void {
    this.changed.dispose();
  }
}

