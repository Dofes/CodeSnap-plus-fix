// Streaming PNG encoder, so images taller than any canvas can be encoded band by band.
// Rows are stored unfiltered: snapshots are mostly long runs of identical pixels, which the
// native zlib behind CompressionStream compresses better and faster than with Sub/Up filters.
// Bands are compressed in parallel in workers as independent DEFLATE streams that are then
// joined the way pigz does it: every stream but the last ends like a zlib sync flush.

// Self-contained: the workers run this function's own source text.
const pngCodec = () => {
  const CRC_TABLE = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });

  const crc32 = (bytes, crc = -1) => {
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return crc;
  };

  // Returns the chunk as parts for a Blob, so large data is never copied.
  const chunk = (type, data, crc = crc32(data, crc32(typeBytes(type)))) => {
    const head = new Uint8Array(8);
    const tail = new Uint8Array(4);
    new DataView(head.buffer).setUint32(0, data.length);
    head.set(typeBytes(type), 4);
    new DataView(tail.buffer).setUint32(0, ~crc >>> 0);
    return [head, data, tail];
  };

  const typeBytes = (type) => Uint8Array.from(type, (c) => c.charCodeAt(0));

  // zlib's adler32_combine: the checksum of A+B from those of A and B and the length of B.
  const adlerCombine = (a, b, lengthB) => {
    const BASE = 65521;
    const rem = lengthB % BASE;
    let sum1 = a & 0xffff;
    let sum2 = (rem * sum1) % BASE;
    sum1 += (b & 0xffff) + BASE - 1;
    sum2 += ((a >>> 16) & 0xffff) + ((b >>> 16) & 0xffff) + BASE - rem;
    if (sum1 >= BASE) sum1 -= BASE;
    if (sum1 >= BASE) sum1 -= BASE;
    if (sum2 >= BASE * 2) sum2 -= BASE * 2;
    if (sum2 >= BASE) sum2 -= BASE;
    return (sum1 | (sum2 << 16)) >>> 0;
  };

  // Extra bits after length codes 257-285 and after distance codes 0-29.
  const LEN_EXTRA = Array.from({ length: 29 }, (_, i) => (i < 8 || i === 28 ? 0 : (i >> 2) - 1));
  const DIST_EXTRA = Array.from({ length: 30 }, (_, i) => (i < 4 ? 0 : (i >> 1) - 1));
  const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  // Lookup table indexed by the next `max` stream bits: (symbol << 4) | code length.
  const huffman = (lens) => {
    let max = 0;
    for (let i = 0; i < lens.length; i++) if (lens[i] > max) max = lens[i];
    const count = new Uint16Array(16);
    for (let i = 0; i < lens.length; i++) count[lens[i]]++;
    count[0] = 0;
    const next = new Uint16Array(16);
    for (let b = 1, code = 0; b < 16; b++) next[b] = code = (code + count[b - 1]) << 1;
    const table = new Uint32Array(1 << max);
    for (let s = 0; s < lens.length; s++) {
      const len = lens[s];
      if (!len) continue;
      // Codes are packed most significant bit first into a least significant first stream.
      let rev = 0;
      for (let k = 0, code = next[len]++; k < len; k++, code >>= 1) rev = (rev << 1) | (code & 1);
      for (let j = rev; j < table.length; j += 1 << len) table[j] = (s << 4) | len;
    }
    return { table, max };
  };

  const FIXED_LIT = huffman(
    Uint8Array.from({ length: 288 }, (_, i) => (i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8))
  );
  const FIXED_DIST = huffman(new Uint8Array(30).fill(5));

  // Bit offsets where the final block of a raw DEFLATE stream starts and ends.
  const finalBlock = (buf) => {
    const bits = (pos, n) => {
      const i = pos >>> 3;
      const word = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24);
      return (word >>> (pos & 7)) & ((1 << n) - 1);
    };
    const symbol = (code, pos) => code.table[bits(pos, code.max)];
    for (let pos = 0; ; ) {
      const start = pos;
      const last = bits(pos, 1);
      const type = bits(pos + 1, 2);
      pos += 3;
      if (type === 0) {
        pos = Math.ceil(pos / 8) * 8;
        pos += 32 + bits(pos, 16) * 8;
      } else {
        let lit = FIXED_LIT;
        let dist = FIXED_DIST;
        if (type === 2) {
          const nlit = bits(pos, 5) + 257;
          const ndist = bits(pos + 5, 5) + 1;
          const nclen = bits(pos + 10, 4) + 4;
          pos += 14;
          const clens = new Uint8Array(19);
          for (let i = 0; i < nclen; i++, pos += 3) clens[CL_ORDER[i]] = bits(pos, 3);
          const cl = huffman(clens);
          const lens = new Uint8Array(nlit + ndist);
          for (let i = 0; i < lens.length; ) {
            const e = symbol(cl, pos);
            pos += e & 15;
            const sym = e >>> 4;
            if (sym < 16) {
              lens[i++] = sym;
            } else {
              const [extra, base, value] =
                sym === 16 ? [2, 3, lens[i - 1]] : sym === 17 ? [3, 3, 0] : [7, 11, 0];
              const repeat = base + bits(pos, extra);
              pos += extra;
              lens.fill(value, i, i + repeat);
              i += repeat;
            }
          }
          lit = huffman(lens.subarray(0, nlit));
          dist = huffman(lens.subarray(nlit));
        } else if (type !== 1) {
          throw new Error('Invalid DEFLATE block type');
        }
        for (;;) {
          let e = symbol(lit, pos);
          if (!(e & 15)) throw new Error('Invalid DEFLATE code');
          pos += e & 15;
          const sym = e >>> 4;
          if (sym < 256) continue;
          if (sym === 256) break;
          pos += LEN_EXTRA[sym - 257];
          e = symbol(dist, pos);
          pos += (e & 15) + DIST_EXTRA[e >>> 4];
        }
      }
      if (last) return { start, end: pos };
      if (pos >= buf.length * 8) throw new Error('DEFLATE stream has no final block');
    }
  };

  // Makes a complete raw DEFLATE stream end like a sync flush, so another one can follow.
  const unfinish = (buf) => {
    const { start, end } = finalBlock(buf);
    // An empty stored block after the old final block: 3 zero bits, padding, LEN and NLEN.
    const size = Math.ceil((end + 3) / 8);
    const out = new Uint8Array(size + 4);
    out.set(buf.subarray(0, size));
    out[start >>> 3] &= ~(1 << (start & 7));
    out[end >>> 3] &= (1 << (end & 7)) - 1;
    out.fill(0, (end >>> 3) + 1, size);
    out.set([0, 0, 0xff, 0xff], size);
    return out;
  };

  /** Compresses a band of `{ rgba, x }` tiles into a part of the image's DEFLATE stream. */
  const deflateBand = async (tiles, width, rows, last) => {
    const stride = width * 4;
    const raw = new Uint8Array(rows * (stride + 1));
    for (const { rgba, x } of tiles) {
      const tileStride = rgba.length / rows;
      for (let r = 0; r < rows; r++) {
        // Filter byte 0 (None) followed by the row's pixels.
        const row = rgba.subarray(r * tileStride, (r + 1) * tileStride);
        raw.set(row, r * (stride + 1) + 1 + x * 4);
      }
    }
    const stream = new CompressionStream('deflate');
    const compressed = new Response(stream.readable).arrayBuffer();
    const writer = stream.writable.getWriter();
    writer.write(raw);
    writer.close();
    // A zlib stream: 2-byte header, raw DEFLATE data, then the band's adler32.
    const zlib = new Uint8Array(await compressed);
    const data = zlib.subarray(2, zlib.length - 4);
    const deflate = last ? data.slice() : unfinish(data);
    return {
      deflate,
      crc: crc32(deflate, crc32(typeBytes('IDAT'))),
      adler: new DataView(zlib.buffer).getUint32(zlib.length - 4),
      length: raw.length
    };
  };

  return { chunk, adlerCombine, deflateBand };
};

const { chunk, adlerCombine, deflateBand } = pngCodec();

const WORKER_SOURCE = `const { deflateBand } = (${pngCodec})();
self.postMessage(typeof CompressionStream === 'function');
self.onmessage = async ({ data: { tiles, width, rows, last } }) => {
  try {
    const band = await deflateBand(tiles, width, rows, last);
    self.postMessage(band, [band.deflate.buffer]);
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};`;

// With more workers than this, painting on the main thread is the bottleneck; each worker
// holds about two bands in memory.
const WORKERS = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));

const idleWorkers = [];
const waitingForWorker = [];

// Resolves with whether workers can run here (a CSP or an old Chromium may prevent it).
let workerPool;
const startWorkers = () => {
  workerPool =
    workerPool ||
    new Promise((resolve) => {
      let workers = [];
      const fail = () => {
        workers.forEach((w) => w.terminate());
        resolve(false);
      };
      try {
        const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
        workers = Array.from({ length: WORKERS }, () => new Worker(url));
      } catch (_) {
        fail();
        return;
      }
      const timer = setTimeout(fail, 3000);
      let ready = 0;
      workers.forEach((worker) => {
        worker.onerror = fail;
        worker.onmessage = ({ data }) => {
          if (!data) fail();
          else if (++ready === workers.length) {
            clearTimeout(timer);
            idleWorkers.push(...workers);
            resolve(true);
          }
        };
      });
    });
  return workerPool;
};

const takeWorker = () =>
  idleWorkers.length ? idleWorkers.pop() : new Promise((r) => waitingForWorker.push(r));

const releaseWorker = (worker) => {
  const waiting = waitingForWorker.shift();
  if (waiting) waiting(worker);
  else idleWorkers.push(worker);
};

const deflateInWorker = (worker, message) =>
  new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => (data.error ? reject(new Error(data.error)) : resolve(data));
    worker.onerror = (e) => reject(new Error(e.message || 'PNG worker failed'));
    worker.postMessage(
      message,
      message.tiles.map((tile) => tile.rgba.buffer)
    );
  }).finally(() => releaseWorker(worker));

/** Starts the compression workers, best before the first band is painted. */
export const preparePngEncoder = startWorkers;

export const createPngEncoder = async (width, height) => {
  const parallel = await startWorkers();
  const bands = [];
  let rowsLeft = height;

  return {
    /** Appends a band of `rows` rows given as `{ rgba, x }` tiles, taking their buffers. */
    async addBand(tiles, rows) {
      rowsLeft -= rows;
      if (rowsLeft < 0) throw new Error('PNG encoder: too many rows');
      const last = rowsLeft === 0;
      if (parallel) {
        // Waiting for a free worker keeps the painted bands in memory bounded.
        const band = deflateInWorker(await takeWorker(), { tiles, width, rows, last });
        // finish() reports failures; this only keeps an abandoned encoder from logging them.
        band.catch(() => undefined);
        bands.push(band);
      } else {
        bands.push(await deflateBand(tiles, width, rows, last));
      }
    },

    /** Resolves with the finished PNG once every row was added. */
    async finish() {
      if (rowsLeft !== 0) throw new Error('PNG encoder: missing rows');
      const parts = await Promise.all(bands);

      const ihdr = new Uint8Array(13);
      const view = new DataView(ihdr.buffer);
      view.setUint32(0, width);
      view.setUint32(4, height);
      ihdr[8] = 8; // bit depth
      ihdr[9] = 6; // colour type: RGBA

      let adler = 1;
      const out = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), ...chunk('IHDR', ihdr)];
      out.push(...chunk('IDAT', Uint8Array.of(0x78, 0x9c))); // zlib header
      parts.forEach(({ deflate, crc, adler: bandAdler, length }) => {
        out.push(...chunk('IDAT', deflate, crc));
        adler = adlerCombine(adler, bandAdler, length);
      });
      const trailer = new Uint8Array(4);
      new DataView(trailer.buffer).setUint32(0, adler);
      out.push(...chunk('IDAT', trailer), ...chunk('IEND', new Uint8Array(0)));
      return new Blob(out, { type: 'image/png' });
    }
  };
};
