// A JPEG DECODER THAT NEVER HOLDS THE IMAGE. jpeg-js keeps an Int32Array per 8x8 block, then a line
// per row per component, then RGB, then RGBA: about 25 bytes a pixel, 0.7 to 1.1 GB for a phone
// photo. This is a port of jpeg-js's scan decoder and IDCT (pdf.js code, Apache-2.0) that hands each
// band of rows to a FitAccumulator instead, so the result is byte for byte jpeg-js plus `fitRgba`.
// A single sequential scan streams, with only one band alive; any other layout (progressive,
// one scan per component) keeps the coefficients as Int16, 2 bytes a sample. What it does not
// cover it declines with `null`, and the caller decodes with jpeg-js as before.

import { FitAccumulator, type Rgba } from "./raster";

type HuffmanNode = Array<number | HuffmanNode | undefined>;

type Coefficients = Int16Array | Int32Array;

type Component = {
  readonly h: number;
  readonly v: number;
  readonly quantizationId: number;
  readonly blocksPerLine: number;
  readonly blocksPerColumn: number;
  readonly paddedLine: number;
  readonly paddedRows: number;
  readonly scaleX: number;
  readonly scaleY: number;
  quantization: Int32Array | null;
  dcTable: HuffmanNode | undefined;
  acTable: HuffmanNode | undefined;
  pred: number;
  // Block rows per band, and where the band's coefficients live: the whole image in `full` mode,
  // one band in `stream` mode.
  bandRows: number;
  coefficients: Coefficients;
  // The band's sample rows, `blocksPerLine * 8` wide.
  samples: Uint8Array;
  columns: Int32Array;
};

type Frame = {
  readonly width: number;
  readonly height: number;
  readonly progressive: boolean;
  readonly maxV: number;
  readonly mcusPerLine: number;
  readonly mcusPerColumn: number;
  readonly components: readonly Component[];
  readonly byId: ReadonlyMap<number, Component>;
};

type Output = {
  readonly frame: Frame;
  readonly mode: "stream" | "full";
  readonly bands: number;
  readonly bandLines: number;
  readonly fit: FitAccumulator;
  readonly strip: Uint8Array;
  band: number;
};

// Thrown for a layout this decoder leaves to jpeg-js; never escapes `decodeJpegFitted`.
class Declined extends Error {}

const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40,
  48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29,
  22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54,
  47, 55, 62, 63,
]);

const COS1 = 4017;
const SIN1 = 799;
const COS3 = 3406;
const SIN3 = 2276;
const COS6 = 1567;
const SIN6 = 3784;
const SQRT2 = 5793;
const SQRT1D2 = 2896;

export type StreamFitOptions = {
  readonly maxEdge: number;
  readonly maxPixels: number;
};

// The fitted image, or `null` when the file needs no fitting or is laid out in a way this decoder
// leaves to jpeg-js. A file it covers but cannot decode throws, as jpeg-js would.
export function decodeJpegFitted(
  data: Uint8Array,
  opts: StreamFitOptions,
): Rgba | null {
  try {
    return decode(data, opts);
  } catch (err) {
    if (err instanceof Declined) return null;
    throw err;
  }
}

function decode(data: Uint8Array, opts: StreamFitOptions): Rgba {
  let offset = 0;
  const readUint16 = (): number => {
    const value = ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0);
    offset += 2;
    return value;
  };
  const quantizationTables: Array<Int32Array | undefined> = [];
  const dcTables: Array<HuffmanNode | undefined> = [];
  const acTables: Array<HuffmanNode | undefined> = [];
  let frame: Frame | null = null;
  let output: Output | null = null;
  let scans = 0;
  let resetInterval = 0;

  if (readUint16() !== 0xffd8) throw new Declined();
  for (;;) {
    if (offset + 2 > data.length) throw new Error("unexpected end of file");
    const marker = readUint16();
    if (marker === 0xffd9) break;
    if (marker === 0xff00) continue;
    if ((marker >= 0xffe0 && marker <= 0xffef) || marker === 0xfffe) {
      const length = readUint16();
      const end = Math.min(data.length, offset + length - 2);
      offset += Math.max(0, end - offset);
    } else if (marker === 0xffdb) {
      // A table redefined after a band was already drawn would change what jpeg-js draws there.
      if (output?.mode === "stream") throw new Declined();
      const end = readUint16() + offset - 2;
      while (offset < end) {
        const spec = data[offset++] ?? 0;
        const table = new Int32Array(64);
        if (spec >> 4 === 0)
          for (let j = 0; j < 64; j++)
            table[ZIGZAG[j] as number] = data[offset++] ?? 0;
        else if (spec >> 4 === 1)
          for (let j = 0; j < 64; j++)
            table[ZIGZAG[j] as number] = readUint16();
        else throw new Declined();
        quantizationTables[spec & 15] = table;
      }
    } else if (marker >= 0xffc0 && marker <= 0xffc2) {
      if (frame !== null) throw new Declined();
      readUint16();
      frame = readFrame(data, offset, marker === 0xffc2, opts);
      offset += 6 + 3 * frame.components.length;
    } else if (marker === 0xffc4) {
      const length = readUint16();
      for (let i = 2; i < length; ) {
        const spec = data[offset++] ?? 0;
        const lengths = new Uint8Array(16);
        let total = 0;
        for (let j = 0; j < 16; j++, offset++)
          total += lengths[j] = data[offset] ?? 0;
        const values = new Uint8Array(total);
        for (let j = 0; j < total; j++, offset++) values[j] = data[offset] ?? 0;
        i += 17 + total;
        (spec >> 4 === 0 ? dcTables : acTables)[spec & 15] = buildHuffmanTable(
          lengths,
          values,
        );
      }
    } else if (marker === 0xffdd) {
      readUint16();
      resetInterval = readUint16();
    } else if (marker === 0xffdc) {
      readUint16();
      readUint16();
    } else if (marker === 0xffda) {
      if (frame === null) throw new Declined();
      readUint16();
      const count = data[offset++] ?? 0;
      const components: Component[] = [];
      for (let i = 0; i < count; i++) {
        const component = frame.byId.get(data[offset++] ?? 0);
        const spec = data[offset++] ?? 0;
        if (component === undefined) throw new Declined();
        component.dcTable = dcTables[spec >> 4];
        component.acTable = acTables[spec & 15];
        components.push(component);
      }
      const spectralStart = data[offset++] ?? 0;
      const spectralEnd = data[offset++] ?? 0;
      const approximation = data[offset++] ?? 0;
      if (output === null) {
        const streams =
          !frame.progressive && components.length === frame.components.length;
        output = openOutput(frame, streams, quantizationTables, opts);
      } else if (output.mode === "stream") throw new Declined();
      scans++;
      offset += decodeScan(
        data,
        offset,
        output,
        components,
        resetInterval,
        spectralStart,
        spectralEnd,
        approximation >> 4,
        approximation & 15,
      );
    } else if (marker === 0xffff) {
      if (data[offset] !== 0xff) offset--;
    } else throw new Declined();
  }
  if (frame === null || output === null || scans === 0) throw new Declined();
  if (output.mode === "full")
    for (const c of frame.components) {
      const table = quantizationTables[c.quantizationId];
      if (table === undefined) throw new Declined();
      c.quantization = table;
    }
  while (output.band < output.bands) {
    emitBand(output, output.band);
    output.band++;
  }
  return output.fit.result();
}

function readFrame(
  data: Uint8Array,
  at: number,
  progressive: boolean,
  opts: StreamFitOptions,
): Frame {
  const precision = data[at] ?? 0;
  const height = ((data[at + 1] ?? 0) << 8) | (data[at + 2] ?? 0);
  const width = ((data[at + 3] ?? 0) << 8) | (data[at + 4] ?? 0);
  const count = data[at + 5] ?? 0;
  if (precision !== 8 || (count !== 1 && count !== 3)) throw new Declined();
  if (width === 0 || height === 0 || width * height > opts.maxPixels)
    throw new Declined();
  if (Math.max(width, height) <= opts.maxEdge) throw new Declined();
  const raw: Array<{ id: number; h: number; v: number; q: number }> = [];
  for (let i = 0; i < count; i++) {
    const o = at + 6 + 3 * i;
    const sampling = data[o + 1] ?? 0;
    raw.push({
      id: data[o] ?? 0,
      h: sampling >> 4,
      v: sampling & 15,
      q: data[o + 2] ?? 0,
    });
  }
  // Sampling factors outside the standard's 1..4 are where `0 | (y * v / maxV)` stops being an exact
  // floor (7/10 at y = 90), which would make a band read a row of the band before it.
  if (raw.some((r) => r.h < 1 || r.h > 4 || r.v < 1 || r.v > 4))
    throw new Declined();
  if (new Set(raw.map((r) => r.id)).size !== count) throw new Declined();
  const maxH = Math.max(1, ...raw.map((r) => r.h));
  const maxV = Math.max(1, ...raw.map((r) => r.v));
  const mcusPerLine = Math.ceil(width / 8 / maxH);
  const mcusPerColumn = Math.ceil(height / 8 / maxV);
  const byId = new Map<number, Component>();
  const components = raw.map((r) => {
    const c: Component = {
      h: r.h,
      v: r.v,
      quantizationId: r.q,
      blocksPerLine: Math.ceil((Math.ceil(width / 8) * r.h) / maxH),
      blocksPerColumn: Math.ceil((Math.ceil(height / 8) * r.v) / maxV),
      paddedLine: mcusPerLine * r.h,
      paddedRows: mcusPerColumn * r.v,
      scaleX: r.h / maxH,
      scaleY: r.v / maxV,
      quantization: null,
      dcTable: undefined,
      acTable: undefined,
      pred: 0,
      bandRows: 0,
      coefficients: new Int32Array(0),
      samples: new Uint8Array(0),
      columns: new Int32Array(0),
    };
    byId.set(r.id, c);
    return c;
  });
  return {
    width,
    height,
    progressive,
    maxV,
    mcusPerLine,
    mcusPerColumn,
    components,
    byId,
  };
}

// The decision is taken at the first scan: one sequential scan carrying every component is the
// whole image in raster order, so it can be drawn band by band as it decodes. A single-component
// frame's scan walks block rows, so its band is one block row; an interleaved scan's is a row of
// MCUs. Anything else may revisit a block in a later scan, so every coefficient is kept.
function openOutput(
  frame: Frame,
  streams: boolean,
  quantizationTables: Array<Int32Array | undefined>,
  opts: StreamFitOptions,
): Output {
  const single = frame.components.length === 1;
  const bandLines = streams && single ? 8 : 8 * frame.maxV;
  for (const c of frame.components) {
    c.bandRows = streams && single ? 1 : c.v;
    const lineWidth = c.blocksPerLine * 8;
    c.samples = new Uint8Array(c.bandRows * 8 * lineWidth);
    c.columns = new Int32Array(frame.width);
    for (let x = 0; x < frame.width; x++) c.columns[x] = 0 | (x * c.scaleX);
    if (streams) {
      const table = quantizationTables[c.quantizationId];
      if (table === undefined) throw new Declined();
      c.quantization = table;
      c.coefficients = new Int32Array(c.bandRows * c.paddedLine * 64);
    } else c.coefficients = new Int16Array(c.paddedRows * c.paddedLine * 64);
  }
  return {
    frame,
    mode: streams ? "stream" : "full",
    bands: Math.ceil(frame.height / bandLines),
    bandLines,
    fit: new FitAccumulator(frame.width, frame.height, opts.maxEdge),
    strip: new Uint8Array(frame.width * bandLines * 4),
    band: 0,
  };
}

// jpeg-js's `buildHuffmanTable`, unchanged: the same tree, so a code the stream does not define
// fails the same way.
function buildHuffmanTable(
  codeLengths: Uint8Array,
  values: Uint8Array,
): HuffmanNode {
  type Node = { children: HuffmanNode; index: number };
  let k = 0;
  let length = 16;
  while (length > 0 && !codeLengths[length - 1]) length--;
  const code: Node[] = [{ children: [], index: 0 }];
  let p = code[0] as Node;
  let q: Node;
  for (let i = 0; i < length; i++) {
    for (let j = 0; j < (codeLengths[i] as number); j++) {
      p = code.pop() as Node;
      p.children[p.index] = values[k];
      while (p.index > 0) {
        if (code.length === 0)
          throw new Error("Could not recreate Huffman Table");
        p = code.pop() as Node;
      }
      p.index++;
      code.push(p);
      while (code.length <= i) {
        q = { children: [], index: 0 };
        code.push(q);
        p.children[p.index] = q.children;
        p = q;
      }
      k++;
    }
    if (i + 1 < length) {
      q = { children: [], index: 0 };
      code.push(q);
      p.children[p.index] = q.children;
      p = q;
    }
  }
  return (code[0] as Node).children;
}

type BlockDecoder = (c: Component, zz: Coefficients, o: number) => void;

// jpeg-js's `decodeScan`, with the block lookup pointed at this decoder's storage. Kept line for
// line, quirks included (a restart interval of a single-component scan runs past the last block,
// and jpeg-js skips only the blocks with no storage), because the bits each block consumes decide
// where every later block starts.
function decodeScan(
  data: Uint8Array,
  start: number,
  out: Output,
  components: Component[],
  interval: number,
  spectralStart: number,
  spectralEnd: number,
  successivePrev: number,
  successive: number,
): number {
  const frame = out.frame;
  const scratch = new Int32Array(64);
  let offset = start;
  let bitsData = 0;
  let bitsCount = 0;
  let eobrun = 0;
  let successiveACState = 0;
  let successiveACNextValue = 0;

  const readBit = (): number => {
    if (bitsCount > 0) {
      bitsCount--;
      return (bitsData >> bitsCount) & 1;
    }
    bitsData = data[offset++] ?? 0;
    if (bitsData === 0xff) {
      const next = data[offset++] ?? 0;
      if (next)
        throw new Error(
          `unexpected marker: ${((bitsData << 8) | next).toString(16)}`,
        );
    }
    bitsCount = 7;
    return bitsData >>> 7;
  };
  const decodeHuffman = (tree: HuffmanNode | undefined): number => {
    if (tree === undefined) throw new Error("invalid huffman sequence");
    let node: number | HuffmanNode | undefined = tree;
    for (;;) {
      node = (node as HuffmanNode)[readBit()];
      if (typeof node === "number") return node;
      if (typeof node !== "object") throw new Error("invalid huffman sequence");
    }
  };
  const receive = (length: number): number => {
    let n = 0;
    for (let l = length; l > 0; l--) n = (n << 1) | readBit();
    return n;
  };
  const receiveAndExtend = (length: number): number => {
    const n = receive(length);
    if (n >= 1 << (length - 1)) return n;
    return n + (-1 << length) + 1;
  };

  const decodeBaseline: BlockDecoder = (c, zz, o) => {
    const t = decodeHuffman(c.dcTable);
    const diff = t === 0 ? 0 : receiveAndExtend(t);
    c.pred += diff;
    zz[o] = c.pred;
    let k = 1;
    while (k < 64) {
      const rs = decodeHuffman(c.acTable);
      const s = rs & 15;
      const r = rs >> 4;
      if (s === 0) {
        if (r < 15) break;
        k += 16;
        continue;
      }
      k += r;
      const value = receiveAndExtend(s);
      if (k < 64) zz[o + (ZIGZAG[k] as number)] = value;
      k++;
    }
  };
  const decodeDCFirst: BlockDecoder = (c, zz, o) => {
    const t = decodeHuffman(c.dcTable);
    const diff = t === 0 ? 0 : receiveAndExtend(t) << successive;
    c.pred += diff;
    zz[o] = c.pred;
  };
  const decodeDCSuccessive: BlockDecoder = (_c, zz, o) => {
    zz[o] = (zz[o] as number) | (readBit() << successive);
  };
  const decodeACFirst: BlockDecoder = (c, zz, o) => {
    if (eobrun > 0) {
      eobrun--;
      return;
    }
    let k = spectralStart;
    while (k <= spectralEnd) {
      const rs = decodeHuffman(c.acTable);
      const s = rs & 15;
      const r = rs >> 4;
      if (s === 0) {
        if (r < 15) {
          eobrun = receive(r) + (1 << r) - 1;
          break;
        }
        k += 16;
        continue;
      }
      k += r;
      const value = receiveAndExtend(s) * (1 << successive);
      if (k < 64) zz[o + (ZIGZAG[k] as number)] = value;
      k++;
    }
  };
  const decodeACSuccessive: BlockDecoder = (c, zz, o) => {
    let k = spectralStart;
    let r = 0;
    while (k <= spectralEnd) {
      const at = k < 64 ? o + (ZIGZAG[k] as number) : -1;
      const current = at < 0 ? 0 : (zz[at] as number);
      const direction = current < 0 ? -1 : 1;
      switch (successiveACState) {
        case 0: {
          const rs = decodeHuffman(c.acTable);
          const s = rs & 15;
          r = rs >> 4;
          if (s === 0) {
            if (r < 15) {
              eobrun = receive(r) + (1 << r);
              successiveACState = 4;
            } else {
              r = 16;
              successiveACState = 1;
            }
          } else {
            if (s !== 1) throw new Error("invalid ACn encoding");
            successiveACNextValue = receiveAndExtend(s);
            successiveACState = r ? 2 : 3;
          }
          continue;
        }
        case 1:
        case 2:
          if (current) zz[at] = current + (readBit() << successive) * direction;
          else {
            r--;
            if (r === 0) successiveACState = successiveACState === 2 ? 3 : 0;
          }
          break;
        case 3:
          if (current) zz[at] = current + (readBit() << successive) * direction;
          else {
            if (at >= 0) zz[at] = successiveACNextValue << successive;
            successiveACState = 0;
          }
          break;
        case 4:
          if (current) zz[at] = current + (readBit() << successive) * direction;
          break;
      }
      k++;
    }
    if (successiveACState === 4) {
      eobrun--;
      if (eobrun === 0) successiveACState = 0;
    }
  };

  // Where block (row, col) of `c` lives, or false for a block jpeg-js has no storage for.
  let target: Coefficients = scratch;
  let targetOffset = 0;
  const locate = (
    c: Component,
    blockRow: number,
    blockCol: number,
  ): boolean => {
    if (blockRow >= c.paddedRows) return false;
    if (out.mode === "full") {
      target = c.coefficients;
      targetOffset = (blockRow * c.paddedLine + blockCol) * 64;
      return true;
    }
    const band = Math.floor(blockRow / c.bandRows);
    if (band < out.band)
      throw new Error(`jpeg block row ${blockRow} arrived after its band`);
    if (band >= out.bands) {
      target = scratch;
      targetOffset = 0;
      return true;
    }
    while (out.band < band) {
      emitBand(out, out.band);
      out.band++;
    }
    target = c.coefficients;
    targetOffset =
      ((blockRow - band * c.bandRows) * c.paddedLine + blockCol) * 64;
    return true;
  };
  const decodeMcu = (
    c: Component,
    decodeFn: BlockDecoder,
    mcu: number,
    row: number,
    col: number,
  ): void => {
    const mcuRow = (mcu / frame.mcusPerLine) | 0;
    const mcuCol = mcu % frame.mcusPerLine;
    if (locate(c, mcuRow * c.v + row, mcuCol * c.h + col))
      decodeFn(c, target, targetOffset);
  };
  const decodeBlock = (c: Component, decodeFn: BlockDecoder, mcu: number) => {
    if (locate(c, (mcu / c.blocksPerLine) | 0, mcu % c.blocksPerLine))
      decodeFn(c, target, targetOffset);
  };

  let decodeFn: BlockDecoder = decodeBaseline;
  if (frame.progressive) {
    if (spectralStart === 0)
      decodeFn = successivePrev === 0 ? decodeDCFirst : decodeDCSuccessive;
    else decodeFn = successivePrev === 0 ? decodeACFirst : decodeACSuccessive;
  }

  const first = components[0] as Component;
  const mcuExpected =
    components.length === 1
      ? first.blocksPerLine * first.blocksPerColumn
      : frame.mcusPerLine * frame.mcusPerColumn;
  const resetInterval = interval || mcuExpected;
  let mcu = 0;
  while (mcu < mcuExpected) {
    for (const c of components) c.pred = 0;
    eobrun = 0;
    if (components.length === 1) {
      for (let n = 0; n < resetInterval; n++) {
        decodeBlock(first, decodeFn, mcu);
        mcu++;
      }
    } else {
      for (let n = 0; n < resetInterval; n++) {
        for (const c of components)
          for (let j = 0; j < c.v; j++)
            for (let k = 0; k < c.h; k++) decodeMcu(c, decodeFn, mcu, j, k);
        mcu++;
        if (mcu === mcuExpected) break;
      }
    }
    if (mcu === mcuExpected) {
      do {
        if (data[offset] === 0xff && data[offset + 1] !== 0x00) break;
        offset += 1;
      } while (offset < data.length - 2);
    }
    bitsCount = 0;
    const marker = ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0);
    if (marker < 0xff00) throw new Error("marker was not found");
    if (marker >= 0xffd0 && marker <= 0xffd7) offset += 2;
    else break;
  }
  return offset - start;
}

// Draws band `band`: the IDCT of its blocks into each component's sample rows, then jpeg-js's
// `getData` for those output rows (nearest chroma sample, the same YCbCr formula written into a
// Uint8Array, which truncates), handed to the accumulator. In `stream` mode the band's coefficients
// are cleared afterwards, since a sequential block writes only its non-zero ones.
function emitBand(out: Output, band: number): void {
  const { frame, strip } = out;
  const p = new Int32Array(64);
  for (const c of frame.components) {
    const lineWidth = c.blocksPerLine * 8;
    const table = c.quantization as Int32Array;
    for (let r = 0; r < c.bandRows; r++) {
      const blockRow = band * c.bandRows + r;
      if (blockRow >= c.blocksPerColumn) continue;
      const source = out.mode === "full" ? blockRow : r;
      for (let col = 0; col < c.blocksPerLine; col++)
        quantizeAndInverse(
          c.coefficients,
          (source * c.paddedLine + col) * 64,
          table,
          p,
          c.samples,
          r * 8 * lineWidth + col * 8,
          lineWidth,
        );
    }
  }
  const y0 = band * out.bandLines;
  const y1 = Math.min(frame.height, y0 + out.bandLines);
  const width = frame.width;
  const [c1, c2, c3] = frame.components as [Component, Component?, Component?];
  let j = 0;
  for (let y = y0; y < y1; y++) {
    const s1 = c1.samples;
    const o1 = sampleRow(c1, y, band);
    const col1 = c1.columns;
    if (c2 === undefined || c3 === undefined) {
      for (let x = 0; x < width; x++) {
        const gray = s1[o1 + (col1[x] as number)] as number;
        strip[j++] = gray;
        strip[j++] = gray;
        strip[j++] = gray;
        strip[j++] = 255;
      }
      continue;
    }
    const s2 = c2.samples;
    const s3 = c3.samples;
    const o2 = sampleRow(c2, y, band);
    const o3 = sampleRow(c3, y, band);
    const col2 = c2.columns;
    const col3 = c3.columns;
    for (let x = 0; x < width; x++) {
      const lum = s1[o1 + (col1[x] as number)] as number;
      const cb = s2[o2 + (col2[x] as number)] as number;
      const cr = s3[o3 + (col3[x] as number)] as number;
      strip[j++] = clampTo8bit(lum + 1.402 * (cr - 128));
      strip[j++] = clampTo8bit(
        lum - 0.3441363 * (cb - 128) - 0.71413636 * (cr - 128),
      );
      strip[j++] = clampTo8bit(lum + 1.772 * (cb - 128));
      strip[j++] = 255;
    }
  }
  if (y1 > y0)
    out.fit.add({ data: strip.subarray(0, j), width, height: y1 - y0 }, 0, y0);
  if (out.mode === "stream")
    for (const c of frame.components) c.coefficients.fill(0);
}

// Offset of the sample row jpeg-js reads for output row `y`: `lines[0 | (y * scaleY)]`, which with
// sampling factors of 1..4 always falls inside the band that holds `y`.
function sampleRow(c: Component, y: number, band: number): number {
  const local = (0 | (y * c.scaleY)) - band * c.bandRows * 8;
  if (local < 0 || local >= c.bandRows * 8)
    throw new Error(`jpeg sample row ${local} is outside its band`);
  return local * c.blocksPerLine * 8;
}

function clampTo8bit(a: number): number {
  return a < 0 ? 0 : Math.min(a, 255);
}

// jpeg-js's `quantizeAndInverse` (poppler's IDCT after Loeffler, Ligtenberg and Moschytz, 1989),
// unchanged but for where it reads and writes. Every step is the same integer arithmetic on an
// Int32Array, which is what makes the output byte-identical.
function quantizeAndInverse(
  zz: Coefficients,
  zo: number,
  qt: Int32Array,
  p: Int32Array,
  out: Uint8Array,
  oo: number,
  stride: number,
): void {
  let v0: number;
  let v1: number;
  let v2: number;
  let v3: number;
  let v4: number;
  let v5: number;
  let v6: number;
  let v7: number;
  let t: number;
  for (let i = 0; i < 64; i++)
    p[i] = (zz[zo + i] as number) * (qt[i] as number);
  for (let i = 0; i < 8; ++i) {
    const row = 8 * i;
    if (
      p[1 + row] === 0 &&
      p[2 + row] === 0 &&
      p[3 + row] === 0 &&
      p[4 + row] === 0 &&
      p[5 + row] === 0 &&
      p[6 + row] === 0 &&
      p[7 + row] === 0
    ) {
      t = (SQRT2 * (p[row] as number) + 512) >> 10;
      for (let k = 0; k < 8; k++) p[row + k] = t;
      continue;
    }
    v0 = (SQRT2 * (p[row] as number) + 128) >> 8;
    v1 = (SQRT2 * (p[4 + row] as number) + 128) >> 8;
    v2 = p[2 + row] as number;
    v3 = p[6 + row] as number;
    v4 =
      (SQRT1D2 * ((p[1 + row] as number) - (p[7 + row] as number)) + 128) >> 8;
    v7 =
      (SQRT1D2 * ((p[1 + row] as number) + (p[7 + row] as number)) + 128) >> 8;
    v5 = (p[3 + row] as number) << 4;
    v6 = (p[5 + row] as number) << 4;
    t = (v0 - v1 + 1) >> 1;
    v0 = (v0 + v1 + 1) >> 1;
    v1 = t;
    t = (v2 * SIN6 + v3 * COS6 + 128) >> 8;
    v2 = (v2 * COS6 - v3 * SIN6 + 128) >> 8;
    v3 = t;
    t = (v4 - v6 + 1) >> 1;
    v4 = (v4 + v6 + 1) >> 1;
    v6 = t;
    t = (v7 + v5 + 1) >> 1;
    v5 = (v7 - v5 + 1) >> 1;
    v7 = t;
    t = (v0 - v3 + 1) >> 1;
    v0 = (v0 + v3 + 1) >> 1;
    v3 = t;
    t = (v1 - v2 + 1) >> 1;
    v1 = (v1 + v2 + 1) >> 1;
    v2 = t;
    t = (v4 * SIN3 + v7 * COS3 + 2048) >> 12;
    v4 = (v4 * COS3 - v7 * SIN3 + 2048) >> 12;
    v7 = t;
    t = (v5 * SIN1 + v6 * COS1 + 2048) >> 12;
    v5 = (v5 * COS1 - v6 * SIN1 + 2048) >> 12;
    v6 = t;
    p[row] = v0 + v7;
    p[7 + row] = v0 - v7;
    p[1 + row] = v1 + v6;
    p[6 + row] = v1 - v6;
    p[2 + row] = v2 + v5;
    p[5 + row] = v2 - v5;
    p[3 + row] = v3 + v4;
    p[4 + row] = v3 - v4;
  }
  for (let col = 0; col < 8; ++col) {
    if (
      p[8 + col] === 0 &&
      p[16 + col] === 0 &&
      p[24 + col] === 0 &&
      p[32 + col] === 0 &&
      p[40 + col] === 0 &&
      p[48 + col] === 0 &&
      p[56 + col] === 0
    ) {
      t = (SQRT2 * (p[col] as number) + 8192) >> 14;
      for (let k = 0; k < 64; k += 8) p[k + col] = t;
      continue;
    }
    v0 = (SQRT2 * (p[col] as number) + 2048) >> 12;
    v1 = (SQRT2 * (p[32 + col] as number) + 2048) >> 12;
    v2 = p[16 + col] as number;
    v3 = p[48 + col] as number;
    v4 =
      (SQRT1D2 * ((p[8 + col] as number) - (p[56 + col] as number)) + 2048) >>
      12;
    v7 =
      (SQRT1D2 * ((p[8 + col] as number) + (p[56 + col] as number)) + 2048) >>
      12;
    v5 = p[24 + col] as number;
    v6 = p[40 + col] as number;
    t = (v0 - v1 + 1) >> 1;
    v0 = (v0 + v1 + 1) >> 1;
    v1 = t;
    t = (v2 * SIN6 + v3 * COS6 + 2048) >> 12;
    v2 = (v2 * COS6 - v3 * SIN6 + 2048) >> 12;
    v3 = t;
    t = (v4 - v6 + 1) >> 1;
    v4 = (v4 + v6 + 1) >> 1;
    v6 = t;
    t = (v7 + v5 + 1) >> 1;
    v5 = (v7 - v5 + 1) >> 1;
    v7 = t;
    t = (v0 - v3 + 1) >> 1;
    v0 = (v0 + v3 + 1) >> 1;
    v3 = t;
    t = (v1 - v2 + 1) >> 1;
    v1 = (v1 + v2 + 1) >> 1;
    v2 = t;
    t = (v4 * SIN3 + v7 * COS3 + 2048) >> 12;
    v4 = (v4 * COS3 - v7 * SIN3 + 2048) >> 12;
    v7 = t;
    t = (v5 * SIN1 + v6 * COS1 + 2048) >> 12;
    v5 = (v5 * COS1 - v6 * SIN1 + 2048) >> 12;
    v6 = t;
    p[col] = v0 + v7;
    p[56 + col] = v0 - v7;
    p[8 + col] = v1 + v6;
    p[48 + col] = v1 - v6;
    p[16 + col] = v2 + v5;
    p[40 + col] = v2 - v5;
    p[24 + col] = v3 + v4;
    p[32 + col] = v3 - v4;
  }
  for (let i = 0; i < 64; ++i) {
    const sample = 128 + (((p[i] as number) + 8) >> 4);
    out[oo + (i >> 3) * stride + (i & 7)] =
      sample < 0 ? 0 : Math.min(sample, 0xff);
  }
}
