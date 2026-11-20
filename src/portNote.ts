// A one-time note for people with both the VEXcode and PROS extensions:
// VEXcode's extension checks on the brain every 3 s while VS Code has the
// focus, opening its USB port each time, so a `pros upload` (or
// `cargo v5 upload`) that starts then fails with "could not open port"
// and works on the next try. Happens with a real brain too.
import * as vscode from 'vscode';

const SHOWN_KEY = 'v5sim.vexcodePortNoteShown';
const README = 'https://github.com/UNSW-Robotics-Competition-Club/v5-simulacrum-vscode#troubleshooting';

export async function vexcodePortNote(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(SHOWN_KEY)) return;
  if (!vscode.extensions.getExtension('vexrobotics.vexcode')) return;
  const uploader = vscode.extensions.getExtension('sigbots.pros')
    || (await vscode.workspace.findFiles('**/Cargo.toml', '**/{node_modules,target}/**', 1)).length > 0;
  if (!uploader) return;
  await context.globalState.update(SHOWN_KEY, true);
  const more = 'Learn more';
  const pick = await vscode.window.showInformationMessage(
    'With the VEXcode extension installed, a `pros upload` or `cargo v5 upload` can fail with "could not open port" ' +
    "and work on the next try: VEXcode's extension checks on the brain every few seconds. " +
    'Try again, or use V5 Sim: Run Program on Sim, which isn\'t affected.', more);
  if (pick === more) void vscode.env.openExternal(vscode.Uri.parse(README));
}
