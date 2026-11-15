#!/usr/bin/env node
// Pixel Veil: a tiny static server for trying the app on this computer.
//
//   node tools/serve.mjs [port]      default port 8080, or set PORT
//
// No dependencies. It serves the project folder (the parent of tools/) on 127.0.0.1
// only, so nothing is exposed to the network. Browsers treat 127.0.0.1 as secure,
// which means the service worker and Install both work here without HTTPS.

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const DEFAULT_PORT = 8080;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function readPort() {
  const given = process.argv[2] ?? process.env.PORT;
  if (given === undefined || given === '') return DEFAULT_PORT;
  const port = Number(given);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`serve: "${given}" is not a port number (1 to 65535).`);
    process.exit(1);
  }
  return port;
}

function sendText(res, status, message, extraHeaders = {}) {
  const body = Buffer.from(message + '\n', 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

/**
 * Turn the request path into a file path inside ROOT, or null when the request tries
 * to leave the folder.
 *
 * The path is percent-decoded first, so "%2e%2e%2f" is caught as well as "../".
 * Backslashes, colons and NUL bytes are refused outright: on Windows they can mean a
 * second path separator, a drive letter or an alternate data stream. Then the path is
 * resolved and must still sit inside ROOT.
 */
function toFilePath(rawUrl) {
  let pathname = rawUrl.split(/[?#]/, 1)[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!pathname.startsWith('/') || /[\\:\0]/.test(pathname)) return null;
  if (pathname.split('/').includes('..')) return null;

  const filePath = resolve(ROOT, '.' + pathname);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) return null;
  return filePath;
}

async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return;
  }

  const rawPath = req.url.split(/[?#]/, 1)[0];
  let filePath = toFilePath(req.url);
  if (filePath === null) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  let info;
  try {
    info = await stat(filePath);
    if (info.isDirectory()) {
      // A folder without its trailing slash would break relative links, so redirect.
      if (!rawPath.endsWith('/')) {
        const query = req.url.slice(rawPath.length);
        sendText(res, 301, 'Moved', { Location: rawPath + '/' + query });
        return;
      }
      filePath = join(filePath, 'index.html');
      info = await stat(filePath);
    }
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    sendText(res, 404, 'Not found');
    return;
  }

  const type = MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

const port = readPort();
const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(`serve: ${req.method} ${req.url} failed: ${error.message}`);
    if (res.headersSent) res.destroy();
    else sendText(res, 500, 'Server error');
  });
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`serve: port ${port} is already in use. Try another port, e.g. node tools/serve.mjs ${port + 1}`);
  } else {
    console.error(`serve: ${error.message}`);
  }
  process.exit(1);
});

server.listen(port, HOST, () => {
  console.log(`Pixel Veil is at http://${HOST}:${port}/`);
  console.log(`Serving ${ROOT}`);
  console.log('Press Ctrl+C to stop.');
});
