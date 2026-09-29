import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

// Qoder Sites reserves /api, so the published build points the client at the
// platform function entry instead; other hosts override via BAIHUA_API_ENTRY.
const API_ENTRY = process.env.BAIHUA_API_ENTRY || '/functions/v1/app';
const SCRIPT_TAG = '<script src="social.js" defer></script>';

const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
if (!page.includes(SCRIPT_TAG)) throw new Error('index.html 的 social.js 脚本标签已变化，请同步本脚本');
if (page.includes('data-api')) throw new Error('index.html 不应自带 data-api，注入由本脚本负责');

await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/index.html', import.meta.url),
    page.replace(SCRIPT_TAG, `<script src="social.js" data-api="${API_ENTRY}" defer></script>`), 'utf8');
await copyFile(new URL('../social.js', import.meta.url), new URL('../dist/social.js', import.meta.url));
console.log(`dist/index.html + dist/social.js 已生成，接口指向 ${API_ENTRY}`);
