/*
 * Pixel Veil - face.js
 *
 * Lazy, fully local face detection. Nothing is loaded until the first call to
 * PixelVeilFaces.detect(); after that the detector is kept for the session.
 *
 * The detector is Google MediaPipe "Face Detector" (BlazeFace full-range,
 * Apache-2.0, see vendor/mediapipe/NOTICE.md). It runs in WebAssembly on the
 * CPU. Two ways of finding its files are supported:
 *
 *   - PWA mode: the files are fetched from vendor/mediapipe/ next to the page
 *     (same origin, precached by the service worker).
 *   - Embedded mode: the single-file build carries the same four files as
 *     base64 text in inert <script type="application/octet-stream"> tags.
 *     They are decoded on first use and handed over as Blob URLs / bytes.
 *
 * Public interface (the only global this file creates):
 *
 *   window.PixelVeilFaces = {
 *     ready: false,            // true once the detector has loaded
 *     async detect(canvas)     // -> [{ x, y, w, h, score }] in canvas pixels
 *   };
 */
(function () {
  'use strict';

  // ---- Where the detector's files live -----------------------------------

  const VENDOR_DIR = 'vendor/mediapipe/';
  const VENDOR_FILES = {
    bundle: 'vision_bundle.js',
    loader: 'wasm/vision_wasm_internal.js',
    wasm: 'wasm/vision_wasm_internal.wasm',
    model: 'face_detection_full_range.tflite'
  };
  const EMBED_IDS = {
    bundle: 'pv-embed-bundle',
    loader: 'pv-embed-loader',
    wasm: 'pv-embed-wasm',
    model: 'pv-embed-model'
  };

  // ---- Tuning ------------------------------------------------------------

  // How long one detect() call waits for the detector to load, so the caller's
  // busy state can never be stuck forever. Compiling the 11 MB wasm normally
  // takes a few seconds at most, but on a first visit the wait also includes
  // downloading about 12 MB. The load itself is never abandoned: a call that
  // times out leaves it running for the next call to pick up.
  const LOAD_TIMEOUT_MS = 60000;

  const MIN_CONFIDENCE = 0.4;

  // Every pass is drawn to a scratch canvas no larger than this on its long
  // side. The model only ever looks at a 192 x 192 version of what it is
  // given, so more pixels cannot help; shrinking with the canvas's
  // high-quality filter first actually measured slightly better than letting
  // MediaPipe sample a big image down in one step. A small, bounded size also
  // keeps the upload cheap and inside every GPU's texture limit (MediaPipe
  // hands images to the wasm module through a WebGL texture even though
  // inference runs on the CPU).
  const MAX_PASS_SIDE = 512;

  // Because the model input is so small, a face is only found reliably when
  // it spans roughly 8 % or more of the picture it is shown. So besides the
  // whole image, the image is searched again in overlapping square tiles,
  // level after level, each level's tiles two thirds the size of the last:
  //
  //   tile side = 60 % of the long side, then 40 %, 27 %, 18 % ...
  //
  // until the tiles would get smaller than MIN_TILE_SIDE (the model looks at
  // 192 x 192, so a smaller tile shows it nothing new) or the next level would
  // push the number of detector runs past MAX_PASSES (which bounds the wait).
  // A small MIN_TILE_SIDE matters for photos at chat-app sizes: in a 1200 px
  // group photo the faces are about 40 px, far too small for a 600 px tile.
  const FIRST_TILE_FRACTION = 0.6;
  const TILE_SHRINK = 2 / 3;
  const MIN_TILE_SIDE = 200;
  const MAX_PASSES = 40;
  // Neighbouring tiles share at least this much of their side, so a face up
  // to that size lies wholly inside one of them; anything bigger is a
  // comfortable size for the level above.
  const TILE_OVERLAP = 0.2;

  // Two boxes are treated as the same face when they overlap this much
  // (intersection over union), or when at least this fraction of the weaker
  // box lies inside the stronger one.
  const MERGE_IOU = 0.3;
  const MERGE_CONTAINED = 0.8;

  // ---- State -------------------------------------------------------------

  let detectorPromise = null;       // cached Promise<FaceDetector>, null until first use / after a failure
  let queue = Promise.resolve();    // serialises detect() calls

  const api = {
    ready: false,
    detect: function (canvas) {
      const run = queue.then(function () { return runDetect(canvas); });
      queue = run.then(noop, noop);
      return run;
    }
  };

  function noop() {}

  /**
   * Lets the browser paint (spinner, toasts) between chunks of work. Uses a
   * MessageChannel rather than setTimeout: timers are clamped to a second or
   * more in background tabs, which would stretch a multi-pass detection out
   * enormously if the user looked away.
   */
  let pausePort = null;
  const pauseWaiters = [];
  function pause() {
    return new Promise(function (resolve) {
      if (typeof MessageChannel !== 'function') {
        setTimeout(resolve, 0);
        return;
      }
      if (!pausePort) {
        const channel = new MessageChannel();
        channel.port1.onmessage = function () {
          const next = pauseWaiters.shift();
          if (next) next();
        };
        pausePort = channel.port2;
      }
      pauseWaiters.push(resolve);
      pausePort.postMessage(0);
    });
  }

  // ---- Loading -----------------------------------------------------------

  function isEmbedded() {
    return !!document.getElementById(EMBED_IDS.bundle);
  }

  function vendorUrl(key) {
    return new URL(VENDOR_DIR + VENDOR_FILES[key], document.baseURI).href;
  }

  function getDetector() {
    if (!detectorPromise) {
      const loading = isEmbedded() ? loadEmbedded() : loadFromFiles();
      detectorPromise = loading;
      loading.then(
        function () { if (detectorPromise === loading) api.ready = true; },
        // Forget a failed load so the next detect() starts from scratch.
        function () { if (detectorPromise === loading) detectorPromise = null; }
      );
    }
    return detectorPromise;
  }

  // Waits for the detector for at most LOAD_TIMEOUT_MS per call, so the
  // caller's busy state cannot be stuck forever. The load itself is left
  // running: on a slow first visit the files are still downloading, and the
  // next detect() picks up the same load instead of starting again.
  function waitForDetector() {
    let timer = 0;
    const timeout = new Promise(function (resolve, reject) {
      timer = setTimeout(function () {
        const err = new Error('Face detector is still loading');
        err.name = 'TimeoutError';
        reject(err);
      }, LOAD_TIMEOUT_MS);
    });
    return Promise.race([getDetector(), timeout]).finally(function () { clearTimeout(timer); });
  }

  /** PWA mode: everything comes from same-origin static files. */
  async function loadFromFiles() {
    const vision = await import(vendorUrl('bundle'));
    // The fileset is built by hand on purpose: FilesetResolver.forVisionTasks()
    // may ask for a non-SIMD build, which is not shipped.
    const fileset = {
      wasmLoaderPath: vendorUrl('loader'),
      wasmBinaryPath: vendorUrl('wasm')
    };
    return createDetector(vision, fileset, { modelAssetPath: vendorUrl('model') });
  }

  /** Single-file mode: decode the embedded base64 payloads into Blob URLs. */
  async function loadEmbedded() {
    const urls = [];
    async function blobUrl(key, type) {
      // `bytes` goes out of scope right after the Blob has copied it.
      const bytes = await decodeBase64(embeddedText(key));
      const url = URL.createObjectURL(new Blob([bytes], { type: type }));
      urls.push(url);
      return url;
    }
    try {
      const vision = await import(await blobUrl('bundle', 'text/javascript'));
      const fileset = {
        wasmLoaderPath: await blobUrl('loader', 'text/javascript'),
        wasmBinaryPath: await blobUrl('wasm', 'application/wasm')
      };
      // MediaPipe copies the model into the wasm heap, so this array is
      // garbage as soon as the detector exists.
      const model = await decodeBase64(embeddedText('model'));
      return await createDetector(vision, fileset, { modelAssetBuffer: model });
    } finally {
      // By now the module, loader script and wasm binary have been consumed
      // (or the load failed); either way the Blobs can be released.
      urls.forEach(function (url) { URL.revokeObjectURL(url); });
    }
  }

  function embeddedText(key) {
    const el = document.getElementById(EMBED_IDS[key]);
    const text = el ? el.textContent : '';
    if (!text) throw new Error('Embedded face detector data is missing (' + EMBED_IDS[key] + ')');
    return text;
  }

  async function createDetector(vision, fileset, baseOptions) {
    const FaceDetector = vision && vision.FaceDetector;
    if (!FaceDetector || typeof FaceDetector.createFromOptions !== 'function') {
      throw new Error('Face detector library did not load correctly');
    }
    baseOptions.delegate = 'CPU';
    // The wasm runtime announces itself on stderr ("INFO: Created TensorFlow
    // Lite XNNPACK delegate for CPU."), which Emscripten would print through
    // console.error. MediaPipe's loader adopts a global `Module` object if one
    // exists when it starts, and clears it again once the runtime is up; that
    // is the one hook for sending this chatter somewhere quieter.
    const hooks = { printErr: logFromWasm };
    self.Module = hooks;
    try {
      return await FaceDetector.createFromOptions(fileset, {
        baseOptions: baseOptions,
        runningMode: 'IMAGE',
        minDetectionConfidence: MIN_CONFIDENCE
      });
    } finally {
      // Still ours only if the load failed before MediaPipe picked it up.
      if (self.Module === hooks) self.Module = undefined;
    }
  }

  function logFromWasm(text) {
    if (/^INFO:/.test(text)) console.debug('[face detector] ' + text);
    else console.warn('[face detector] ' + text);
  }

  function closeQuietly(detector) {
    try {
      if (detector && typeof detector.close === 'function') detector.close();
    } catch (err) { /* nothing useful to do */ }
  }

  /**
   * base64 text -> Uint8Array. The wasm payload is about 15 MB of text, so
   * this uses the native decoder where there is one, and otherwise works
   * through the string in slices with a pause between them so the page stays
   * responsive.
   */
  async function decodeBase64(text) {
    if (typeof Uint8Array.fromBase64 === 'function') {
      try {
        return Uint8Array.fromBase64(text);
      } catch (err) { /* fall through to the portable decoder */ }
    }
    if (/\s/.test(text)) text = text.replace(/\s+/g, '');

    const length = text.length;
    let padding = 0;
    if (length > 0 && text.charCodeAt(length - 1) === 61) padding++;   // '='
    if (length > 1 && text.charCodeAt(length - 2) === 61) padding++;
    const out = new Uint8Array(Math.floor(length * 3 / 4) - padding);

    const SLICE = 1 << 20;          // characters per slice; a multiple of 4
    let written = 0;
    for (let start = 0; start < length; start += SLICE) {
      const binary = atob(text.slice(start, start + SLICE));
      const n = binary.length;
      for (let i = 0; i < n; i++) out[written + i] = binary.charCodeAt(i);
      written += n;
      if (start + SLICE < length) await pause();
    }
    if (written !== out.length) throw new Error('Embedded face detector data is corrupt');
    return out;
  }

  // ---- Detection ---------------------------------------------------------

  async function runDetect(canvas) {
    if (!canvas || typeof canvas.width !== 'number' || typeof canvas.height !== 'number') {
      throw new TypeError('PixelVeilFaces.detect() needs a canvas');
    }
    const width = canvas.width | 0;
    const height = canvas.height | 0;
    if (width < 1 || height < 1) return [];
    const detector = await waitForDetector();

    const scratch = document.createElement('canvas');
    const found = [];
    try {
      const regions = buildRegions(width, height);
      for (let i = 0; i < regions.length; i++) {
        if (i > 0) await pause();
        detectRegion(detector, canvas, regions[i], scratch, found);
      }
    } catch (err) {
      // A failure here usually means the detector's wasm or WebGL state is
      // gone (for example a lost graphics context). Drop it so that a later
      // call builds a fresh one instead of failing the same way again.
      if (detectorPromise) {
        detectorPromise = null;
        api.ready = false;
        closeQuietly(detector);
      }
      throw err;
    } finally {
      // Hand the scratch pixels back straight away rather than waiting for GC.
      scratch.width = 0;
      scratch.height = 0;
    }
    return finish(mergeDetections(found), width, height);
  }

  /** The whole image first, then level after level of overlapping tiles. */
  function buildRegions(width, height) {
    const regions = [{ x: 0, y: 0, w: width, h: height }];
    let side = Math.max(width, height) * FIRST_TILE_FRACTION;
    while (side >= MIN_TILE_SIDE) {
      const tw = Math.min(width, Math.round(side));
      const th = Math.min(height, Math.round(side));
      const xs = tileOffsets(width, tw);
      const ys = tileOffsets(height, th);
      if (regions.length + xs.length * ys.length > MAX_PASSES) break;
      for (let row = 0; row < ys.length; row++) {
        for (let col = 0; col < xs.length; col++) {
          regions.push({ x: xs[col], y: ys[row], w: tw, h: th });
        }
      }
      side *= TILE_SHRINK;
    }
    return regions;
  }

  /**
   * Start positions of evenly spread tiles of length `tile` that cover
   * `total` from edge to edge and overlap by at least TILE_OVERLAP.
   */
  function tileOffsets(total, tile) {
    if (tile >= total) return [0];
    const count = Math.ceil((total - tile) / (tile * (1 - TILE_OVERLAP))) + 1;
    const offsets = [];
    for (let i = 0; i < count; i++) {
      offsets.push(Math.round((total - tile) * i / (count - 1)));
    }
    return offsets;
  }

  /**
   * Runs the detector on one rectangle of the source canvas and appends what
   * it finds to `out`, converted back to source-canvas coordinates.
   */
  function detectRegion(detector, source, region, scratch, out) {
    const scale = Math.min(1, MAX_PASS_SIDE / Math.max(region.w, region.h));
    const cw = Math.max(1, Math.round(region.w * scale));
    const ch = Math.max(1, Math.round(region.h * scale));
    if (scratch.width !== cw || scratch.height !== ch) {
      scratch.width = cw;
      scratch.height = ch;
    }
    const ctx = scratch.getContext('2d');
    if (!ctx) throw new Error('Could not create a 2D canvas for face detection');
    // White behind transparent pixels, the same way they are flattened for JPEG.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, cw, ch);

    const result = detector.detect(scratch);
    const detections = (result && result.detections) || [];
    const sx = region.w / cw;
    const sy = region.h / ch;
    for (let i = 0; i < detections.length; i++) {
      const box = detections[i].boundingBox;
      if (!box || !(box.width > 0) || !(box.height > 0)) continue;
      const categories = detections[i].categories;
      const score = categories && categories.length ? Number(categories[0].score) || 0 : 0;
      out.push({
        x: region.x + box.originX * sx,
        y: region.y + box.originY * sy,
        w: box.width * sx,
        h: box.height * sy,
        score: score
      });
    }
  }

  /**
   * Greedy non-max suppression over the detections of all passes, strongest
   * first. A box that duplicates an already kept one (IoU above MERGE_IOU, or
   * mostly inside it, as happens with a face cut off by a tile edge) is
   * dropped - but the kept box is grown to cover it. For an anonymiser that is
   * the safe direction: nothing the detector flagged ends up outside the
   * returned rectangles, even if two real faces overlapped enough to be
   * merged. Comparisons always use the kept box's original extent, so a box
   * cannot snowball across a crowd by absorbing neighbour after neighbour.
   */
  function mergeDetections(found) {
    const sorted = found.slice().sort(function (a, b) { return b.score - a.score; });
    const kept = [];
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      const cArea = c.w * c.h;
      let absorbed = false;
      for (let k = 0; k < kept.length && !absorbed; k++) {
        const core = kept[k].core;
        const iw = Math.min(c.x + c.w, core.x + core.w) - Math.max(c.x, core.x);
        const ih = Math.min(c.y + c.h, core.y + core.h) - Math.max(c.y, core.y);
        if (iw <= 0 || ih <= 0) continue;
        const inter = iw * ih;
        const union = cArea + core.w * core.h - inter;
        if (inter / union > MERGE_IOU || inter >= MERGE_CONTAINED * cArea) {
          const cover = kept[k].cover;
          const x1 = Math.min(cover.x, c.x);
          const y1 = Math.min(cover.y, c.y);
          const x2 = Math.max(cover.x + cover.w, c.x + c.w);
          const y2 = Math.max(cover.y + cover.h, c.y + c.h);
          cover.x = x1;
          cover.y = y1;
          cover.w = x2 - x1;
          cover.h = y2 - y1;
          absorbed = true;
        }
      }
      if (!absorbed) {
        kept.push({
          core: c,
          cover: { x: c.x, y: c.y, w: c.w, h: c.h, score: c.score }
        });
      }
    }
    return kept.map(function (entry) { return entry.cover; });
  }

  /** Clamp to the canvas and snap outwards to whole pixels. */
  function finish(boxes, width, height) {
    const results = [];
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const x1 = Math.min(width, Math.max(0, Math.floor(b.x)));
      const y1 = Math.min(height, Math.max(0, Math.floor(b.y)));
      const x2 = Math.min(width, Math.max(0, Math.ceil(b.x + b.w)));
      const y2 = Math.min(height, Math.max(0, Math.ceil(b.y + b.h)));
      if (x2 - x1 < 1 || y2 - y1 < 1) continue;
      results.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, score: b.score });
    }
    return results;
  }

  window.PixelVeilFaces = api;
})();
