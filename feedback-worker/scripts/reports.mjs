#!/usr/bin/env node
// Maintainers: list and download V5 Sim feedback reports.
//   V5SIM_FEEDBACK_TOKEN=... node scripts/reports.mjs list [yyyy-mm-dd]
//   V5SIM_FEEDBACK_TOKEN=... node scripts/reports.mjs get <yyyy-mm-dd/uuid> [out-dir]
// V5SIM_FEEDBACK_URL overrides the Worker address.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

const [cmd, arg, out = '.'] = process.argv.slice(2);
if (cmd === 'list') {
  let cursor = '';
  do {
    const q = new URLSearchParams({ ...(arg ? { day: arg } : {}), ...(cursor ? { cursor } : {}) });
    const page = await (await get(`?${q}`)).json();
    for (const r of page.reports) console.log(`${clean(r.id)}  ${clean(r.kind)}  ${clean(r.summary)}`);
    cursor = page.cursor;
  } while (cursor);
} else if (cmd === 'get' && /^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}$/.test(arg ?? '')) {
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
  console.error('usage: reports.mjs list [day] | get <day/uuid> [out-dir]');
  process.exit(2);
}
