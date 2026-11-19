// When a build writes a program (.bin), whether to offer "Run on Sim".
// No VS Code imports: the tests run it under plain Node.

/** v5sim.runOnBuild */
export type RunOnBuild = 'ask' | 'always' | 'never';

/** A build's program: VEXcode's build/<project>.bin or PROS's bin/monolith.bin
 *  (not PROS's hot/cold halves, which only run together). */
export function isProgramBuild(file: string): boolean {
  const parts = file.split(/[\\/]/);
  const name = parts[parts.length - 1] ?? '';
  const folder = parts[parts.length - 2] ?? '';
  return /\.bin$/i.test(name) && /^(build|bin)$/i.test(folder) && !/(^|[._-])(hot|cold)([._-]|$)/i.test(name);
}

export interface Host {
  /** VS Code runs on a Mac */
  isMac: boolean;
  /** Windows with usbip-win2: the brain is on Windows USB and VEXcode's
   *  Download button reaches it */
  windowsUsb: boolean;
}

/** What to do with a new build: ask, run it, or nothing. */
export function buildAction(setting: string | undefined, host: Host): 'ask' | 'run' | 'none' {
  if (host.windowsUsb) return 'none';                // Download works there
  if (setting === 'never') return 'none';
  return setting === 'always' ? 'run' : 'ask';
}
