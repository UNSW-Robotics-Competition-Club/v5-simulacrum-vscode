#!/usr/bin/env node
// Maintainers: list and download V5 Sim feedback reports.
//   V5SIM_FEEDBACK_TOKEN=... node scripts/reports.mjs list [yyyy-mm-dd]
//   V5SIM_FEEDBACK_TOKEN=... node scripts/reports.mjs get <yyyy-mm-dd/uuid> [out-dir]
//   V5SIM_FEEDBACK_TOKEN=... node scripts/reports.mjs delete <yyyy-mm-dd/uuid>... [--yes]
// V5SIM_FEEDBACK_URL overrides the Worker address. delete removes a report
// and its bundle for good (it asks first unless --yes); a copy in Sentry's
// User Feedback has to be deleted there.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

const base = (process.env.V5SIM_FEEDBACK_URL ?? 'https://v5sim-feedback.unsw-rcc.workers.dev').replace(/\/$/, '');
const token = process.env.V5SIM_FEEDBACK_TOKEN;
if (!token) {
  console.error('Set V5SIM_FEEDBACK_TOKEN to the Worker\'s ADMIN_TOKEN.');
  process.exit(2);
}
const headers = { authorization: `Bearer ${token}` };
// report text comes from anyone: no terminal escape sequences
const clean = v => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

async function get(p) {
  const res = await fetch(`${base}/admin/reports${p}`, { headers });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res;
}

const ID = /^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}$/;

async function deleteReports(args) {
  const yes = args.includes('--yes');
  const ids = args.filter(a => a !== '--yes');
  const bad = ids.filter(id => !ID.test(id));
  if (!ids.length || bad.length) {
    console.error(bad.length ? `not report ids: ${bad.join(' ')}` : 'usage: reports.mjs delete <day/uuid>... [--yes]');
    process.exit(2);
  }
  if (!yes && !process.stdin.isTTY) {
    console.error('Not asking without a terminal: add --yes to delete.');
    process.exit(2);
  }
  const rl = yes ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  let failed = 0;
  for (const id of ids) {
    if (rl) {
      let summary = '(report.json missing)';
      try { summary = clean(JSON.parse(await (await get(`/${id}/report.json`)).text()).summary); } catch { /* shown as missing */ }
      const answer = await rl.question(`Delete ${id}  "${summary}" and its bundle for good? [y/N] `);
      if (!/^y(es)?$/i.test(answer.trim())) { console.log('  kept'); continue; }
    }
    const res = await fetch(`${base}/admin/reports/${id}`, { method: 'DELETE', headers });
    const body = await res.json().catch(() => ({}));
    if (res.ok) console.log(`deleted ${id} (${body.deleted.map(k => k.split('/').pop()).join(', ')})`);
    else { failed++; console.error(`${id}: ${res.status} ${clean(body.error)}`); }
  }
  rl?.close();
  if (failed < ids.length) {
    // the copy forwarded to Sentry isn't reachable from here
    console.error('\nAlso delete the copy in Sentry: User Feedback, All Environments, search for each id as report:<id>.');
  }
  if (failed) process.exit(1);
}

const [cmd, arg, out = '.'] = process.argv.slice(2);
if (cmd === 'delete') {
  await deleteReports(process.argv.slice(3));
} else if (cmd === 'list') {
  let cursor = '';
  do {
    const q = new URLSearchParams({ ...(arg ? { day: arg } : {}), ...(cursor ? { cursor } : {}) });
    const page = await (await get(`?${q}`)).json();
    for (const r of page.reports) console.log(`${clean(r.id)}  ${clean(r.kind)}  ${clean(r.summary)}`);
    cursor = page.cursor;
  } while (cursor);
} else if (cmd === 'get' && ID.test(arg ?? '')) {
  const dir = path.join(out, arg.replace(/\//g, '_'));
  await mkdir(dir, { recursive: true });
  const report = await (await get(`/${arg}/report.json`)).text();
  await writeFile(path.join(dir, 'report.json'), report);
  try {
    const zip = Buffer.from(await (await get(`/${arg}/bundle.zip`)).arrayBuffer());
    await writeFile(path.join(dir, 'bundle.zip'), zip);
  } catch (e) {
    if (!String(e.message).startsWith('404')) throw e;
  }
  console.log(dir);
} else {
  console.error('usage: reports.mjs list [day] | get <day/uuid> [out-dir] | delete <day/uuid>... [--yes]');
  process.exit(2);
}
