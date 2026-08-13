#!/usr/bin/env node
// Optional local web server.
//
// Pleex is designed to run straight from file:// with no server at all. This is
// here for two cases: browsers configured to restrict local file access, and
// watching from another device on the same network.
//
//   node tools/serve.mjs [--port 8080] [--host 0.0.0.0]

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { networkInterfaces } from 'node:os';

const args = process.argv.slice(2);
const getArg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : dflt;
};

const PORT = +getArg('port', 8080);
const HOST = getArg('host', '127.0.0.1');
const ROOT = path.resolve(getArg('dir', '.'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.vtt': 'text/vtt; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/') rel = '/Watch.html';

    const file = path.join(ROOT, rel);
    // Refuse anything that escapes the served directory.
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const info = await stat(file);
    if (info.isDirectory()) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;

    // Range support is what makes seeking in a large video work.
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : info.size - 1;
      if (start >= info.size || end >= info.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${info.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Cache-Control': 'no-cache',
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': info.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\nPleex serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}`);
  if (HOST === '0.0.0.0') {
    for (const list of Object.values(networkInterfaces())) {
      for (const n of list || []) {
        if (n.family === 'IPv4' && !n.internal) console.log(`  http://${n.address}:${PORT}`);
      }
    }
  }
  console.log('\nCtrl-C to stop.\n');
});
