#!/usr/bin/env node
/* global Buffer, console */
// Generates placeholder PWA icons for the player at 192px and 512px.
// Hand-rolled PNG encoder (zlib + CRC32) so we don't pull a binary
// image lib into the toolchain for what's effectively a solid-color
// square with a centered "W" — designers can replace these with a
// real logo by overwriting player-app/public/icon-{192,512}.png.

import { createHash } from 'crypto';
import { deflateSync } from 'zlib';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'player-app', 'public');

// Theme color matches manifest.webmanifest's background_color (#1a1a2e).
const BG = [0x1a, 0x1a, 0x2e, 0xff];
const FG = [0xff, 0xff, 0xff, 0xff];

// CRC32 table for PNG chunk integrity. Built once at startup.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Render an RGBA pixel buffer of size×size with a colored background
 * and a centered "W" stroke. Crude bitmap stencil — readable enough
 * at 192px and up. */
function renderRgba(size) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      buf[i] = BG[0];
      buf[i + 1] = BG[1];
      buf[i + 2] = BG[2];
      buf[i + 3] = BG[3];
    }
  }
  // Draw a chunky "W" centered. Five strokes from the standard W
  // outline: down-right, up-right, down-right, up-right.
  // Coordinates as fractions of the canvas, then rasterized.
  const cx = size / 2;
  const cy = size / 2;
  const halfW = size * 0.28;
  const halfH = size * 0.18;
  const strokeR = Math.max(2, Math.round(size * 0.045));

  const pts = [
    [cx - halfW, cy - halfH],
    [cx - halfW / 2, cy + halfH],
    [cx, cy - halfH * 0.4],
    [cx + halfW / 2, cy + halfH],
    [cx + halfW, cy - halfH],
  ];

  function plot(x, y) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= size || yi >= size) return;
    const i = (yi * size + xi) * 4;
    buf[i] = FG[0];
    buf[i + 1] = FG[1];
    buf[i + 2] = FG[2];
    buf[i + 3] = FG[3];
  }
  function disc(cxd, cyd, r) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r) plot(cxd + dx, cyd + dy);
      }
    }
  }
  // Bresenham-ish line, rasterized as a disc at each step.
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, strokeR);
    }
  }
  return buf;
}

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Each scanline must be prefixed with a filter byte. Use 0 (none).
  const stride = size * 4;
  const filtered = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    filtered[y * (stride + 1)] = 0;
    rgba.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(filtered);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const png = encodePng(size, renderRgba(size));
  const path = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(path, png);
  console.log(
    `wrote ${path} (${png.length} bytes)  sha256=${createHash('sha256').update(png).digest('hex').slice(0, 12)}`,
  );
}
