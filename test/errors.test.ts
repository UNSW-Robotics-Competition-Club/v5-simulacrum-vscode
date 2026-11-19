import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ErrorEvent } from '@sentry/core';

import { groupingKey, scrubEvent } from '../src/errors/scrub';
import { createSentry } from '../src/errors/sentry';

const opts = { home: 'C:\\Users\\kevin', user: 'kevin', extensionRoot: 'c:\\Users\\kevin\\.vscode\\extensions\\v5sim-0.3.13' };

function event(): ErrorEvent {
  return {
    type: undefined,
    server_name: 'KEVINS-LAPTOP',
    user: { id: 'x', ip_address: '1.2.3.4' },
    request: { url: 'http://localhost' },
    breadcrumbs: [{ message: 'C:\\Users\\kevin\\secret' }],
    message: 'failed at C:\\Users\\kevin\\robot\\main.cpp',
    extra: { log: 'wsl: /home/kevin/.v5-simulacrum/runtime' },
    exception: { values: [{ type: 'Error', value: 'ENOENT: C:\\Users\\kevin\\x', stacktrace: { frames: [
      { filename: 'C:\\Users\\kevin\\.vscode\\extensions\\v5sim-0.3.13\\out\\src\\simInstance.js', function: 'SimInstance.start', lineno: 10, colno: 3, in_app: false },
      { filename: 'c:\\Program Files\\Microsoft VS Code\\resources\\app\\out\\vs\\workbench\\api\\node\\extensionHostProcess.js', function: 'x', lineno: 1 },
      { filename: 'node:internal/process/task_queues', function: 'process.processTicksAndRejections', lineno: 95 },
    ] } }] },
  };
}

test('scrubEvent drops the computer name, user, request and breadcrumbs', () => {
  const e = scrubEvent(event(), opts);
  assert.equal(e.server_name, undefined);
  assert.equal(e.user, undefined);
  assert.equal(e.request, undefined);
  assert.equal(e.breadcrumbs, undefined);
});

test('scrubEvent keeps only the fields and tags this extension sets', () => {
  const e = scrubEvent({ ...event(), contexts: { app: { app_name: 'other' } }, tags: { stage: 'start', other: 'x' },
    extra: { log: 'l', otherExtra: 'y' }, dist: 'd' } as ErrorEvent, opts);
  assert.deepEqual(Object.keys(e).sort(), ['exception', 'extra', 'tags']);
  assert.deepEqual(e.tags, { stage: 'start' });
  assert.deepEqual(e.extra, { log: 'l' });
});

test('scrubEvent takes the home folder and user name out of every string', () => {
  const e = scrubEvent(event(), opts);
  const text = JSON.stringify(e);
  assert.ok(!/kevin/i.test(text), text);
  assert.equal(e.exception!.values![0].value, 'ENOENT: ~\\x');
  assert.equal((e.extra as any).log, 'wsl: /home/<user>/.v5-simulacrum/runtime');
});

test('scrubEvent keeps our frames relative and others as a bare file name', () => {
  const frames = scrubEvent(event(), opts).exception!.values![0].stacktrace!.frames!;
  assert.deepEqual(frames.map(f => [f.filename, f.in_app]), [
    ['app:///out/src/simInstance.js', true],
    ['extensionHostProcess.js', false],
    ['task_queues', false],
  ]);
  assert.equal(frames[0].function, 'SimInstance.start');
  assert.equal(frames[0].lineno, 10);
});

test('scrubEvent does not change the event it is given', () => {
  const e = event();
  scrubEvent(e, opts);
  assert.equal(e.server_name, 'KEVINS-LAPTOP');
});

test('groupingKey blanks what changes between runs', () => {
  assert.equal(groupingKey('spawn C:\\Users\\a\\wsl.exe ENOENT'), groupingKey('spawn C:\\Users\\b\\wsl.exe ENOENT'));
  assert.equal(groupingKey('timed out after 120 s on port 8766'), 'timed out after <n> s on port <n>');
  assert.equal(groupingKey("no preset 'robot one'"), 'no preset <q>');
  assert.notEqual(groupingKey('VEXos download failed'), groupingKey('WSL is not installed'));
});

/** A Sentry client whose requests land in an array. */
function fakeSentry(beforeSend = (e: ErrorEvent): ErrorEvent | null => e) {
  const sent: { url: string; items: any[] }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const lines = String(init.body).split('\n').filter(Boolean).map(l => JSON.parse(l));
    sent.push({ url, items: lines });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const sentry = createSentry({ dsn: 'https://pub123@o1.ingest.example.io/42', release: 'v5sim-vscode@1.2.3',
    environment: 'test', beforeSend, fetchFn });
  return { sentry, sent };
}

test('createSentry sends a captured error to the DSN\'s project', async () => {
  const { sentry, sent } = fakeSentry();
  const id = sentry.capture(new Error('VEXos download failed'), {
    tags: { stage: 'setup' }, extra: { log: 'last lines' }, fingerprint: ['setup', 'Error', 'VEXos download failed'],
  });
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.ok(await sentry.flush(2000));
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /^https:\/\/o1\.ingest\.example\.io\/api\/42\/envelope\/\?.*sentry_key=pub123/);
  const ev = sent[0].items[2];
  assert.equal(sent[0].items[1].type, 'event');
  assert.equal(ev.event_id, id);
  assert.equal(ev.release, 'v5sim-vscode@1.2.3');
  assert.equal(ev.environment, 'test');
  assert.equal(ev.tags.stage, 'setup');
  assert.equal(ev.extra.log, 'last lines');
  assert.deepEqual(ev.fingerprint, ['setup', 'Error', 'VEXos download failed']);
  assert.equal(ev.exception.values[0].value, 'VEXos download failed');
  assert.ok(ev.exception.values[0].stacktrace.frames.length > 0, 'has a stack');
  assert.equal(ev.server_name, undefined);
  await sentry.close(1000);
});

test('createSentry runs every event through beforeSend, which can drop it', async () => {
  const { sentry, sent } = fakeSentry(e => (e.exception?.values?.[0].value === 'drop me' ? null : { ...e, message: 'seen' }));
  sentry.capture(new Error('drop me'));
  sentry.capture(new Error('keep me'));
  await sentry.flush(2000);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].items[2].message, 'seen');
  await sentry.close(1000);
});

test('createSentry adds no process-wide handlers and is not the global client', async () => {
  const events = ['uncaughtException', 'unhandledRejection', 'warning', 'exit', 'beforeExit'] as const;
  const before = events.map(e => process.listenerCount(e));
  const { sentry } = fakeSentry();
  sentry.capture(new Error('x'));
  await sentry.flush(1000);
  assert.deepEqual(events.map(e => process.listenerCount(e)), before);
  const { getClient } = await import('@sentry/core');
  assert.equal(getClient(), undefined, 'another extension\'s Sentry.captureException would not reach ours');
  await sentry.close(1000);
});

test('createSentry gives up quietly when Sentry is unreachable', async () => {
  const sentry = createSentry({ dsn: 'https://k@o1.ingest.example.io/1', release: 'r', environment: 't',
    beforeSend: e => e, fetchFn: (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch });
  assert.doesNotThrow(() => sentry.capture(new Error('x')));
  await sentry.flush(1000);
  await sentry.close(1000);
});

test('another extension\'s Sentry scopes do not get into our events', async () => {
  const core = await import('@sentry/core');
  // what an extension calling Sentry.init / setTag / setContext would leave in the shared global scopes
  core.getGlobalScope().setTag('other_extension', 'secret-tag');
  core.getGlobalScope().setContext('other', { token: 'secret-context' });
  core.getIsolationScope().setExtra('other_extra', 'secret-extra');
  core.getIsolationScope().setUser({ email: 'someone@example.com' });
  core.getGlobalScope().addEventProcessor(e => ({ ...e, extra: { ...e.extra, injected: 'secret-processor' } }));
  // (left in place: node --test runs each file in its own process, and this test is the file's last)
  const { sentry, sent } = fakeSentry(e => scrubEvent(e, opts));
  sentry.capture(new Error('ours'), { tags: { stage: 'setup' }, extra: { log: 'l' } });
  await sentry.flush(2000);
  const text = JSON.stringify(sent[0].items[2]);
  assert.ok(!/secret|someone@/.test(text), text);
  assert.equal(sent[0].items[2].tags.stage, 'setup');
  assert.equal(sent[0].items[2].extra.log, 'l');
  await sentry.close(1000);
});
