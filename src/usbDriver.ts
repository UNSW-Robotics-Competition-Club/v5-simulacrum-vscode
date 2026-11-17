// Installing usbip-win2, the Windows driver that puts the simulated brain on
// USB (so VEXcode and PROS can download to it). It's a kernel driver, so it is
// never installed silently: the user starts it, sees Windows' admin prompt and
// the installer, through winget in a terminal.
import * as vscode from 'vscode';

import { isWindows, onPath, usbipExe } from './runner';
import { USBIP_PINNED_VERSION, USBIP_RELEASE_URL, WINGET_INSTALL_ARGS } from './usbip';

const DECLINED_KEY = 'v5sim.usbDriverDeclined';
const INSTALL = 'Install USB driver';
const NEVER = "Don't ask again";

let memento: vscode.Memento | undefined;
let offeredThisSession = false;

export function initUsbDriver(context: vscode.ExtensionContext): void {
  memento = context.globalState;
}

/** The sim is starting without usbip-win2: say why the brain won't be on
 *  Windows USB and offer the driver (once a session, until declined). */
export async function offerUsbDriver(): Promise<void> {
  if (!isWindows || offeredThisSession || memento?.get<boolean>(DECLINED_KEY)) return;
  offeredThisSession = true;
  const pick = await vscode.window.showWarningMessage(
    "The simulated brain won't show up on Windows USB, so VEXcode and PROS can't download to it: " +
    "the usbip-win2 USB driver isn't installed. The simulator uses WSL serial ports for now " +
    '("Run Program on Sim" still works).',
    INSTALL, NEVER);
  if (pick === NEVER) await memento?.update(DECLINED_KEY, true);
  if (pick === INSTALL) await installUsbDriver();
}

/** V5 Sim: Install USB Driver. Resolves true once usbip.exe is there. */
export async function installUsbDriver(): Promise<boolean> {
  if (!isWindows) {
    vscode.window.showInformationMessage('The USB driver (usbip-win2) is only for Windows.');
    return false;
  }
  if (usbipExe()) {
    vscode.window.showInformationMessage('The USB driver (usbip-win2) is already installed.');
    return true;
  }
  if (!(await onPath('winget'))) return openReleasePage('winget (App Installer) isn\'t available');

  const terminal = vscode.window.createTerminal({
    name: 'V5 Sim: USB driver',
    shellPath: 'winget.exe',
    shellArgs: [...WINGET_INSTALL_ARGS],
  });
  terminal.show();
  vscode.window.showInformationMessage(
    `Installing usbip-win2 ${USBIP_PINNED_VERSION}: allow the Windows admin prompt, then follow the installer.`);
  const code = await new Promise<number | undefined>(resolve => {
    const d = vscode.window.onDidCloseTerminal(t => {
      if (t !== terminal) return;
      d.dispose();
      resolve(t.exitStatus?.code);
    });
  });
  if (!usbipExe()) return openReleasePage(`winget exited with code ${code ?? '?'}`);

  const restart = 'Restart simulator';
  const pick = await vscode.window.showInformationMessage(
    'The USB driver is installed. Restart the simulator to put its brain on Windows USB.', restart);
  if (pick === restart) await vscode.commands.executeCommand('v5sim.restart');
  return true;
}

async function openReleasePage(why: string): Promise<false> {
  const open = 'Open download page';
  const pick = await vscode.window.showErrorMessage(
    `Couldn't install the USB driver (${why}). Install usbip-win2 ${USBIP_PINNED_VERSION} ` +
    '(USBip-…-x64.exe) from its release page, then restart the simulator.', open);
  if (pick === open) await vscode.env.openExternal(vscode.Uri.parse(USBIP_RELEASE_URL));
  return false;
}
