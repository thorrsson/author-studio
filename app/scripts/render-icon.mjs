// Renders src/renderer/icon.svg into the PNG app icons that electron-builder
// turns into .icns and .ico files, plus the sized PNGs Linux desktops use.
// Run with `npm run icons` after changing the SVG, then commit the PNGs in build/.
import { app, BrowserWindow } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
// Linux desktops look up icons by size in the hicolor theme.
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(path.join(appRoot, 'src', 'renderer', 'icon.svg'), 'utf8');
const outputs = [
  // macOS: the tile sits inside Apple's icon grid margin.
  { file: 'icon.png', svg },
  // Windows and Linux: the tile fills the whole icon.
  { file: 'icon-windows.png', svg: svg.replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"'), linux: true },
];

function pageFor(source) {
  const image = `data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}`;
  const html = `<!doctype html><html><head><style>html,body{margin:0;overflow:hidden;background:transparent}img{display:block;width:${SIZE}px;height:${SIZE}px}</style></head><body><img src="${image}"></body></html>`;
  return `data:text/html;base64,${Buffer.from(html).toString('base64')}`;
}

async function render(win, source) {
  let latest = null;
  const onPaint = (_event, _dirty, image) => {
    latest = image;
  };
  win.webContents.on('paint', onPaint);
  try {
    await win.loadURL(pageFor(source));
    await win.webContents.executeJavaScript('document.images[0].decode().then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))');
    win.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 400));
  } finally {
    win.webContents.off('paint', onPaint);
  }
  if (!latest || latest.isEmpty()) throw new Error('The icon did not render.');
  const { width, height } = latest.getSize();
  return width === SIZE && height === SIZE ? latest : latest.resize({ width: SIZE, height: SIZE, quality: 'best' });
}

app.disableHardwareAcceleration();
app.dock?.hide();
app.whenReady().then(async () => {
  let code = 0;
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(30);
  try {
    mkdirSync(path.join(appRoot, 'build'), { recursive: true });
    for (const output of outputs) {
      const image = await render(win, output.svg);
      writeFileSync(path.join(appRoot, 'build', output.file), image.toPNG());
      console.log(`Wrote build/${output.file}`);
      if (output.linux) {
        mkdirSync(path.join(appRoot, 'build', 'icons'), { recursive: true });
        for (const size of LINUX_SIZES) {
          writeFileSync(path.join(appRoot, 'build', 'icons', `${size}x${size}.png`), image.resize({ width: size, height: size, quality: 'best' }).toPNG());
        }
        console.log(`Wrote build/icons/ (${LINUX_SIZES.join(', ')} px)`);
      }
    }
  } catch (error) {
    console.error(error);
    code = 1;
  } finally {
    win.destroy();
    app.exit(code);
  }
});
