// What may leave the computer in an error report: the error, where in this
// extension it happened, and the versions. Home folder and user name are
// taken out of every string, the computer's name and any user/request data
// are dropped, and stack frames outside this extension keep only their file
// name. No vscode import: the tests run this under plain Node.
import type { ErrorEvent, StackFrame } from '@sentry/core';

import { redact, redactValue } from '../feedback/report';

export interface ScrubOptions {
  home: string;
  user: string;
  /** The extension's folder: frames under it are ours. */
  extensionRoot: string;
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^file:\/\/\/?/, '').toLowerCase();

function scrubFrame(f: StackFrame, o: ScrubOptions): StackFrame {
  const root = norm(o.extensionRoot).replace(/\/$/, '');
  const file = f.filename ?? f.abs_path ?? '';
  const ours = !!file && norm(file).startsWith(`${root}/`);
  const name = ours
    ? `app:///${file.replace(/\\/g, '/').slice(root.length + 1).replace(/^\//, '')}`
    : file.split(/[\\/]/).pop() || undefined;
  return {
    function: f.function ? redact(f.function, o.home, o.user) : f.function,
    filename: name,
    module: undefined,
    lineno: f.lineno,
    colno: f.colno,
    in_app: ours,
  };
}

/** The tags and extras this extension sets. Anything else on an event came
 *  from Sentry's shared global scopes, which another extension in the same
 *  extension host may have filled, so it's left out. */
export const OUR_TAGS = ['stage', 'os', 'arch', 'vscode', 'app', 'remote', 'simulator'] as const;
const OUR_EXTRAS = ['log'] as const;

const pick = (from: Record<string, unknown> | undefined, keys: readonly string[]) => {
  const out = Object.fromEntries(keys.filter(k => from?.[k] !== undefined).map(k => [k, from![k]]));
  return Object.keys(out).length ? out : undefined;
};

/** The event to send: a new one holding only the fields this extension
 *  means to send (an allowlist), frames rewritten, home folder and user name
 *  taken out of every string. */
export function scrubEvent(event: ErrorEvent, o: ScrubOptions): ErrorEvent {
  const kept: ErrorEvent = {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    release: event.release,
    environment: event.environment,
    sdk: event.sdk?.name && event.sdk.version ? { name: event.sdk.name, version: event.sdk.version } : undefined,
    fingerprint: event.fingerprint,
    tags: pick(event.tags, OUR_TAGS) as ErrorEvent['tags'],
    extra: pick(event.extra, OUR_EXTRAS),
    // frames from the real paths: redacting first would hide the extension's folder
    exception: event.exception?.values && {
      values: event.exception.values.map(v => ({
        type: v.type,
        value: v.value,
        mechanism: v.mechanism && { type: v.mechanism.type, handled: v.mechanism.handled },
        stacktrace: v.stacktrace?.frames && { frames: v.stacktrace.frames.map(f => scrubFrame(f, o)) },
      })),
    },
  };
  for (const k of Object.keys(kept) as (keyof ErrorEvent)[]) if (kept[k] === undefined) delete kept[k];
  return redactValue(kept, o.home, o.user);
}

/** A message with what changes from run to run (paths, numbers, quoted
 *  bits) blanked, so the same failure groups into one Sentry issue. */
export function groupingKey(message: string): string {
  return message
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"`)]+/g, '<path>')
    .replace(/(['"`]).*?\1/g, '<q>')
    .replace(/0x[0-9a-f]+/gi, '<n>')
    .replace(/\d+/g, '<n>')
    .slice(0, 200);
}
