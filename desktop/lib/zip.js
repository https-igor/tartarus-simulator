/* Tartarus Overlay: a small streaming zip writer, for "Export logs" (main.js).
 *
 * No package: Node's zlib does the compressing, this only writes the zip's
 * headers around it. Each file is read in 1 MB pieces and deflated as it
 * goes, so a 450 MB game log never sits in memory, and zlib's deflate runs
 * on Node's worker threads: the main process (and so the app's windows and
 * menus) keeps running while it zips. The CRC is zlib.crc32 (native, Node 22.2
 * and later), with a plain table in JavaScript when it's missing.
 *
 * Plain zip (no Zip64): every file under 4 GB and the zip under 4 GB, which
 * logs always are; a file that would go over is left out (add() says so),
 * never a broken zip. Sizes and CRC follow each file (bit 3, a data
 * descriptor), as the file may still be growing: only the bytes there when
 * it was added are read. Names are UTF-8 (bit 11). */
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const { once } = require('events');

const crc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buf, prev = 0) => {
    let c = ~prev;
    for (let i = 0; i < buf.length; i += 1) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  };
})();

const LIMIT = 0xFFFFFFFF - 64 * 1024 * 1024; // room kept for the headers and directory
// MS-DOS time and date, as zip keeps them (2-second steps, local time).
function dosTime(d) {
  const t = d instanceof Date && !Number.isNaN(d.getTime()) && d.getFullYear() >= 1980 ? d : new Date(1980, 0, 1);
  return {
    time: (t.getHours() << 11) | (t.getMinutes() << 5) | Math.floor(t.getSeconds() / 2),
    date: ((t.getFullYear() - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate(),
  };
}

class ZipWriter {
  // level: zlib's 1 (fastest) to 9 (smallest); 5 makes text logs about a
  // tenth of their size at a fraction of 9's work.
  constructor(file, { level = 5 } = {}) {
    this.out = fs.createWriteStream(file);
    this.level = level;
    this.offset = 0;
    this.entries = [];
    this.failed = null;
    this.out.on('error', (e) => {
      this.failed = e;
    });
  }

  async write(buf) {
    if (this.failed) throw this.failed;
    this.offset += buf.length;
    if (!this.out.write(buf)) {
      await Promise.race([once(this.out, 'drain'), once(this.out, 'error').then(([e]) => { throw e; })]);
    }
  }

  // A file from disk, as `name` in the zip. Resolves to { size, packed } or
  // { skipped: why }.
  async addFile(name, file) {
    const st = await fs.promises.stat(file);
    if (!st.isFile()) return { skipped: 'not a file' };
    // Worst case, deflate grows a file a little; one that might not fit is left out.
    if (st.size >= LIMIT || this.offset + st.size * 1.01 + 1024 >= LIMIT) return { skipped: `too big for the zip (${st.size} bytes)` };
    const src = st.size > 0 ? fs.createReadStream(file, { start: 0, end: st.size - 1, highWaterMark: 1024 * 1024 }) : null;
    return this.addStream(name, src, st.mtime);
  }

  // Text or a Buffer made here (a list of what's in the zip).
  async addBuffer(name, data, mtime = new Date()) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    return this.addStream(name, buf.length ? [buf] : null, mtime);
  }

  async addStream(name, src, mtime) {
    if (this.entries.length >= 0xFFFF) return { skipped: 'too many files for a zip' };
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const { time, date } = dosTime(mtime);
    const start = this.offset;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed: 2.0 (deflate)
    head.writeUInt16LE(0x0808, 6); // bit 3: sizes after the data; bit 11: UTF-8 name
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    // CRC and sizes (14..25) stay 0: they follow in the data descriptor.
    head.writeUInt16LE(nameBuf.length, 26);
    await this.write(Buffer.concat([head, nameBuf]));

    let crc = 0;
    let size = 0;
    let packed = 0;
    const deflate = zlib.createDeflateRaw({ level: this.level });
    // Read → CRC → deflate, waiting on deflate's buffer (it doesn't fill
    // memory with a fast disk); deflate → zip, waiting on the zip file.
    const feed = (async () => {
      if (src) {
        for await (const chunk of src) {
          crc = crc32(chunk, crc);
          size += chunk.length;
          if (!deflate.write(chunk)) await once(deflate, 'drain');
        }
      }
      deflate.end();
    })();
    feed.catch((e) => deflate.destroy(e));
    try {
      for await (const chunk of deflate) {
        packed += chunk.length;
        await this.write(chunk);
      }
      await feed;
    } catch (e) {
      if (src && typeof src.destroy === 'function') src.destroy();
      throw e;
    }

    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    desc.writeUInt32LE(packed, 8);
    desc.writeUInt32LE(size, 12);
    await this.write(desc);
    this.entries.push({ nameBuf, time, date, crc: crc >>> 0, packed, size, start });
    return { size, packed };
  }

  // The central directory and its end record; resolves when the file is shut.
  async finish() {
    const dirStart = this.offset;
    const parts = [];
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4); // made by: 2.0, MS-DOS attributes
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0808, 8);
      c.writeUInt16LE(8, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.packed, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.nameBuf.length, 28);
      // Extra, comment, disk, internal and external attributes: 0.
      c.writeUInt32LE(e.start, 42);
      parts.push(c, e.nameBuf);
    }
    const dir = Buffer.concat(parts);
    await this.write(dir);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(dirStart, 16);
    await this.write(end);
    await new Promise((resolve, reject) => {
      this.out.once('error', reject);
      this.out.end(resolve);
    });
    return this.offset;
  }

  // Stops and closes the file, after an error (the caller removes it).
  abort() {
    this.out.destroy();
  }
}

module.exports = { ZipWriter };
