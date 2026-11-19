// End-to-end check of the extension's feedback modules against a running
// feedback Worker (not part of `npm test`: it needs a Worker).
//   cd feedback-worker && npx wrangler dev --port 8799   (ADMIN_TOKEN in .dev.vars)
//   npx tsc -p . && V5SIM_FEEDBACK_URL=http://localhost:8799 V5SIM_FEEDBACK_TOKEN=... node test/feedback-worker.integration.mjs
// Against the deployed Worker it leaves one report behind (summary starts "[integration test]").
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const out = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'out', 'src', 'feedback');
const { zip } = require(path.join(out, 'zip.js'));
const { scanProject } = require(path.join(out, 'projectFiles.js'));
const { buildReport, bundleEntries } = require(path.join(out, 'report.js'));
const { submitReport, SubmitError } = require(path.join(out, 'submit.js'));

const base = process.env.V5SIM_FEEDBACK_URL ?? 'http://localhost:8799';
const token = process.env.V5SIM_FEEDBACK_TOKEN;
assert.ok(token, 'set V5SIM_FEEDBACK_TOKEN');

// a small PROS-like project
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'v5sim-int-'));
const w = (rel, data) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data); };
w('project.pros', '{"py/object": "pros.conductor.project.Project"}');
w('src/main.cpp', '#include "main.h"\nvoid opcontrol() {}\n');
w('include/main.h', '#pragma once\n');
w('.env', 'SECRET=1');
w('bin/monolith.bin', 'x');

const form = { kind: 'bug', summary: '[integration test] brain screen black', description: 'steps…', contact: '',
  includeLog: true, includeProject: true };
const report = buildReport(form, { extension: 'test', platform: process.platform });
const scan = await scanProject(root);
const bundle = zip(bundleEntries(report, 'log line\n', scan, abs => fs.readFileSync(abs)));

const { id } = await submitReport(base, report, bundle, 'v5sim-vscode/integration');
assert.match(id, /^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}$/);
console.log('submitted', id);

const admin = p => fetch(`${base}/admin/reports${p}`, { headers: { authorization: `Bearer ${token}` } });
const stored = await (await admin(`/${id}/report.json`)).json();
assert.equal(stored.summary, form.summary);
assert.equal(stored.kind, 'bug');
assert.equal(stored.bundleBytes, bundle.length);
const back = Buffer.from(await (await admin(`/${id}/bundle.zip`)).arrayBuffer());
if (!back.equals(bundle)) {
  const at = back.findIndex((b, i) => b !== bundle[i]);
  fs.writeFileSync(path.join(os.tmpdir(), 'sent.zip'), bundle);
  fs.writeFileSync(path.join(os.tmpdir(), 'back.zip'), back);
  assert.fail(`bundle differs: ${back.length} vs ${bundle.length} bytes, first at ${at}`);
}
const listed = await (await admin(`?day=${id.slice(0, 10)}`)).json();
assert.ok(listed.reports.some(r => r.id === id && r.summary === form.summary), 'listed');
console.log('stored and listed ok');

// refusals. Every POST counts toward the rate limit (5 a minute), so a 429
// here means wait for the next minute and ask again.
const post = async init => {
  for (;;) {
    const res = await fetch(`${base}/report`, { method: 'POST', ...init });
    if (res.status !== 429) return res;
    console.log('rate limited; waiting a minute');
    await new Promise(r => setTimeout(r, 61_000));
  }
};
assert.equal((await fetch(`${base}/admin/reports`)).status, 401);
assert.equal((await fetch(`${base}/admin/reports`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
assert.equal((await fetch(`${base}/report`)).status, 405);
const bad = async (fields, status, re) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await post({ body: fd });
  const body = await res.json();
  assert.equal(res.status, status, JSON.stringify(body));
  if (re) assert.match(body.error, re);
};
await bad({ report: '{' }, 400, /JSON/);
await bad({ report: JSON.stringify({ ...report, kind: 'rant' }) }, 400, /kind/);
await bad({ report: JSON.stringify({ ...report, summary: '' }) }, 400, /summary/);
await bad({ report: JSON.stringify(report), bundle: new Blob(['not a zip']) }, 400, /zip/);
const plain = await post({ body: '{}', headers: { 'content-type': 'application/json' } });
assert.equal(plain.status, 415);
console.log('refusals ok');

// rate limit: 5 a minute per address (some already used above)
let limited = false;
for (let i = 0; i < 8 && !limited; i++) {
  try { await submitReport(base, { ...report, summary: '[integration test] rate' }, undefined, 'it'); } catch (e) {
    assert.ok(e instanceof SubmitError);
    if (e.status === 429) limited = true; else throw e;
  }
}
assert.ok(limited, 'rate limited');
console.log('rate limit ok');
console.log('ALL OK');
