#!/usr/bin/env bun
// Minimal static file server for local development, powered by Bun.serve.
// Usage: bun scripts/serve-bun.mjs [rootDir] [port]

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveStaticPath } from './static-path.ts';

const rootDir = path.resolve(process.argv[2] || 'source');
const port = Number(process.argv[3] || process.env.PORT || 3000);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.vmd': 'text/plain; charset=utf-8',
};

const server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(req) {
        const url = new URL(req.url);
        let pathname = decodeURIComponent(url.pathname);
        if (pathname.endsWith('/')) pathname += 'index.html';

        const filePath = resolveStaticPath(rootDir, pathname);
        if (!filePath) {
            return new Response('Forbidden', { status: 403 });
        }

        const file = Bun.file(filePath);
        if (!(await file.exists())) {
            return new Response('Not found', { status: 404 });
        }

        return new Response(file, {
            headers: {
                'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
                'Cache-Control': 'no-cache',
            },
        });
    },
});

console.log(`Serving ${rootDir} at ${server.url}`);
