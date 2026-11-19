// Loaded next to V5 Sim by test/e2e/runErrorReports.ts, in a VS Code that is
// NOT running extension tests (in a test run VS Code never sends extension
// telemetry, it only logs it). Sends error reports through V5 Sim's real
// path, switches reporting off two ways and tries again, writes PROBE_OUT
// and quits.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const GLOBAL = vscode.ConfigurationTarget.Global;

/** V5 Sim's own copy of a module (the drive letter's case may differ). */
function v5simModule(extPath, ...rel) {
  const want = path.join(extPath, 'out', 'src', ...rel).toLowerCase();
  const key = Object.keys(require.cache).find(k => k.toLowerCase() === want);
  if (!key) throw new Error(`${rel.join('/')} not loaded`);
  return require.cache[key].exports;
}

exports.activate = async () => {
  const out = process.env.PROBE_OUT;
  const steps = [];
  try {
    const ext = vscode.extensions.getExtension('unsw-robotics-competition-club.v5-simulacrum-vscode');
    await ext.activate();
    const { reportError } = v5simModule(ext.extensionPath, 'errors', 'errorReporting.js');
    const telemetry = vscode.workspace.getConfiguration('telemetry');

    await telemetry.update('telemetryLevel', 'all', GLOBAL);
    await sleep(1000);
    steps.push(`errors enabled: ${vscode.env.isTelemetryEnabled}`);
    reportError('start', `probe: the simulator never said which instance it is (${path.join(os.homedir(), 'robot')})`,
      { withLog: true });
    reportError('setup', new Error(`probe: VEXos download failed in ${path.join(os.homedir(), '.v5-simulacrum')}`));
    await sleep(3000);

    await telemetry.update('telemetryLevel', 'crash', GLOBAL);   // crashes only: no errors
    await sleep(1000);
    reportError('setup', 'probe: telemetry at crash level');
    await telemetry.update('telemetryLevel', 'all', GLOBAL);
    await sleep(1000);
    await vscode.workspace.getConfiguration('v5sim').update('errorReporting', false, GLOBAL);
    reportError('setup', 'probe: v5sim.errorReporting off');
    await sleep(3000);
    steps.push('done');
  } catch (e) {
    steps.push(`error: ${e.stack || e}`);
  }
  fs.writeFileSync(out, steps.join('\n'));
  await vscode.commands.executeCommand('workbench.action.quit');
};
