// Regenerate the desktop app icons from design/brand/sebeto-app-icon.svg.
//
//   node scripts/make-icons.mjs
//
// Writes apps/desktop/build/icon.png (1024 px; also the source electron-builder turns into the
// macOS .icns and the Linux icon sizes) and apps/desktop/build/icon.ico (16-256 px, Windows).
// No extra dependency: the SVG is rasterised by
// the Electron (Chromium) that is already a dev dependency of @sebeto/desktop, drawing it on a
// canvas at each target size, and the .ico is written by hand (BMP entries up to 128 px, PNG at
// 256 px, which is what Windows and NSIS expect).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = join(root, 'design', 'brand', 'sebeto-app-icon.svg');
const outDir = join(root, 'apps', 'desktop', 'build');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

if (!process.versions.electron) {
  // Plain Node: re-run this file inside Electron.
  const require = createRequire(join(root, 'apps', 'desktop', 'package.json'));
  const electronBin = require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // set by some hosts (e.g. VS Code terminals); would run Electron as plain Node
  const res = spawnSync(electronBin, [fileURLToPath(import.meta.url)], { stdio: 'inherit', env });
  process.exit(res.status ?? 1);
}

const { app, BrowserWindow } = await import('electron');

/** Render the SVG at `size` px; returns { png: Buffer, rgba: Buffer }. */
async function render(win, size) {
  const result = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify('data:image/svg+xml;base64,' + readFileSync(svgPath).toString('base64'))};
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = ${size};
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, ${size}, ${size});
    const rgba = Array.from(ctx.getImageData(0, 0, ${size}, ${size}).data);
    return { png: c.toDataURL('image/png').split(',')[1], rgba };
  })()`);
  return { png: Buffer.from(result.png, 'base64'), rgba: Buffer.from(result.rgba) };
}

/** 32-bit BMP (DIB) icon entry: BITMAPINFOHEADER + bottom-up BGRA + 1-bit AND mask. */
function bmpEntry(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND mask height
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = ((size - 1 - y) * size + x) * 4;
      pixels[dst] = rgba[src + 2];
      pixels[dst + 1] = rgba[src + 1];
      pixels[dst + 2] = rgba[src];
      pixels[dst + 3] = rgba[src + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size); // all zero: alpha channel decides
  return Buffer.concat([header, pixels, mask]);
}

function ico(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach(({ size, data }, i) => {
    const o = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, o);
    head.writeUInt8(size >= 256 ? 0 : size, o + 1);
    head.writeUInt8(0, o + 2);
    head.writeUInt8(0, o + 3);
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(data.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.data)]);
}

app.disableHardwareAcceleration();
// No top-level await on whenReady(): Electron emits "ready" only after the ESM entry has finished.
app.whenReady().then(main);

async function main() {
  try {
    const win = new BrowserWindow({ show: false });
    await win.loadURL('data:text/html,<!doctype html><title>icons</title>');
    mkdirSync(outDir, { recursive: true });

    const big = await render(win, 1024);
    writeFileSync(join(outDir, 'icon.png'), big.png);
    const entries = [];
    for (const size of ICO_SIZES) {
      const r = await render(win, size);
      entries.push({ size, data: size >= 256 ? r.png : bmpEntry(size, r.rgba) });
    }
    writeFileSync(join(outDir, 'icon.ico'), ico(entries));
    console.log(`Icons written to ${outDir}: icon.png (1024), icon.ico (${ICO_SIZES.join('/')})`);
    app.exit(0);
  } catch (err) {
    console.error(err);
    app.exit(1);
  }
}
