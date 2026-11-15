#!/usr/bin/env node
// Pixel Veil: regenerate the PNG icons from icons/icon.svg.
//
//   node tools/make-icons.mjs
//
// No dependencies. The script reads the <rect> elements out of icons/icon.svg, draws
// them into an RGBA buffer with anti-aliased rounded corners, and writes PNG files with
// a small encoder built on zlib and CRC32. Because the SVG is the only description of
// the artwork, the PNGs always match it. Change a colour in the SVG, run this again.
//
// The SVG reader is deliberately tiny. It understands <rect> with x, y, width, height,
// rx, fill (#rgb or #rrggbb), opacity and fill-opacity, in a square viewBox that starts
// at 0 0. Anything else (paths, circles, transforms, gradients) stops the script with
// an error, so the PNGs can never drift from the SVG without anyone noticing.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = join(ROOT, 'icons');
const SVG_PATH = join(ICON_DIR, 'icon.svg');

// The maskable safe zone is a circle whose diameter is 80 % of the icon. The mark is
// shrunk until its farthest corner sits a little inside that circle.
const SAFE_RADIUS = 0.4;
const SAFE_MARGIN = 0.96;

const OUTPUTS = [
  // Rounded tile on a transparent background, exactly like the SVG.
  { file: 'icon-192.png', size: 192, fullBleed: false, safeZone: false },
  { file: 'icon-512.png', size: 512, fullBleed: false, safeZone: false },
  // Maskable: the launcher cuts its own shape, so the background fills the square and
  // the mark stays inside the safe zone.
  { file: 'icon-maskable-512.png', size: 512, fullBleed: true, safeZone: true },
  // iOS rounds the corners itself and paints transparent pixels black, so the
  // apple-touch-icon is an opaque square.
  { file: 'apple-touch-icon.png', size: 180, fullBleed: true, safeZone: false },
];

function fail(message) {
  console.error(`make-icons: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Reading the SVG
// ---------------------------------------------------------------------------

function parseColour(text, where) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(text).trim());
  if (!hex) fail(`${where}: fill must be #rgb or #rrggbb, found "${text}"`);
  let digits = hex[1];
  if (digits.length === 3) digits = digits.replace(/./g, (c) => c + c);
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
}

function parseNumber(text, where, name, fallback) {
  if (text === undefined) {
    if (fallback === undefined) fail(`${where}: missing ${name}`);
    return fallback;
  }
  const value = Number(text);
  if (!Number.isFinite(value)) fail(`${where}: ${name} must be a plain number, found "${text}"`);
  return value;
}

function readSvg(path) {
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    fail(`cannot read ${path} (${error.code || error.message})`);
  }
  source = source.replace(/<!--[\s\S]*?-->/g, '');

  const viewBox = /<svg\b[^>]*\bviewBox\s*=\s*"([^"]*)"/.exec(source);
  if (!viewBox) fail('icon.svg needs a viewBox on the <svg> element');
  const [minX, minY, vbWidth, vbHeight] = viewBox[1].trim().split(/[\s,]+/).map(Number);
  if (minX !== 0 || minY !== 0 || !(vbWidth > 0) || vbWidth !== vbHeight) {
    fail(`icon.svg viewBox must be square and start at 0 0, found "${viewBox[1]}"`);
  }

  const unsupported = /<(path|circle|ellipse|line|polyline|polygon|text|image|use|g|defs|linearGradient|radialGradient|mask|clipPath|filter|style)\b/.exec(source);
  if (unsupported) fail(`icon.svg contains <${unsupported[1]}>, but this script only draws <rect>`);
  if (/\btransform\s*=/.test(source)) fail('icon.svg uses a transform, but this script does not apply transforms');

  const rects = [];
  const rectTag = /<rect\b([^>]*)>/g;
  for (let match; (match = rectTag.exec(source)); ) {
    const attrs = {};
    const attr = /([\w:-]+)\s*=\s*"([^"]*)"/g;
    for (let pair; (pair = attr.exec(match[1])); ) attrs[pair[1]] = pair[2];
    const where = `rect ${rects.length + 1}`;
    const width = parseNumber(attrs.width, where, 'width');
    const height = parseNumber(attrs.height, where, 'height');
    const rx = parseNumber(attrs.rx ?? attrs.ry, where, 'rx', 0);
    rects.push({
      id: attrs.id || '',
      x: parseNumber(attrs.x, where, 'x', 0),
      y: parseNumber(attrs.y, where, 'y', 0),
      width,
      height,
      rx: Math.max(0, Math.min(rx, width / 2, height / 2)),
      rgb: parseColour(attrs.fill, where),
      alpha:
        parseNumber(attrs.opacity, where, 'opacity', 1) *
        parseNumber(attrs['fill-opacity'], where, 'fill-opacity', 1),
    });
  }

  const tile = rects.find((rect) => rect.id === 'tile');
  if (!tile) fail('icon.svg needs a background <rect id="tile">');
  const mark = rects.filter((rect) => rect !== tile);
  if (mark.length === 0) fail('icon.svg has no mark, only the tile');
  return { viewSize: vbWidth, tile, mark };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/**
 * Paint an anti-aliased rounded rectangle into a straight-alpha RGBA buffer.
 * Coordinates are in output pixels and may be fractional.
 *
 * Coverage comes from the signed distance between each pixel centre and the shape's
 * edge: half a pixel inside is fully covered, half a pixel outside is empty. That is
 * exact along the straight sides and very close on the corner arcs.
 */
function fillRoundRect(pixels, size, x, y, width, height, radius, rgb, alpha) {
  const halfW = width / 2;
  const halfH = height / 2;
  const centreX = x + halfW;
  const centreY = y + halfH;
  const r = Math.max(0, Math.min(radius, halfW, halfH));

  const x0 = Math.max(0, Math.floor(x - 1));
  const y0 = Math.max(0, Math.floor(y - 1));
  const x1 = Math.min(size - 1, Math.ceil(x + width + 1));
  const y1 = Math.min(size - 1, Math.ceil(y + height + 1));

  for (let py = y0; py <= y1; py++) {
    const qy = Math.abs(py + 0.5 - centreY) - (halfH - r);
    for (let px = x0; px <= x1; px++) {
      const qx = Math.abs(px + 0.5 - centreX) - (halfW - r);
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
      const inside = Math.min(Math.max(qx, qy), 0);
      const distance = outside + inside - r;
      const coverage = Math.min(1, Math.max(0, 0.5 - distance));
      if (coverage <= 0) continue;

      // Source-over blend with straight (not premultiplied) alpha.
      const srcA = coverage * alpha;
      const i = (py * size + px) * 4;
      const dstA = pixels[i + 3] / 255;
      const outA = srcA + dstA * (1 - srcA);
      for (let c = 0; c < 3; c++) {
        const blended = (rgb[c] * srcA + pixels[i + c] * dstA * (1 - srcA)) / outA;
        pixels[i + c] = Math.round(blended);
      }
      pixels[i + 3] = Math.round(outA * 255);
    }
  }
}

function renderIcon(art, { size, fullBleed, safeZone }) {
  const pixels = new Uint8Array(size * size * 4); // starts fully transparent
  const scale = size / art.viewSize;
  const centre = art.viewSize / 2;

  const { tile } = art;
  if (fullBleed) {
    fillRoundRect(pixels, size, 0, 0, size, size, 0, tile.rgb, 1);
  } else {
    fillRoundRect(
      pixels, size,
      tile.x * scale, tile.y * scale, tile.width * scale, tile.height * scale,
      tile.rx * scale, tile.rgb, tile.alpha,
    );
  }

  // For the maskable icon, shrink the mark around the centre until its farthest
  // corner is inside the safe circle.
  let markScale = 1;
  if (safeZone) {
    let farthest = 0;
    for (const rect of art.mark) {
      for (const cx of [rect.x, rect.x + rect.width]) {
        for (const cy of [rect.y, rect.y + rect.height]) {
          farthest = Math.max(farthest, Math.hypot(cx - centre, cy - centre));
        }
      }
    }
    markScale = Math.min(1, (SAFE_RADIUS * SAFE_MARGIN * art.viewSize) / farthest);
  }

  for (const rect of art.mark) {
    const x = centre + (rect.x - centre) * markScale;
    const y = centre + (rect.y - centre) * markScale;
    fillRoundRect(
      pixels, size,
      x * scale, y * scale,
      rect.width * markScale * scale, rect.height * markScale * scale,
      rect.rx * markScale * scale, rect.rgb, rect.alpha,
    );
  }
  return pixels;
}

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, checksum]);
}

function encodePng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); // width
  header.writeUInt32BE(size, 4); // height
  header[8] = 8; // bits per channel
  header[9] = 6; // colour type 6: RGBA
  header[10] = 0; // compression: deflate
  header[11] = 0; // filter method 0
  header[12] = 0; // not interlaced

  // Each scanline is one filter byte (0 = none) followed by the row's RGBA bytes.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let row = 0; row < size; row++) {
    const start = row * (stride + 1);
    raw[start] = 0;
    raw.set(pixels.subarray(row * stride, (row + 1) * stride), start + 1);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Read a PNG back and check the signature, every chunk CRC, the IHDR and the data size. */
function verifyPng(file, name, expectedSize) {
  const where = `${name}: verification failed,`;
  if (!file.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${where} bad signature`);
  let offset = 8;
  let header = null;
  const data = [];
  let ended = false;
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('latin1', offset + 4, offset + 8);
    const body = file.subarray(offset + 4, offset + 8 + length);
    if (crc32(body) !== file.readUInt32BE(offset + 8 + length)) throw new Error(`${where} bad CRC in ${type}`);
    if (type === 'IHDR') header = body.subarray(4);
    if (type === 'IDAT') data.push(body.subarray(4));
    if (type === 'IEND') ended = true;
    offset += 12 + length;
  }
  if (!header || !ended) throw new Error(`${where} missing IHDR or IEND`);
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(`${where} size is ${width} x ${height}, expected ${expectedSize} x ${expectedSize}`);
  }
  if (header[8] !== 8 || header[9] !== 6) throw new Error(`${where} not 8-bit RGBA`);
  const inflated = inflateSync(Buffer.concat(data));
  if (inflated.length !== (width * 4 + 1) * height) throw new Error(`${where} pixel data has the wrong length`);
  return { width, height };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const art = readSvg(SVG_PATH);
mkdirSync(ICON_DIR, { recursive: true });

for (const output of OUTPUTS) {
  const png = encodePng(renderIcon(art, output), output.size);
  const target = join(ICON_DIR, output.file);
  writeFileSync(target, png);
  let checked;
  try {
    checked = verifyPng(readFileSync(target), `icons/${output.file}`, output.size);
  } catch (error) {
    fail(error.message);
  }
  const name = `icons/${output.file}`.padEnd(30);
  console.log(`${name} ${checked.width} x ${checked.height}  ${png.length.toLocaleString('en-AU')} bytes`);
}
console.log(`Drew ${art.mark.length} blocks from icons/icon.svg.`);
