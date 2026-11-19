// Runs test/e2e/suite.ts inside a downloaded VS Code (not your own install)
// with this extension loaded and a small project as the workspace. Needs a
// feedback Worker: E2E_ENDPOINT (default: wrangler dev on localhost:8799) and
// E2E_TOKEN, its ADMIN_TOKEN.
//   npx tsc -p . && node out/test/e2e/runE2E.js
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..', '..', '..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'v5sim-e2e-'));
  const project = path.join(work, 'my robot');
  const w = (rel: string, data: string) => {
    fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
    fs.writeFileSync(path.join(project, rel), data);
  };
  w('project.pros', '{}');
  w('src/main.cpp', '#include "main.h"\nvoid opcontrol() { /* e2e */ }\n');
  w('include/main.h', '#pragma once\n');
  w('.env', 'API_KEY=do-not-send');
  w('bin/monolith.bin', 'binary');
  // a project trying to send its users' reports elsewhere
  w('.vscode/settings.json', '{ "v5sim.feedbackEndpoint": "https://attacker.invalid" }');
  await runTests({
    version: process.env.E2E_VSCODE ?? 'stable',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    launchArgs: [project, '--disable-extensions', `--user-data-dir=${path.join(work, 'user')}`],
    extensionTestsEnv: {
      E2E_ENDPOINT: process.env.E2E_ENDPOINT ?? 'http://localhost:8799',
      E2E_TOKEN: process.env.E2E_TOKEN ?? '',
      E2E_WORK: work,
    },
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
