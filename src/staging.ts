// A no-space copy of a file for the simulator's scripts. v5brain.sh splits
// --robot on spaces (it holds several options) and refuses --run paths with
// spaces or wildcards, so a preset or program in e.g. "OneDrive - School"
// or "C:\Users\First Last" is copied to a staging folder first.
// No VS Code imports: the tests run it under plain Node.
import { createHash } from 'node:crypto';

import { sh } from './runner';

/** Whether the scripts can't take this (Linux/macOS) path as it is. */
export function needsStaging(unixPath: string): boolean {
  return /[\s*?[\]]/.test(unixPath);
}

/** A name the scripts take: v5brain.sh derives the program's name from it. */
export function stagedName(unixPath: string): string {
  const base = unixPath.split('/').pop() || 'file';
  return base.replace(/[^\w.-]/g, '_');
}

/** Shell script: copy unixPath to a staging folder of its own (keyed by the
 *  source path, so two presets with one name don't collide) and print the
 *  copy's path. */
export function stageScript(unixPath: string): string {
  const key = createHash('sha1').update(unixPath).digest('hex').slice(0, 10);
  const dir = `"\${TMPDIR:-/tmp}/v5sim-stage-$(id -u)/${key}"`;
  const dst = `${dir.slice(0, -1)}/${stagedName(unixPath)}"`;
  return `set -e; mkdir -p ${dir}; cp -- ${sh(unixPath)} ${dst}; printf '%s' ${dst}`;
}
