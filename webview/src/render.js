const XHTML = 'http://www.w3.org/1999/xhtml';

// Inherited properties the snapshot root takes over from the node's ancestors. Rules for
// html/body can't match inside the SVG, so their effect is copied as computed values.
const INHERITED = new Set([
  'color',
  'color-scheme',
  'cursor',
  'direction',
  'font-family',
  'font-feature-settings',
  'font-kerning',
  'font-optical-sizing',
  'font-palette',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-synthesis-small-caps',
  'font-synthesis-style',
  'font-synthesis-weight',
  'font-variant-alternates',
  'font-variant-caps',
  'font-variant-east-asian',
  'font-variant-emoji',
  'font-variant-ligatures',
  'font-variant-numeric',
  'font-variant-position',
  'font-variation-settings',
  'font-weight',
  'hyphens',
  'letter-spacing',
  'line-break',
  'overflow-wrap',
  'tab-size',
  'text-align',
  'text-align-last',
  'text-indent',
  'text-rendering',
  'text-shadow',
  'text-transform',
  'text-underline-position',
  'text-wrap-mode',
  'text-wrap-style',
  'visibility',
  'white-space-collapse',
  'word-break',
  'word-spacing',
  'writing-mode',
  '-webkit-font-smoothing'
  // Not -webkit-text-fill-color: it defaults to currentcolor, which getComputedStyle reports
  // as the parent's resolved colour and would then override every token's colour.
]);

// Characters that are legal in HTML text but make the SVG's XML parser reject the image
// (in unicode mode the surrogate range only matches unpaired surrogates).
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\0-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF\uD800-\uDFFF]/gu;

let cssCache;
const collectCss = async () => {
  if (cssCache) return cssCache;
  const sheets = await Promise.all(
    Array.from(document.styleSheets, async (sheet) => {
      try {
        return Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
      } catch (_) {
        // Rules of a cross-origin sheet aren't scriptable; read its source instead.
        return sheet.href ? (await fetch(sheet.href)).text() : '';
      }
    })
  );
  cssCache = sheets.join('\n');
  return cssCache;
};

const createRoot = (node, overrides) => {
  const root = document.createElementNS(XHTML, 'div');
  const parentStyle = getComputedStyle(node.parentElement);
  for (let i = 0; i < parentStyle.length; i++) {
    const prop = parentStyle[i];
    if (prop.startsWith('--') || INHERITED.has(prop)) {
      root.style.setProperty(prop, parentStyle.getPropertyValue(prop));
    }
  }
  // getComputedStyle resolves line-height to px, but the page sets it unitless on <html>,
  // so descendants with another font size need the ratio rather than the px value.
  const fontSize = parseFloat(parentStyle.fontSize);
  if (parentStyle.lineHeight.endsWith('px') && fontSize) {
    root.style.lineHeight = String(parseFloat(parentStyle.lineHeight) / fontSize);
  }
  Object.entries(overrides).forEach(([prop, value]) => root.style.setProperty(prop, value));
  return root;
};

/**
 * Serializes `node` into a standalone SVG image. Instead of inlining every computed style on
 * every element (what dom-to-image does, ~1400 properties per node in a VS Code webview), the
 * markup is cloned as-is and the page's stylesheets are embedded once.
 */
export const nodeToSvg = async (node, { overrides = {}, extraCss = '' } = {}) => {
  const rect = node.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(rect.width));
  const height = Math.max(1, Math.ceil(rect.height));

  const root = createRoot(node, overrides);
  const style = document.createElementNS(XHTML, 'style');
  style.textContent = (await collectCss()) + '\n' + extraCss;
  root.appendChild(style);

  const clone = node.cloneNode(true);
  // Rounding up the size must not leave a transparent sliver at the edges.
  clone.style.minWidth = width + 'px';
  clone.style.minHeight = height + 'px';
  root.appendChild(clone);

  const xhtml = new XMLSerializer().serializeToString(root).replace(INVALID_XML_CHARS, '\uFFFD');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}"><foreignObject x="0" y="0" width="100%" height="100%">` +
    xhtml +
    '</foreignObject></svg>';
  return { svg, width, height };
};

// Chromium taints the canvas for a <foreignObject> SVG from a blob: URL, but not from a data:
// URL. The SVG is small now that styles aren't inlined, so encoding it costs little.
export const loadSvgImage = async (svg) => {
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  return img;
};

// Chromium refuses canvases above 32767px per side or 268M pixels in total, and large
// readbacks are slow, so the image is painted in bands of at most this many pixels.
const MAX_TILE_PIXELS = 1 << 24;
const MAX_TILE_SIDE = 8192;

/**
 * Paints `img` at `scale` band by band. `onBand(rgba, width, rows)` receives each band's
 * pixels (full image width, top to bottom) and may return a promise to apply backpressure.
 */
export const rasterize = async (img, { width, height, scale }, onBand) => {
  const fullWidth = Math.ceil(width * scale);
  const fullHeight = Math.ceil(height * scale);
  const tileWidth = Math.min(fullWidth, MAX_TILE_SIDE);
  const bandHeight = Math.max(
    1,
    Math.min(fullHeight, MAX_TILE_SIDE, Math.floor(MAX_TILE_PIXELS / tileWidth))
  );

  for (let y = 0; y < fullHeight; y += bandHeight) {
    const rows = Math.min(bandHeight, fullHeight - y);
    let band;
    for (let x = 0; x < fullWidth; x += tileWidth) {
      const cols = Math.min(tileWidth, fullWidth - x);
      // A fresh canvas per tile: Chromium moves a canvas that is read back repeatedly from
      // the GPU to the CPU, which makes painting text several times slower.
      const canvas = document.createElement('canvas');
      canvas.width = cols;
      canvas.height = rows;
      const ctx = canvas.getContext('2d');
      // Drawing only the tile's source rectangle lets Chromium skip painting the rest of the
      // SVG, which otherwise makes every tile cost as much as the whole snippet.
      ctx.drawImage(img, x / scale, y / scale, cols / scale, rows / scale, 0, 0, cols, rows);
      const tile = ctx.getImageData(0, 0, cols, rows).data;
      // Release the backing store now rather than whenever the canvas is collected.
      canvas.width = canvas.height = 0;
      if (cols === fullWidth) {
        band = tile;
      } else {
        band = band || new Uint8ClampedArray(fullWidth * rows * 4);
        for (let r = 0; r < rows; r++) {
          band.set(tile.subarray(r * cols * 4, (r + 1) * cols * 4), (r * fullWidth + x) * 4);
        }
      }
    }
    await onBand(band, fullWidth, rows);
  }
  return { width: fullWidth, height: fullHeight };
};
