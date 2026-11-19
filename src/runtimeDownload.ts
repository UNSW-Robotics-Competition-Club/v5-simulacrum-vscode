// Getting the simulator runtime when this .vsix doesn't carry one (the
// platform-neutral package, or a copy that lost it): download the one for
// this computer from the extension's GitHub releases, checked against the
// release's SHA256SUMS. The pure parts are here (no VS Code imports: the
// tests run them under plain Node); fetchRuntime does the download.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const RELEASES_API =
  'https://api.github.com/repos/UNSW-Robotics-Competition-Club/v5-simulacrum-vscode/releases?per_page=20';
export const SUMS_NAME = 'SHA256SUMS';

/** The runtime this computer runs: Macs their own; Windows the Linux one
 *  (it runs in WSL, x64 only); Linux x64 (VS Code in WSL). */
export function runtimePlatform(platform: string, arch: string): string | undefined {
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : arch === 'x64' ? 'darwin-x64' : undefined;
  if ((platform === 'win32' || platform === 'linux') && arch === 'x64') return 'linux-x64';
  return undefined;
}

export const runtimeAsset = (plat: string) => `runtime-${plat}.tar.gz`;

interface Asset { name: string; browser_download_url: string; size?: number }
export interface Release { tag_name: string; draft?: boolean; assets: Asset[] }

export interface RuntimeSource { tag: string; url: string; sumsUrl: string; size?: number }

/** This version's release if it has the runtime, else the newest release
 *  that has it (a test build between releases). Drafts never. */
export function pickRuntime(releases: Release[], version: string, plat: string): RuntimeSource | undefined {
  const name = runtimeAsset(plat);
  const usable = releases.filter(r => !r.draft && r.assets.some(a => a.name === name)
    && r.assets.some(a => a.name === SUMS_NAME));
  const r = usable.find(x => x.tag_name === `v${version}`) ?? usable[0];
  if (!r) return undefined;
  const asset = r.assets.find(a => a.name === name)!;
  const sums = r.assets.find(a => a.name === SUMS_NAME)!;
  return { tag: r.tag_name, url: asset.browser_download_url, sumsUrl: sums.browser_download_url, size: asset.size };
}

/** The hash for name in a `sha256sum` listing ("<hex>  <name>"). */
export function sumFor(sums: string, name: string): string | undefined {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m && m[2] === name) return m[1].toLowerCase();
  }
  return undefined;
}

export type OnBytes = (received: number, total: number | undefined) => void;

/** A downloaded runtime: the file and the release it came from. */
export interface Downloaded { file: string; tag: string }

/** Written next to a verified download, so later starts need no network. */
export const CACHE_NAME = 'runtime.json';

/** The runtime downloaded earlier for plat, if its file is still there. */
export function cachedRuntime(dir: string, plat: string): Downloaded | undefined {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, CACHE_NAME), 'utf8')) as Partial<Downloaded>;
    if (typeof c.tag !== 'string' || typeof c.file !== 'string' || !/^v[\w.-]+$/.test(c.tag)) return undefined;
    const file = path.join(dir, path.basename(c.file));
    return path.basename(file) === `${c.tag}-${runtimeAsset(plat)}` && fs.existsSync(file) ? { file, tag: c.tag } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether to ask GitHub at all: not when this version's own runtime is
 *  already downloaded (offline, or behind a school firewall, it still
 *  starts), unless repairing. A runtime from another release is replaced
 *  once this version's appears. */
export function needsCheck(cached: Downloaded | undefined, version: string, force: boolean): boolean {
  return force || !cached || cached.tag !== `v${version}`;
}

/** The folder name the runtime unpacks into: per extension version and,
 *  for a downloaded one, per release, so a runtime from another release
 *  (a stand-in until this version's is published) is replaced when this
 *  version's arrives, not kept because its folder already exists. */
export function installKey(version: string, tag: string | undefined): string {
  return tag && tag !== `v${version}` ? `${version}-${tag}` : version;
}

/** This computer's runtime: the one downloaded earlier when it is this
 *  version's (no network), else downloaded into dir from the releases (kept
 *  for Repair; other versions' are removed). When GitHub can't be reached
 *  but a runtime was downloaded earlier, that one. Throws with a reason. */
export async function fetchRuntime(dir: string, version: string, plat: string, onBytes: OnBytes,
                                   log: (line: string) => void, force = false): Promise<Downloaded> {
  const cached = cachedRuntime(dir, plat);
  if (cached && !needsCheck(cached, version, force)) {
    log(`[v5sim] using the simulator for ${plat} downloaded from ${cached.tag}`);
    return cached;
  }
  try {
    return await download1(dir, version, plat, onBytes, log, cached);
  } catch (e) {
    if (!cached) throw e;
    log(`[v5sim] couldn't check GitHub for the simulator (${(e as Error).message}); using the one from ${cached.tag}`);
    return cached;
  }
}

async function download1(dir: string, version: string, plat: string, onBytes: OnBytes,
                         log: (line: string) => void, cached: Downloaded | undefined): Promise<Downloaded> {
  const releases = await getJson<Release[]>(RELEASES_API);
  const src = pickRuntime(releases, version, plat);
  if (!src) throw new Error(`no release has the simulator for ${plat}`);
  if (src.tag !== `v${version}`) log(`[v5sim] ${version}'s release has no simulator for ${plat} yet: using ${src.tag}'s`);
  const name = runtimeAsset(plat);
  const want = sumFor(await getText(src.sumsUrl), name);
  if (!want) throw new Error(`${src.tag}'s ${SUMS_NAME} has no ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${src.tag}-${name}`);
  const done = (): Downloaded => {
    fs.writeFileSync(path.join(dir, CACHE_NAME), JSON.stringify({ tag: src.tag, file: path.basename(file) }));
    return { file, tag: src.tag };
  };
  if (fs.existsSync(file) && (cached?.file === file || await sha256(file) === want)) {
    log(`[v5sim] the simulator for ${plat} from ${src.tag} is already downloaded`);
    return done();
  }
  log(`[v5sim] downloading the simulator for ${plat} from ${src.tag}: ${src.url}`);
  const part = `${file}.part`;
  let got: string;
  try {
    got = await download(src.url, part, src.size, onBytes);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
  if (got !== want) {
    fs.rmSync(part, { force: true });
    throw new Error(`the download's checksum is wrong (${got.slice(0, 12)}…, expected ${want.slice(0, 12)}…)`);
  }
  fs.renameSync(part, file);
  for (const f of fs.readdirSync(dir)) {
    if (f !== path.basename(file) && /^v.+-runtime-.+\.tar\.gz(\.part)?$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  }
  return done();
}

async function getJson<T>(url: string): Promise<T> {
  return JSON.parse(await getText(url)) as T;
}

async function getText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'User-Agent': 'v5-simulacrum-vscode', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000) });
  if (r.status === 403 || r.status === 429) {
    // unauthenticated GitHub API: 60 requests an hour per address, which a
    // classroom behind one address can use up
    throw new Error('GitHub is limiting requests from this network; try again in an hour');
  }
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

/** How long a download may go without receiving anything. */
export const STALL_MS = 60_000;

/** Stream url into file, reporting bytes; returns the SHA-256 (hex). Gives
 *  up when nothing arrives for STALL_MS, or the file can't be written. */
export async function download(url: string, file: string, size: number | undefined, onBytes: OnBytes,
                               stallMs = STALL_MS): Promise<string> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = () => {
    clearTimeout(timer);
    timer = setTimeout(() => abort.abort(new Error(`the download stalled (nothing for ${stallMs / 1000} s)`)), stallMs);
  };
  stalled();
  const out = fs.createWriteStream(file);
  let writeError: Error | undefined;
  out.on('error', e => { writeError = e; abort.abort(e); });
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'v5-simulacrum-vscode' }, signal: abort.signal });
    if (!r.ok || !r.body) throw new Error(`${url}: HTTP ${r.status}`);
    const total = Number(r.headers.get('content-length')) || size;
    const hash = createHash('sha256');
    const reader = r.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stalled();
      hash.update(value);
      received += value.length;
      if (!out.write(value)) {
        await new Promise<void>((ok, fail) => {
          out.once('drain', ok);
          abort.signal.addEventListener('abort', () => fail(abort.signal.reason), { once: true });
        });
      }
      onBytes(received, total);
    }
    await new Promise<void>((ok, fail) => out.end((e?: Error | null) => (e ? fail(e) : ok())));
    if (writeError) throw writeError;
    return hash.digest('hex');
  } catch (e) {
    out.destroy();
    throw writeError ?? (abort.signal.aborted ? abort.signal.reason : e);
  } finally {
    clearTimeout(timer);
  }
}

function sha256(file: string): Promise<string> {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', fail);
  });
}
