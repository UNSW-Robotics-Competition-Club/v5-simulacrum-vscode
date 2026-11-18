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

/** Download this computer's runtime into dir (kept for Repair; other
 *  versions' are removed). Returns the file. Throws with a reason. */
export async function fetchRuntime(dir: string, version: string, plat: string, onBytes: OnBytes,
                                   log: (line: string) => void): Promise<string> {
  const releases = await getJson<Release[]>(RELEASES_API);
  const src = pickRuntime(releases, version, plat);
  if (!src) throw new Error(`no release has the simulator for ${plat}`);
  const name = runtimeAsset(plat);
  const want = sumFor(await getText(src.sumsUrl), name);
  if (!want) throw new Error(`${src.tag}'s ${SUMS_NAME} has no ${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${src.tag}-${name}`);
  if (fs.existsSync(file) && await sha256(file) === want) {
    log(`[v5sim] the simulator for ${plat} from ${src.tag} is already downloaded`);
    return file;
  }
  log(`[v5sim] downloading the simulator for ${plat} from ${src.tag}: ${src.url}`);
  const part = `${file}.part`;
  const got = await download(src.url, part, src.size, onBytes);
  if (got !== want) {
    fs.rmSync(part, { force: true });
    throw new Error(`the download's checksum is wrong (${got.slice(0, 12)}…, expected ${want.slice(0, 12)}…)`);
  }
  fs.renameSync(part, file);
  for (const f of fs.readdirSync(dir)) {
    if (f !== path.basename(file) && /^v.+-runtime-.+\.tar\.gz(\.part)?$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  }
  return file;
}

async function getJson<T>(url: string): Promise<T> {
  return JSON.parse(await getText(url)) as T;
}

async function getText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'User-Agent': 'v5-simulacrum-vscode', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

/** Stream url into file, reporting bytes; returns the SHA-256 (hex). */
async function download(url: string, file: string, size: number | undefined, onBytes: OnBytes): Promise<string> {
  const r = await fetch(url, { headers: { 'User-Agent': 'v5-simulacrum-vscode' } });
  if (!r.ok || !r.body) throw new Error(`${url}: HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || size;
  const hash = createHash('sha256');
  const out = fs.createWriteStream(file);
  const reader = r.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.length;
      if (!out.write(value)) await new Promise<void>(ok => out.once('drain', () => ok()));
      onBytes(received, total);
    }
  } finally {
    await new Promise<void>((ok, fail) => out.end((e?: Error | null) => (e ? fail(e) : ok())));
  }
  return hash.digest('hex');
}

function sha256(file: string): Promise<string> {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', fail);
  });
}
