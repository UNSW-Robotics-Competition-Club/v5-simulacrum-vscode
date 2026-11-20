// Before a project's program goes onto the simulated brain: if its build is
// older than its source, say so and let the user build first or run the old
// build. Nothing builds unless the user picks "Build and run".
import * as path from 'node:path';
import * as vscode from 'vscode';

import { BuildStep, Fs, Program, buildFor, project, projectRoot, staleSource } from './programs';
import { terminalEnv } from './runner';

/** How long to wait for a build started through another extension's
 *  command (VEXcode's), which doesn't say when it has finished or failed. */
const COMMAND_BUILD_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 1_000;
/** The build watcher offers a new build this long after its last write:
 *  keep its offer away for a while after our own build. */
const OFFER_QUIET_MS = 10_000;

/** Projects being built by "Build and run" (and briefly after): the build
 *  watcher doesn't offer their builds, which this run is about to use. */
const building = new Map<string, number>();
export function buildingHere(root: string): boolean {
  const until = building.get(root);
  return until !== undefined && (until === Infinity || Date.now() < until);
}

/** The program to run: the given one, or a new build of it.
 *  undefined: don't run (cancelled, or the build failed). */
export async function upToDate(program: Program, fs: Fs, sdkRoot: string | undefined): Promise<Program | undefined> {
  const root = projectRoot(program.file, fs);
  if (!root) return program;
  const changed = staleSource(root, program, fs);
  if (!changed) return program;
  const step = buildFor(root, program, fs);
  const build = 'Build and run', anyway = 'Run anyway';
  const pick = await vscode.window.showWarningMessage(
    `${path.basename(root)}'s build is older than its source (${path.relative(root, changed)} changed). Build it first?`,
    ...(step ? [build, anyway] : [anyway]));
  if (pick === anyway) return program;
  if (pick !== build || !step) return undefined;

  // what the user chose: the project's own program (rebuilt: hot/cold may
  // become the monolith or back), or a particular file (the same file, rebuilt)
  const own = project(root, fs, sdkRoot)?.program;
  const isOwn = !own || own.file === program.file;
  const before = fs.mtime(program.file);
  building.set(root, Infinity);
  try {
    if (!await runBuild(root, step, program, fs, before)) return undefined;
  } finally {
    building.set(root, Date.now() + OFFER_QUIET_MS);
  }
  const fresh = isOwn ? project(root, fs, sdkRoot)?.program ?? program : program;
  if (fs.mtime(fresh.file) <= before) {
    void vscode.window.showWarningMessage(`The build of ${path.basename(root)} didn't write a new ${path.basename(fresh.file)}: see its output.`);
    return undefined;
  }
  return fresh;
}

/** Runs the build; true when it succeeded. */
async function runBuild(root: string, step: BuildStep, program: Program, fs: Fs, before: number): Promise<boolean> {
  if ('shell' in step) return runShellBuild(root, step.shell);
  try {
    await vscode.commands.executeCommand(step.command);
  } catch (e) {
    void vscode.window.showErrorMessage(`Couldn't start the build (${step.command}): ${(e as Error).message ?? e}`);
    return false;
  }
  return waitForNewProgram(root, program, fs, before);
}

/** A shell build as a VS Code task (its output in the terminal panel),
 *  with a cancellable progress notification. */
function runShellBuild(root: string, command: string): Thenable<boolean> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
    title: `Building ${path.basename(root)} (${command})...` }, async (_p, token) => {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
    // an id in the definition finds this run's end (listening before it starts)
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const task = new vscode.Task({ type: 'v5sim-build', id }, folder ?? vscode.TaskScope.Workspace, `Build ${path.basename(root)}`,
      'V5 Sim', new vscode.ShellExecution(command, { cwd: root, env: terminalEnv() }));
    const ours = (e: { execution: vscode.TaskExecution }) => e.execution.task.definition.id === id;
    const subs: vscode.Disposable[] = [];
    let execution: vscode.TaskExecution | undefined;
    try {
      const code = await new Promise<number | undefined>((resolve, reject) => {
        subs.push(vscode.tasks.onDidEndTaskProcess(e => { if (ours(e)) resolve(e.exitCode); }));
        // ends without a process (the shell couldn't start, or it was stopped)
        subs.push(vscode.tasks.onDidEndTask(e => { if (ours(e)) resolve(undefined); }));
        subs.push(token.onCancellationRequested(() => { execution?.terminate(); resolve(undefined); }));
        vscode.tasks.executeTask(task).then(x => { execution = x; }, reject);
      });
      if (token.isCancellationRequested) return false;
      if (code !== 0) {
        void vscode.window.showErrorMessage(`${command} failed${code === undefined ? '' : ` (exit code ${code})`}: see its output in the terminal.`);
        return false;
      }
      return true;
    } catch (e) {
      void vscode.window.showErrorMessage(`Couldn't run ${command}: ${(e as Error).message ?? e}`);
      return false;
    } finally {
      subs.forEach(d => d.dispose());
    }
  });
}

/** Another extension's build, which doesn't say when it ends: wait for the
 *  program to be rewritten and then left alone for a moment (not a file
 *  half written). A failed build writes nothing: say so after the timeout. */
function waitForNewProgram(root: string, program: Program, fs: Fs, before: number): Thenable<boolean> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
    title: `Waiting for VEXcode to build ${path.basename(root)}...` }, async (_p, token) => {
    const end = Date.now() + COMMAND_BUILD_TIMEOUT_MS;
    let last = before;
    while (!token.isCancellationRequested && Date.now() < end) {
      await new Promise(r => setTimeout(r, POLL_MS));
      const file = project(root, fs, undefined)?.program?.file ?? program.file;
      const m = fs.mtime(file);
      if (m > before && m === last) return true;                 // written, and not changing
      last = m;
    }
    if (!token.isCancellationRequested) {
      void vscode.window.showWarningMessage(
        `No new build of ${path.basename(root)} after ${COMMAND_BUILD_TIMEOUT_MS / 60_000} minutes: check VEXcode's build output (it may have failed).`);
    }
    return false;
  });
}
