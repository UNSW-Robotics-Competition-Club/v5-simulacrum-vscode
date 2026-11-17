// usbip-win2 from the Windows side, for when WSL can't attach the brain itself.
//
// v5brain.sh --usbip attaches the brain by running Windows' usbip.exe through
// WSL interop. Ubuntu 24.04's systemd-binfmt can unregister WSLInterop at boot,
// and then every .exe fails in WSL ("Exec format error"): the USB/IP server is
// up but nothing attaches, so no brain appears on Windows USB. The extension
// runs on Windows, so it can attach (and detach) the brain itself.
// No VS Code imports: the tests run it under plain Node.
import { execFile } from 'node:child_process';
import * as net from 'node:net';

/** Re-registers WSL interop now, and at every boot through systemd-binfmt
 *  (run as root in the distro: `wsl -u root`). */
export const INTEROP_REPAIR =
  'mkdir -p /etc/binfmt.d && ' +
  "echo ':WSLInterop:M::MZ::/init:PF' > /etc/binfmt.d/WSLInterop.conf && " +
  "{ [ -e /proc/sys/fs/binfmt_misc/WSLInterop ] || " +
  "echo ':WSLInterop:M::MZ::/init:PF' > /proc/sys/fs/binfmt_misc/register; }";

/** usbip-win2 for the simulator's brain. Pinned: 0.9.7.8 is the version the
 *  simulator is tested with (0.9.8.x is a large rewrite its notes warn may
 *  regress). winget checks the signed installer's hash. */
export const USBIP_WINGET_ID = 'vadimgrn.usbip-win2';
export const USBIP_PINNED_VERSION = '0.9.7.8';
export const USBIP_RELEASE_URL =
  `https://github.com/vadimgrn/usbip-win2/releases/tag/v.${USBIP_PINNED_VERSION}`;
export const WINGET_INSTALL_ARGS: readonly string[] = [
  'install', '--id', USBIP_WINGET_ID, '--exact', '--version', USBIP_PINNED_VERSION,
  '--accept-package-agreements', '--accept-source-agreements',
];

const ATTACH_TIMEOUT_MS = 30_000;
const LISTEN_WAIT_MS = 15_000;
const LISTEN_POLL_MS = 250;

export interface UsbipResult { ok: boolean; output: string }

/** "succesfully attached to port 1" (sic) -> 1 */
export function parseAttachedPort(output: string): number | undefined {
  const m = /attached to port (\d+)/i.exec(output);
  return m ? +m[1] : undefined;
}

/** The Windows port (from `usbip port`) holding the device served on
 *  localhost:tcpPort, if any. */
export function attachedVport(portOutput: string, tcpPort: number): number | undefined {
  let current: number | undefined;
  for (const line of portOutput.split(/\r?\n/)) {
    const head = /^Port (\d+):/.exec(line);
    if (head) current = +head[1];
    else if (current !== undefined && line.includes(`usbip://localhost:${tcpPort}/`)) return current;
  }
  return undefined;
}

/** The port an attach went to: from its output, else from `usbip port`
 *  (another usbip-win2 version or language words it differently). */
export function resolveVport(attachOutput: string, portOutput: string, tcpPort: number): number | undefined {
  return parseAttachedPort(attachOutput) ?? attachedVport(portOutput, tcpPort);
}

function run(exe: string, args: string[]): Promise<UsbipResult> {
  return new Promise(resolve => {
    execFile(exe, args, { timeout: ATTACH_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, output: `${stdout ?? ''}${stderr ?? ''}`.trim() || (err?.message ?? '') }));
  });
}

export async function usbipPorts(exe: string): Promise<string> {
  return (await run(exe, ['port'])).output;
}

function listening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1_000, () => done(false));
  });
}

/** Wait for the sim's USB/IP server, then attach its brain once, unless
 *  stillWanted() turns false first (the sim is stopping). Returns the Windows
 *  port, or the error output. */
export async function attachBrain(exe: string, tcpPort: number,
                                  stillWanted: () => boolean = () => true): Promise<{ vport?: number; output: string }> {
  const deadline = Date.now() + LISTEN_WAIT_MS;
  while (!(await listening(tcpPort))) {
    if (!stillWanted()) return { output: 'the simulator is stopping: not attached' };
    if (Date.now() > deadline) return { output: `nothing is listening on localhost:${tcpPort}` };
    await new Promise(ok => setTimeout(ok, LISTEN_POLL_MS));
  }
  if (!stillWanted()) return { output: 'the simulator is stopping: not attached' };
  // already there (WSL attached it after all): never attach twice, a second
  // attach can crash usbip-win2's driver
  const already = attachedVport(await usbipPorts(exe), tcpPort);
  if (already !== undefined) return { vport: already, output: `already on port ${already}` };
  // --once: no retry loop that stacks dead COM ports (see v5brain.sh)
  const r = await run(exe, ['-t', String(tcpPort), 'attach', '-r', 'localhost', '-b', '1-1', '--once']);
  // look it up even after an error: never leave an attached port untracked
  return { vport: resolveVport(r.output, await usbipPorts(exe), tcpPort), output: r.output };
}

export function detachBrain(exe: string, vport: number): Promise<UsbipResult> {
  return run(exe, ['detach', '-p', String(vport)]);
}
