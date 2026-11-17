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
import { Runner, usbipBrainAttached, usbipExe } from './runner';
import { cfg, presetFile, repoPath } from './settings';

export type State = 'stopped' | 'starting' | 'running' | 'stopping';

export type { Running };

/** A program to install and run for this start only (not saved to settings). */
export interface RunOnce { program: string; slot: number }

export class SimInstance implements vscode.Disposable {
  state: State = 'stopped';
  current?: Running;
  private proc?: ChildProcess;
  private exited?: Promise<void>;
  private readonly changed = new vscode.EventEmitter<SimInstance>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly log: vscode.OutputChannel) {}

  private set(state: State, current = this.current) {
    this.state = state;
    this.current = current;
    this.changed.fire(this);
  }

  async runner(): Promise<Runner | undefined> {
    const repo = await repoPath();
    return repo ? new Runner(repo, cfg().get('wslDistro', 'Ubuntu-24.04')) : undefined;
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
      if (!c.get<boolean>('showBrainWindow', false)) args.push('--headless');
      const usb = await this.usbOption(c.get<string>('usb', 'auto'));
      if (usb) args.push(usb);
      const extra = c.get<string>('extraRobotArgs', '').trim();
      args.push('--robot', `@${await runner.toUnix(preset)}${extra ? ' ' + extra : ''}`);
      const program = once?.program ?? c.get<string>('program', '').trim();
      if (program) {
        if (!fs.existsSync(program)) throw new Error(`no such program: ${program}`);
        const slot = once?.slot ?? c.get<number>('slot', 1);
        args.push('--run', await runner.toUnix(program), '--slot', String(slot));
      }
      this.log.appendLine(`> v5brain.sh ${args.join(' ')}`);
      const proc = await runner.spawnScript('v5brain.sh', args);
      this.proc = proc;
      let buffer = '';
      const onData = (chunk: Buffer) => {
        const text = chunk.toString();
        this.log.append(text);
        buffer = (buffer + text).slice(-4096);
        // whole lines only: the instance line can arrive in two chunks
        const running = parseInstanceLine(buffer.slice(0, buffer.lastIndexOf('\n') + 1));
        if (running && this.state === 'starting') {
          buffer = '';
          this.set('running', running);
        }
      };
      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);
      this.exited = new Promise(resolve => proc.on('close', (code, signal) => {
        this.log.appendLine(`[v5sim] the simulator exited (${signal ?? `code ${code}`})`);
        if (this.proc === proc) {
          this.proc = undefined;
          this.set('stopped', undefined);
        }
        resolve();
      }));
      proc.on('error', e => {
        this.log.appendLine(`[v5sim] couldn't start: ${e.message}`);
        vscode.window.showErrorMessage(`Couldn't start the simulator: ${e.message}`);
      });
    } catch (e) {
      this.set('stopped', undefined);
      vscode.window.showErrorMessage(`Couldn't start the simulator: ${(e as Error).message}`);
    }
  }

  /** --usbip / --usb / nothing, as V5Sim.cmd picks it. */
  private async usbOption(mode: string): Promise<string | undefined> {
    if (mode === 'none') return undefined;
    if (mode === 'pty') return '--usb';
    const exe = usbipExe();
    if (mode === 'usbip') return '--usbip';
    if (!exe) return '--usb';
    if (await usbipBrainAttached(exe)) {
      this.log.appendLine('[v5sim] a V5 brain is already on Windows USB (usbip-win2 takes one at a time): using WSL serial ports');
      return '--usb';
    }
    return '--usbip';
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

