// Reads a zip back through its central directory, as unzip tools do, and
// checks every entry's size and CRC.
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';

import { crc32 } from '../src/feedback/zip';

export function unzip(buf: Buffer): Map<string, Buffer> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    assert.equal(buf.readUInt32LE(local), 0x04034b50);
    const lnlen = buf.readUInt16LE(local + 26);
    const start = local + 30 + lnlen + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    assert.equal(data.length, size);
    assert.equal(crc32(data), crc, `crc of ${name}`);
    out.set(name, data);
    p += 46 + nlen;
  }
  return out;
}

