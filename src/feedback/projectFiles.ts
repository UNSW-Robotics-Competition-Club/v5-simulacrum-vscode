// Which files of a project folder go into a feedback bundle. Source and
// project settings yes; version control, build output, dependencies,
// anything that looks like a secret, symlinks and big files no. The user sees
// the resulting list before anything is sent.
import * as fs from 'node:fs';
import * as path from 'node:path';

export const LIMITS = {
  fileBytes: 1024 * 1024,
  totalBytes: 10 * 1024 * 1024,
  files: 2000,
  /** directory entries looked at in all, so a home folder opened as the
   *  workspace can't keep the scan going for minutes */
  entries: 20000,
  /** skipped entries listed one by one; the rest are counted */
  skippedListed: 300,
};

export type SkipReason = 'excluded folder' | 'possible secret' | 'build output' | 'symlink'
  | 'too large' | 'unreadable' | 'limit reached' | 'not listed';

export interface ProjectFile { rel: string; abs: string; size: number }
export interface Skipped { rel: string; reason: SkipReason }
export interface ProjectScan { root: string; files: ProjectFile[]; skipped: Skipped[]; totalBytes: number }

const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.cache', '.vs', '.idea', '.gradle', '.wrangler',
  'build', 'bin', 'out', 'dist', 'firmware',   // VEXcode build/, PROS bin/ and firmware/ (vendor libraries)
]);

const SECRET_NAMES: RegExp[] = [
  /^\.env(\..*)?$/i, /\.(pem|key|p12|pfx|keystore|jks|asc|gpg)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(npmrc|netrc|pypirc|git-credentials)$/i, /(^|[._-])(credentials?|secrets?|tokens?)([._-]|$)/i,
];
// .vscode/settings.json can hold other extensions' API keys
const SECRET_PATHS = /(^|\/)\.vscode\/settings\.json$/i;
const BUILD_EXT = /\.(o|obj|a|lib|elf|bin|hex|map|d|exe|dll|so|dylib|pyc|zip|7z|tar|gz|vsix)$/i;

export function classify(rel: string): SkipReason | undefined {
  const name = path.posix.basename(rel);
  if (SECRET_PATHS.test(rel) || SECRET_NAMES.some(r => r.test(name))) return 'possible secret';
  if (BUILD_EXT.test(name)) return 'build output';
  return undefined;
}

/** The files to send, walking the folder in name order. It stops at the
 *  first limit it reaches (file count, total size, entries looked at) and
 *  says so in one 'limit reached' line. */
export async function scanProject(root: string, limits = LIMITS): Promise<ProjectScan> {
  const files: ProjectFile[] = [];
  const skipped: Skipped[] = [];
  let totalBytes = 0;
  let entries = 0;
  let unlisted = 0;
  let stopped: string | undefined;
  const skip = (rel: string, reason: SkipReason) => {
    if (skipped.length < limits.skippedListed) skipped.push({ rel, reason });
    else unlisted++;
  };
  const walk = async (dir: string, relDir: string): Promise<void> => {
    let names: fs.Dirent[];
    try {
      names = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      skip(relDir || '.', 'unreadable');
      return;
    }
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of names) {
      if (stopped) return;
      if (++entries > limits.entries) { stopped = `more than ${limits.entries} files and folders`; return; }
      const rel = relDir ? `${relDir}/${d.name}` : d.name;
      const abs = path.join(dir, d.name);
      if (d.isSymbolicLink()) { skip(rel, 'symlink'); continue; }
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) skip(rel, 'excluded folder');
        else await walk(abs, rel);
        continue;
      }
      if (!d.isFile()) continue;
      const why = classify(rel);
      if (why) { skip(rel, why); continue; }
      let size: number;
      try { size = (await fs.promises.stat(abs)).size; } catch { skip(rel, 'unreadable'); continue; }
      if (size > limits.fileBytes) { skip(rel, 'too large'); continue; }
      if (files.length >= limits.files) { stopped = `more than ${limits.files} files`; return; }
      if (totalBytes + size > limits.totalBytes) { stopped = `over ${Math.round(limits.totalBytes / 1048576)} MB`; return; }
      files.push({ rel, abs, size });
      totalBytes += size;
    }
  };
  await walk(root, '');
  if (unlisted) skipped.push({ rel: `(${unlisted} more not listed)`, reason: 'not listed' });
  if (stopped) skipped.push({ rel: `(the rest of the folder: ${stopped})`, reason: 'limit reached' });
  return { root, files, skipped, totalBytes };
}

export interface ReadFile { rel: string; data: Buffer }
export interface ProjectRead { files: ReadFile[]; skipped: Skipped[] }

/** The scanned files' contents, read when the report is sent. A file
 *  deleted or grown past the limits since the scan is left out (and listed
 *  as skipped), not a failed report. */
export async function readProjectFiles(scan: ProjectScan, limits = LIMITS): Promise<ProjectRead> {
  const files: ReadFile[] = [];
  const skipped: Skipped[] = [...scan.skipped];
  let total = 0;
  for (const f of scan.files) {
    let data: Buffer;
    try {
      data = await fs.promises.readFile(f.abs);
    } catch {
      skipped.push({ rel: f.rel, reason: 'unreadable' });
      continue;
    }
    if (data.length > limits.fileBytes) { skipped.push({ rel: f.rel, reason: 'too large' }); continue; }
    if (total + data.length > limits.totalBytes) { skipped.push({ rel: f.rel, reason: 'limit reached' }); continue; }
    files.push({ rel: f.rel, data });
    total += data.length;
  }
  return { files, skipped };
}
