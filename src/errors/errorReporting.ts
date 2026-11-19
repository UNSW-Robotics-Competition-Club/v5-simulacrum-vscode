// Automatic error reports to the maintainers' Sentry project. They go
// through VS Code's TelemetryLogger, so they follow the user's telemetry
// setting (errors are sent at "error" and "all", never at "crash" or "off"),
// plus v5sim.errorReporting. VS Code also hands the logger uncaught errors
// from this extension (and only this one).
//
// An event holds the error, where in this extension it happened, the
// versions and OS, and for a failed start the last lines of the V5 Sim log;
// home folder and user name are taken out (scrub.ts). No code, no usage data.
import * as os from 'node:os';
import * as vscode from 'vscode';

import type { LogBuffer } from '../feedback/logBuffer';
import { redact } from '../feedback/report';
import { mode } from '../runtime';
import { cfg } from '../settings';
import { type ScrubOptions, groupingKey, scrubEvent, scrubStack } from './scrub';
import type { SentryReporter, SentryOptions } from './sentry';

/** The Sentry project's DSN (public by design: it only lets clients send).
 *  Empty: error reporting is off. V5SIM_SENTRY_DSN overrides it (tests).
 *  Project: the club's Sentry org, EU region (ingest.de.sentry.io). */
const SENTRY_DSN = 'https://bcd47336ef9ebb1f75e829ad9f2dfe98@o4512458784440320.ingest.de.sentry.io/4512458892836944';

const MAX_EVENTS_PER_SESSION = 20;
const LOG_TAIL_LINES = 40;
const FLUSH_TIMEOUT_MS = 2_000;

/** Where a failure happened; a Sentry tag and part of its grouping. */
export type Stage = 'setup' | 'start' | 'usb-attach' | 'wsl-interop' | 'usb-driver' | 'ports' | 'feedback'
  | 'unhandled';

let logger: vscode.TelemetryLogger | undefined;
let logBuffer: LogBuffer | undefined;
let scrubOptions: ScrubOptions | undefined;

export function initErrorReporting(context: vscode.ExtensionContext, log: LogBuffer): void {
  const dsn = (process.env.V5SIM_SENTRY_DSN ?? SENTRY_DSN).trim();
  if (!dsn) return;
  const version = String(context.extension.packageJSON?.version ?? '0.0.0');
  const scrub: ScrubOptions = { home: os.homedir(), user: userName(), host: os.hostname(), extensionRoot: context.extensionPath };
  // loaded only now, and a failure only turns reporting off: the extension
  // must start whatever happens to the Sentry bundle
  let sentry: SentryReporter;
  try {
    const { createSentry } = require('./sentry') as { createSentry: (o: SentryOptions) => SentryReporter };
    sentry = createSentry({
      dsn,
      release: `v5sim-vscode@${version}`,
      environment: context.extensionMode === vscode.ExtensionMode.Production ? 'production' : 'development',
      beforeSend: event => scrubEvent(event, scrub),
    });
  } catch {
    return;
  }
  logBuffer = log;
  scrubOptions = scrub;
  let sent = 0;
  const sender: vscode.TelemetrySender = {
    sendEventData: () => undefined,          // no usage telemetry, errors only
    sendErrorData: (error, data) => {
      if (!cfg().get<boolean>('errorReporting', true) || sent >= MAX_EVENTS_PER_SESSION) return;
      sent++;
      const stage = typeof data?.stage === 'string' ? data.stage : 'unhandled';
      // our own scrubbed frames, in place of the ones VS Code blanked
      const frames = trusted(data?.stack);
      if (frames) error.stack = `${error.name}: ${error.message}\n${frames}`;
      sentry.capture(error, {
        tags: {
          stage,
          os: process.platform,
          arch: process.arch,
          vscode: vscode.version,
          app: vscode.env.appName,
          remote: vscode.env.remoteName ?? 'none',
          simulator: mode(),
        },
        extra: typeof data?.log === 'string' ? { log: data.log } : undefined,
        fingerprint: [stage, error.name, groupingKey(error.message)],
      });
    },
    flush: () => sentry.flush(FLUSH_TIMEOUT_MS).then(() => undefined),
  };
  logger = vscode.env.createTelemetryLogger(sender, { ignoreBuiltInCommonProperties: true });
  context.subscriptions.push(logger);
}

/** Reports a failure the user was shown (or would be stuck on). Strings
 *  become errors named after the stage, so Sentry titles say where. */
export function reportError(stage: Stage, error: unknown, opts: { withLog?: boolean } = {}): void {
  if (!logger) return;
  let e: Error;
  if (error instanceof Error) {
    e = error;
  } else {
    e = new Error(String(error));
    e.name = `V5Sim ${stage} failed`;
  }
  const data: Record<string, unknown> = { stage };
  if (e.stack && scrubOptions) data.stack = new vscode.TelemetryTrustedValue(scrubStack(e.stack, scrubOptions));
  if (opts.withLog && logBuffer) {
    data.log = redact(logBuffer.text().split('\n').slice(-LOG_TAIL_LINES - 1).join('\n'), os.homedir(), userName(), os.hostname());
  }
  try {
    logger.logError(e, data);
  } catch {
    // reporting must never break what it reports on
  }
}

/** A trusted value as the sender gets it (VS Code may pass the wrapper or its value). */
function trusted(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { value?: unknown }).value === 'string') return (v as { value: string }).value;
  return undefined;
}

function userName(): string {
  try { return os.userInfo().username; } catch { return process.env.USERNAME ?? process.env.USER ?? ''; }
}
