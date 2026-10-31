// Streaming PNG encoder, so images taller than any canvas can be encoded band by band.
// Rows are stored unfiltered: snapshots are mostly long runs of identical pixels, which the
// native zlib behind CompressionStream compresses better and faster than with Sub/Up filters.

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

const crc32 = (bytes, crc = -1) => {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc;
};

// Returns the chunk as parts for a Blob, so large IDAT data is never copied.
const chunk = (type, data) => {
  const head = new Uint8Array(8);
  const tail = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i++) head[4 + i] = type.charCodeAt(i);
  new DataView(tail.buffer).setUint32(0, ~crc32(data, crc32(head.subarray(4))) >>> 0);
  return [head, data, tail];
};

// IDAT chunks are capped well below the format's 2 GiB limit.
const IDAT_SIZE = 1 << 24;

export const createPngEncoder = (width, height) => {
  const stride = width * 4;
  const deflate = new CompressionStream('deflate');
  const writer = deflate.writable.getWriter();
  const compressed = new Response(deflate.readable).arrayBuffer();
  let rowsLeft = height;

  return {
    /** Appends `rows` rows of straight-alpha RGBA pixels. */
    async addRows(rgba, rows) {
      rowsLeft -= rows;
      if (rowsLeft < 0) throw new Error('PNG encoder: too many rows');
      const raw = new Uint8Array(rows * (stride + 1));
      for (let r = 0; r < rows; r++) {
        // Filter byte 0 (None) followed by the row's pixels.
        raw.set(rgba.subarray(r * stride, (r + 1) * stride), r * (stride + 1) + 1);
      }
      await writer.write(raw);
    },

    /** Resolves with the finished PNG once every row was added. */
    async finish() {
      if (rowsLeft !== 0) throw new Error('PNG encoder: missing rows');
      await writer.close();
      const idat = new Uint8Array(await compressed);

      const ihdr = new Uint8Array(13);
      const view = new DataView(ihdr.buffer);
      view.setUint32(0, width);
      view.setUint32(4, height);
      ihdr[8] = 8; // bit depth
      ihdr[9] = 6; // colour type: RGBA

      const parts = [SIGNATURE, ...chunk('IHDR', ihdr)];
      for (let i = 0; i < idat.length; i += IDAT_SIZE) {
        parts.push(...chunk('IDAT', idat.subarray(i, i + IDAT_SIZE)));
      }
      parts.push(...chunk('IEND', new Uint8Array(0)));
      return new Blob(parts, { type: 'image/png' });
    }
  };
};
