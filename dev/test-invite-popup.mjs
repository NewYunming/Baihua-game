// 邀请弹窗联调：把 dist/social.js 装进最小假 DOM，网络仍打到本地服务器（dev/serve-local.mjs）。
// 覆盖：收到邀请弹窗 → 接受进入对决 / 拒绝作废邀请 → 同一邀请不重复弹。
// 用法：node scripts/prepare-web-dist.mjs && node dev/serve-local.mjs & node dev/test-invite-popup.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const BASE = 'http://127.0.0.1:8787';
const API = `${BASE}/functions/v1/app`;
const source = await readFile(new URL('../dist/social.js', import.meta.url), 'utf8');

class El {
    constructor(tagName = 'div', id = '') {
        this.tagName = tagName; this.id = id; this.children = []; this.handlers = {};
        this.hidden = false; this.disabled = false; this.textContent = ''; this.value = '';
        this.className = ''; this.dataset = {}; this.type = ''; this.autocomplete = '';
    }
    get childElementCount() { return this.children.length; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
    removeEventListener() {}
    setAttribute(name, value) { this[name] = value; }
    focus() { this.focused = (this.focused || 0) + 1; }
    click() { for (const fn of this.handlers.click || []) fn({ preventDefault() {}, target: this }); }
}

function createSocial(token, hooks = {}) {
    const elements = new Map();
    const byId = id => {
        if (!elements.has(id)) elements.set(id, new El('div', id));
        return elements.get(id);
    };
    const store = new Map(token ? [['baihuaSessionToken', token]] : []);
    const windowHandlers = {};
    const sandbox = {
        console, performance, structuredClone, URLSearchParams, AbortController,
        Math, Date, JSON, Number, String, Boolean, Array, Object, Set, Map, Error, Promise,
        setInterval: (fn, ms) => setInterval(fn, ms).unref(),
        setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
        clearTimeout,
        fetch: (url, options) => fetch(url, options),
        localStorage: {
            getItem: key => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => store.set(key, String(value)),
            removeItem: key => store.delete(key),
        },
        document: {
            hidden: false,
            getElementById: byId,
            createElement: tag => new El(tag),
            // social.js 只按选择器取单个标签页按钮和 data-api，这里一律给桩元素。
            querySelector: selector => (selector === 'script[data-api]'
                ? Object.assign(new El('script'), { dataset: { api: API } })
                : byId(selector)),
            querySelectorAll: () => [],
        },
        addEventListener: (type, fn) => { (windowHandlers[type] ||= []).push(fn); },
        baihuaPvp: {
            isActive: () => Boolean(hooks.active),
            start: (info, names) => { hooks.started = { info, names }; return true; },
        },
        baihuaSocialBridge: {
            pause: () => { hooks.pauses = (hooks.pauses || 0) + 1; return true; },
            resume: () => { hooks.resumes = (hooks.resumes || 0) + 1; },
        },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);
    // 与 index.html 的初始标记一致：面板和弹窗默认隐藏。
    byId('socialHub').hidden = true;
    byId('pvpInvite').hidden = true;
    vm.runInContext(source, context, { filename: 'social.js' });
    return {
        sandbox, hooks, elements, byId,
        status: () => byId('socialStatus').textContent,
        invite: byId('pvpInvite'),
        inviteBody: byId('pvpInviteBody'),
        press: code => { for (const fn of windowHandlers.keydown || []) fn({ code, preventDefault() {} }); },
        refresh: () => sandbox.baihuaSocialNet.refresh(),
    };
}

async function call(token, op, body) {
    const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ op, token, ...body }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`${op} → ${response.status} ${result.error || ''}`);
    return result;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stamp = Date.now() % 100000;
const register = async name => {
    const result = await call('', 'register', { username: name, password: 'baihua-test-password' });
    return { id: result.user.id, name, token: result.token };
};

const host = await register(`弹窗甲${stamp}`);
const guest = await register(`弹窗乙${stamp}`);
await call(host.token, 'friend', { userId: guest.id });
const link = (await call(host.token, 'me', {})).friends.find(item => item.userId === guest.id);
await call(guest.token, 'acceptFriend', { id: link.id });

// 被邀请方：social.js 常驻运行，靠 3 秒轮询发现邀请。
const hooks = {};
const client = createSocial(guest.token, hooks);
await sleep(60);
assert.equal(client.sandbox.baihuaSocialNet.user.username, guest.name, '应使用已有会话自动登录');
assert.equal(client.invite.hidden, true, '没有邀请时不该弹窗');

await call(host.token, 'challenge', { userId: guest.id });
await client.refresh();
assert.equal(client.invite.hidden, false, '收到对决邀请应弹窗');
assert.ok(client.inviteBody.textContent.includes(host.name), `弹窗应写明邀请人，实际「${client.inviteBody.textContent}」`);
assert.equal(hooks.pauses, 1, '弹窗期间应暂停单人局');
assert.equal(client.byId('pvpInviteAccept').focused, 1, '焦点应落在接受按钮上');
assert.equal(client.byId('socialInvites').children.length, 1, '竞技场页也应列出这条邀请');

// 拒绝：邀请作废，同一邀请不再重复弹。
client.byId('pvpInviteDecline').click();
await sleep(120);
assert.equal(client.invite.hidden, true, '拒绝后应关闭弹窗');
assert.equal(client.status(), '已拒绝邀请');
assert.equal(hooks.resumes, 1, '拒绝后应恢复单人局');
assert.equal(hooks.started, undefined, '拒绝不该进入对决');
await client.refresh();
assert.equal(client.invite.hidden, true, '已处理的邀请不该再次弹出');
const declined = (await call(host.token, 'me', {})).matches;
assert.ok(declined.every(item => item.status !== 'pending'), `被拒的邀请应作废，实际 ${JSON.stringify(declined)}`);

// 接受：进入对决，弹窗关闭，画布拿到对局。
await call(host.token, 'me', {});
await call(guest.token, 'me', {});
const invited = await call(host.token, 'challenge', { userId: guest.id });
await client.refresh();
assert.equal(client.invite.hidden, false, '第二次邀请应重新弹窗');
client.press('Enter'); // 键盘确认，与点击"接受对决"同一条路径
await sleep(150);
assert.ok(hooks.started, '接受后应调用 baihuaPvp.start');
assert.equal(hooks.started.info.id, invited.id);
assert.equal(hooks.started.info.side, 1, '被邀请方应为 1 号位');
assert.equal(hooks.started.info.arena.status, 'active', '接受后对局应立即开始');
assert.equal(hooks.started.names.opponent, host.name, '应把邀请人名字交给对决画面');
assert.equal(client.invite.hidden, true, '接受后应关闭弹窗');
assert.equal(client.status(), '对决开始');

// 对决进行中：面板拒绝打开，也不该再弹邀请。
hooks.active = true;
await client.refresh();
assert.equal(client.invite.hidden, true, '对决中不该再弹邀请');
await call(host.token, 'leaveMatch', { id: invited.id });

console.log('邀请弹窗联调: OK');
process.exit(0);
