/*
 * Pixel Veil — editor
 *
 * A classic script in one IIFE. It owns the whole editor: the batch of photos and
 * its filmstrip, the drag gesture, the pixelate / blur / black effects, undo, crop,
 * the face picker and saving. Nothing here talks to the network. Face detection
 * lives in face.js (window.PixelVeilFaces) and the ZIP writer in zip.js
 * (window.PixelVeilZip). Either may be missing.
 *
 * The model: a photo is its source file plus an ordered list of edits ("ops").
 * Only the active photo is held at full size. Every op is drawn by applyOp(),
 * whatever the target: the canvas on screen, a thumbnail or a full-size export.
 *
 * Coordinates: both canvases are sized in image pixels and scaled to fit with CSS.
 * Everything below works in image pixels unless a name says otherwise. Ops keep
 * their rectangles as fractions of the frame, so they fit any resolution.
 */
(function () {
  'use strict';

  const VERSION = '1.1.0';

  /* ======================================================================
   * Pure helpers. No DOM in this block, so the maths can be tested in Node.
   * ==================================================================== */
  /* @pure-begin */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /**
   * Largest size with the same shape as w x h that fits the pixel budget and the
   * side limit. Never scales up.
   */
  function fitWithinBudget(w, h, budget, maxSide) {
    let s = 1;
    if (w * h > budget) s = Math.sqrt(budget / (w * h));
    s = Math.min(s, maxSide / w, maxSide / h);
    if (!(s < 1)) return { w: w, h: h, scaled: false };
    return {
      w: Math.max(1, Math.floor(w * s)),
      h: Math.max(1, Math.floor(h * s)),
      scaled: true,
    };
  }

  /** Integer rectangle between two points, clamped to a W x H image. */
  function rectFromPoints(x0, y0, x1, y1, W, H) {
    const l = clamp(Math.round(Math.min(x0, x1)), 0, W);
    const t = clamp(Math.round(Math.min(y0, y1)), 0, H);
    const r = clamp(Math.round(Math.max(x0, x1)), 0, W);
    const b = clamp(Math.round(Math.max(y0, y1)), 0, H);
    return { x: l, y: t, w: r - l, h: b - t };
  }

  /** What a tool does to a w x h selection. `level` is the Strength slider (2..25). */
  function effectFor(tool, w, h, level) {
    const minDim = Math.min(w, h);
    if (tool === 'black') return { type: 'black' };
    // A long, thin box (either way up) is almost always a line of text.
    const line = minDim / Math.max(w, h) < 0.5;
    if (tool === 'pixelate') {
      const most = Math.max(3, Math.floor(minDim / 2));
      // The default (10) matches Auto on a roughly square box: an eighth of the short
      // side. A line of text needs blocks about as big as its letters, so it gets a
      // quarter of the line height.
      return { type: 'pixelate', block: clamp(Math.round((minDim * level) / (line ? 40 : 80)), 3, most) };
    }
    if (tool === 'blur') {
      // The default (10) gives minDim / 2, the same as Auto on a line of text. There is
      // no fixed cap: blurBuffer limits the box to the region's short side, and its
      // cost does not depend on the radius. Levels from 20 up give the same result.
      return { type: 'blur', radius: clamp(Math.round((minDim * level) / 20), 2, Math.max(2, minDim)) };
    }
    // Auto. Blur hides a line of text better than big blocks do. Both sizes follow
    // the box, so the result looks the same whatever the photo's resolution. The
    // floor of 2 keeps a very narrow box from getting a 1 px block, which would
    // change nothing.
    if (line) return { type: 'blur', radius: Math.ceil(minDim / 2) };
    return { type: 'pixelate', block: Math.max(2, Math.ceil(w / 8)) };
  }

  /** What the Faces button does to a face box that is w pixels wide. */
  function faceEffect(tool, w) {
    if (tool === 'blur') return { type: 'blur', radius: Math.ceil(w / 3) };
    if (tool === 'black') return { type: 'black' };
    return { type: 'pixelate', block: Math.max(4, Math.ceil(w / 8)) };
  }

  /** Grow a detected face box by 8 % on each side and clamp it to the image. */
  function padFace(face, W, H) {
    const px = face.w * 0.08;
    const py = face.h * 0.08;
    const l = clamp(Math.floor(face.x - px), 0, W);
    const t = clamp(Math.floor(face.y - py), 0, H);
    const r = clamp(Math.ceil(face.x + face.w + px), 0, W);
    const b = clamp(Math.ceil(face.y + face.h + py), 0, H);
    return { x: l, y: t, w: r - l, h: b - t };
  }

  /** Straight alpha to premultiplied alpha, in place. `d` is a Uint8ClampedArray. */
  function premultiply(d) {
    for (let i = 0, n = d.length; i < n; i += 4) {
      const a = d[i + 3];
      if (a === 255) continue;
      const k = a / 255;
      d[i] = d[i] * k;
      d[i + 1] = d[i + 1] * k;
      d[i + 2] = d[i + 2] * k;
    }
  }

  /** Premultiplied alpha back to straight alpha, in place. */
  function unpremultiply(d) {
    for (let i = 0, n = d.length; i < n; i += 4) {
      const a = d[i + 3];
      if (a === 255) continue;
      if (a === 0) {
        d[i] = d[i + 1] = d[i + 2] = 0;
        continue;
      }
      const k = 255 / a;
      d[i] = d[i] * k; // the clamped array rounds and caps at 255
      d[i + 1] = d[i + 1] * k;
      d[i + 2] = d[i + 2] * k;
    }
  }

  /**
   * Mosaic, in place. `d` is RGBA for a w x h region. The grid starts at the top
   * left, so cells on the right and bottom edges may be partial. Colour is averaged
   * weighted by alpha (premultiplied space), so a transparent pixel adds no colour.
   */
  function pixelateBuffer(d, w, h, block) {
    block = Math.max(1, Math.floor(block));
    for (let by = 0; by < h; by += block) {
      const bh = Math.min(block, h - by);
      for (let bx = 0; bx < w; bx += block) {
        const bw = Math.min(block, w - bx);
        // Sums stay far below 2^53 even for a cell covering a whole 40 MP image.
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let y = 0; y < bh; y++) {
          let i = ((by + y) * w + bx) * 4;
          for (let x = 0; x < bw; x++, i += 4) {
            const al = d[i + 3];
            r += d[i] * al;
            g += d[i + 1] * al;
            b += d[i + 2] * al;
            a += al;
          }
        }
        let R = 0;
        let G = 0;
        let B = 0;
        let A = 0;
        if (a > 0) {
          R = Math.round(r / a);
          G = Math.round(g / a);
          B = Math.round(b / a);
          A = Math.round(a / (bw * bh));
        }
        for (let y = 0; y < bh; y++) {
          let i = ((by + y) * w + bx) * 4;
          for (let x = 0; x < bw; x++, i += 4) {
            d[i] = R;
            d[i + 1] = G;
            d[i + 2] = B;
            d[i + 3] = A;
          }
        }
      }
    }
  }

  /**
   * One horizontal box-blur pass from src to dst (plain Uint8Arrays). The window is
   * 2r + 1 wide and the edge pixel is repeated past the ends of a row. A running sum
   * makes the cost the same for any r. `nch` is 3 to leave alpha alone, or 4.
   * An average of bytes is always within 0..255, so it is rounded by hand with
   * (v + 0.5) | 0, which is a good deal faster than a clamped store.
   */
  function boxBlurH(src, dst, w, h, r, nch) {
    const inv = 1 / (2 * r + 1);
    const lastX = w - 1;
    // Columns in [xa, xb) have their whole window inside the row: no edge tests there.
    const xa = Math.min(r, w);
    const xb = Math.max(xa, w - r - 1);
    const ahead = (r + 1) * 4;
    const behind = r * 4;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let c = 0; c < nch; c++) {
        const base = row + c;
        const first = src[base];
        const last = src[base + lastX * 4];
        // Window centred on x = 0: the first pixel r + 1 times, then r more.
        let sum = first * (r + 1);
        for (let k = 1; k <= r; k++) sum += src[base + (k < lastX ? k : lastX) * 4];
        let o = base;
        let x = 0;
        for (; x < xa; x++, o += 4) {
          dst[o] = (sum * inv + 0.5) | 0;
          const add = x + r + 1;
          sum += (add <= lastX ? src[base + add * 4] : last) - first;
        }
        for (; x < xb; x++, o += 4) {
          dst[o] = (sum * inv + 0.5) | 0;
          sum += src[o + ahead] - src[o - behind];
        }
        for (; x < w; x++, o += 4) {
          dst[o] = (sum * inv + 0.5) | 0;
          const sub = x - r;
          sum += last - (sub >= 0 ? src[base + sub * 4] : first);
        }
      }
    }
  }

  /**
   * One vertical box-blur pass from src to dst. It walks row by row and keeps one
   * running sum per column in `sums` (Int32Array of w * 4), which is much kinder
   * to the cache than walking down each column.
   */
  function boxBlurV(src, dst, w, h, r, nch, sums) {
    const stride = w * 4;
    const inv = 1 / (2 * r + 1);
    const lastY = h - 1;
    const alpha = nch === 4;
    for (let i = 0; i < stride; i++) sums[i] = src[i] * (r + 1);
    for (let k = 1; k <= r; k++) {
      const ro = (k < lastY ? k : lastY) * stride;
      for (let i = 0; i < stride; i++) sums[i] += src[ro + i];
    }
    for (let y = 0; y < h; y++) {
      const out = y * stride;
      const add = (y + r + 1 <= lastY ? y + r + 1 : lastY) * stride;
      const sub = (y - r >= 0 ? y - r : 0) * stride;
      for (let i = 0; i < stride; i += 4) {
        dst[out + i] = (sums[i] * inv + 0.5) | 0;
        sums[i] += src[add + i] - src[sub + i];
        dst[out + i + 1] = (sums[i + 1] * inv + 0.5) | 0;
        sums[i + 1] += src[add + i + 1] - src[sub + i + 1];
        dst[out + i + 2] = (sums[i + 2] * inv + 0.5) | 0;
        sums[i + 2] += src[add + i + 2] - src[sub + i + 2];
        if (alpha) {
          dst[out + i + 3] = (sums[i + 3] * inv + 0.5) | 0;
          sums[i + 3] += src[add + i + 3] - src[sub + i + 3];
        }
      }
    }
  }

  /**
   * Blur, in place. `d` is the Uint8ClampedArray of a w x h ImageData. Three
   * box-blur passes (each horizontal then vertical) come very close to a Gaussian.
   * Only pixels inside the region are read, so nothing from outside the selection
   * can leak in. Works in premultiplied alpha.
   *
   * No overflow: the half-width is capped at half the region's short side, so a
   * window sum is at most 255 * min(w, h). That is far inside an Int32 for any
   * canvas a browser can create. The horizontal sums are ordinary doubles.
   */
  function blurBuffer(d, w, h, radius) {
    let half = Math.max(1, Math.round(radius / 2));
    half = Math.max(1, Math.min(half, Math.floor((Math.min(w, h) - 1) / 2)));

    let opaque = true;
    for (let i = 3, n = d.length; i < n; i += 4) {
      if (d[i] !== 255) {
        opaque = false;
        break;
      }
    }
    if (!opaque) premultiply(d);

    // Fully opaque regions skip the alpha channel: d keeps its 255s throughout.
    const nch = opaque ? 3 : 4;
    const px = new Uint8Array(d.buffer, d.byteOffset, d.length); // same bytes as d
    const tmp = new Uint8Array(d.length);
    const sums = new Int32Array(w * 4);
    for (let pass = 0; pass < 3; pass++) {
      boxBlurH(px, tmp, w, h, half, nch);
      boxBlurV(tmp, px, w, h, half, nch, sums);
    }

    if (!opaque) unpremultiply(d);
  }

  /** "photo.final.JPG" to "photo.final", with characters a file system rejects removed. */
  function baseNameOf(name) {
    let s = String(name || '').replace(/^.*[\\/]/, '');
    s = s.replace(/\.[A-Za-z0-9]{1,5}$/, '');
    // Chrome and Edge refuse a folder file name that holds a format or control
    // character (zero-width joiner, LRM/RLM, soft hyphen...) or a non-character,
    // or that starts with "~". The invisible ones go first, so that a "~", dot or
    // space they were hiding at the start is then trimmed.
    s = s.replace(/[\p{Cf}\p{Noncharacter_Code_Point}]+/gu, '');
    s = s.replace(/[\p{Cc}<>:"/\\|?*]+/gu, '_').replace(/^[\s.~]+|[\s.]+$/g, '');
    if (s.length > 80) s = s.slice(0, 80);
    return s || 'photo';
  }

  /** An integer rect as fractions of a W x H frame. */
  function normRect(r, W, H) {
    return { x: r.x / W, y: r.y / H, w: r.w / W, h: r.h / H };
  }

  /**
   * Fractions back to an integer rect inside a W x H frame. At the size the rect
   * was made for, this gives back exactly the rect that went into normRect.
   */
  function denormRect(n, W, H) {
    const x = clamp(Math.round(n.x * W), 0, W);
    const y = clamp(Math.round(n.y * H), 0, H);
    return {
      x: x,
      y: y,
      w: clamp(Math.round(n.w * W), 0, W - x),
      h: clamp(Math.round(n.h * H), 0, H - y),
    };
  }

  /**
   * A rect that was measured inside the crop frame `c`, expressed in the frame
   * that `c` itself was measured in. All in fractions.
   */
  function uncropRect(n, c) {
    return { x: c.x + n.x * c.w, y: c.y + n.y * c.h, w: n.w * c.w, h: n.h * c.h };
  }

  /** 'jpeg' or 'png' for a photo of MIME type `type`, given the format the user chose. */
  function exportFormatFor(choice, type) {
    if (choice === 'jpeg' || choice === 'png') return choice;
    // "Same as each original": PNG stays PNG, everything else becomes JPEG.
    return String(type || '').toLowerCase() === 'image/png' ? 'png' : 'jpeg';
  }

  /**
   * `name`, or else "name (2)", "name (3)" and so on with the number before the
   * extension: the first one that is not in `taken`, a Set of lower-cased names.
   * The result is added to the set.
   */
  function uniqueName(name, taken) {
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = stem + ' (' + n + ')' + ext;
    taken.add(candidate.toLowerCase());
    return candidate;
  }

  /** "20261115-0932", for the name of an exported archive. */
  function stampOf(date) {
    const two = function (v) {
      return (v < 10 ? '0' : '') + v;
    };
    return (
      date.getFullYear() + two(date.getMonth() + 1) + two(date.getDate()) + '-' + two(date.getHours()) + two(date.getMinutes())
    );
  }

  /** "1 photo", "3 photos". */
  function count(n, noun) {
    return n + ' ' + noun + (n === 1 ? '' : 's');
  }

  /* @pure-end */

  /* ======================================================================
   * Elements and device limits
   * ==================================================================== */

  const $ = (id) => document.getElementById(id);

  const els = {
    app: $('app'),
    stage: $('stage'),
    stageFit: $('stageFit'),
    wrap: $('canvasWrap'),
    main: $('mainCanvas'),
    overlay: $('overlayCanvas'),
    faceLayer: $('faceLayer'),
    empty: $('emptyState'),
    emptyOpenBtn: $('emptyOpenBtn'),
    undoBtn: $('undoBtn'),
    openBtn: $('openBtn'),
    saveBtn: $('saveBtn'),
    saveMenu: $('saveMenu'),
    saveScopes: $('saveScopes'),
    helpBtn: $('helpBtn'),
    help: $('helpDialog'),
    helpBody: $('helpBody'),
    helpCloseBtn: $('helpCloseBtn'),
    resetChoicesBtn: $('resetChoicesBtn'),
    offlineStatus: $('offlineStatus'),
    versionText: $('versionText'),
    toolbar: $('toolbar'),
    facesBtn: $('facesBtn'),
    cropBtn: $('cropBtn'),
    revertBtn: $('revertBtn'),
    cropBar: $('cropBar'),
    cropSize: $('cropSize'),
    cropCancelBtn: $('cropCancelBtn'),
    cropApplyBtn: $('cropApplyBtn'),
    faceBar: $('faceBar'),
    faceCount: $('faceCount'),
    faceMeta: $('faceMeta'),
    faceAllBtn: $('faceAllBtn'),
    faceNoneBtn: $('faceNoneBtn'),
    faceBulkBtn: $('faceBulkBtn'),
    faceBackBtn: $('faceBackBtn'),
    faceSkipBtn: $('faceSkipBtn'),
    faceCancelBtn: $('faceCancelBtn'),
    faceApplyBtn: $('faceApplyBtn'),
    strengthRow: $('strengthRow'),
    strength: $('strength'),
    strengthValue: $('strengthValue'),
    hint: $('hint'),
    strip: $('strip'),
    stripCount: $('stripCount'),
    stripList: $('stripList'),
    stripSelectAllBtn: $('stripSelectAllBtn'),
    stripSelectBtn: $('stripSelectBtn'),
    stripAddBtn: $('stripAddBtn'),
    stripRemoveBtn: $('stripRemoveBtn'),
    fileInput: $('fileInput'),
    toasts: $('toasts'),
    busy: $('busy'),
    busyText: $('busyText'),
    busyCancelBtn: $('busyCancelBtn'),
    dropVeil: $('dropVeil'),
    confirm: $('confirmDialog'),
    confirmText: $('confirmText'),
    confirmOkBtn: $('confirmOkBtn'),
    confirmCancelBtn: $('confirmCancelBtn'),
    result: $('resultDialog'),
    resultTitle: $('resultTitle'),
    resultShareBtn: $('resultShareBtn'),
    resultZipBtn: $('resultZipBtn'),
    resultCloseBtn: $('resultCloseBtn'),
    tplCheck: $('tplCheck'),
    tplEyeOff: $('tplEyeOff'),
  };

  const main = els.main;
  const overlay = els.overlay;
  const ctx = main.getContext('2d', { willReadFrequently: true });
  const octx = overlay.getContext('2d');
  const toolButtons = Array.from(els.toolbar.querySelectorAll('[data-tool]'));
  const formatItems = Array.from(els.saveMenu.querySelectorAll('[data-format]'));
  const scopeItems = Array.from(els.saveMenu.querySelectorAll('[data-scope]'));

  // Phones and tablets get a smaller pixel budget. 16 MP also stays under the
  // 4096 x 4096 canvas area that mobile Safari allows.
  const IS_TOUCH = navigator.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches;
  // Only iOS and iPadOS have "Save Image" and "Save to Files" in the share sheet.
  // Elsewhere (Android, Windows tablets) the sheet can only send the file to another app.
  const IS_IOS =
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const LOW_MEMORY = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4;
  const MOBILE_BUDGET = IS_TOUCH || LOW_MEMORY;
  const PIXEL_BUDGET = MOBILE_BUDGET ? 16000000 : 40000000; // the working size of the active photo
  const MAX_SIDE = 16384;
  const UNDO_BYTES = (MOBILE_BUDGET ? 96 : 320) * 1024 * 1024;
  const UNDO_ENTRIES = 50;
  const MAX_UPSCALE = 4;
  const BUSY_AREA = 3000000; // show the busy overlay for work on regions above this
  const MAX_PHOTOS = 300;
  const THUMB_EDGE = 256; // long edge of a thumbnail, in pixels
  const FACE_TARGET = 32; // least size of a face's touch target, in CSS pixels (see .face::after)
  const ZIP_LIMIT = 3.5e9; // bytes per archive, safely under the 4 GB of a plain ZIP

  const ACCENT = '#37d9b8';
  const ACCENT_FILL = 'rgba(55, 217, 184, 0.16)';

  const TOOLS = ['auto', 'pixelate', 'blur', 'black'];
  const TOOL_NAMES = { auto: 'Auto', pixelate: 'Pixelate', blur: 'Blur', black: 'Black' };

  const MSG_FACES_UNAVAILABLE = "Face detection isn't available here. Drag over faces instead.";
  const MSG_FACES_LOADING = 'Still loading the face detector. Try again in a moment.';
  const MSG_NO_FACES = 'No faces found. Drag over them instead.';
  const MSG_TOO_LARGE = 'That area is too large to process on this device.';
  const MSG_STILL_WORKING = 'Still working. Add the photo again in a moment.';

  /* ======================================================================
   * Choices that are remembered between visits
   *
   * Only the tool, the strength and the two save formats. Never anything about a
   * photo. Storage can be missing or blocked (private windows, some file:// setups),
   * so every access is guarded and the app works the same without it.
   * ==================================================================== */

  const SETTINGS_KEY = 'pixel-veil-settings';
  const DEFAULTS = { tool: 'auto', level: 10, saveFormat: null, batchFormat: 'same' };

  /** The stored choices, each one checked. Anything unexpected is ignored. */
  function readSettings() {
    const out = Object.assign({}, DEFAULTS);
    let saved = null;
    try {
      saved = JSON.parse(window.localStorage.getItem(SETTINGS_KEY));
    } catch (err) {
      return out;
    }
    if (!saved || typeof saved !== 'object' || saved.v !== 1) return out;
    if (TOOLS.indexOf(saved.tool) >= 0) out.tool = saved.tool;
    if (Number.isInteger(saved.level) && saved.level >= 2 && saved.level <= 25) out.level = saved.level;
    if (saved.format === 'jpeg' || saved.format === 'png') out.saveFormat = saved.format;
    if (saved.batchFormat === 'jpeg' || saved.batchFormat === 'png' || saved.batchFormat === 'same') {
      out.batchFormat = saved.batchFormat;
    }
    return out;
  }

  let settingsTimer = 0;

  function writeSettings() {
    clearTimeout(settingsTimer);
    settingsTimer = 0;
    const data = { v: 1, tool: state.tool, level: state.level, batchFormat: state.batchFormat };
    if (state.saveFormat) data.format = state.saveFormat; // absent until the user has picked one
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
    } catch (err) {
      /* no storage: the choices last until the page is closed */
    }
  }

  /** For the slider, which fires on every step of a drag. */
  function writeSettingsSoon() {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(writeSettings, 400);
  }

  function resetChoices() {
    clearTimeout(settingsTimer);
    settingsTimer = 0;
    try {
      window.localStorage.removeItem(SETTINGS_KEY);
    } catch (err) {
      /* nothing was stored */
    }
    Object.assign(state, DEFAULTS);
    showLevel();
    updateUI();
    if (facePick) syncFacePick();
    toast('Choices reset.');
  }

  /* ======================================================================
   * State
   * ==================================================================== */

  const state = Object.assign(readSettings(), {
    busy: false, // a task holds the busy overlay
    loading: false, // the active photo is still being decoded: the canvas is not it yet
    cropping: false,
    multiMode: false, // filmstrip taps add to the selection (the Select button)
  });

  const photos = []; // the batch, in filmstrip order
  let active = null; // the photo on the canvas, always one of the selected ones
  // The photo whose pixels the canvas and view.orig really hold. It differs from
  // `active` while a photo is loading, and when the active photo's file cannot be read.
  let shown = null;
  let canvasStale = false; // the canvas no longer matches `shown` and its ops: redraw before going back to it

  // The canvas on screen as a target for applyOp: `orig` is the clean original at
  // working size, `crop` is the canvas's rectangle inside it.
  const view = { ctx: ctx, canvas: main, orig: null, crop: { x: 0, y: 0, w: 0, h: 0 } };

  let idCounter = 0; // ids for photos, ops and groups
  let viewScale = 1; // CSS pixels per image pixel
  let drag = null; // the gesture in progress, if any
  let cropRect = null; // {x, y, w, h} integers, while cropping
  let keyBox = null; // {x0, y0, x1, y1} in image pixels: the keyboard selection outside crop mode
  let overlayDirty = null; // what the overlay last drew: a rect, 'all', or null
  let overlayQueued = false;
  let fitQueued = false;

  function newId() {
    return ++idCounter;
  }

  /** True if this photo's pixels are the ones on the canvas, ready to be edited. */
  function isShown(photo) {
    return photo === shown && !state.loading;
  }

  function selectedPhotos() {
    return photos.filter(function (p) {
      return p.selected;
    });
  }

  function selectedCount() {
    let n = 0;
    for (const p of photos) if (p.selected) n++;
    return n;
  }

  /**
   * True while nothing may edit the photo: no photo, a task running, a photo
   * loading, or an active photo whose file could not be read (the canvas is not it).
   */
  function blocked() {
    return !active || state.busy || state.loading || shown !== active;
  }

  /* ======================================================================
   * Small UI pieces: toasts, busy overlay, confirm dialog, hint
   * ==================================================================== */

  function toast(message, ms) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    els.toasts.appendChild(el);
    while (els.toasts.children.length > 3) els.toasts.removeChild(els.toasts.firstChild);
    setTimeout(function () {
      el.classList.add('leaving');
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 300);
    }, ms || 3400);
  }

  let busyCancel = null; // what the overlay's Cancel button does, when it is shown
  let loadingShown = false; // the overlay is up for a photo that is slow to open

  function syncBusy() {
    els.busy.hidden = !(state.busy || loadingShown);
  }

  /** Show the busy overlay. With `onCancel` it also offers a Cancel button. */
  function showBusy(text, onCancel) {
    state.busy = true;
    busyCancel = onCancel || null;
    els.busyText.textContent = text;
    els.busyCancelBtn.hidden = !busyCancel;
    els.busyCancelBtn.disabled = false;
    syncBusy();
  }

  function setBusyText(text) {
    els.busyText.textContent = text;
  }

  function hideBusy() {
    state.busy = false;
    busyCancel = null;
    els.busyCancelBtn.hidden = true;
    syncBusy();
  }

  els.busyCancelBtn.addEventListener('click', function () {
    if (!busyCancel) return;
    busyCancel();
    els.busyCancelBtn.disabled = true; // it takes effect after the photo in hand
  });

  /**
   * Resolves once the browser has had a chance to paint (two animation frames).
   * The timer is a fallback for a hidden tab, where frames do not fire.
   */
  function paint() {
    return new Promise(function (resolve) {
      let done = false;
      const finish = function () {
        if (done) return;
        done = true;
        resolve();
      };
      requestAnimationFrame(function () {
        requestAnimationFrame(finish);
      });
      setTimeout(finish, 250);
    });
  }

  let confirmDone = null;

  /** A small yes / no dialog. Resolves to true when the user presses the `okLabel` button. */
  function askConfirm(message, okLabel) {
    return new Promise(function (resolve) {
      if (typeof els.confirm.showModal !== 'function') {
        resolve(window.confirm(message));
        return;
      }
      els.confirmText.textContent = message;
      els.confirmOkBtn.textContent = okLabel;
      els.confirm.returnValue = '';
      confirmDone = resolve;
      els.confirm.showModal(); // focus lands on Cancel, the safe answer
    });
  }

  els.confirmOkBtn.addEventListener('click', function () {
    els.confirm.close('ok');
  });
  els.confirmCancelBtn.addEventListener('click', function () {
    els.confirm.close('');
  });
  els.confirm.addEventListener('close', function () {
    const done = confirmDone;
    confirmDone = null;
    if (done) done(els.confirm.returnValue === 'ok'); // Escape leaves it empty
  });

  function hintText() {
    if (!active) return '';
    if (shown !== active && !state.loading) return "This photo can't be read right now.";
    const n = selectedCount();
    // The count goes first: the hint is cut at its end when it does not fit.
    const many = n > 1 ? 'Editing ' + n + ' photos together. ' : '';
    if (facePick) return 'Tap a face to keep it visible.';
    if (state.cropping) {
      const what = cropRect ? 'Drag inside to move, an edge to resize.' : 'Drag on the photo to choose the part to keep.';
      return n > 1 ? 'Cropping ' + n + ' photos together. ' + what : what;
    }
    if (drag && drag.kind === 'select' && isReverse(drag)) {
      return many + 'Let go to bring the original back here.';
    }
    if (keyBox && !drag) return many + 'Arrow keys move the box. Shift resizes. Enter hides it.';
    // Several photos selected: say so before anything else, because the next drag
    // lands on all of them.
    if (n > 1) return 'Editing ' + n + ' photos together';
    switch (state.tool) {
      case 'pixelate':
        return 'Drag to pixelate. Drag up and left to reveal.';
      case 'blur':
        return 'Drag to blur. Drag up and left to reveal.';
      case 'black':
        return 'Drag to black out. Drag up and left to reveal.';
      default:
        return 'Drag to hide. Drag up and left to reveal.';
    }
  }

  /** The cheap part of updateUI, safe to call on every pointer move. */
  function updateLive() {
    if (state.cropping) {
      const size = cropRect ? cropRect.w + ' × ' + cropRect.h + ' px' : 'Drag on the photo';
      if (els.cropSize.textContent !== size) els.cropSize.textContent = size;
      els.cropApplyBtn.disabled = !cropRect;
    }
    const text = hintText();
    if (els.hint.textContent !== text) els.hint.textContent = text;
    const many = !!active && !facePick && selectedCount() > 1;
    els.hint.classList.toggle('is-sync', many);
    // The hint is not read out, and a short screen hides it. The photo's own name
    // says where an edit will land. (Written only when it changes.)
    const label =
      (many ? 'Photo. Edits go onto all ' + selectedCount() + ' selected photos. ' : 'Photo. ') +
      'Drag over an area to hide it, or use the arrow keys to place a box and press Enter.';
    if (overlay.getAttribute('aria-label') !== label) overlay.setAttribute('aria-label', label);
  }

  function setDisabled(el, off) {
    el.disabled = off;
    if (off) el.setAttribute('aria-disabled', 'true');
    else el.removeAttribute('aria-disabled');
  }

  function updateUI() {
    const has = !!active;
    const picking = !!facePick;

    for (const b of toolButtons) {
      b.setAttribute('aria-pressed', String(b.dataset.tool === state.tool));
      setDisabled(b, !has);
    }
    // With no photo there is nothing to edit or save. Open and Help still work.
    setDisabled(els.facesBtn, !has);
    setDisabled(els.cropBtn, !has);
    setDisabled(els.revertBtn, !has);
    setDisabled(els.strength, !has);
    setDisabled(els.saveBtn, !has);
    setDisabled(els.undoBtn, !has || picking || active.ops.length === 0);
    // An Undo of a shared step comes off every photo that has it: say so up front.
    let reach = 1;
    const last = has && active.ops.length ? active.ops[active.ops.length - 1] : null;
    if (last && last.group !== null) {
      for (const p of photos) if (p !== active && canRemoveGroupOp(p, last.group)) reach++;
    }
    const undoLabel = reach > 1 ? 'Undo on ' + reach + ' photos' : 'Undo';
    if (els.undoBtn.getAttribute('aria-label') !== undoLabel) {
      els.undoBtn.setAttribute('aria-label', undoLabel);
      els.undoBtn.title = undoLabel + ' (Ctrl+Z)';
    }
    els.cropBtn.setAttribute('aria-pressed', String(state.cropping));

    const adjustable = state.tool === 'pixelate' || state.tool === 'blur';
    els.strengthRow.hidden = state.cropping || picking || !adjustable;
    els.cropBar.hidden = !state.cropping;
    els.faceBar.hidden = !picking;
    els.app.classList.toggle('is-picking', picking);

    // The stage shows either the photo or the empty state. The canvas stays out of
    // sight until the first photo has been drawn on it.
    els.empty.hidden = has;
    els.wrap.hidden = !view.orig;
    els.stage.classList.toggle('is-empty', !has);
    updateLive();
  }

  function showLevel() {
    els.strength.value = String(state.level);
    els.strengthValue.textContent = String(state.level);
  }

  /* ======================================================================
   * Canvas size and fitting
   * ==================================================================== */

  function setCanvasSize(w, h) {
    main.width = w;
    main.height = h;
    syncOverlay();
  }

  /** Give the overlay the main canvas's size. Call after anything that resized it. */
  function syncOverlay() {
    overlay.width = main.width;
    overlay.height = main.height;
    overlayDirty = null; // resizing a canvas clears it
    keyBox = null; // it was placed on the old image
    fit();
  }

  /** Scale the canvases to the stage with CSS. Never more than 4x. */
  function fit() {
    const W = main.width;
    const H = main.height;
    const availW = Math.max(1, els.stageFit.clientWidth);
    const availH = Math.max(1, els.stageFit.clientHeight);
    const s = Math.min(availW / W, availH / H, MAX_UPSCALE);
    const cssW = Math.max(1, Math.floor(W * s));
    const cssH = Math.max(1, Math.floor(H * s));
    els.wrap.style.width = cssW + 'px';
    els.wrap.style.height = cssH + 'px';
    viewScale = cssW / W;
    requestOverlay(); // line widths depend on the scale
  }

  function requestFit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(function () {
      fitQueued = false;
      fit();
    });
  }

  /** Pointer position in image pixels. Not clamped: it may lie outside the image. */
  function toImage(e) {
    const r = overlay.getBoundingClientRect();
    const sx = r.width > 0 ? overlay.width / r.width : 1;
    const sy = r.height > 0 ? overlay.height / r.height : 1;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }

  /* ======================================================================
   * Overlay drawing (selection rectangle and crop frame)
   * ==================================================================== */

  function requestOverlay() {
    if (overlayQueued) return;
    overlayQueued = true;
    requestAnimationFrame(function () {
      overlayQueued = false;
      drawOverlay();
    });
  }

  function drawOverlay() {
    const W = overlay.width;
    const H = overlay.height;

    // Wipe only what was drawn last time. A full clear of a 40 MP canvas on every
    // pointer move would be wasteful.
    if (overlayDirty === 'all') octx.clearRect(0, 0, W, H);
    else if (overlayDirty) octx.clearRect(overlayDirty.x, overlayDirty.y, overlayDirty.w, overlayDirty.h);
    overlayDirty = null;

    const px = 1 / viewScale; // one CSS pixel, in image pixels

    if (state.cropping) {
      if (cropRect) drawCropFrame(cropRect, W, H, px);
      return;
    }
    // The pointer drag in progress, or else the box placed with the keyboard.
    const sel = drag && drag.kind === 'select' ? drag : keyBox;
    if (!sel) return;

    const x0 = clamp(Math.min(sel.x0, sel.x1), 0, W);
    const y0 = clamp(Math.min(sel.y0, sel.y1), 0, H);
    const x1 = clamp(Math.max(sel.x0, sel.x1), 0, W);
    const y1 = clamp(Math.max(sel.y0, sel.y1), 0, H);
    const w = x1 - x0;
    const h = y1 - y0;
    if (w <= 0 || h <= 0) return;

    octx.save();
    if (!isReverse(sel)) {
      octx.fillStyle = ACCENT_FILL;
      octx.fillRect(x0, y0, w, h);
    }
    // A dark line under the dashes keeps them visible on pale photos.
    octx.lineWidth = 4 * px;
    octx.strokeStyle = 'rgba(6, 12, 14, 0.6)';
    octx.strokeRect(x0, y0, w, h);
    octx.lineWidth = 2 * px;
    octx.strokeStyle = ACCENT;
    octx.setLineDash([7 * px, 5 * px]);
    octx.strokeRect(x0, y0, w, h);
    octx.restore();

    const pad = 4 * px + 2;
    overlayDirty = {
      x: Math.floor(x0 - pad),
      y: Math.floor(y0 - pad),
      w: Math.ceil(w + pad * 2) + 1,
      h: Math.ceil(h + pad * 2) + 1,
    };
  }

  function drawCropFrame(r, W, H, px) {
    const thin = Math.max(1, px);
    octx.save();

    // Dim everything outside the frame.
    octx.fillStyle = 'rgba(7, 9, 12, 0.64)';
    octx.fillRect(0, 0, W, r.y);
    octx.fillRect(0, r.y + r.h, W, H - r.y - r.h);
    octx.fillRect(0, r.y, r.x, r.h);
    octx.fillRect(r.x + r.w, r.y, W - r.x - r.w, r.h);

    // Rule-of-thirds lines.
    octx.beginPath();
    for (let i = 1; i <= 2; i++) {
      const vx = r.x + (r.w * i) / 3;
      const hy = r.y + (r.h * i) / 3;
      octx.moveTo(vx, r.y);
      octx.lineTo(vx, r.y + r.h);
      octx.moveTo(r.x, hy);
      octx.lineTo(r.x + r.w, hy);
    }
    octx.lineWidth = thin;
    octx.strokeStyle = 'rgba(255, 255, 255, 0.42)';
    octx.stroke();

    // White border on a dark underline.
    octx.lineWidth = Math.max(1, 3.5 * px);
    octx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    octx.strokeRect(r.x, r.y, r.w, r.h);
    octx.lineWidth = Math.max(1, 1.5 * px);
    octx.strokeStyle = '#ffffff';
    octx.strokeRect(r.x, r.y, r.w, r.h);

    // Corner brackets, so the resize handles are easy to see.
    const len = Math.min(18 * px, r.w / 3, r.h / 3);
    const xa = r.x;
    const xb = r.x + r.w;
    const ya = r.y;
    const yb = r.y + r.h;
    octx.beginPath();
    octx.moveTo(xa, ya + len);
    octx.lineTo(xa, ya);
    octx.lineTo(xa + len, ya);
    octx.moveTo(xb - len, ya);
    octx.lineTo(xb, ya);
    octx.lineTo(xb, ya + len);
    octx.moveTo(xb, yb - len);
    octx.lineTo(xb, yb);
    octx.lineTo(xb - len, yb);
    octx.moveTo(xa + len, yb);
    octx.lineTo(xa, yb);
    octx.lineTo(xa, yb - len);
    octx.lineWidth = Math.max(1, 4 * px);
    octx.lineJoin = 'miter';
    octx.strokeStyle = '#ffffff';
    octx.stroke();

    octx.restore();
    overlayDirty = 'all';
  }

  /* ======================================================================
   * Ops: the edits a photo is made of
   *
   *   { id, group, type: 'effect', tool, level, rect }
   *   { id, group, type: 'reveal', rect }            a reverse drag: original pixels back
   *   { id, group, type: 'faces', effect, rects }    rects already padded
   *   { id, group, type: 'crop', rect }
   *   { id, group, type: 'revert', saved }           saved = the ops it replaced
   *
   * Rects are fractions of the frame the op was made in (the photo after any
   * earlier crops). `group` is shared by the ops that one action put on several
   * photos, so the action can be undone on all of them. It is null for an edit to
   * a single photo.
   * ==================================================================== */

  /** A new off-DOM canvas and its context. Throws if the browser cannot back it. */
  function makeCanvas(w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g || canvas.width !== w || canvas.height !== h || !canvasHoldsPixels(g)) {
      dropCanvas(canvas);
      throw new Error('no backing store');
    }
    return { canvas: canvas, ctx: g };
  }

  /** Hand a canvas's pixels back straight away instead of waiting for the collector. */
  function dropCanvas(canvas) {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
  }

  /**
   * True if the canvas behind `g` really has a backing store. Some browsers accept
   * a size they cannot allocate and then quietly ignore every draw.
   */
  function canvasHoldsPixels(g) {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 1, 1);
    const ok = g.getImageData(0, 0, 1, 1).data[3] === 255;
    g.clearRect(0, 0, 1, 1);
    return ok;
  }

  /** One effect on an integer rect inside the target. Throws before changing anything. */
  function applyRegion(t, r, fx) {
    const g = t.ctx;
    if (fx.type === 'black') {
      g.fillStyle = '#000';
      g.fillRect(r.x, r.y, r.w, r.h);
    } else if (fx.type === 'reveal') {
      g.clearRect(r.x, r.y, r.w, r.h);
      g.drawImage(t.orig, t.crop.x + r.x, t.crop.y + r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    } else {
      const img = g.getImageData(r.x, r.y, r.w, r.h);
      if (fx.type === 'pixelate') pixelateBuffer(img.data, r.w, r.h, fx.block);
      else blurBuffer(img.data, r.w, r.h, fx.radius);
      g.putImageData(img, r.x, r.y);
    }
  }

  /**
   * Draw one op onto a target { ctx, canvas, orig, crop }: `orig` is the clean
   * original at the target's scale and `crop` the canvas's rectangle inside it.
   *
   * This is the only place an op turns into pixels. The live edit, the redraw
   * after changing photo, thumbnails and exports all come through here, and each
   * works out its integer rects the same way, so a replay at the same size gives
   * exactly the pixels the user saw.
   */
  function applyOp(t, op) {
    const W = t.canvas.width;
    const H = t.canvas.height;
    switch (op.type) {
      case 'effect': {
        const r = denormRect(op.rect, W, H);
        if (r.w > 0 && r.h > 0) applyRegion(t, r, effectFor(op.tool, r.w, r.h, op.level));
        break;
      }
      case 'reveal': {
        const r = denormRect(op.rect, W, H);
        if (r.w > 0 && r.h > 0) applyRegion(t, r, { type: 'reveal' });
        break;
      }
      case 'faces':
        for (const rect of op.rects) {
          const r = denormRect(rect, W, H);
          if (r.w > 0 && r.h > 0) applyRegion(t, r, faceEffect(op.effect, r.w));
        }
        break;
      case 'crop': {
        const r = denormRect(op.rect, W, H);
        // A thumbnail can round a thin frame down to nothing. Keep one pixel.
        if (r.w < 1) {
          r.w = 1;
          r.x = Math.min(r.x, W - 1);
        }
        if (r.h < 1) {
          r.h = 1;
          r.y = Math.min(r.y, H - 1);
        }
        const keep = makeCanvas(r.w, r.h);
        try {
          keep.ctx.drawImage(t.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
          t.canvas.width = r.w;
          t.canvas.height = r.h;
          t.ctx.drawImage(keep.canvas, 0, 0);
        } finally {
          dropCanvas(keep.canvas);
        }
        t.crop = { x: t.crop.x + r.x, y: t.crop.y + r.y, w: r.w, h: r.h };
        break;
      }
      case 'revert':
        drawClean(t);
        break;
    }
  }

  /** Reset a target to its whole clean original. */
  function drawClean(t) {
    t.canvas.width = t.orig.width; // also clears it
    t.canvas.height = t.orig.height;
    t.ctx.drawImage(t.orig, 0, 0);
    t.crop = { x: 0, y: 0, w: t.orig.width, h: t.orig.height };
  }

  /**
   * The ops that make the photo what it is now: a Revert starts again from the
   * clean original, so nothing before it counts.
   */
  function effectiveOps(photo) {
    const ops = photo.ops;
    let from = 0;
    for (let i = ops.length - 1; i >= 0; i--) {
      if (ops[i].type === 'revert') {
        from = i + 1;
        break;
      }
    }
    // A faces op with no rects only marks a synced action for Undo. It draws nothing,
    // so the photo is not edited by it.
    return ops.slice(from).filter(function (op) {
      return op.type !== 'faces' || op.rects.length > 0;
    });
  }

  /** Changes whenever the photo's pixels would. Compared to tell saved from unsaved. */
  function signature(photo) {
    return effectiveOps(photo)
      .map(function (op) {
        return op.id;
      })
      .join(',');
  }

  function isEdited(photo) {
    return effectiveOps(photo).length > 0;
  }

  /** Has edits that have not been exported. */
  function isDirty(photo) {
    return signature(photo) !== photo.savedSig;
  }

  /** Exported, with no edit since. */
  function isSaved(photo) {
    return photo.savedOnce && !isDirty(photo);
  }

  function markSaved(photo, sig) {
    photo.savedSig = sig;
    photo.savedOnce = true;
  }

  /** How many times Undo can be pressed: a Revert also holds the steps before it. */
  function undoDepth(ops) {
    let n = 0;
    for (const op of ops) n += 1 + (op.type === 'revert' ? undoDepth(op.saved) : 0);
    return n;
  }

  /** Apply every op to a target. Returns false if any could not be drawn. */
  function replay(t, ops) {
    let ok = true;
    for (const op of ops) {
      try {
        applyOp(t, op);
      } catch (err) {
        ok = false; // out of memory for that region: carry on with the rest
      }
    }
    return ok;
  }

  /** Redraw the active photo from its clean original and its ops. */
  function rerenderActive() {
    drawClean(view);
    const ok = replay(view, effectiveOps(active));
    syncOverlay();
    if (!ok) toast(MSG_TOO_LARGE);
  }

  /* ======================================================================
   * Undo
   *
   * Undo removes the active photo's last op. The pixels come back from a snapshot
   * taken when the op was made, if there is one. That is the fast path, and its
   * memory is bounded. Otherwise the photo is redrawn from its remaining ops, which
   * is always possible. Snapshots belong to the active photo and are dropped when
   * another photo becomes active.
   * ==================================================================== */

  const snaps = []; // { opId, kind: 'regions', items: [{x, y, data}] } | { opId, kind: 'full', data, crop }
  let snapBytes = 0;

  function clearSnaps() {
    snaps.length = 0;
    snapBytes = 0;
  }

  /** Keep a snapshot for `opId`, then drop the oldest until the stack fits its limits. */
  function pushSnap(snap, opId) {
    snap.opId = opId;
    snap.bytes = 0;
    if (snap.kind === 'full') snap.bytes = snap.data.data.length;
    else for (const it of snap.items) snap.bytes += it.data.data.length;
    if (snap.bytes > UNDO_BYTES) return; // undo will redraw instead
    snaps.push(snap);
    snapBytes += snap.bytes;
    while (snaps.length > UNDO_ENTRIES || snapBytes > UNDO_BYTES) {
      snapBytes -= snaps.shift().bytes;
    }
  }

  /** The pixels inside some rects of the canvas, or null when they are too many to keep. */
  function captureRects(rects) {
    let bytes = 0;
    for (const r of rects) bytes += r.w * r.h * 4;
    if (bytes > UNDO_BYTES) return null;
    try {
      return {
        kind: 'regions',
        items: rects.map(function (r) {
          return { x: r.x, y: r.y, data: ctx.getImageData(r.x, r.y, r.w, r.h) };
        }),
      };
    } catch (err) {
      return null;
    }
  }

  /** The whole canvas, or null when that would not fit in the undo budget. */
  function captureFull() {
    if (main.width * main.height * 4 > UNDO_BYTES) return null;
    try {
      return { kind: 'full', data: ctx.getImageData(0, 0, main.width, main.height), crop: view.crop };
    } catch (err) {
      return null;
    }
  }

  function restoreSnap(snap) {
    if (snap.kind === 'full') {
      setCanvasSize(snap.data.width, snap.data.height);
      ctx.putImageData(snap.data, 0, 0);
      view.crop = snap.crop;
    } else {
      // Every item was captured before the op changed anything, so the order is free.
      for (const it of snap.items) ctx.putImageData(it.data, it.x, it.y);
    }
  }

  /** Where the op of `group` sits in a photo's list, or -1 if the photo has none. */
  function groupOpAt(photo, group) {
    const ops = photo.ops;
    for (let i = ops.length - 1; i >= 0; i--) {
      if (ops[i].group === group) return i;
    }
    return -1;
  }

  /**
   * True if an Undo of `group` would take its op off this photo. A Revert that the
   * photo has been edited after is left in place (see removeGroupOp).
   */
  function canRemoveGroupOp(photo, group) {
    const at = groupOpAt(photo, group);
    return at >= 0 && !(photo.ops[at].type === 'revert' && at < photo.ops.length - 1);
  }

  /**
   * Take the op of `group` back off a photo that is not on screen. Returns true only
   * if the op was taken off. A Revert that the photo has been edited after is left
   * in place, and so is the photo.
   */
  function removeGroupOp(photo, group) {
    if (!canRemoveGroupOp(photo, group)) return false;
    const ops = photo.ops;
    const at = groupOpAt(photo, group);
    const op = ops[at];
    const later = ops.slice(at + 1);
    if (op.type === 'revert') {
      // Edits made since the Revert were measured on the whole original. The saved
      // list can hold a crop, and behind it they would land somewhere else (a hidden
      // area could come back). So a photo that has been edited on its own since is
      // left alone (canRemoveGroupOp): its own Undo takes those edits off first and
      // then the Revert. Here nothing comes after the Revert.
      photo.ops = op.saved;
    } else {
      if (op.type === 'crop') {
        // Edits made after the crop were measured inside its frame. Move them out
        // into the frame the crop was measured in, so they stay on the same spot.
        // That goes as far as the next crop, which frames everything after it.
        for (let i = 0; i < later.length; i++) {
          const o = later[i];
          if (o.type === 'faces') {
            later[i] = Object.assign({}, o, {
              rects: o.rects.map(function (n) {
                return uncropRect(n, op.rect);
              }),
            });
          } else if (o.rect) {
            later[i] = Object.assign({}, o, { rect: uncropRect(o.rect, op.rect) });
          }
          if (o.type === 'crop') break;
        }
      }
      photo.ops = ops.slice(0, at).concat(later);
    }
    return true;
  }

  function undo() {
    if (blocked() || facePick) return;
    cancelDrag();
    exitCrop();
    const op = active.ops.pop();
    if (!op) return;
    if (op.type === 'revert') active.ops = op.saved;

    // The same action on the other photos it went to.
    let others = 0;
    let outside = 0; // changed photos that are not in the current selection
    if (op.group !== null) {
      for (const p of photos) {
        if (p !== active && removeGroupOp(p, op.group)) {
          renderThumb(p);
          others++;
          if (!p.selected) outside++;
        }
      }
    }
    // The step was shared. Say how far the undo reached, and keep the message up
    // longer when it changed photos the user is not looking at.
    if (others) toast('Undone on ' + (others + 1) + ' photos', outside ? 6000 : 0);

    const finish = function () {
      renderThumb(active);
      afterEdit();
    };
    const top = snaps[snaps.length - 1];
    if (top && top.opId === op.id) {
      snaps.pop();
      snapBytes -= top.bytes;
      restoreSnap(top);
      finish();
    } else if (main.width * main.height > BUSY_AREA && active.ops.length) {
      // No snapshot (always the case after changing photo), and a redraw of a big
      // photo with edits can take a moment.
      showBusy('Working…');
      paint().then(function () {
        try {
          rerenderActive();
        } finally {
          hideBusy();
          finish();
        }
      });
    } else {
      rerenderActive();
      finish();
    }
  }

  /* ======================================================================
   * Making an edit
   * ==================================================================== */

  /** A fresh group id when the edit will go to several photos, else null. */
  function syncGroup() {
    return selectedCount() > 1 ? newId() : null;
  }

  /**
   * Make one edit. It is drawn on the active photo now. With `sync`, every other
   * selected photo gets the same op in its list and on its thumbnail, and no
   * full-size work is done for those until they are shown or exported.
   *
   * `snap` holds the pixels the op is about to change (or null). Returns false,
   * with the photo as it was, if the browser could not draw the op.
   */
  function commitOp(op, snap, sync) {
    try {
      applyOp(view, op);
    } catch (err) {
      // A faces op may have got part of the way before it failed.
      if (snap) restoreSnap(snap);
      else rerenderActive();
      return false;
    }
    if (overlay.width !== main.width || overlay.height !== main.height) syncOverlay();
    active.ops.push(op);
    if (snap) pushSnap(snap, op.id);
    thumbAfterOp(active, op);
    if (sync) {
      for (const p of photos) {
        if (!p.selected || p === active) continue;
        const copy = Object.assign({}, op, { id: newId() });
        p.ops.push(copy);
        thumbAfterOp(p, copy);
      }
    }
    afterEdit();
    return true;
  }

  /** Bring the buttons and the filmstrip marks in line after ops changed. */
  function afterEdit() {
    syncStrip();
    updateUI();
  }

  function isReverse(d) {
    return d.x1 < d.x0 && d.y1 < d.y0;
  }

  /** The drag has ended: hide (or reveal) what is inside it. */
  function finishSelection(d) {
    if (blocked()) return;
    const W = main.width;
    const H = main.height;
    const r = rectFromPoints(d.x0, d.y0, d.x1, d.y1, W, H);
    if (r.w < 3 || r.h < 3) return;

    const op = { id: newId(), group: syncGroup(), type: 'reveal', rect: normRect(r, W, H) };
    let heavy = false;
    if (!isReverse(d)) {
      op.type = 'effect';
      op.tool = state.tool;
      op.level = state.level;
      heavy = state.tool !== 'black' && r.w * r.h > BUSY_AREA;
    }

    const run = function () {
      if (!commitOp(op, captureRects([r]), true)) toast(MSG_TOO_LARGE);
    };
    if (!heavy) {
      run();
      return;
    }
    showBusy('Working…');
    paint().then(function () {
      try {
        run();
      } finally {
        hideBusy();
      }
    });
  }

  /* ======================================================================
   * Crop
   * ==================================================================== */

  function minCrop() {
    return { w: Math.min(8, main.width), h: Math.min(8, main.height) };
  }

  function enterCrop() {
    if (state.cropping || blocked()) return;
    cancelDrag();
    cancelFaces();
    state.cropping = true;
    cropRect = null;
    keyBox = null;
    updateUI();
    drawOverlay();
  }

  function exitCrop() {
    if (!state.cropping) return;
    if (drag && drag.kind === 'crop') releaseDrag();
    state.cropping = false;
    cropRect = null;
    overlay.style.cursor = '';
    updateUI();
    drawOverlay();
  }

  /**
   * Which part of the crop frame a point touches: null (outside), {kind: 'move'},
   * or {kind: 'resize', l, r, t, b}. The grab zone is about 16 CSS pixels each
   * side of an edge, but never more than a third of the frame on the inside, so a
   * small frame can still be moved.
   */
  function cropHit(p) {
    const r = cropRect;
    if (!r) return null;
    const zone = 16 / viewScale;
    if (p.x < r.x - zone || p.x > r.x + r.w + zone || p.y < r.y - zone || p.y > r.y + r.h + zone) return null;
    const inX = Math.min(zone, r.w / 3);
    const inY = Math.min(zone, r.h / 3);
    const l = p.x < r.x + inX;
    const rt = p.x > r.x + r.w - inX;
    const t = p.y < r.y + inY;
    const b = p.y > r.y + r.h - inY;
    if (l || rt || t || b) return { kind: 'resize', l: l, r: rt, t: t, b: b };
    return { kind: 'move' };
  }

  function cropCursor(hit) {
    if (!hit) return 'crosshair';
    if (hit.kind === 'move') return 'move';
    if ((hit.l && hit.t) || (hit.r && hit.b)) return 'nwse-resize';
    if ((hit.r && hit.t) || (hit.l && hit.b)) return 'nesw-resize';
    return hit.l || hit.r ? 'ew-resize' : 'ns-resize';
  }

  function startCropDrag(p, pointerId) {
    const hit = cropHit(p);
    drag = {
      kind: 'crop',
      id: pointerId,
      x0: p.x,
      y0: p.y,
      mode: hit ? hit.kind : 'new',
      edges: hit && hit.kind === 'resize' ? hit : null,
      orig: cropRect ? { x: cropRect.x, y: cropRect.y, w: cropRect.w, h: cropRect.h } : null,
    };
  }

  function moveCropDrag(p) {
    const W = main.width;
    const H = main.height;
    const d = drag;
    const o = d.orig;
    if (d.mode === 'new') {
      cropRect = rectFromPoints(d.x0, d.y0, p.x, p.y, W, H);
    } else if (d.mode === 'move') {
      cropRect = {
        x: clamp(Math.round(o.x + p.x - d.x0), 0, W - o.w),
        y: clamp(Math.round(o.y + p.y - d.y0), 0, H - o.h),
        w: o.w,
        h: o.h,
      };
    } else {
      const min = minCrop();
      const dx = p.x - d.x0;
      const dy = p.y - d.y0;
      let l = o.x;
      let t = o.y;
      let r = o.x + o.w;
      let b = o.y + o.h;
      // The dragged edge stops at the image border and at the minimum size.
      if (d.edges.l) l = clamp(Math.round(o.x + dx), 0, r - min.w);
      if (d.edges.r) r = clamp(Math.round(o.x + o.w + dx), l + min.w, W);
      if (d.edges.t) t = clamp(Math.round(o.y + dy), 0, b - min.h);
      if (d.edges.b) b = clamp(Math.round(o.y + o.h + dy), t + min.h, H);
      cropRect = { x: l, y: t, w: r - l, h: b - t };
    }
    updateLive();
    requestOverlay();
  }

  function endCropDrag() {
    const min = minCrop();
    // A new frame that is too small (a tap, say) clears the frame.
    if (cropRect && (cropRect.w < min.w || cropRect.h < min.h)) cropRect = null;
    updateUI();
    drawOverlay();
  }

  /**
   * Keyboard version of the drag: move the box by a step, or with `resize` move its
   * bottom-right corner. Works on the crop frame in crop mode and on keyBox otherwise.
   * The first press places a box in the middle of the photo.
   */
  function nudgeKeyBox(dx, dy, resize) {
    const W = main.width;
    const H = main.height;
    const min = minCrop();
    const step = Math.max(1, Math.round(8 / viewScale)); // about 8 CSS pixels
    let r = state.cropping
      ? cropRect
      : keyBox && { x: keyBox.x0, y: keyBox.y0, w: keyBox.x1 - keyBox.x0, h: keyBox.y1 - keyBox.y0 };
    if (!r) {
      // Start centred, a quarter of each side.
      const w = Math.max(min.w, Math.round(W / 4));
      const h = Math.max(min.h, Math.round(H / 4));
      r = { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w: w, h: h };
    } else if (resize) {
      r = {
        x: r.x,
        y: r.y,
        w: clamp(r.w + dx * step, min.w, W - r.x),
        h: clamp(r.h + dy * step, min.h, H - r.y),
      };
    } else {
      r = { x: clamp(r.x + dx * step, 0, W - r.w), y: clamp(r.y + dy * step, 0, H - r.h), w: r.w, h: r.h };
    }
    if (state.cropping) cropRect = r;
    else keyBox = { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
    updateUI();
    drawOverlay();
  }

  function clearKeyBox() {
    if (!keyBox) return;
    keyBox = null;
    updateUI();
    drawOverlay();
  }

  function applyCrop() {
    if (!state.cropping || blocked() || drag) return;
    const r = cropRect;
    if (!r) return;
    const W = main.width;
    const H = main.height;
    if (r.x === 0 && r.y === 0 && r.w === W && r.h === H) {
      exitCrop(); // the frame is the whole image: nothing to do
      return;
    }
    const op = { id: newId(), group: syncGroup(), type: 'crop', rect: normRect(r, W, H) };
    const snap = captureFull();
    state.cropping = false;
    cropRect = null;
    overlay.style.cursor = '';
    if (!commitOp(op, snap, true)) {
      toast(MSG_TOO_LARGE);
      updateUI();
      drawOverlay();
    }
  }

  /* ======================================================================
   * Revert
   * ==================================================================== */

  /** Every selected photo with edits goes back to its clean original. */
  function revert() {
    if (blocked()) return;
    cancelDrag();
    exitCrop();
    cancelFaces();
    const edited = selectedPhotos().filter(isEdited);
    if (!edited.length) {
      toast(selectedCount() > 1 ? 'These are already the originals.' : 'This is already the original.');
      return;
    }
    const group = syncGroup();
    // Undo works from the active photo's last op. A synced Revert leaves its op there
    // too, even when the active photo has nothing to revert, so that Undo here takes
    // the Revert back on every photo it went to. That op changes no pixels and keeps
    // the photo's signature, so the photo is not marked as edited by it.
    const targets = group !== null && edited.indexOf(active) < 0 ? edited.concat([active]) : edited;
    for (const p of targets) {
      const op = { id: newId(), group: group, type: 'revert', saved: p.ops };
      if (p === active && isEdited(p)) {
        const snap = captureFull();
        applyOp(view, op);
        syncOverlay();
        if (snap) pushSnap(snap, op.id);
      }
      p.ops = [op];
      renderThumb(p);
    }
    afterEdit();
    if (group !== null) toast(count(edited.length, 'photo') + ' reverted');
  }

  /* ======================================================================
   * The pointer gesture
   * ==================================================================== */

  function releaseDrag() {
    const d = drag;
    drag = null;
    if (d) {
      try {
        overlay.releasePointerCapture(d.id);
      } catch (err) {
        /* the capture may already be gone */
      }
    }
    return d;
  }

  /** Abandon the gesture in progress and put things back as they were. */
  function cancelDrag() {
    const d = releaseDrag();
    if (!d) return;
    if (d.kind === 'crop') cropRect = d.orig;
    updateUI();
    drawOverlay();
  }

  overlay.addEventListener('pointerdown', function (e) {
    if (drag) {
      // A second finger during a touch drag is a pinch attempt, not a selection:
      // abandon the gesture instead of committing whatever the first finger swept.
      // The drag.touch test keeps a resting palm from cancelling a pen or mouse drag.
      if (drag.touch && e.pointerType === 'touch' && e.pointerId !== drag.id) cancelDrag();
      return;
    }
    // Primary button only. Nothing starts while a photo is loading, a task is
    // running or faces are being chosen.
    if (e.button !== 0 || blocked() || facePick) return;
    // A touch that lands while another finger is still down is the rest of a pinch.
    // Ignore it, so nothing starts until every finger has been lifted.
    if (e.pointerType === 'touch' && e.isPrimary === false) return;
    e.preventDefault();
    // preventDefault also stops the browser taking focus off the button that was
    // pressed last (Crop, say). Left there, Enter would press that button again
    // and close crop mode, where the user meant to apply the crop.
    const focused = document.activeElement;
    if (focused && focused !== document.body && typeof focused.blur === 'function') focused.blur();
    const p = toImage(e);
    if (state.cropping) startCropDrag(p, e.pointerId);
    else drag = { kind: 'select', id: e.pointerId, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    drag.touch = e.pointerType === 'touch';
    try {
      overlay.setPointerCapture(e.pointerId);
    } catch (err) {
      /* synthetic events have nothing to capture */
    }
  });

  // Move and release are heard on the window, so the gesture still ends properly
  // if pointer capture is unavailable and the pointer leaves the canvas.
  window.addEventListener('pointermove', function (e) {
    if (!drag) {
      if (state.cropping && e.target === overlay && e.pointerType === 'mouse') {
        overlay.style.cursor = cropCursor(cropHit(toImage(e)));
      }
      return;
    }
    if (e.pointerId !== drag.id) return;
    const p = toImage(e);
    if (drag.kind === 'crop') {
      moveCropDrag(p);
    } else {
      drag.x1 = p.x;
      drag.y1 = p.y;
      updateLive(); // the hint changes when the drag turns into a reveal
      requestOverlay();
    }
  });

  window.addEventListener('pointerup', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    const p = toImage(e);
    if (drag.kind === 'crop') {
      moveCropDrag(p);
      releaseDrag();
      endCropDrag();
      return;
    }
    drag.x1 = p.x;
    drag.y1 = p.y;
    const d = releaseDrag();
    updateUI();
    drawOverlay();
    finishSelection(d);
  });

  window.addEventListener('pointercancel', function (e) {
    if (drag && e.pointerId === drag.id) cancelDrag();
  });

  overlay.addEventListener('lostpointercapture', function (e) {
    if (drag && e.pointerId === drag.id) cancelDrag();
  });

  overlay.addEventListener('contextmenu', function (e) {
    e.preventDefault();
  });

  // The keyboard box goes when focus leaves the photo (a pointer drag does that too).
  // Switching to another window is not leaving: focus comes back to the photo.
  overlay.addEventListener('blur', function () {
    if (document.hasFocus()) clearKeyBox();
  });

  /* ======================================================================
   * Decoding
   * ==================================================================== */

  /** Decode a blob at full size. Resolves to {source, width, height, release}. */
  async function decodeImage(blob) {
    if (typeof createImageBitmap === 'function') {
      let bmp = null;
      try {
        bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      } catch (err) {
        try {
          bmp = await createImageBitmap(blob); // older engines reject the option
        } catch (err2) {
          bmp = null;
        }
      }
      if (bmp && bmp.width > 0 && bmp.height > 0) {
        return {
          source: bmp,
          width: bmp.width,
          height: bmp.height,
          release: function () {
            if (bmp.close) bmp.close();
          },
        };
      }
    }
    // Fallback: an <img> on an object URL. It honours Exif orientation by default.
    const img = await loadImg(blob);
    return { source: img.img, width: img.img.naturalWidth, height: img.img.naturalHeight, release: img.release };
  }

  /** An <img> for a blob, loaded. Resolves to {img, release}. */
  function loadImg(blob) {
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      const release = function () {
        URL.revokeObjectURL(url);
      };
      img.onload = function () {
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          resolve({ img: img, release: release });
        } else {
          release();
          reject(new Error('empty image'));
        }
      };
      img.onerror = function () {
        release();
        reject(new Error('decode failed'));
      };
      img.src = url;
    });
  }

  /**
   * Put a decoded image on screen at working size: full resolution when the
   * device's budget allows, scaled down to fit it otherwise. If a canvas cannot be
   * allocated the budget is halved, up to three times. Returns {w, h, scaled}, or
   * null if nothing worked.
   */
  function installSource(source, sw, sh) {
    let budget = PIXEL_BUDGET;
    for (let attempt = 0; attempt < 4; attempt++) {
      const size = fitWithinBudget(sw, sh, budget, MAX_SIDE);
      let clean = null;
      try {
        clean = makeCanvas(size.w, size.h);
        clean.ctx.imageSmoothingEnabled = true;
        clean.ctx.imageSmoothingQuality = 'high';
        clean.ctx.drawImage(source, 0, 0, size.w, size.h);
        clean.ctx.getImageData(0, 0, 1, 1);

        setCanvasSize(size.w, size.h);
        if (!canvasHoldsPixels(ctx)) throw new Error('no backing store');
        ctx.drawImage(clean.canvas, 0, 0);
        ctx.getImageData(0, 0, 1, 1);

        dropCanvas(view.orig);
        view.orig = clean.canvas;
        view.crop = { x: 0, y: 0, w: size.w, h: size.h };
        return size;
      } catch (err) {
        if (clean) dropCanvas(clean.canvas);
        budget = Math.floor(budget / 2);
      }
    }
    return null;
  }

  /**
   * A photo drawn off screen with its ops applied. With `full` it is at the
   * source's own pixel size, and only if a canvas that big cannot be had does it
   * fall back to the working budget (`reduced` is then true). Without `full` it is
   * at working size, which is what face detection wants.
   *
   * Resolves to {canvas, ctx, reduced, release}. Throws if the file cannot be
   * decoded or no canvas could be allocated.
   */
  async function renderPhoto(photo, full) {
    const decoded = await decodeImage(photo.file);
    try {
      const sw = decoded.width;
      const sh = decoded.height;
      photo.srcW = sw;
      photo.srcH = sh;
      const ops = effectiveOps(photo);
      // Only a Reveal reads the clean original again. Without one, a second
      // full-size canvas would be memory spent for nothing.
      const needsClean = ops.some(function (op) {
        return op.type === 'reveal';
      });

      let budget = PIXEL_BUDGET;
      for (let attempt = full ? -1 : 0; attempt < 4; attempt++) {
        // Attempt -1 is the exact source size, whatever the budget says.
        const size = attempt < 0 ? { w: sw, h: sh } : fitWithinBudget(sw, sh, budget, MAX_SIDE);
        if (attempt >= 0) budget = Math.floor(budget / 2);
        let work = null;
        let clean = null;
        try {
          work = makeCanvas(size.w, size.h);
          work.ctx.imageSmoothingEnabled = true;
          work.ctx.imageSmoothingQuality = 'high';
          work.ctx.drawImage(decoded.source, 0, 0, size.w, size.h);
          work.ctx.getImageData(0, 0, 1, 1);
          if (needsClean) {
            clean = makeCanvas(size.w, size.h);
            clean.ctx.drawImage(work.canvas, 0, 0);
          }
          const target = {
            ctx: work.ctx,
            canvas: work.canvas,
            orig: clean && clean.canvas,
            crop: { x: 0, y: 0, w: size.w, h: size.h },
          };
          for (const op of ops) applyOp(target, op); // a failure here retries smaller
          const canvas = work.canvas;
          work = null; // it is the caller's now
          return {
            canvas: canvas,
            ctx: target.ctx,
            reduced: size.w !== sw || size.h !== sh,
            release: function () {
              dropCanvas(canvas);
            },
          };
        } catch (err) {
          /* try the next size down */
        } finally {
          if (work) dropCanvas(work.canvas);
          if (clean) dropCanvas(clean.canvas);
        }
      }
      throw new Error('no canvas for this photo');
    } finally {
      decoded.release();
    }
  }

  /* ======================================================================
   * The batch: adding, activating and removing photos
   *
   *   photo = {
   *     id, file, name, base, type,     the source, never modified
   *     srcW, srcH,                     decoded size (0 until first read)
   *     ops,                            the ordered edit list
   *     thumbSrc, thumb, thumbCrop,     small canvases: clean, and with ops applied
   *     selected, savedSig, savedOnce,  filmstrip selection and export marks
   *     el, dotEl, tickEl,              its filmstrip option
   *   }
   * ==================================================================== */

  function makePhoto(blob, name, pasted) {
    return {
      id: 'p' + newId(),
      file: blob,
      name: String(name || 'photo'),
      base: baseNameOf(name),
      // Pasted images are usually screenshots, so they count as PNG sources.
      type: pasted ? 'image/png' : String(blob.type || '').toLowerCase(),
      srcW: 0,
      srcH: 0,
      ops: [],
      thumbSrc: null,
      thumb: null,
      thumbCtx: null,
      thumbCrop: null,
      selected: false,
      savedSig: '', // signature at the last export: a photo with no edits starts clean
      savedOnce: false,
      scaleNoted: false,
      el: null,
      dotEl: null,
      tickEl: null,
    };
  }

  function photoById(id) {
    for (const p of photos) if (p.id === id) return p;
    return null;
  }

  /**
   * Add image files to the batch and show the first of them. `items` is a list of
   * {blob, name, pasted}. Resolves to true once a new photo is on screen.
   */
  async function addFiles(items) {
    if (!items.length || els.confirm.open || els.result.open) return false;
    if (state.busy) {
      // Dropped or pasted while another task holds the busy overlay: say so instead
      // of letting the photos vanish. Long enough to outlast the overlay, which dims it.
      toast(MSG_STILL_WORKING, 5000);
      return false;
    }
    const added = [];
    let notImages = 0;
    let overLimit = 0;
    for (const it of items) {
      if (!it || !it.blob) continue;
      if (it.blob.type && !/^image\//i.test(it.blob.type)) notImages++;
      else if (photos.length >= MAX_PHOTOS) overLimit++;
      else {
        const p = makePhoto(it.blob, it.name, it.pasted);
        photos.push(p);
        added.push(p);
      }
    }
    if (notImages) {
      toast(
        items.length === 1
          ? "That file isn't an image."
          : notImages === 1
            ? '1 file was not an image'
            : notImages + ' files were not images'
      );
    }
    if (overLimit) {
      toast('Up to ' + MAX_PHOTOS + ' photos can be open at once. ' + count(overLimit, 'photo') + ' left out.', 5000);
    }
    if (!added.length) return false;

    if (els.help.open) closeHelp();
    cancelFaces();
    queueThumbs(added);

    // Show the first new photo that opens. One that is not an image is taken out again.
    const before = active;
    for (const p of added) {
      const result = await tryActivate(p, false);
      if (result === 'ok') return true;
      if (result === 'stale') return false; // the user has already moved on
      if (!wasRead(p)) forgetPhoto(p);
    }
    fallBack(before, false);
    return false;
  }

  let activation = 0; // bumped by every activation: an older one that sees it changed gives up

  /**
   * Make `photo` the active one: decode its file, draw it at working size, replay
   * its ops. Resolves to 'ok', to 'failed' (after a toast) when the file cannot be
   * shown, or to 'stale' when a newer activation overtook this one. Until it
   * resolves the canvas still holds the previous photo, and state.loading keeps
   * every edit away from it.
   */
  async function tryActivate(photo, keepSelection) {
    const token = ++activation;
    cancelDrag();
    exitCrop();
    if (!keepSelection) for (const p of photos) p.selected = false;
    photo.selected = true;
    active = photo;
    state.loading = true;
    clearSnaps();
    syncStrip();
    updateUI();
    if (photo.el && !els.strip.hidden) photo.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });

    // Most photos open faster than an overlay could fade in. Show it only for slow ones.
    const slow = setTimeout(function () {
      if (token !== activation || !state.loading) return; // overtaken by a newer activation
      loadingShown = true;
      if (!state.busy) setBusyText('Opening photo…');
      syncBusy();
    }, 150);

    try {
      let decoded = null;
      try {
        decoded = await decodeImage(photo.file);
      } catch (err) {
        decoded = null;
      }
      if (token !== activation) {
        if (decoded) decoded.release();
        return 'stale';
      }
      if (!decoded) {
        // A photo that opened before has not stopped being an image: its file has
        // moved, changed or gone offline. It stays in the batch (see activate).
        const known = wasRead(photo);
        toast(
          known
            ? photo.name +
                " can't be read right now. It may have been moved or changed, or its drive disconnected." +
                (photo.ops.length ? ' Its edits are kept.' : '')
            : photo.name + " couldn't be opened as an image.",
          known ? 7000 : 0
        );
        return 'failed';
      }
      let size;
      try {
        size = installSource(decoded.source, decoded.width, decoded.height);
      } finally {
        decoded.release();
      }
      if (!size) {
        canvasStale = true; // installSource may have resized the canvas before it gave up
        toast(photo.name + ' is too large for this device.');
        return 'failed';
      }
      shown = photo;
      canvasStale = false;
      photo.srcW = decoded.width;
      photo.srcH = decoded.height;
      if (!replay(view, effectiveOps(photo))) toast(MSG_TOO_LARGE);
      syncOverlay();
      if (!photo.thumbSrc) {
        // The clean original is right here: no need to decode the file again for it.
        try {
          setThumbSource(photo, view.orig, view.orig.width, view.orig.height);
          renderThumb(photo);
        } catch (err) {
          /* the thumbnail queue will try */
        }
      }
      if (size.scaled && !photo.scaleNoted) {
        photo.scaleNoted = true;
        toast('Photo scaled to ' + size.w + ' × ' + size.h + ' to fit this device', 5000);
      }
      return 'ok';
    } finally {
      clearTimeout(slow);
      if (token === activation) {
        state.loading = false;
        loadingShown = false;
        syncBusy();
        updateUI();
      }
    }
  }

  /**
   * Switch to a photo. `opts.keepSelection` leaves the selection alone (the photo
   * must already be in it). `opts.review` is for the face step-through, which
   * changes photo itself and must not be ended by doing so. Resolves to true when
   * the photo is on screen.
   */
  async function activate(photo, opts) {
    if (!(opts && opts.review)) cancelFaces();
    const before = active;
    const result = await tryActivate(photo, !!(opts && opts.keepSelection));
    if (result !== 'failed') return result === 'ok';
    if (!wasRead(photo)) forgetPhoto(photo);
    fallBack(before, !!(opts && opts.keepSelection));
    return false;
  }

  /** Make the active photo the only selected one, without loading anything. */
  function selectOnlyActive() {
    cancelFaces();
    for (const p of photos) p.selected = p === active;
    syncStrip();
    updateUI();
  }

  /** Take a photo out of the batch and free what it holds. */
  function forgetPhoto(photo) {
    const at = photos.indexOf(photo);
    if (at >= 0) photos.splice(at, 1);
    if (photo.el && photo.el.parentNode) photo.el.parentNode.removeChild(photo.el);
    dropCanvas(photo.thumbSrc);
    dropCanvas(photo.thumb);
    photo.thumbSrc = photo.thumb = photo.thumbCtx = null;
    photo.selected = false;
  }

  /**
   * True for a photo that has been read before or carries edits. If its file cannot
   * be read now, the file has moved, changed or gone offline: the photo stays in the
   * batch with its edits. Only a file that never opened is "not an image".
   */
  function wasRead(photo) {
    return photo.ops.length > 0 || photo.srcW > 0 || !!photo.thumbSrc;
  }

  /**
   * After a photo failed to open. This reads no file, so it cannot fail in turn (and
   * take one photo after another out of the batch): the photo the canvas still holds
   * becomes the active one again. If that one has left the batch, `prefer` (or the
   * first photo) is active with an empty stage, and nothing can be edited until a
   * photo opens.
   */
  function fallBack(prefer, keepSelection) {
    cancelFaces();
    if (!photos.length) {
      setEmpty();
      return;
    }
    if (shown && photos.indexOf(shown) >= 0 && view.orig) {
      active = shown;
      if (!keepSelection) for (const p of photos) p.selected = false;
      shown.selected = true;
      if (canvasStale) {
        canvasStale = false;
        try {
          rerenderActive();
        } catch (err) {
          shown = null;
        }
      }
    }
    if (shown !== active || photos.indexOf(active) < 0) {
      // Nothing of the batch is on the canvas: an empty stage, photos and edits kept.
      shown = null;
      active = photos.indexOf(active) >= 0 ? active : photos.indexOf(prefer) >= 0 ? prefer : photos[0];
      if (!keepSelection || !active.selected) for (const p of photos) p.selected = false;
      active.selected = true;
      clearSnaps();
      dropCanvas(view.orig);
      view.orig = null;
      view.crop = { x: 0, y: 0, w: 0, h: 0 };
      main.width = main.height = 2;
      overlay.width = overlay.height = 2;
      overlayDirty = null;
      keyBox = null;
    }
    syncStrip();
    updateUI();
  }

  /** Remove photos from the batch. The caller has already asked, if asking was needed. */
  function removePhotos(list) {
    cancelDrag();
    exitCrop();
    cancelFaces();
    const at = photos.indexOf(active);
    let keptBefore = 0;
    for (let i = 0; i < at; i++) if (list.indexOf(photos[i]) < 0) keptBefore++;
    const lostActive = list.indexOf(active) >= 0;
    // The focused thumbnail (or the strip itself) may be about to go. Keep a keyboard
    // user where they were, not back at the top of the page.
    const hadFocus = els.strip.contains(document.activeElement);
    for (const p of list) forgetPhoto(p);
    if (!photos.length) {
      setEmpty();
    } else if (lostActive) {
      // The photo that slid into the active one's place, or the last one.
      activate(photos[Math.min(keptBefore, photos.length - 1)]);
    } else {
      syncStrip();
      updateUI();
    }
    if (hadFocus) {
      // Decided on what is left, not on document.activeElement alone: a button in a
      // strip that has just been hidden still reports itself as focused for a moment.
      if (!active) els.emptyOpenBtn.focus();
      else if (els.strip.hidden) overlay.focus({ preventScroll: true });
      else if (!els.strip.contains(document.activeElement) && active.el) active.el.focus({ preventScroll: true });
    }
  }

  /** No photo loaded: back to the start screen. */
  function setEmpty() {
    activation++; // anything still decoding belongs to a photo that is gone
    cancelDrag();
    active = null;
    shown = null;
    canvasStale = false;
    review = null;
    facePick = null;
    els.faceLayer.hidden = true;
    els.faceLayer.textContent = '';
    state.loading = false;
    state.cropping = false;
    state.multiMode = false;
    loadingShown = false;
    cropRect = null;
    keyBox = null;
    overlay.style.cursor = '';
    clearSnaps();
    dropCanvas(view.orig);
    view.orig = null;
    view.crop = { x: 0, y: 0, w: 0, h: 0 };
    main.width = main.height = 2;
    overlay.width = overlay.height = 2;
    overlayDirty = null;
    syncBusy();
    syncStrip();
    updateUI();
  }

  async function removeSelected() {
    if (state.busy || !active) return;
    const list = selectedPhotos();
    const unsaved = list.filter(isDirty).length;
    if (unsaved) {
      const message =
        list.length === 1
          ? 'Remove this photo? Its edits have not been saved.'
          : 'Remove ' +
            list.length +
            ' photos? ' +
            (unsaved === 1 ? '1 of them has' : unsaved + ' of them have') +
            ' edits that have not been saved.';
      if (!(await askConfirm(message, 'Remove'))) return;
      if (state.busy) return;
    }
    removePhotos(
      list.filter(function (p) {
        return photos.indexOf(p) >= 0;
      })
    );
  }

  /* ======================================================================
   * Thumbnails
   *
   * Each photo has a clean thumbnail (thumbSrc) and the one on show (thumb), which
   * has the ops applied at thumbnail scale. They are made one at a time from a
   * queue, so a hundred large photos are never decoded at once.
   * ==================================================================== */

  const thumbQueue = [];
  let thumbsRunning = false;
  let idleWaiters = [];

  function thumbSize(w, h) {
    const s = Math.min(1, THUMB_EDGE / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  }

  /** Draw `source` (sw x sh) down to thumbnail size and keep it as the clean thumbnail. */
  function setThumbSource(photo, source, sw, sh) {
    const size = thumbSize(sw, sh);
    const made = makeCanvas(size.w, size.h);
    made.ctx.imageSmoothingEnabled = true;
    made.ctx.imageSmoothingQuality = 'high';
    made.ctx.drawImage(source, 0, 0, size.w, size.h);
    photo.thumbSrc = made.canvas;
  }

  /** Read the file just far enough to make its clean thumbnail. Throws if it is not a readable image. */
  async function loadThumbSource(photo) {
    // The size first. An <img> gets it from the file's header without decoding
    // the pixels, and it already allows for Exif orientation.
    if (!photo.srcW) {
      try {
        const probe = await loadImg(photo.file);
        if (!photo.srcW) {
          photo.srcW = probe.img.naturalWidth;
          photo.srcH = probe.img.naturalHeight;
        }
        probe.release();
      } catch (err) {
        /* the full decode below settles whether the file is an image */
      }
    }
    // Then a decode straight to thumbnail size, where the browser can do that.
    let small = null;
    if (photo.srcW && typeof createImageBitmap === 'function') {
      const size = thumbSize(photo.srcW, photo.srcH);
      try {
        small = await createImageBitmap(photo.file, {
          imageOrientation: 'from-image',
          resizeWidth: size.w,
          resizeHeight: size.h,
          resizeQuality: 'medium',
        });
      } catch (err) {
        small = null;
      }
    }
    if (small) {
      try {
        if (!photo.thumbSrc) setThumbSource(photo, small, small.width, small.height);
      } finally {
        if (small.close) small.close();
      }
      return;
    }
    // Otherwise decode it whole and scale that down.
    const decoded = await decodeImage(photo.file);
    try {
      photo.srcW = decoded.width;
      photo.srcH = decoded.height;
      if (!photo.thumbSrc) setThumbSource(photo, decoded.source, decoded.width, decoded.height);
    } finally {
      decoded.release();
    }
  }

  function queueThumbs(list) {
    for (const p of list) thumbQueue.push(p);
    runThumbs();
  }

  async function runThumbs() {
    if (thumbsRunning) return;
    thumbsRunning = true;
    let unreadable = 0;
    try {
      while (thumbQueue.length) {
        const p = thumbQueue.shift();
        if (photos.indexOf(p) < 0 || p.thumbSrc) continue; // removed, or made when it was shown
        let ok = true;
        try {
          await loadThumbSource(p);
        } catch (err) {
          ok = false;
        }
        if (photos.indexOf(p) < 0) {
          forgetPhoto(p); // removed while it was being read: free what was just made
        } else if (ok) {
          renderThumb(p);
        } else if (p !== active && !wasRead(p)) {
          // Not an image the browser can read. (If it is the active photo, opening
          // it reports the problem and removes it.) A photo that already carries
          // edits keeps its placeholder: it gets its thumbnail when it next opens.
          unreadable++;
          forgetPhoto(p);
          syncStrip();
          updateUI();
        }
        await new Promise(function (resolve) {
          setTimeout(resolve, 0); // let input and painting in between photos
        });
      }
    } finally {
      thumbsRunning = false;
    }
    if (unreadable) {
      toast(unreadable === 1 ? "1 file couldn't be opened as an image." : unreadable + " files couldn't be opened as images.");
    }
    if (thumbQueue.length) runThumbs();
    else settleIdle();
  }

  /** Resolves when no photo is loading and every thumbnail has been made. For tests. */
  function whenIdle() {
    return new Promise(function (resolve) {
      idleWaiters.push(resolve);
      settleIdle();
    });
  }

  function settleIdle() {
    if (state.loading || thumbsRunning || thumbQueue.length) {
      if (idleWaiters.length) setTimeout(settleIdle, 30);
      return;
    }
    const waiting = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiting) resolve();
  }

  /** Draw the photo's thumbnail from scratch: the clean one, then every op. */
  function renderThumb(photo) {
    const src = photo.thumbSrc;
    if (!src) return; // not read yet: it is drawn, with its ops, when it has been
    if (!photo.thumb) {
      photo.thumb = document.createElement('canvas');
      photo.thumb.className = 'thumb-img';
      photo.thumbCtx = photo.thumb.getContext('2d', { willReadFrequently: true });
    }
    const target = { ctx: photo.thumbCtx, canvas: photo.thumb, orig: src, crop: null };
    drawClean(target);
    replay(target, effectiveOps(photo));
    photo.thumbCrop = target.crop;
    mountThumb(photo);
  }

  /** Add one new op to a thumbnail that is already up to date. */
  function thumbAfterOp(photo, op) {
    if (!photo.thumb) return;
    if (op.type === 'crop' || op.type === 'revert') {
      renderThumb(photo);
      return;
    }
    const target = { ctx: photo.thumbCtx, canvas: photo.thumb, orig: photo.thumbSrc, crop: photo.thumbCrop };
    try {
      applyOp(target, op);
    } catch (err) {
      renderThumb(photo);
    }
  }

  /** Put the thumbnail canvas into the photo's filmstrip option, in place of the placeholder. */
  function mountThumb(photo) {
    if (!photo.el || !photo.thumb || photo.thumb.parentNode === photo.el) return;
    const wait = photo.el.querySelector('.thumb-wait');
    if (wait) photo.el.replaceChild(photo.thumb, wait);
    else photo.el.insertBefore(photo.thumb, photo.el.firstChild);
  }

  /* ======================================================================
   * Filmstrip
   *
   * Shown when two or more photos are loaded. Selection works as in a file
   * manager: click for one, Ctrl / Cmd + click to toggle, Shift + click for a
   * range. The active photo is always part of the selection.
   * ==================================================================== */

  function makeThumbEl(photo) {
    const el = document.createElement('div');
    el.className = 'thumb';
    el.setAttribute('role', 'option');
    el.dataset.id = photo.id;
    el.tabIndex = -1;

    const wait = document.createElement('span');
    wait.className = 'thumb-wait';
    el.appendChild(wait);

    const dot = document.createElement('span');
    dot.className = 'thumb-dot';
    dot.hidden = true;
    el.appendChild(dot);

    const tick = document.createElement('span');
    tick.className = 'thumb-tick';
    tick.hidden = true;
    tick.appendChild(els.tplCheck.content.cloneNode(true));
    el.appendChild(tick);

    photo.el = el;
    photo.dotEl = dot;
    photo.tickEl = tick;
    return el;
  }

  /** Bring the filmstrip in line with the batch: which photos, selection, marks, labels. */
  function syncStrip() {
    const show = photos.length >= 2;
    if (!show) state.multiMode = false;
    const n = selectedCount();
    // While the focus is in the strip, the tab stop goes with it (Ctrl + arrows move
    // the focus without changing photo). Otherwise it is the active photo.
    const focusEl = document.activeElement;
    const focused = focusEl && focusEl.parentNode === els.stripList ? focusEl : null;

    for (const p of photos) {
      if (!p.el) {
        els.stripList.appendChild(makeThumbEl(p)); // photos are only ever added at the end
        mountThumb(p);
      }
      const edited = isEdited(p);
      const saved = isSaved(p);
      p.el.setAttribute('aria-selected', String(p.selected));
      p.el.classList.toggle('is-active', p === active);
      p.el.tabIndex = (focused ? p.el === focused : p === active) ? 0 : -1; // roving: one tab stop
      p.dotEl.hidden = !edited;
      p.tickEl.hidden = !saved;
      const label = p.name + (edited ? ', edited' : '') + (saved ? ', saved' : '') + (p.selected ? ', selected' : '');
      if (p.el.getAttribute('aria-label') !== label) p.el.setAttribute('aria-label', label);
      if (p.el.title !== p.name) p.el.title = p.name;
    }

    els.strip.hidden = !show;
    els.strip.classList.toggle('is-multi', n > 1);
    els.stripCount.textContent = n + ' of ' + photos.length + ' selected';
    els.stripSelectAllBtn.setAttribute('aria-pressed', String(show && n === photos.length));
    els.stripSelectBtn.hidden = !IS_TOUCH;
    els.stripSelectBtn.setAttribute('aria-pressed', String(state.multiMode));
    const removeLabel = n > 1 ? 'Remove the ' + n + ' selected photos' : 'Remove this photo';
    els.stripRemoveBtn.setAttribute('aria-label', removeLabel);
    els.stripRemoveBtn.title = removeLabel + ' (Delete)';
  }

  /** Ctrl / Cmd + click, or a tap in Select mode: add the photo to the selection or take it out. */
  function toggleSelected(photo) {
    if (photo !== active) {
      cancelFaces();
      photo.selected = !photo.selected;
      syncStrip();
      updateUI();
      return;
    }
    // The active photo is always selected. To take it out, hand "active" to the
    // nearest other selected photo. If there is none, leave things as they are.
    const at = photos.indexOf(photo);
    let next = null;
    for (let d = 1; d < photos.length && !next; d++) {
      const after = photos[at + d];
      const before = photos[at - d];
      if (after && after.selected) next = after;
      else if (before && before.selected) next = before;
    }
    if (!next) return;
    photo.selected = false;
    activate(next, { keepSelection: true });
  }

  /** Shift + click: everything from the active photo to this one. */
  function selectRange(photo) {
    cancelFaces();
    const a = photos.indexOf(active);
    const b = photos.indexOf(photo);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    photos.forEach(function (p, i) {
      p.selected = i >= lo && i <= hi;
    });
    syncStrip();
    updateUI();
  }

  /** Select every photo. Pressed again with all selected, it goes back to the active one alone. */
  function selectAll(toggle) {
    if (photos.length < 2 || state.busy) return;
    if (toggle && selectedCount() === photos.length) {
      selectOnlyActive();
      return;
    }
    cancelFaces();
    for (const p of photos) p.selected = true;
    syncStrip();
    updateUI();
  }

  /** A plain click: that photo, and only it. */
  function showOnly(photo) {
    // An active photo whose file could not be read is not on the canvas: try it again.
    if (photo === active && !state.loading && shown === active) {
      if (selectedCount() > 1) selectOnlyActive();
      return;
    }
    activate(photo);
  }

  function photoOfEvent(e) {
    const el = e.target && e.target.closest ? e.target.closest('.thumb') : null;
    return el ? photoById(el.dataset.id) : null;
  }

  let longPress = null; // {timer, x, y} while a finger rests on a thumbnail
  let skipClick = false; // the click that ends a long press has already been dealt with

  function endLongPress() {
    if (!longPress) return;
    clearTimeout(longPress.timer);
    longPress = null;
  }

  /**
   * True while the strip must not react: a task is running, or a face step-through
   * is between two photos. (The face bar has just gone and the strip has moved into
   * its place, so the second tap of a double tap on "Apply & next" lands here.)
   */
  function stripLocked() {
    return state.busy || (!!review && !facePick);
  }

  els.stripList.addEventListener('click', function (e) {
    const photo = photoOfEvent(e);
    if (!photo || stripLocked()) return;
    if (skipClick) {
      skipClick = false;
      return;
    }
    if (e.shiftKey) selectRange(photo);
    else if (e.ctrlKey || e.metaKey || state.multiMode) toggleSelected(photo);
    else showOnly(photo);
  });

  // Touch: press and hold a thumbnail to start selecting several.
  els.stripList.addEventListener('pointerdown', function (e) {
    skipClick = false;
    endLongPress();
    if (e.pointerType !== 'touch' || stripLocked()) return;
    const photo = photoOfEvent(e);
    if (!photo) return;
    longPress = {
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(function () {
        longPress = null;
        if (photos.indexOf(photo) < 0 || stripLocked()) return;
        skipClick = true;
        state.multiMode = true;
        if (photo.selected) syncStrip();
        else toggleSelected(photo);
      }, 500),
    };
  });

  els.stripList.addEventListener('pointermove', function (e) {
    // A finger that moves is scrolling the strip, not holding a photo.
    if (longPress && Math.abs(e.clientX - longPress.x) + Math.abs(e.clientY - longPress.y) > 10) endLongPress();
  });
  els.stripList.addEventListener('pointerup', endLongPress);
  els.stripList.addEventListener('pointercancel', endLongPress);
  els.stripList.addEventListener('pointerleave', endLongPress);
  els.stripList.addEventListener('contextmenu', function (e) {
    if (IS_TOUCH) e.preventDefault(); // the long press is ours
  });

  function focusThumb(photo) {
    if (!photo.el) return;
    photo.el.focus();
    syncStrip(); // the tab stop goes with the focus
  }

  // Left and Right change photo, but only from here: on the photo itself the arrow
  // keys move the selection box, and on the slider they change the strength. As in
  // a file manager, Shift + arrows select a run, Ctrl / Cmd + arrows move the focus
  // alone, and Ctrl / Cmd + Space then adds the focused photo or takes it out.
  els.stripList.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || stripLocked() || e.altKey) return;
    const mod = e.ctrlKey || e.metaKey;
    const here = photoOfEvent(e) || active; // the photo that has the focus
    if (!here) return;
    const at = photos.indexOf(here);
    let to = -1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = at - 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = at + 1;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = photos.length - 1;
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) {
      e.preventDefault();
      removeSelected();
      return;
    } else if (e.key === ' ' || (e.key === 'Enter' && !mod)) {
      e.preventDefault();
      if (mod) toggleSelected(here); // Ctrl / Cmd + Space: add the focused photo, or take it out
      else if (e.shiftKey) selectRange(here); // a run from the active photo to here
      else showOnly(here); // this photo alone
      return;
    } else {
      return; // Ctrl+A, Ctrl+Z, Ctrl+S and the rest go on to the document's handler
    }
    e.preventDefault();
    const photo = photos[clamp(to, 0, photos.length - 1)];
    if (!photo) return;
    if (e.shiftKey) selectRange(photo); // extend or shrink the run: the active photo stays its anchor
    else if (!mod) showOnly(photo); // plain arrows: that photo alone
    // Ctrl / Cmd + arrow: only the focus moves
    focusThumb(photo);
  });
  // Focus has left the strip: the tab stop goes back to the active photo.
  els.stripList.addEventListener('focusout', function (e) {
    if (els.stripList.contains(e.relatedTarget)) return;
    for (const p of photos) if (p.el) p.el.tabIndex = p === active ? 0 : -1;
  });

  els.stripSelectAllBtn.addEventListener('click', function () {
    selectAll(true);
  });
  els.stripSelectBtn.addEventListener('click', function () {
    if (state.busy) return;
    state.multiMode = !state.multiMode;
    syncStrip();
  });
  // A mouse wheel turns up and down. Let it move the strip sideways.
  els.stripList.addEventListener(
    'wheel',
    function (e) {
      const list = els.stripList;
      if (e.deltaX || !e.deltaY || e.ctrlKey || list.scrollWidth <= list.clientWidth) return;
      e.preventDefault();
      list.scrollLeft += e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
    },
    { passive: false }
  );

  els.stripAddBtn.addEventListener('click', openPicker);
  els.stripRemoveBtn.addEventListener('click', removeSelected);

  /* ======================================================================
   * Opening files: picker, drop, paste
   * ==================================================================== */

  function openPicker() {
    if (state.busy) return;
    els.fileInput.click();
  }

  function itemsOf(fileList) {
    const items = [];
    for (let i = 0; fileList && i < fileList.length; i++) {
      items.push({ blob: fileList[i], name: fileList[i].name });
    }
    return items;
  }

  els.fileInput.addEventListener('change', function () {
    const items = itemsOf(els.fileInput.files);
    els.fileInput.value = ''; // so picking the same files again still fires 'change'
    addFiles(items);
  });

  // Drag and drop, anywhere on the page.
  let dragDepth = 0;

  function hasFiles(e) {
    const dt = e.dataTransfer;
    if (!dt || !dt.types) return false;
    for (let i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
    return false;
  }

  function endFileDrag() {
    dragDepth = 0;
    els.dropVeil.hidden = true;
  }

  document.addEventListener('dragenter', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    // No "drop it here" highlight for a drop that would be refused.
    if (!state.busy) els.dropVeil.hidden = false;
  });

  document.addEventListener('dragover', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault(); // without this the browser would navigate to the file
    e.dataTransfer.dropEffect = 'copy';
  });

  document.addEventListener('dragleave', function (e) {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    const outside =
      e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;
    if (dragDepth === 0 || outside) endFileDrag();
  });

  document.addEventListener('drop', function (e) {
    endFileDrag();
    if (!hasFiles(e)) return;
    e.preventDefault();
    addFiles(itemsOf(e.dataTransfer.files));
  });

  window.addEventListener('blur', endFileDrag);

  // Paste: every image on the clipboard.
  document.addEventListener('paste', function (e) {
    const cd = e.clipboardData;
    if (!cd) return;
    const files = [];
    for (let i = 0; cd.files && i < cd.files.length; i++) {
      if (/^image\//i.test(cd.files[i].type)) files.push(cd.files[i]);
    }
    for (let i = 0; !files.length && cd.items && i < cd.items.length; i++) {
      const it = cd.items[i];
      const file = it.kind === 'file' && /^image\//i.test(it.type) ? it.getAsFile() : null;
      if (file) files.push(file);
    }
    if (!files.length) return;
    e.preventDefault();
    addFiles(
      files.map(function (file) {
        // Browsers name a pasted bitmap "image.png", which says nothing useful. A
        // bitmap like that is usually a screenshot. A copied file keeps its own name.
        const named = file.name && !/^image\.[a-z]+$/i.test(file.name);
        return { blob: file, name: named ? file.name : 'pasted-image', pasted: !named };
      })
    );
  });

  /* ======================================================================
   * Faces
   *
   * Faces finds the faces and then lets the user choose which to hide. Each face
   * gets a toggle button over the photo, and nothing changes until Apply. Every
   * face starts out marked "hide", the safe way round. With several photos
   * selected it becomes a step-through, one photo at a time, because each photo
   * has different people in it.
   * ==================================================================== */

  let faceStub = null; // tests: a stand-in detector, (canvas) => rects
  let facePick = null; // { faces: [{x, y, w, h, hide, el}] } while the picker is open
  // { list, index, outcome: Map(id -> 'applied' | 'skipped' | 'none'), applied: Map(id -> op id),
  //   taken: Map(id -> {photo, op}) for the ops Back took off }
  let review = null;

  function hasDetector() {
    const api = window.PixelVeilFaces;
    return !!faceStub || !!(api && typeof api.detect === 'function');
  }

  /** The effect a face gets, taken from the selected tool at the moment it is applied. */
  function faceEffectName() {
    return state.tool === 'blur' || state.tool === 'black' ? state.tool : 'pixelate';
  }

  /**
   * The faces on a canvas, as integer rects already grown by 8 % a side. Throws
   * when detection fails. A TimeoutError means the detector is still loading.
   */
  async function findFaces(canvas) {
    const found = faceStub ? await faceStub(canvas) : await window.PixelVeilFaces.detect(canvas);
    const W = canvas.width;
    const H = canvas.height;
    const rects = [];
    if (Array.isArray(found)) {
      for (const f of found) {
        if (!f || !isFinite(f.x) || !isFinite(f.y) || !(f.w > 0) || !(f.h > 0)) continue;
        const r = padFace(f, W, H);
        if (r.w >= 3 && r.h >= 3) rects.push(r);
      }
    }
    return rects;
  }

  function detectError(err) {
    // A timeout means the detector's files are still on their way (a slow first
    // visit). The load carries on, so pressing Faces again picks it up.
    toast(err && err.name === 'TimeoutError' ? MSG_FACES_LOADING : MSG_FACES_UNAVAILABLE);
  }

  /**
   * Find the faces on the active photo, behind the busy overlay. Resolves to the
   * rects, or to null after telling the user that detection did not work.
   */
  async function detectOnActive() {
    const api = window.PixelVeilFaces;
    const firstTime = !faceStub && !!api && !api.ready;
    showBusy(firstTime ? 'Loading face detector…' : 'Finding faces…');
    // detect() loads the detector and then runs it, with no hook in between, so
    // watch its ready flag to change the label.
    const watch = firstTime
      ? setInterval(function () {
          if (api.ready) setBusyText('Finding faces…');
        }, 150)
      : 0;
    try {
      await paint();
      return await findFaces(main);
    } catch (err) {
      detectError(err);
      return null;
    } finally {
      if (watch) clearInterval(watch);
      hideBusy();
    }
  }

  /** The Faces button. */
  async function startFaces() {
    if (blocked() || facePick || review) return;
    cancelDrag();
    exitCrop();
    if (!hasDetector()) {
      toast(MSG_FACES_UNAVAILABLE);
      return;
    }
    const list = selectedPhotos();
    if (list.length > 1) {
      review = { list: list, index: 0, outcome: new Map(), applied: new Map(), taken: new Map() };
      reviewStep();
      return;
    }
    const rects = await detectOnActive();
    if (!rects) return;
    if (!rects.length) toast(MSG_NO_FACES);
    else openFacePick(rects);
  }

  /* ---- the picker ------------------------------------------------------ */

  function openFacePick(rects) {
    const W = main.width;
    const H = main.height;
    facePick = {
      faces: rects.map(function (r) {
        return { x: r.x, y: r.y, w: r.w, h: r.h, hide: true, el: null };
      }),
    };
    els.faceLayer.textContent = '';
    for (const face of facePick.faces) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'face';
      // Percentages of the photo, so the buttons follow it through every resize.
      b.style.left = ((face.x + face.w / 2) / W) * 100 + '%';
      b.style.top = ((face.y + face.h / 2) / H) * 100 + '%';
      b.style.width = (face.w / W) * 100 + '%';
      b.style.height = (face.h / H) * 100 + '%';
      const badge = document.createElement('span');
      badge.className = 'face-badge';
      badge.appendChild(els.tplEyeOff.content.cloneNode(true));
      b.appendChild(badge);
      b.addEventListener('click', function (e) {
        // A small face keeps a 32 px touch target, so on a crowded photo the targets
        // of neighbours overlap. A tap or click (detail > 0) goes to the face whose
        // centre is nearest. A key press goes to the focused face.
        const hit = (e.detail > 0 && nearestFace(e.clientX, e.clientY)) || face;
        hit.hide = !hit.hide;
        syncFacePick();
        if (hit !== face) hit.el.focus({ preventScroll: true });
      });
      face.el = b;
      els.faceLayer.appendChild(b);
    }
    els.faceLayer.hidden = false;
    keyBox = null;
    updateUI();
    syncFacePick();
    drawOverlay();
    // From here Tab walks the faces, and Enter (on the layer, not on a button) applies.
    els.faceLayer.focus({ preventScroll: true });
  }

  /**
   * The face under a point on screen. Where the boxes or the touch targets of
   * several faces overlap, it is the one whose centre is nearest. Null if none.
   */
  function nearestFace(x, y) {
    let best = null;
    let bestD = Infinity;
    for (const face of facePick.faces) {
      const r = face.el.getBoundingClientRect();
      const dx = Math.abs(x - (r.left + r.width / 2));
      const dy = Math.abs(y - (r.top + r.height / 2));
      // styles.css gives every face a target of at least FACE_TARGET px each way.
      if (dx > Math.max(r.width, FACE_TARGET) / 2 || dy > Math.max(r.height, FACE_TARGET) / 2) continue;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = face;
      }
    }
    return best;
  }

  /** Bring the face buttons and the bar in line with the choices. */
  function syncFacePick() {
    const faces = facePick.faces;
    const n = faces.length;
    let hiding = 0;
    faces.forEach(function (face, i) {
      if (face.hide) hiding++;
      face.el.setAttribute('aria-pressed', String(face.hide));
      face.el.setAttribute(
        'aria-label',
        'Face ' + (i + 1) + ' of ' + n + (face.hide ? ', will be hidden' : ', stays visible')
      );
    });
    els.faceCount.textContent = hiding + ' of ' + count(n, 'face') + ' will be hidden';
    let meta = 'Hide with: ' + TOOL_NAMES[faceEffectName()];
    if (review) meta += ' · Photo ' + (review.index + 1) + ' of ' + review.list.length;
    els.faceMeta.textContent = meta;

    const stepping = !!review;
    els.faceBackBtn.hidden = !stepping;
    els.faceSkipBtn.hidden = !stepping;
    els.faceBulkBtn.hidden = !stepping;
    let apply = 'Apply';
    if (stepping) {
      els.faceBackBtn.disabled = reviewBackIndex() < 0;
      els.faceBulkBtn.textContent = 'Hide all faces in all ' + review.list.length;
      apply = review.index === review.list.length - 1 ? 'Apply & finish' : 'Apply & next';
    }
    els.faceApplyBtn.textContent = apply;
  }

  function closeFacePick() {
    if (!facePick) return;
    facePick = null;
    // The focused face or bar button is about to go. Put focus on the photo, so a
    // keyboard user carries on from there and not from the top of the page.
    const focused = document.activeElement;
    const hadFocus = !!focused && (els.faceLayer.contains(focused) || els.faceBar.contains(focused));
    els.faceLayer.hidden = true;
    els.faceLayer.textContent = '';
    updateUI();
    if (hadFocus) overlay.focus({ preventScroll: true });
  }

  /** Leave the picker without applying, and stop a step-through. Safe to call at any time. */
  function cancelFaces() {
    closeFacePick();
    if (review) endReview();
  }

  function setAllFaces(hide) {
    if (!facePick) return;
    for (const face of facePick.faces) face.hide = hide;
    syncFacePick();
  }

  /** Apply: hide the chosen faces as one op, which is one undo step. */
  function applyFacePick() {
    if (!facePick || blocked()) return;
    const W = main.width;
    const H = main.height;
    const all = facePick.faces;
    const chosen = all.filter(function (face) {
      return face.hide;
    });
    const stepping = review;
    if (!chosen.length) {
      // Nothing to hide here. In a step-through that is a Skip, otherwise a Cancel.
      if (stepping) skipFacePick();
      else cancelFaces();
      return;
    }
    // Each photo in a step-through gets its own choice, so the op belongs to no
    // group: undoing it on one photo leaves the others as they are.
    const op = {
      id: newId(),
      group: null,
      type: 'faces',
      effect: faceEffectName(),
      rects: chosen.map(function (face) {
        return normRect(face, W, H);
      }),
    };
    const snap = captureRects(chosen);
    closeFacePick();
    if (!commitOp(op, snap, false)) {
      toast(MSG_TOO_LARGE);
      if (review) endReview();
      return;
    }
    if (stepping) {
      stepping.taken.delete(active.id); // a new choice replaces what Back took off
      stepping.outcome.set(active.id, 'applied');
      stepping.applied.set(active.id, op.id);
      stepping.index++;
      reviewStep();
    } else {
      const kept = all.length - chosen.length;
      toast(count(chosen.length, 'face') + ' hidden' + (kept ? ', ' + kept + ' left visible' : ''));
    }
  }

  /* ---- step-through for several photos ----------------------------------- */

  /**
   * Open the picker on the photo the review has reached. Photos with no faces
   * are noted and passed over. Past the last photo, the review ends.
   */
  async function reviewStep() {
    const rv = review;
    while (review === rv && rv.index < rv.list.length) {
      const photo = rv.list[rv.index];
      if (photos.indexOf(photo) < 0) {
        rv.index++;
        continue;
      }
      if (photo !== active || !isShown(photo)) {
        const opened = await activate(photo, { keepSelection: true, review: true });
        if (review !== rv) return;
        if (!opened) {
          endReview();
          return;
        }
      }
      const rects = await detectOnActive();
      if (review !== rv) return;
      if (!rects) {
        endReview(); // detection is not working: no point going on
        return;
      }
      if (rects.length) {
        openFacePick(rects);
        return;
      }
      rv.outcome.set(photo.id, 'none');
      toast('No faces found in ' + photo.name, 2400);
      rv.index++;
    }
    if (review === rv) endReview();
  }

  /**
   * Back took the hiding off a photo so that its faces could be chosen again. A
   * photo the review leaves before a new choice was made there gets it back.
   */
  function putBackTaken(rv) {
    if (!rv.taken.size) return;
    rv.taken.forEach(function (t) {
      const photo = t.photo;
      if (photos.indexOf(photo) < 0) return;
      if (photo === active && isShown(photo)) {
        if (!commitOp(t.op, null, false)) {
          toast(MSG_TOO_LARGE);
          return;
        }
      } else {
        // Not on screen, or still opening: it is drawn from its ops when it is shown.
        photo.ops.push(t.op);
        renderThumb(photo);
        if (photo === shown) canvasStale = true; // the canvas holds it without the op
      }
      rv.outcome.set(photo.id, 'applied');
    });
    rv.taken.clear();
    syncStrip();
  }

  /** Stop the review and say what it did. */
  function endReview() {
    const rv = review;
    review = null;
    if (!rv) return;
    putBackTaken(rv);
    let applied = 0;
    let skipped = 0;
    let none = 0;
    rv.outcome.forEach(function (what) {
      if (what === 'applied') applied++;
      else if (what === 'skipped') skipped++;
      else none++;
    });
    if (applied + skipped + none === 0) return;
    let text = applied ? 'Faces hidden in ' + count(applied, 'photo') : 'No faces hidden';
    if (skipped) text += ', ' + skipped + ' skipped';
    if (none) text += ', ' + none + ' had none';
    toast(text, 5000);
    updateUI();
  }

  function skipFacePick() {
    const rv = review;
    if (!rv || !facePick || blocked()) return;
    rv.taken.delete(active.id); // Skip after Back is a choice too: the photo stays as it is now
    rv.outcome.set(active.id, 'skipped');
    closeFacePick();
    rv.index++;
    reviewStep();
  }

  /** The step Back would return to: the nearest earlier photo that had faces. -1 if none. */
  function reviewBackIndex() {
    for (let i = review.index - 1; i >= 0; i--) {
      if (review.outcome.get(review.list[i].id) !== 'none' && photos.indexOf(review.list[i]) >= 0) return i;
    }
    return -1;
  }

  function backFacePick() {
    const rv = review;
    if (!rv || !facePick || blocked()) return;
    const to = reviewBackIndex();
    if (to < 0) return;
    closeFacePick();
    const photo = rv.list[to];
    // Take back what this review did to that photo, so its faces can be found and
    // chosen again. The photo is not on screen now: it is redrawn when it is shown.
    // The op is kept: if the review stops before a new choice, it goes back on.
    const opId = rv.applied.get(photo.id);
    const last = photo.ops[photo.ops.length - 1];
    if (opId && last && last.id === opId) {
      rv.taken.set(photo.id, { photo: photo, op: photo.ops.pop() });
      renderThumb(photo);
      syncStrip();
    }
    rv.applied.delete(photo.id);
    rv.outcome.delete(photo.id);
    rv.index = to;
    reviewStep();
  }

  /* ---- every face in every selected photo, without review ---------------- */

  async function hideAllFaces(list) {
    if (blocked()) return;
    closeFacePick();
    // The review ends here without endReview(). A photo that Back took the hiding
    // off keeps it, whatever this run then finds there.
    if (review) putBackTaken(review);
    review = null;
    const job = { cancelled: false };
    const group = newId();
    const n = list.length;
    let onActive = false; // the run put an op on the active photo
    let elsewhere = false; // ...or on another one
    let faces = 0;
    let withFaces = 0;
    let none = 0;
    let failed = 0;
    showBusy('Finding faces 1 / ' + n, function () {
      job.cancelled = true;
    });
    try {
      for (let i = 0; i < n && !job.cancelled; i++) {
        const photo = list[i];
        if (photos.indexOf(photo) < 0) continue;
        setBusyText('Finding faces ' + (i + 1) + ' / ' + n);
        await paint();
        let rects;
        let W;
        let H;
        let shot = null;
        try {
          // The photo on screen is used as it is. The others are decoded at working
          // size with their edits drawn in, one at a time.
          const canvas = photo === active ? main : (shot = await renderPhoto(photo, false)).canvas;
          W = canvas.width;
          H = canvas.height;
          rects = await findFaces(canvas);
        } catch (err) {
          if (!shot && photo !== active) {
            failed++; // this photo could not be read: go on to the next
            continue;
          }
          detectError(err); // the detector itself is not working: stop
          return;
        } finally {
          if (shot) shot.release();
        }
        if (!rects.length) {
          none++;
          continue;
        }
        const op = {
          id: newId(),
          group: group,
          type: 'faces',
          effect: faceEffectName(),
          rects: rects.map(function (r) {
            return normRect(r, W, H);
          }),
        };
        if (photo === active) {
          if (!commitOp(op, captureRects(rects), false)) {
            failed++;
            continue;
          }
          onActive = true;
        } else {
          photo.ops.push(op);
          thumbAfterOp(photo, op);
          elsewhere = true;
        }
        faces += rects.length;
        withFaces++;
      }
    } finally {
      // Undo works from the active photo's last op. If this run changed other photos
      // and not the active one, leave an empty op of the group there for Undo to find.
      if (elsewhere && !onActive && active && photos.indexOf(active) >= 0) {
        active.ops.push({ id: newId(), group: group, type: 'faces', effect: faceEffectName(), rects: [] });
      }
      hideBusy();
      afterEdit();
    }
    let text = faces
      ? count(faces, 'face') + ' hidden in ' + count(withFaces, 'photo')
      : MSG_NO_FACES;
    if (faces && none) text += '. ' + count(none, 'photo') + ' had none';
    if (job.cancelled) text += '. Stopped early';
    toast(text, 5000);
    if (failed) toast(count(failed, 'photo') + " couldn't be checked for faces.", 5000);
  }

  els.facesBtn.addEventListener('click', startFaces);
  els.faceApplyBtn.addEventListener('click', applyFacePick);
  els.faceCancelBtn.addEventListener('click', cancelFaces);
  els.faceSkipBtn.addEventListener('click', skipFacePick);
  els.faceBackBtn.addEventListener('click', backFacePick);
  els.faceAllBtn.addEventListener('click', function () {
    setAllFaces(true);
  });
  els.faceNoneBtn.addEventListener('click', function () {
    setAllFaces(false);
  });
  els.faceBulkBtn.addEventListener('click', function () {
    if (review) hideAllFaces(review.list);
  });

  /* ======================================================================
   * Saving
   *
   * Every saved file is drawn fresh from the source file at its own pixel size,
   * with the photo's ops replayed at that size. Drawing through a canvas means the
   * new file carries pixels only: no Exif, no GPS, nothing else from the original.
   * ==================================================================== */

  /** The single-photo format: the user's pick, else PNG for PNG sources and JPEG for the rest. */
  function currentFormat() {
    return state.saveFormat || exportFormatFor('same', active ? active.type : '');
  }

  function exportName(photo, format) {
    return photo.base + '_anonymized.' + (format === 'jpeg' ? 'jpg' : 'png');
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise(function (resolve) {
      try {
        canvas.toBlob(resolve, mime, quality);
      } catch (err) {
        resolve(null);
      }
    });
  }

  /**
   * Encode one photo for saving. `format` is 'jpeg' or 'png'. Resolves to
   * {blob, reduced}. One photo, a batch and the test hook all come through here.
   */
  async function renderExport(photo, format) {
    const shot = await renderPhoto(photo, true);
    try {
      const jpeg = format === 'jpeg';
      if (jpeg) {
        // JPEG has no transparency. Put white behind the photo so clear areas do
        // not turn black.
        shot.ctx.globalCompositeOperation = 'destination-over';
        shot.ctx.fillStyle = '#fff';
        shot.ctx.fillRect(0, 0, shot.canvas.width, shot.canvas.height);
        shot.ctx.globalCompositeOperation = 'source-over';
      }
      const blob = await canvasToBlob(shot.canvas, jpeg ? 'image/jpeg' : 'image/png', jpeg ? 0.92 : undefined);
      if (!blob) throw new Error('encoding failed');
      return { blob: blob, reduced: shot.reduced };
    } finally {
      shot.release();
    }
  }

  function download(blob, name, keepMs) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.hidden = true;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, keepMs || 2000);
  }

  /** Whether this browser's share sheet takes these files. */
  function canShare(files) {
    try {
      return typeof navigator.canShare === 'function' && typeof navigator.share === 'function' && navigator.canShare({ files: files });
    } catch (err) {
      return false;
    }
  }

  /**
   * Things that must be settled before any save. A crop frame that is drawn but not
   * applied looks as if the dimmed part is already gone, and faces marked in the
   * picker look hidden. Saving then would write a photo that shows them.
   */
  function readyToSave() {
    if (facePick) {
      toast('Faces not hidden yet. Press Apply or Cancel, then save.');
      els.faceApplyBtn.focus();
      return false;
    }
    if (state.cropping) {
      if (cropRect) {
        toast('Crop not applied yet. Press Apply to crop, or Cancel, then save.');
        els.cropApplyBtn.focus();
        return false;
      }
      exitCrop(); // crop mode with no frame: nothing pending, just leave it
    }
    return true;
  }

  /** Save one photo: a download, or the share sheet on an iPhone or iPad. */
  async function saveOne(photo, format) {
    if (blocked()) return;
    cancelDrag();
    if (!readyToSave()) return;
    const name = exportName(photo, format);
    const sig = signature(photo);

    showBusy('Saving…');
    try {
      await paint();
      let out;
      try {
        out = await renderExport(photo, format);
      } catch (err) {
        toast("The photo couldn't be saved. It may be too large for this device.");
        return;
      }
      const saved = function () {
        markSaved(photo, sig);
        if (out.reduced) toast('The photo was reduced because it is too large for this device.', 5000);
      };

      // On iPhone and iPad the share sheet is the way into the photo library.
      // Everywhere else a download is the only way to get a local file.
      if (IS_IOS && typeof File === 'function') {
        let file = null;
        try {
          file = new File([out.blob], name, { type: out.blob.type });
        } catch (err) {
          file = null;
        }
        if (file && canShare([file])) {
          hideBusy();
          try {
            await navigator.share({ files: [file] });
            saved();
            return;
          } catch (err) {
            if (err && err.name === 'AbortError') return; // the user closed the sheet
            // anything else: fall through to a plain download
          }
        }
      }

      download(out.blob, name);
      saved();
      toast('Saved ' + name);
    } catch (err) {
      toast("The photo couldn't be saved.");
    } finally {
      hideBusy();
      syncStrip();
    }
  }

  /* ---- several photos ---------------------------------------------------- */

  // A "sink" is where exported files go: {label, write(name, blob), finish()}, with
  // write and finish async. One makes a ZIP download, one keeps files for the share sheet.

  /**
   * One ZIP download, or several when the photos would pass the size limit. If
   * zip.js is missing the files are downloaded one by one instead.
   */
  function zipSink() {
    const api = window.PixelVeilZip;
    const stamp = stampOf(new Date());
    if (!api || typeof api.create !== 'function') {
      return {
        label: 'as separate downloads',
        write: async function (name, blob) {
          download(blob, name);
          await new Promise(function (resolve) {
            setTimeout(resolve, 150); // browsers drop downloads that arrive in a burst
          });
        },
        finish: async function () {},
      };
    }
    let zip = null;
    let bytes = 0;
    let part = 0;
    const flush = async function () {
      if (!zip) return;
      const blob = await zip.finish();
      zip = null;
      part++;
      download(blob, 'pixel-veil-' + stamp + (part > 1 ? '-' + part : '') + '.zip', 60000);
    };
    const sink = {
      label: 'as pixel-veil-' + stamp + '.zip',
      write: async function (name, blob) {
        if (zip && bytes + blob.size > ZIP_LIMIT) await flush();
        if (!zip) {
          zip = api.create();
          bytes = 0;
        }
        try {
          await zip.add(name, blob);
        } catch (err) {
          // The archive says it is full after all: close it and start the next one.
          const full = err && (err.code === 'ZIP_ARCHIVE_FULL' || err.code === 'ZIP_TOO_MANY_ENTRIES');
          if (!full || !bytes) throw err;
          await flush();
          zip = api.create();
          bytes = 0;
          await zip.add(name, blob);
        }
        bytes += blob.size + 2 * name.length + 128; // the file plus its two headers, roughly
      },
      finish: async function () {
        await flush();
        if (part > 1) sink.label = 'as ' + part + ' ZIP files';
      },
    };
    return sink;
  }

  /** Files kept in memory for the result dialog, which shares them or zips them. */
  function shareSink() {
    const files = [];
    return {
      files: files,
      label: '',
      write: async function (name, blob) {
        files.push(new File([blob], name, { type: blob.type }));
      },
      finish: async function () {},
    };
  }

  /**
   * Save several photos as one ZIP download. An iPhone or iPad gets the share sheet
   * instead, because that is the way into its photo library.
   */
  function saveMany(list, choice) {
    if (blocked() || !list.length) return;
    cancelDrag();
    if (!readyToSave()) return;
    const probe = typeof File === 'function' ? [new File([''], 'a.jpg', { type: 'image/jpeg' })] : null;
    exportBatch(list, choice, IS_IOS && probe && canShare(probe) ? 'share' : 'zip');
  }

  async function exportBatch(list, choice, kind) {
    const job = { cancelled: false };
    const taken = new Set(); // names used in this batch, lower-cased
    const done = []; // {photo, sig} for each file written
    let reduced = 0;
    let failed = 0;
    let sink = null;

    try {
      sink = kind === 'share' ? shareSink() : zipSink();

      const n = list.length;
      showBusy('Exporting 1 / ' + n, function () {
        job.cancelled = true;
      });
      for (let i = 0; i < n && !job.cancelled; i++) {
        const photo = list[i];
        if (photos.indexOf(photo) < 0) continue;
        const format = exportFormatFor(choice, photo.type);
        const name = uniqueName(exportName(photo, format), taken);
        setBusyText('Exporting ' + (i + 1) + ' / ' + n + ' — ' + name);
        await paint(); // lets the overlay update, and Cancel be pressed
        const sig = signature(photo);
        try {
          const out = await renderExport(photo, format);
          await sink.write(name, out.blob);
          done.push({ photo: photo, sig: sig });
          if (out.reduced) reduced++;
        } catch (err) {
          failed++;
        }
      }

      // A cancelled export is dropped: nothing has been downloaded yet.
      const kept = job.cancelled ? [] : done;
      if (!job.cancelled) {
        showBusy('Finishing…'); // past the point where Cancel means anything
        await sink.finish();
      }
      if (kind === 'share' && kept.length) {
        openResult(sink.files, kept); // sharing needs a fresh tap, so it waits in a dialog
      } else {
        for (const d of kept) markSaved(d.photo, d.sig);
        if (job.cancelled) {
          toast(kept.length ? 'Export stopped. ' + count(kept.length, 'photo') + ' saved ' + sink.label + '.' : 'Export cancelled.', 5000);
        } else if (kept.length) {
          toast('Saved ' + count(kept.length, 'photo') + ' ' + sink.label, 5000);
        }
      }
      if (reduced) {
        toast(
          reduced === 1
            ? '1 photo was reduced because it is too large for this device'
            : reduced + ' photos were reduced because they are too large for this device',
          6000
        );
      }
      if (failed) toast(count(failed, 'photo') + " couldn't be saved.", 6000);
    } catch (err) {
      toast("The photos couldn't be saved.");
    } finally {
      hideBusy();
      syncStrip();
    }
  }

  /* ---- result dialog (iPhone and iPad): share, or download a ZIP ---------- */

  let pending = null; // {files, done} while the dialog is open
  let sharing = false; // true from the Share tap until share() settles

  function openResult(files, done) {
    pending = { files: files, done: done };
    els.resultTitle.textContent = count(files.length, 'photo') + ' ready';
    els.resultShareBtn.hidden = !canShare(files);
    if (typeof els.result.showModal === 'function') els.result.showModal();
    else els.result.setAttribute('open', '');
  }

  function closeResult() {
    pending = null; // lets the files go
    if (!els.result.open) return;
    if (typeof els.result.close === 'function') els.result.close();
    else els.result.removeAttribute('open');
  }

  function resultSaved(p, text) {
    for (const d of p.done) markSaved(d.photo, d.sig);
    closeResult();
    syncStrip();
    toast(text, 5000);
  }

  async function zipPending() {
    const p = pending;
    if (!p || state.busy) return;
    showBusy('Making the ZIP…');
    try {
      const sink = zipSink();
      for (const file of p.files) await sink.write(file.name, file);
      await sink.finish();
      resultSaved(p, 'Saved ' + count(p.files.length, 'photo') + ' ' + sink.label);
    } catch (err) {
      toast("The ZIP couldn't be made.");
    } finally {
      hideBusy();
    }
  }

  els.resultShareBtn.addEventListener('click', async function () {
    const p = pending;
    if (!p || state.busy || sharing) return; // a second tap while the sheet is coming up does nothing
    sharing = true;
    let failure = null;
    try {
      await navigator.share({ files: p.files });
    } catch (err) {
      failure = err || new Error('share failed');
    } finally {
      sharing = false;
    }
    if (!failure) {
      resultSaved(p, 'Shared ' + count(p.files.length, 'photo'));
      return;
    }
    // AbortError: the sheet was closed, and the dialog stays for another go.
    // InvalidStateError: a share is already in progress, so this one did not fail.
    if (failure.name === 'AbortError' || failure.name === 'InvalidStateError') return;
    if (pending === p) zipPending(); // sharing really failed: the ZIP still works
  });
  els.resultZipBtn.addEventListener('click', zipPending);
  els.resultCloseBtn.addEventListener('click', closeResult);
  els.result.addEventListener('close', function () {
    pending = null;
  });

  /* ---- Save menu ---------------------------------------------------------- */

  function menuOpen() {
    return !els.saveMenu.hidden;
  }

  function visibleMenuItems() {
    return formatItems.concat(scopeItems).filter(function (item) {
      return !item.hidden && !(item.parentNode.hidden && item.parentNode !== els.saveMenu);
    });
  }

  /** What Ctrl / Cmd + S saves when several photos are open. */
  function defaultScope() {
    return selectedCount() > 1 ? 'selected' : 'this';
  }

  /**
   * One photo open: two formats, and picking one saves. Several open: the format
   * is a setting (with "Same as each original"), and the buttons under it say
   * what to save.
   */
  function openMenu() {
    const batch = photos.length > 1;
    const format = batch ? state.batchFormat : currentFormat();
    let focus = formatItems[0];
    for (const item of formatItems) {
      const on = item.dataset.format === format;
      item.hidden = item.dataset.format === 'same' && !batch;
      item.setAttribute('aria-checked', String(on));
      if (on) focus = item;
    }
    els.saveMenu.classList.toggle('is-batch', batch);
    els.saveScopes.hidden = !batch;
    if (batch) {
      const n = selectedCount();
      const preferred = defaultScope();
      for (const item of scopeItems) {
        const scope = item.dataset.scope;
        if (scope === 'selected') {
          item.hidden = n < 2;
          item.textContent = 'Save ' + n + ' selected';
        } else if (scope === 'all') {
          item.textContent = 'Save all ' + photos.length;
        }
        item.classList.toggle('btn-primary', scope === preferred);
        item.classList.toggle('btn-quiet', scope !== preferred);
        if (scope === preferred) focus = item;
      }
    }
    els.saveMenu.hidden = false;
    els.saveBtn.setAttribute('aria-expanded', 'true');
    focus.focus();
  }

  function closeMenu(returnFocus) {
    if (!menuOpen()) return;
    els.saveMenu.hidden = true;
    els.saveBtn.setAttribute('aria-expanded', 'false');
    if (returnFocus) els.saveBtn.focus();
  }

  /** Save by scope: 'this' photo, the 'selected' ones or 'all'. Call from the user's gesture. */
  function saveScope(scope) {
    if (blocked()) return;
    if (scope === 'this') saveOne(active, exportFormatFor(state.batchFormat, active.type));
    else saveMany(scope === 'all' ? photos.slice() : selectedPhotos(), state.batchFormat);
  }

  /** Ctrl / Cmd + S. */
  function saveShortcut() {
    if (blocked()) return;
    if (photos.length > 1) saveScope(defaultScope());
    else saveOne(active, currentFormat());
  }

  els.saveBtn.addEventListener('click', function () {
    if (menuOpen()) closeMenu(true);
    else if (!state.busy && active) openMenu();
  });

  for (const item of formatItems) {
    item.addEventListener('click', function () {
      const format = item.dataset.format;
      if (photos.length > 1) {
        // Several photos: this only sets the format. The buttons below do the saving.
        state.batchFormat = format;
        writeSettings();
        for (const other of formatItems) other.setAttribute('aria-checked', String(other === item));
        return;
      }
      state.saveFormat = format;
      writeSettings();
      closeMenu(true);
      saveOne(active, format);
    });
  }

  for (const item of scopeItems) {
    item.addEventListener('click', function () {
      closeMenu(true);
      saveScope(item.dataset.scope);
    });
  }

  // Focus leaving the Save button and its menu, in either direction, closes the menu.
  // A null relatedTarget (the window losing focus, a click on something that takes
  // no focus) is left to the pointerdown handler further down.
  const menuAnchor = els.saveBtn.parentNode;
  menuAnchor.addEventListener('focusout', function (e) {
    const to = e.relatedTarget;
    if (to && !menuAnchor.contains(to)) closeMenu(false);
  });

  /* ======================================================================
   * Tools and buttons
   * ==================================================================== */

  function selectTool(tool) {
    if (state.busy || !active) return;
    if (facePick) {
      // The picker stays open: the tool only decides how the chosen faces are hidden.
      state.tool = tool;
      writeSettings();
      updateUI();
      syncFacePick();
      return;
    }
    cancelDrag();
    exitCrop();
    state.tool = tool;
    writeSettings();
    updateUI();
  }

  for (const b of toolButtons) {
    b.addEventListener('click', function () {
      selectTool(b.dataset.tool);
    });
  }

  els.strength.addEventListener('input', function () {
    const v = parseInt(els.strength.value, 10);
    state.level = clamp(isFinite(v) ? v : 10, 2, 25);
    els.strengthValue.textContent = String(state.level);
    writeSettingsSoon();
  });

  function toggleCrop() {
    if (state.cropping) exitCrop();
    else enterCrop();
  }

  els.undoBtn.addEventListener('click', undo);
  els.openBtn.addEventListener('click', openPicker);
  els.emptyOpenBtn.addEventListener('click', openPicker);
  els.revertBtn.addEventListener('click', revert);
  els.cropApplyBtn.addEventListener('click', applyCrop);
  els.cropCancelBtn.addEventListener('click', exitCrop);
  els.cropBtn.addEventListener('click', toggleCrop);

  // Help dialog.

  function openHelp() {
    if (els.help.open) return;
    closeMenu(false);
    if (typeof els.help.showModal === 'function') els.help.showModal();
    else els.help.setAttribute('open', '');
    els.helpBody.scrollTop = 0;
  }

  function closeHelp() {
    if (typeof els.help.close === 'function') els.help.close();
    else els.help.removeAttribute('open');
  }

  els.helpBtn.addEventListener('click', openHelp);
  els.helpCloseBtn.addEventListener('click', closeHelp);
  els.resetChoicesBtn.addEventListener('click', resetChoices);
  els.help.addEventListener('click', function (e) {
    if (e.target === els.help) closeHelp(); // a click on the backdrop
  });

  // A press outside the Save menu closes it.
  document.addEventListener(
    'pointerdown',
    function (e) {
      if (menuOpen() && !els.saveMenu.contains(e.target) && !els.saveBtn.contains(e.target)) closeMenu(false);
    },
    true
  );

  /* ======================================================================
   * Keyboard
   * ==================================================================== */

  function isTextField(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag !== 'INPUT') return false;
    return !/^(range|checkbox|radio|button|submit|reset|file|color)$/i.test(el.type || '');
  }

  function onButton(e) {
    const tag = e.target && e.target.tagName;
    return tag === 'BUTTON' || tag === 'A';
  }

  const TOOL_KEYS = { 1: 'auto', 2: 'pixelate', 3: 'blur', 4: 'black' };
  const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || e.isComposing) return;
    const raw = e.key || '';
    const key = raw.length === 1 ? raw.toLowerCase() : raw;
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    // Ctrl+S and Ctrl+O belong to this app. Never let them fall through to the
    // browser's own "save page" and "open file", even while they are ignored here.
    if (mod && (key === 's' || key === 'o')) e.preventDefault();

    if (els.help.open || els.confirm.open || els.result.open) return; // a dialog handles its own keys

    if (menuOpen()) {
      if (e.key === 'Tab') return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu(true);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const items = visibleMenuItems();
        const at = items.indexOf(document.activeElement);
        const step = e.key === 'ArrowDown' ? 1 : -1;
        items[(at + step + items.length) % items.length].focus();
      }
      return;
    }

    if (state.busy) {
      // A long task with a Cancel button: Escape presses it.
      if (key === 'Escape' && busyCancel && !els.busyCancelBtn.disabled) {
        e.preventDefault();
        els.busyCancelBtn.click();
      }
      return;
    }
    if (isTextField(e.target)) return;

    if (e.ctrlKey || e.metaKey) {
      if (!mod) return;
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (key === 's') {
        if (!e.repeat) saveShortcut();
      } else if (key === 'o') {
        if (!e.repeat) openPicker();
      } else if (key === 'a' && (facePick || review)) {
        // Choosing faces: "all" means every face here, never every photo.
        e.preventDefault();
        setAllFaces(true);
      } else if (key === 'a' && photos.length > 1) {
        e.preventDefault();
        selectAll(false);
      }
      return;
    }
    if (e.altKey) return;

    if (key === '?' && !e.repeat) {
      openHelp();
      return;
    }
    if (!active) return; // no photo: nothing to edit

    if (facePick) {
      // Choosing faces. The tool keys still work, because the tool decides how the
      // chosen faces are hidden.
      if (key === 'Escape') {
        cancelFaces();
      } else if (key === 'Enter') {
        // On a focused button (a face, or one in the bar) Enter presses that button.
        if (!onButton(e)) {
          e.preventDefault();
          if (!e.repeat) applyFacePick();
        }
      } else if (e.repeat) {
        /* nothing below repeats */
      } else if (key === 'a') {
        setAllFaces(true);
      } else if (key === 'n') {
        setAllFaces(false);
      } else if (TOOL_KEYS[key]) {
        selectTool(TOOL_KEYS[key]);
      } else if (key === 'c') {
        enterCrop(); // which closes the picker
      }
      return;
    }

    // With the photo focused, the arrow keys place and move a box (Shift resizes it).
    // This sits before the repeat check so that a held key keeps moving the box.
    if (e.target === overlay && ARROWS[key]) {
      e.preventDefault();
      if (!drag && !blocked()) nudgeKeyBox(ARROWS[key][0], ARROWS[key][1], e.shiftKey);
      return;
    }

    if (key === 'Escape') {
      if (drag) cancelDrag();
      else if (keyBox) clearKeyBox();
      else if (state.cropping) exitCrop();
      return;
    }
    if (key === 'Enter') {
      // The keyboard box: hide what is inside it. The box stays, ready for the next area.
      if (!state.cropping && keyBox && e.target === overlay) {
        e.preventDefault();
        if (!e.repeat && !drag) finishSelection(keyBox);
        return;
      }
      // On a focused button Enter already means "press it".
      if (state.cropping && !onButton(e)) {
        e.preventDefault();
        applyCrop();
      }
      return;
    }
    if (e.repeat) return;

    if (TOOL_KEYS[key]) selectTool(TOOL_KEYS[key]);
    else if (key === 'f') startFaces();
    else if (key === 'c') toggleCrop();
  });

  /* ======================================================================
   * Window events
   * ==================================================================== */

  window.addEventListener('resize', requestFit);
  window.addEventListener('orientationchange', requestFit);
  if (typeof ResizeObserver === 'function') {
    // Also catches the stage changing height when the slider, a bar or the
    // filmstrip appears.
    new ResizeObserver(requestFit).observe(els.stageFit);
  }

  window.addEventListener('beforeunload', function (e) {
    if (!photos.some(isDirty)) return;
    e.preventDefault();
    e.returnValue = '';
  });

  window.addEventListener('pagehide', function () {
    if (settingsTimer) writeSettings(); // a strength change that was still waiting
  });

  /* ======================================================================
   * Start
   * ==================================================================== */

  els.versionText.textContent = 'Pixel Veil ' + VERSION + '.';
  showLevel();
  syncStrip();
  updateUI();

  function describePhoto(p) {
    return {
      id: p.id,
      name: p.name,
      selected: p.selected,
      active: p === active,
      ops: p.ops.length,
      dirty: isDirty(p),
      srcW: p.srcW,
      srcH: p.srcH,
      edited: isEdited(p),
      saved: isSaved(p),
      thumbReady: !!p.thumb,
    };
  }

  window.PixelVeil = {
    version: VERSION,
    // For automated tests.
    _test: {
      /** Add photos as the picker would: [{blob, name}]. Resolves when the first is shown and all thumbnails exist. */
      loadBlobs: async function (list) {
        const shown = await addFiles(
          (list || []).map(function (it) {
            return { blob: it.blob, name: it.name || 'test-image' };
          })
        );
        await whenIdle();
        return shown;
      },
      loadBlob: function (blob, name) {
        return window.PixelVeil._test.loadBlobs([{ blob: blob, name: name }]);
      },
      photos: function () {
        return photos.map(describePhoto);
      },
      /** Select exactly these photos. The active photo stays active if it is among them, else the first one becomes active. */
      select: async function (ids) {
        const list = (ids || []).map(photoById).filter(Boolean);
        if (!list.length) return false;
        cancelFaces();
        for (const p of photos) p.selected = list.indexOf(p) >= 0;
        if (list.indexOf(active) < 0) {
          const shown = await activate(list[0], { keepSelection: true });
          await whenIdle();
          return shown;
        }
        syncStrip();
        updateUI();
        return true;
      },
      /** Show a photo. It keeps the selection if the photo is part of it, else it becomes the only selected one. */
      activate: async function (id) {
        const p = photoById(id);
        if (!p) return false;
        const shown = p === active && isShown(p) ? true : await activate(p, { keepSelection: p.selected });
        await whenIdle();
        return shown;
      },
      /** The file an export would write for this photo, as a Blob. format: 'jpeg', 'png' or 'same'. */
      renderExport: async function (id, format) {
        const p = photoById(id);
        if (!p) throw new Error('no such photo');
        return (await renderExport(p, exportFormatFor(format || 'same', p.type))).blob;
      },
      idle: whenIdle,
      /** Replace the face detector: fn(canvas) returns [{x, y, w, h}] (or a promise of it). Pass null to restore. */
      setFaceStub: function (fn) {
        faceStub = typeof fn === 'function' ? fn : null;
      },
      facePick: function () {
        if (!facePick) return null;
        return {
          faces: facePick.faces.map(function (f) {
            return { x: f.x, y: f.y, w: f.w, h: f.h, hide: f.hide };
          }),
          photoIndex: review ? review.index : 0,
          photoCount: review ? review.list.length : 1,
        };
      },
      state: function () {
        const has = !!active && !!view.orig;
        return {
          width: has ? main.width : 0,
          height: has ? main.height : 0,
          tool: state.tool,
          level: state.level,
          undoDepth: active ? undoDepth(active.ops) : 0,
          cropping: state.cropping,
          crop: { x: view.crop.x, y: view.crop.y, w: view.crop.w, h: view.crop.h },
          empty: !active,
          busy: state.busy,
          loading: state.loading,
          photoCount: photos.length,
          selectedCount: selectedCount(),
          facePicking: !!facePick,
          reviewing: !!review,
          saveFormat: state.saveFormat,
          batchFormat: state.batchFormat,
        };
      },
    },
  };

  // Offline support. The single-file build needs none: it is already complete.
  function setOfflineStatus(text) {
    els.offlineStatus.textContent = text;
  }

  if (window.PV_SINGLE_FILE) {
    setOfflineStatus('This file works offline as is.');
  } else if (location.protocol === 'file:') {
    setOfflineStatus('Opened from disk. Use the single-file version for full offline use.');
  } else if (!('serviceWorker' in navigator)) {
    setOfflineStatus('Offline use needs a secure (HTTPS) address in this browser.');
  } else {
    setOfflineStatus('Getting ready for offline use…');
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.PV_SINGLE_FILE) {
    navigator.serviceWorker
      .register('sw.js')
      .then(function (reg) {
        const failed = function () {
          setOfflineStatus("Offline use couldn't be set up. Reload to try again.");
        };
        const worker = reg.installing;
        if (!worker) {
          // No worker in any state: a first install has already failed.
          if (!reg.waiting && !reg.active) failed();
          return;
        }
        worker.addEventListener('statechange', function () {
          // A first install that fails ends as 'redundant' with no active worker.
          // A failed update leaves the old worker active, and that needs no message.
          if (worker.state === 'redundant' && !reg.active) failed();
        });
      })
      .catch(function () {
        setOfflineStatus("Offline use couldn't be set up in this browser.");
      });
    navigator.serviceWorker.ready
      .then(function () {
        setOfflineStatus('Offline ready. Pixel Veil now works without a connection.');
      })
      .catch(function () {
        /* stay with the message above */
      });
  }
})();
