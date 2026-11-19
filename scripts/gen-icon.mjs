import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const SS = 2;
const R = 224;
const STAR_A = 300;

function inRoundedRect(x, y, s, r) {
  if (x < r && y < r) return (x - r) ** 2 + (y - r) ** 2 <= r * r;
  if (x > s - r && y < r) return (x - (s - r)) ** 2 + (y - r) ** 2 <= r * r;
  if (x < r && y > s - r) return (x - r) ** 2 + (y - (s - r)) ** 2 <= r * r;
  if (x > s - r && y > s - r) return (x - (s - r)) ** 2 + (y - (s - r)) ** 2 <= r * r;
  return true;
}

function isStar(dx, dy) {
  const ax = Math.abs(dx) / STAR_A;
  const ay = Math.abs(dy) / STAR_A;
  return Math.pow(ax, 0.62) + Math.pow(ay, 0.62) <= 1;
}

const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
for (let py = 0; py < SIZE; py++) {
  const rowStart = py * (1 + SIZE * 4);
  raw[rowStart] = 0;
  for (let px = 0; px < SIZE; px++) {
    let cov = 0;
    let starCov = 0;
    let gradSum = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = px + (sx + 0.5) / SS;
        const y = py + (sy + 0.5) / SS;
        if (!inRoundedRect(x, y, SIZE, R)) continue;
        cov++;
        gradSum += (x + y) / (2 * SIZE);
        if (isStar(x - SIZE / 2, y - SIZE / 2)) starCov++;
      }
    }
    const total = SS * SS;
    const alpha = Math.round((cov / total) * 255);
    const t = cov > 0 ? gradSum / cov : 0;
    const baseR = Math.round(10 + (0 - 10) * t);
    const baseG = Math.round(132 + (98 - 132) * t);
    const baseB = Math.round(255 + (204 - 255) * t);
    const starRatio = starCov / total;
    const rr = Math.round(baseR + (255 - baseR) * starRatio);
    const gg = Math.round(baseG + (255 - baseG) * starRatio);
    const bb = Math.round(baseB + (255 - baseB) * starRatio);
    const o = rowStart + 1 + px * 4;
    raw[o] = rr;
    raw[o + 1] = gg;
    raw[o + 2] = bb;
    raw[o + 3] = alpha;
  }
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

// 输出到本仓库的图标目录，与脚本位置绑定，任何机器上可直接运行。
const out = fileURLToPath(new URL("../src-tauri/icons/icon.png", import.meta.url));
writeFileSync(out, png);
console.log("icon.png written:", out, png.length, "bytes");
