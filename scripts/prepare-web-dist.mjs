import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';

// Qoder Sites reserves /api, so the published build points the client at the
// platform function entry instead; other hosts override via BAIHUA_API_ENTRY.
const API_ENTRY = process.env.BAIHUA_API_ENTRY || '/functions/v1/app';
const SCRIPT_TAG = '<script src="social.js" defer></script>';
const SCRIPTS = '<script src="pvp-sim.js" defer></script>\n    <script src="pvp.js" defer></script>\n    ';

const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
if (!page.includes(SCRIPT_TAG)) throw new Error('index.html 的 social.js 脚本标签已变化，请同步本脚本');
if (page.includes('data-api')) throw new Error('index.html 不应自带 data-api，注入由本脚本负责');
if (page.includes('pvp-sim.js') || page.includes('"pvp.js"')) {
    throw new Error('index.html 不应自带对决脚本标签，注入由本脚本负责');
}

// 后端与浏览器共用 functions/pvp-sim.mjs；浏览器版就是去掉文件尾部 export 行的同一份代码。
const sim = await readFile(new URL('../functions/pvp-sim.mjs', import.meta.url), 'utf8');
const cut = sim.search(/^export /m);
if (cut < 0) throw new Error('functions/pvp-sim.mjs 末尾应有 export 行');
const browserSim = `${sim.slice(0, cut).trimEnd()}\n`;
if (/^(import|export)[\s{*]/m.test(browserSim)) throw new Error('pvp-sim 浏览器版仍含模块语法');
if (!browserSim.includes('globalThis.PvpSim')) throw new Error('pvp-sim 浏览器版缺少 globalThis.PvpSim 挂载');

await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/index.html', import.meta.url),
    page.replace(SCRIPT_TAG, `${SCRIPTS}<script src="social.js" data-api="${API_ENTRY}" defer></script>`), 'utf8');
await writeFile(new URL('../dist/pvp-sim.js', import.meta.url), browserSim, 'utf8');
await copyFile(new URL('../pvp.js', import.meta.url), new URL('../dist/pvp.js', import.meta.url));
await copyFile(new URL('../social.js', import.meta.url), new URL('../dist/social.js', import.meta.url));
console.log(`dist/index.html + pvp-sim.js + pvp.js + social.js 已生成，接口指向 ${API_ENTRY}`);
