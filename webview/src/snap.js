import { $, redraw, once } from './util.js';
import { nodeToSvg, loadSvgImage, rasterize } from './render.js';
import { createPngEncoder, preparePngEncoder } from './png.js';

const vscode = acquireVsCodeApi();
const windowNode = $('#window');
const snippetContainerNode = $('#snippet-container');
const shutterNode = $('#save');

const flashFx = $('#flash-fx');

const SNAP_SCALE = 2;

// To put an image on the clipboard Chromium decodes it inside the webview's process, and VS
// Code's webview crashes doing so somewhere above 160M pixels. The host copies larger images.
const MAX_CLIPBOARD_PIXELS = 1 << 27;

export const cameraFlashAnimation = async () => {
  flashFx.style.display = 'block';
  redraw(flashFx);
  flashFx.style.opacity = '0';
  await once(flashFx, 'transitionend');
  flashFx.style.display = 'none';
  flashFx.style.opacity = '1';
};

const snapTarget = (config) => (config.target === 'container' ? snippetContainerNode : windowNode);

const renderPng = async (config) => {
  preparePngEncoder();
  const target = snapTarget(config);
  const overrides =
    config.transparentBackground || config.target === 'window'
      ? { '--container-background-color': 'transparent' }
      : {};
  const { svg, width, height } = await nodeToSvg(target, {
    overrides,
    extraCss: '#window { resize: none !important; }'
  });
  const img = await loadSvgImage(svg);
  const encoder = await createPngEncoder(
    Math.ceil(width * SNAP_SCALE),
    Math.ceil(height * SNAP_SCALE)
  );
  await rasterize(img, { width, height, scale: SNAP_SCALE }, (tiles, _, rows) =>
    encoder.addBand(tiles, rows)
  );
  return encoder.finish();
};

let warmedUp = false;

// Pays Chromium's one-off costs (GPU canvas, code font, workers) before the first snapshot by
// painting a single line.
export const warmUp = async () => {
  const line = $('#snippet .line');
  if (warmedUp || !line) return;
  warmedUp = true;
  preparePngEncoder();
  const { svg, width, height } = await nodeToSvg(line);
  const ctx = new OffscreenCanvas(width, height).getContext('2d');
  ctx.drawImage(await loadSvgImage(svg), 0, 0);
  ctx.getImageData(0, 0, 1, 1);
};

const toBytes = async (png) => new Uint8Array(await (await png).arrayBuffer());

const copyPng = async (png) => {
  try {
    // Handing over the pending blob lets the clipboard request start while still focused.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } catch (_) {
    // Older Chromium only accepts resolved blobs in a ClipboardItem.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': await png })]);
  }
};

let snapId = 0;
let busy = false;

export const takeSnap = async (config) => {
  if (busy) return;
  busy = true;
  // Only signal work in progress when it is long enough to notice.
  const busyTimer = setTimeout(() => shutterNode.classList.add('busy'), 200);
  const id = ++snapId;
  try {
    if (config.shutterAction === 'copy') {
      const { width, height } = snapTarget(config).getBoundingClientRect();
      if (Math.ceil(width) * Math.ceil(height) * SNAP_SCALE ** 2 <= MAX_CLIPBOARD_PIXELS) {
        await copyPng(renderPng(config));
      } else {
        const data = await toBytes(renderPng(config));
        vscode.postMessage({ type: 'copy', data }, [data.buffer]);
      }
      cameraFlashAnimation();
    } else {
      // The host opens the save dialog right away; the image follows once it is rendered.
      vscode.postMessage({ type: 'save', id });
      cameraFlashAnimation();
      try {
        const data = await toBytes(renderPng(config));
        vscode.postMessage({ type: 'image', id, data }, [data.buffer]);
      } catch (err) {
        vscode.postMessage({ type: 'image', id, error: String((err && err.message) || err) });
      }
    }
  } catch (err) {
    vscode.postMessage({ type: 'error', message: String((err && err.message) || err) });
  } finally {
    clearTimeout(busyTimer);
    shutterNode.classList.remove('busy');
    busy = false;
  }
};
