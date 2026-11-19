// A small zip writer (deflate, no zip64) for feedback bundles. The extension
// ships without runtime dependencies, so no zip library. Bundles are capped
// well under zip64's 4 GB / 65535-entry limits.
import { deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Path inside the zip, forward slashes, no leading slash. */
  name: string;
  data: Buffer | string;
  mtime?: Date;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date and time, as zip headers hold them (local time, 2 s steps). */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** A name safe to unpack: relative, forward slashes, no `..` segments. */
export function safeEntryName(name: string): string {
  const parts = name.replace(/\\/g, '/').split('/').filter(p => p && p !== '.' && p !== '..');
  if (!parts.length) throw new Error(`bad zip entry name: ${name}`);
  return parts.join('/');
}

export function zip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    const name = Buffer.from(safeEntryName(e.name), 'utf8');
    if (seen.has(name.toString())) throw new Error(`duplicate zip entry: ${e.name}`);
    seen.add(name.toString());
    const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data;
    const deflated = deflateRawSync(raw);
    // keep incompressible files stored
    const [method, body] = deflated.length < raw.length ? [8, deflated] : [0, raw];
    const crc = crc32(raw);
    const { time, date } = dosTime(e.mtime ?? new Date());
    const flags = 0x0800;                          // names are UTF-8

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);                    // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);                  // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}
