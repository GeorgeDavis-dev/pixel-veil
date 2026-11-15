#!/usr/bin/env node
// Pixel Veil build script.
//
//   node tools/build.mjs
//
// No dependencies, and it can be run from any folder. It does two jobs:
//
//   1. Stamps sw.js with a cache version made from a hash of every precached file,
//      so a changed file gives the service worker a new cache and people get the update.
//   2. Writes dist/pixel-veil.html, a single file with the styles, the scripts (zip.js,
//      face.js and app.js, in that order) and the face detector inside it. That file
//      works when opened straight from disk.
//
// Everything is read and checked before anything is written. If index.html or sw.js
// does not look the way this script expects, it stops with an error and changes nothing.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

// The project root is the parent of the folder this file is in, wherever it is run from.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'dist');
const OUT_FILE = join(OUT_DIR, 'pixel-veil.html');

// ---------------------------------------------------------------------------
// The index.html contract. These tags must each appear exactly once, verbatim.
// ---------------------------------------------------------------------------

const TAG_CSP =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'">`;
const TAG_MANIFEST = '<link rel="manifest" href="manifest.webmanifest">';
const TAG_ICON = '<link rel="icon" href="icons/icon.svg" type="image/svg+xml">';
const TAG_APPLE_ICON = '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">';
const TAG_STYLES = '<link rel="stylesheet" href="styles.css">';
const TAG_ZIP_JS = '<script src="zip.js" defer></script>';
const TAG_FACE_JS = '<script src="face.js" defer></script>';
const TAG_APP_JS = '<script src="app.js" defer></script>';
const TAG_BODY_END = '</body>';

// The single file has no server, so nothing can be 'self'. Scripts and styles are
// inline, and the face detector is loaded from blob: URLs made inside the page.
const SINGLE_FILE_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline'; img-src blob: data:; connect-src blob: data:; base-uri 'none'; form-action 'none'";

// The face detector files, embedded as base64 in inert <script> tags that face.js reads.
const EMBEDS = [
  { id: 'pv-embed-bundle', path: 'vendor/mediapipe/vision_bundle.js' },
  { id: 'pv-embed-loader', path: 'vendor/mediapipe/wasm/vision_wasm_internal.js' },
  { id: 'pv-embed-wasm', path: 'vendor/mediapipe/wasm/vision_wasm_internal.wasm' },
  { id: 'pv-embed-model', path: 'vendor/mediapipe/face_detection_full_range.tflite' },
];

const LICENCE_PATH = 'vendor/mediapipe/LICENSE';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const warnings = [];

function fail(message) {
  console.error(`\nbuild failed: ${message}\n`);
  process.exit(1);
}

function readBytes(relPath) {
  try {
    return readFileSync(join(ROOT, relPath));
  } catch (error) {
    fail(`cannot read ${relPath} (${error.code || error.message}). Looked in ${ROOT}`);
  }
}

function readText(relPath) {
  // Drop a UTF-8 byte order mark, which would otherwise end up in the middle of the page.
  return readBytes(relPath).toString('utf8').replace(/^﻿/, '');
}

function countOccurrences(haystack, needle) {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * The span to cut when a tag is removed or replaced. When the tag is alone on its line
 * and `wholeLine` is set, the span covers the indentation and the line break as well,
 * so no blank line is left behind.
 */
function tagSpan(html, tag, wholeLine) {
  let start = html.indexOf(tag);
  let end = start + tag.length;
  if (!wholeLine) return { start, end };

  let lineStart = start;
  while (lineStart > 0 && (html[lineStart - 1] === ' ' || html[lineStart - 1] === '\t')) lineStart--;
  let lineEnd = end;
  while (lineEnd < html.length && (html[lineEnd] === ' ' || html[lineEnd] === '\t')) lineEnd++;
  const startsLine = lineStart === 0 || html[lineStart - 1] === '\n';
  const endsLine = lineEnd === html.length || html[lineEnd] === '\n' || html.startsWith('\r\n', lineEnd);
  if (startsLine && endsLine) {
    start = lineStart;
    end = lineEnd;
    if (html.startsWith('\r\n', end)) end += 2;
    else if (html[end] === '\n') end += 1;
  }
  return { start, end };
}

/**
 * Make JavaScript safe to sit inside an inline <script> element. The HTML parser would
 * end the element at "</script" and changes mode at "<!--", so both get a backslash.
 * Inside a string, a template or a regular expression the backslash changes nothing.
 */
function escapeInlineScript(code) {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

/** The same idea for CSS inside <style>. "\/" is a valid CSS escape for "/". */
function escapeInlineStyle(css) {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

/** Compile (never run) a classic script, so a syntax error stops the build here. */
function checkSyntax(code, name) {
  try {
    new Script(code, { filename: name });
  } catch (error) {
    fail(`${name} does not parse as a classic script after inlining: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Read and check everything
// ---------------------------------------------------------------------------

// --- sw.js: the precache list and the version line ---

const swSource = readText('sw.js');

const listMatch = /const PRECACHE = \[([\s\S]*?)\];/.exec(swSource);
if (!listMatch) fail('sw.js has no "const PRECACHE = [ … ];" list.');
const precache = [...listMatch[1].matchAll(/'([^'\r\n]*)'|"([^"\r\n]*)"/g)].map((m) => m[1] ?? m[2]);
if (precache.length === 0) fail('the PRECACHE list in sw.js is empty.');

const precacheFiles = precache.filter((entry) => entry !== './');
for (const required of ['index.html', 'styles.css', 'app.js', 'face.js', 'zip.js', ...EMBEDS.map((e) => e.path)]) {
  if (!precacheFiles.includes(required)) fail(`the PRECACHE list in sw.js is missing ${required}.`);
}
const missing = precacheFiles.filter((entry) => !existsSync(join(ROOT, entry)));
if (missing.length > 0) {
  fail(`these precached files do not exist in ${ROOT}:\n  ${missing.join('\n  ')}`);
}

const VERSION_LINE = /^[ \t]*const CACHE_VERSION = (['"])[^'"\r\n]*\1;?[ \t]*$/gm;
const versionLines = [...swSource.matchAll(VERSION_LINE)];
if (versionLines.length !== 1) {
  fail(`sw.js must have exactly one "const CACHE_VERSION = '…';" line, found ${versionLines.length}.`);
}

// Hash every precached file, in list order. The path and size go in too, so moving
// bytes from one file to another still changes the hash. sw.js itself is left out,
// otherwise writing the hash into it would change the hash.
const hash = createHash('sha256');
let precacheBytes = 0;
const fileCache = new Map();
for (const entry of precacheFiles) {
  const bytes = readBytes(entry);
  fileCache.set(entry, bytes);
  precacheBytes += bytes.length;
  hash.update(`${entry}\0${bytes.length}\0`);
  hash.update(bytes);
}
const cacheVersion = hash.digest('hex').slice(0, 12);
const swStamped = swSource.replace(VERSION_LINE, () => `const CACHE_VERSION = '${cacheVersion}';`);

// --- index.html: every contract tag exactly once ---

const html = readText('index.html');

const problems = [];
for (const tag of [TAG_CSP, TAG_MANIFEST, TAG_ICON, TAG_APPLE_ICON, TAG_STYLES, TAG_ZIP_JS, TAG_FACE_JS, TAG_APP_JS, TAG_BODY_END]) {
  const count = countOccurrences(html, tag);
  if (count === 0) problems.push(`not found:        ${tag}`);
  else if (count > 1) problems.push(`found ${count} times:    ${tag}`);
}
if (problems.length > 0) {
  fail(
    'index.html does not match the contract in the build spec.\n' +
      'Each of these tags must appear exactly once, character for character:\n  ' +
      problems.join('\n  ')
  );
}
if (!(html.indexOf(TAG_ZIP_JS) < html.indexOf(TAG_FACE_JS) && html.indexOf(TAG_FACE_JS) < html.indexOf(TAG_APP_JS))) {
  fail('index.html must load zip.js, then face.js, then app.js, in that order.');
}

// Anything else that loads a file would be missing from the single file. Warn about it.
{
  let rest = html;
  for (const tag of [TAG_MANIFEST, TAG_ICON, TAG_APPLE_ICON, TAG_STYLES, TAG_ZIP_JS, TAG_FACE_JS, TAG_APP_JS]) rest = rest.replace(tag, () => '');
  for (const m of rest.matchAll(/<(link|script|img|source|iframe|video|audio|object|embed)\b[^>]*?\b(?:src|href|data)\s*=\s*["']([^"']*)["']/gi)) {
    if (!/^(data:|blob:|#)/i.test(m[2])) warnings.push(`index.html: <${m[1].toLowerCase()}> loads "${m[2]}", which the single file cannot reach.`);
  }
  if (/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i.test(rest)) warnings.push('index.html has an inline <script>. The PWA content security policy blocks it.');
}

// --- the pieces to inline ---

const css = readText('styles.css');
if (/@import\b/i.test(css)) warnings.push('styles.css uses @import, which the single file cannot follow.');
for (const m of css.matchAll(/url\(\s*["']?([^"')\s]+)/gi)) {
  if (!/^(data:|#)/i.test(m[1])) warnings.push(`styles.css refers to "${m[1]}", which the single file cannot reach.`);
}

const zipJs = escapeInlineScript(readText('zip.js'));
const faceJs = escapeInlineScript(readText('face.js'));
const appJs = escapeInlineScript(readText('app.js'));
checkSyntax(zipJs, 'zip.js');
checkSyntax(faceJs, 'face.js');
checkSyntax(appJs, 'app.js');

const iconDataUrl = `data:image/svg+xml;base64,${readBytes('icons/icon.svg').toString('base64')}`;

const embedTags = EMBEDS.map(({ id, path }) => {
  const bytes = fileCache.get(path) ?? readBytes(path);
  if (bytes.length === 0) fail(`${path} is empty.`);
  // One unbroken base64 string with no spaces or line breaks, exactly as face.js expects.
  return `<script type="application/octet-stream" id="${id}">${bytes.toString('base64')}</script>`;
});

// The embedded detector is Apache-2.0, which asks for a copy of the licence to travel
// with it. The single file is often passed around alone, so the licence goes inside.
let licenceComment = '';
if (existsSync(join(ROOT, LICENCE_PATH))) {
  const licence = readText(LICENCE_PATH).replace(/--+>/g, '-- >').trim();
  licenceComment =
    '<!--\n' +
    'Face detection in this file is Google MediaPipe Tasks Vision with the BlazeFace\n' +
    'full-range model. Both are embedded below under the Apache License, Version 2.0:\n\n' +
    licence +
    '\n-->\n';
} else {
  warnings.push(`${LICENCE_PATH} is missing, so the single file carries no copy of the Apache licence.`);
}

// ---------------------------------------------------------------------------
// Assemble the single file
// ---------------------------------------------------------------------------

const bodyBlock =
  '<!-- Pixel Veil, single file. Generated by tools/build.mjs: edit the sources and run it again. -->\n' +
  licenceComment +
  embedTags.join('\n') +
  '\n<script>window.PV_SINGLE_FILE = true;</script>\n' +
  `<script>\n${zipJs}\n</script>\n` +
  `<script>\n${faceJs}\n</script>\n` +
  `<script>\n${appJs}\n</script>\n`;

// Every edit is a span of the original text. They are applied from the end of the file
// backwards, so an earlier span never moves, and inlined code is never searched for tags.
const edits = [
  { ...tagSpan(html, TAG_CSP, false), text: `<meta http-equiv="Content-Security-Policy" content="${SINGLE_FILE_CSP}">` },
  { ...tagSpan(html, TAG_MANIFEST, true), text: '' },
  { ...tagSpan(html, TAG_ICON, false), text: `<link rel="icon" href="${iconDataUrl}" type="image/svg+xml">` },
  { ...tagSpan(html, TAG_APPLE_ICON, true), text: '' },
  { ...tagSpan(html, TAG_STYLES, false), text: `<style>\n${escapeInlineStyle(css)}\n</style>` },
  // Inline scripts cannot be deferred, so they leave <head> and run at the end of
  // <body>, once the page's elements exist.
  { ...tagSpan(html, TAG_ZIP_JS, true), text: '' },
  { ...tagSpan(html, TAG_FACE_JS, true), text: '' },
  { ...tagSpan(html, TAG_APP_JS, true), text: '' },
  { start: html.indexOf(TAG_BODY_END), end: html.indexOf(TAG_BODY_END), text: bodyBlock },
].sort((a, b) => b.start - a.start);

for (let i = 1; i < edits.length; i++) {
  if (edits[i].end > edits[i - 1].start) fail('internal error: two edits to index.html overlap.');
}

let singleFile = html;
let skeleton = html; // the same page with nothing inlined, used for the check below
for (const edit of edits) {
  singleFile = singleFile.slice(0, edit.start) + edit.text + singleFile.slice(edit.end);
  skeleton = skeleton.slice(0, edit.start) + skeleton.slice(edit.end);
}

// Last look before writing: the page must not point at any file beside it. Only the
// skeleton is checked, because inlined code may mention these names in plain text.
for (const leftover of ['href="manifest.webmanifest"', 'href="styles.css"', 'src="zip.js"', 'src="face.js"', 'src="app.js"', 'href="icons/']) {
  if (skeleton.includes(leftover)) fail(`internal error: the single file still refers to ${leftover}.`);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

if (swStamped !== swSource) writeFileSync(join(ROOT, 'sw.js'), swStamped);
mkdirSync(OUT_DIR, { recursive: true });
const singleFileBytes = Buffer.from(singleFile, 'utf8');
writeFileSync(OUT_FILE, singleFileBytes);

console.log(`Project        ${ROOT}`);
console.log(`Cache version  ${cacheVersion}${swStamped !== swSource ? '  (sw.js updated)' : '  (sw.js already up to date)'}`);
console.log(`PWA precache   ${formatSize(precacheBytes)} in ${precacheFiles.length} files`);
for (const { path } of EMBEDS) {
  console.log(`  ${path.padEnd(52)} ${formatSize(fileCache.get(path).length).padStart(10)}`);
}
console.log(`Single file    ${formatSize(singleFileBytes.length)}  ${OUT_FILE}`);
for (const warning of warnings) console.warn(`warning: ${warning}`);
