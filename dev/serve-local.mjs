// 本地联调服务器：静态托管 dist/，并用 dev/fake-supabase.mjs 在内存里跑同一份
// functions/handler.mjs，这样两个浏览器标签页就能真打一场对决，不必先部署。
// 用法：node scripts/prepare-web-dist.mjs && node dev/serve-local.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeSupabase } from './fake-supabase.mjs';
import { handleArena } from '../functions/handler.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.argv[2] || 8787);
const store = createFakeSupabase({
    users: [], sessions: [], login_attempts: [], scores: [], friendships: [], matches: [],
});

const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/functions/v1/')) {
        const response = await handleArena({
            request: new Request(url.href, {
                method: req.method,
                headers: req.headers,
                body: ['GET', 'HEAD'].includes(req.method) ? undefined : req,
                duplex: 'half',
            }),
            supabase: store,
        });
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
        return;
    }
    const relative = normalize(url.pathname === '/' ? 'index.html' : url.pathname.slice(1)).replace(/^(\.\.[/\\])+/, '');
    try {
        const body = await readFile(join(root, relative));
        res.writeHead(200, { 'content-type': TYPES[extname(relative)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(body);
    } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
    }
});

server.listen(port, () => console.log(`本地对决联调：http://127.0.0.1:${port}/ （内存数据库，重启即清空）`));
