(() => {
    'use strict';
    const byId = id => document.getElementById(id);
    const hub = byId('socialHub');
    const closeButton = byId('socialClose');
    const status = byId('socialStatus');
    const authForm = byId('socialAuthForm');
    const invite = byId('pvpInvite');
    const inviteBody = byId('pvpInviteBody');
    const inviteAccept = byId('pvpInviteAccept');
    const inviteDecline = byId('pvpInviteDecline');
    let user = null;
    let friends = [];
    let scores = [];
    let matches = [];
    let leaderboard = [];
    let boardMode = 'story';
    let serverTime = Date.now();
    let authMode = 'register';
    let selectedTab = 'profile';
    let openedFrom = 'title';
    let pausedByHub = false;
    let pausedByInvite = false;
    let pendingRuns = {};
    let flushingRuns = false;
    let searchTimer = null;
    let inviteMatch = null;
    let handledInvites = new Set();
    let inviteBusy = false;
    try { pendingRuns = JSON.parse(localStorage.getItem('baihuaPendingRuns') || '{}') || {}; } catch { pendingRuns = {}; }
    const apiBase = document.querySelector('script[data-api]')?.dataset.api || '/api';
    let sessionToken = (() => { try { return localStorage.getItem('baihuaSessionToken') || ''; } catch { return ''; } })();
    function keepToken(token) {
        sessionToken = token || '';
        try {
            if (sessionToken) localStorage.setItem('baihuaSessionToken', sessionToken);
            else localStorage.removeItem('baihuaSessionToken');
        } catch {}
    }

    async function api(op, data, mode, query) {
        const path = data ? apiBase : `${apiBase}?${new URLSearchParams({ op, ...(mode ? { mode } : {}), ...(query || {}), ...(sessionToken ? { t: sessionToken } : {}) })}`;
        const response = await fetch(path, {
            method: data ? 'POST' : 'GET',
            headers: data ? { 'Content-Type': 'application/json' } : undefined,
            body: data ? JSON.stringify({ op, token: sessionToken, ...data }) : undefined
        });
        const result = await response.json();
        if (result && typeof result === 'object' && typeof result.token === 'string' && result.token) keepToken(result.token);
        if (!response.ok) throw new Error(result.error || '请求失败');
        return result;
    }
    function say(message) { status.textContent = message || ''; }
    function make(tag, text, className) {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (className) node.className = className;
        return node;
    }
    function row(label, action, onClick, disabled = false) {
        const item = make('div', undefined, 'social-row');
        item.append(make('span', label));
        if (action) {
            const button = make('button', action);
            button.type = 'button';
            button.disabled = disabled;
            button.addEventListener('click', onClick);
            item.append(button);
        }
        return item;
    }
    function setTab(tab) {
        if (!['profile', 'leaderboard', 'friends', 'arena'].includes(tab)) tab = 'profile';
        selectedTab = tab;
        for (const name of ['profile', 'leaderboard', 'friends', 'arena']) {
            byId('social' + name[0].toUpperCase() + name.slice(1)).hidden = name !== tab;
            document.querySelector(`[data-social-tab="${name}"]`).setAttribute('aria-selected', name === tab ? 'true' : 'false');
        }
        if (tab === 'leaderboard') void refreshLeaderboard();
        if (tab === 'arena') renderArena();
        if (tab === 'friends') renderFriends();
    }
    function open(tab = 'profile', source = 'title') {
        if (window.baihuaPvp?.isActive()) { say('对决进行中，请先结束对局。'); return; }
        openedFrom = source;
        hub.hidden = false;
        pausedByHub = source !== 'pause' && Boolean(window.baihuaSocialBridge?.pause());
        closeButton.textContent = source === 'pause' ? '返回暂停 ✕' : '返回主菜单 ✕';
        setTab(tab);
        closeButton.focus();
        renderAll();
        if (user) void refresh();
    }
    function close() {
        hub.hidden = true;
        if (pausedByHub) window.baihuaSocialBridge?.resume();
        pausedByHub = false;
        if (openedFrom === 'pause') byId('pauseContinueButton').focus();
        else byId('gameCanvas').focus();
    }
    function renderProfile() {
        byId('socialAuth').hidden = Boolean(user);
        byId('socialAccount').hidden = !user;
        byId('socialUserBadge').textContent = user ? user.username : '访客';
        if (!user) return;
        byId('socialAccountName').textContent = user.username;
        const list = byId('socialScores');
        list.replaceChildren();
        if (!scores.length) list.append(make('p', '尚无战绩。死亡结算后会自动记录。', 'social-muted'));
        for (const score of scores) list.append(row(`${score.mode === 'endless' ? '无尽' : '主线'} · 第 ${score.wave} 波 · ${score.kills} 击杀`));
        if (Object.keys(pendingRuns).length) list.append(make('p', '有待同步的结算，联网后会自动提交。', 'social-muted'));
    }
    function renderLeaderboard() {
        for (const button of document.querySelectorAll('[data-board-mode]')) button.setAttribute('aria-pressed', button.dataset.boardMode === boardMode ? 'true' : 'false');
        const list = byId('socialLeaderboardRows');
        list.replaceChildren();
        if (!leaderboard.length) { list.append(make('p', '这个模式还没有战绩。', 'social-muted')); return; }
        leaderboard.forEach((entry, index) => list.append(row(`${index + 1}. ${entry.username} · 第 ${entry.wave} 波 · ${entry.kills} 击杀`)));
    }
    async function refreshLeaderboard() {
        try {
            const mode = boardMode;
            const result = await api('leaderboard', undefined, mode);
            if (mode !== boardMode) return;
            leaderboard = result.entries || [];
            renderLeaderboard();
        } catch (error) { if (!hub.hidden) say(error.message); }
    }
    function renderFriends() {
        const list = byId('socialFriendsList');
        list.replaceChildren();
        if (!user) { list.append(make('p', '登录后可以添加好友。', 'social-muted')); return; }
        const pending = friends.filter(friend => friend.status === 'pending' && friend.requesterId !== user.id);
        const accepted = friends.filter(friend => friend.status === 'accepted');
        for (const friend of pending) list.append(row(`${friend.username} 请求加好友`, '接受', () => void act('acceptFriend', { id: friend.id })));
        for (const friend of accepted) {
            const online = serverTime - friend.lastSeen < 15000;
            const item = row(`${friend.username} · ${online ? '在线' : '离线'}`, '对决', () => void challenge(friend), !online);
            list.append(item);
        }
        if (!pending.length && !accepted.length) list.append(make('p', '暂无好友。', 'social-muted'));
    }
    function renderArena() {
        const invites = byId('socialInvites');
        const online = byId('socialOnlineFriends');
        invites.replaceChildren(); online.replaceChildren();
        if (!user) { invites.append(make('p', '请先在档案战绩中注册或登录。', 'social-muted')); return; }
        for (const match of matches.filter(item => item.status === 'pending' && item.side === 1)) {
            invites.append(row(`${match.opponentName || '好友'} 邀请你对决`, '接受邀请', () => void acceptInvite(match)));
        }
        const ready = friends.filter(friend => friend.status === 'accepted' && serverTime - friend.lastSeen < 15000);
        for (const friend of ready) online.append(row(`${friend.username} 在线`, '发起对决', () => void challenge(friend)));
        if (!invites.childElementCount && !ready.length) online.append(make('p', '暂无在线好友。', 'social-muted'));
    }
    // 邀请弹窗由 refresh 轮询驱动，所以社交面板关着、玩家正在单人局里也能收到。
    function scanInvites() {
        if (inviteMatch || inviteBusy || window.baihuaPvp?.isActive()) return;
        const pending = matches.find(item => item.status === 'pending' && item.side === 1 && !handledInvites.has(item.id));
        if (!pending) return;
        inviteMatch = pending;
        inviteBody.textContent = `${pending.opponentName || '好友'} 邀请你进入随机地图实时对决，三局两胜。接受后会离开当前界面。`;
        invite.hidden = false;
        pausedByInvite = Boolean(window.baihuaSocialBridge?.pause());
        inviteAccept.disabled = false;
        inviteDecline.disabled = false;
        inviteAccept.focus();
    }
    function hideInvite() {
        invite.hidden = true;
        inviteMatch = null;
        if (pausedByInvite) window.baihuaSocialBridge?.resume();
        pausedByInvite = false;
    }
    function renderAll() { renderProfile(); renderLeaderboard(); renderFriends(); renderArena(); }
    async function refresh() {
        try {
            const result = await api('me', {});
            user = result.user;
            friends = result.friends;
            scores = result.scores;
            matches = result.matches;
            serverTime = result.serverTime;
            renderAll();
            scanInvites();
            if (Object.keys(pendingRuns).length) void flushPendingRuns();
        } catch (error) {
            if (String(error.message).includes('登录')) {
                keepToken('');
                user = null; friends = []; scores = []; matches = [];
                renderAll();
            } else if (!hub.hidden) say(error.message);
        }
    }
    async function act(op, data = {}) {
        try {
            say('处理中…');
            const result = await api(op, data);
            await refresh();
            say('操作完成');
            return result;
        } catch (error) { say(error.message); return null; }
    }
    // 对决画面在主画布里跑，所以进入前要关掉社交面板并把焦点还给画布。
    function enterMatch(result, opponentName) {
        const pvp = window.baihuaPvp;
        if (!pvp) { say('对决模块未加载，请刷新页面'); return false; }
        hideInvite();
        if (!hub.hidden) close();
        if (!pvp.start(result, { opponent: opponentName })) { say('无法进入对决'); return false; }
        byId('gameCanvas').focus();
        return true;
    }
    async function acceptInvite(match) {
        if (inviteBusy) return;
        inviteBusy = true;
        inviteAccept.disabled = true;
        inviteDecline.disabled = true;
        try {
            const result = await api('acceptMatch', { id: match.id });
            handledInvites.add(match.id);
            const opponent = match.opponentName
                || friends.find(friend => friend.userId === match.opponentId)?.username || '好友';
            if (!enterMatch(result, opponent)) return;
            say('对决开始');
            await refresh();
        } catch (error) {
            say(error.message);
            inviteAccept.disabled = false;
            inviteDecline.disabled = false;
        } finally { inviteBusy = false; }
    }
    async function declineInvite(match) {
        if (inviteBusy) return;
        inviteBusy = true;
        handledInvites.add(match.id);
        try { await api('leaveMatch', { id: match.id }); } catch {}
        hideInvite();
        inviteBusy = false;
        say('已拒绝邀请');
        await refresh();
    }
    async function challenge(friend) {
        if (inviteBusy) return;
        inviteBusy = true;
        try {
            const created = await api('challenge', { userId: friend.userId });
            const result = await api('match', { id: created.id });
            if (!enterMatch(result, friend.username)) return;
            say(`已邀请 ${friend.username}，等待对方接受`);
        } catch (error) { say(error.message); }
        finally { inviteBusy = false; }
    }
    function savePendingRuns() {
        try { localStorage.setItem('baihuaPendingRuns', JSON.stringify(pendingRuns)); } catch {}
    }
    function betterRun(a, b) {
        return !b || Number(a.reachedWave) > Number(b.reachedWave)
            || (Number(a.reachedWave) === Number(b.reachedWave) && Number(a.kills) > Number(b.kills));
    }
    async function flushPendingRuns() {
        if (!user || flushingRuns) return;
        flushingRuns = true;
        let changed = false;
        try {
            for (const mode of ['story', 'endless']) {
                const summary = pendingRuns[mode];
                if (!summary) continue;
                const result = await api('score', { summary });
                if (pendingRuns[mode] === summary) delete pendingRuns[mode];
                savePendingRuns();
                changed = true;
                if (!hub.hidden) say(result.improved ? '新的个人最佳已自动上榜' : '本次结算未超过个人最佳');
            }
        } catch (error) { if (!hub.hidden) say(`战绩待同步：${error.message}`); }
        finally { flushingRuns = false; }
        if (changed) { await refresh(); if (selectedTab === 'leaderboard') void refreshLeaderboard(); }
    }
    function saveRun(summary) {
        if (!summary || summary.cause === 'victory' || !['story', 'endless'].includes(summary.mode)) return;
        if (betterRun(summary, pendingRuns[summary.mode])) pendingRuns[summary.mode] = summary;
        savePendingRuns();
        if (!user) { if (!hub.hidden) say('结算已暂存在本机，登录后自动上榜'); return; }
        void flushPendingRuns();
    }

    window.addEventListener('baihua:open-social', event => open(event.detail?.tab, event.detail?.source));
    closeButton.addEventListener('click', close);
    for (const button of document.querySelectorAll('[data-social-tab]')) button.addEventListener('click', () => setTab(button.dataset.socialTab));
    for (const button of document.querySelectorAll('[data-board-mode]')) button.addEventListener('click', () => {
        boardMode = button.dataset.boardMode;
        leaderboard = [];
        renderLeaderboard();
        void refreshLeaderboard();
    });
    byId('socialAuthSwitch').addEventListener('click', () => {
        authMode = authMode === 'register' ? 'login' : 'register';
        byId('socialAuthSubmit').textContent = authMode === 'register' ? '注册' : '登录';
        byId('socialAuthSwitch').textContent = authMode === 'register' ? '已有账号？登录' : '没有账号？注册';
        byId('socialPassword').autocomplete = authMode === 'register' ? 'new-password' : 'current-password';
    });
    authForm.addEventListener('submit', async event => {
        event.preventDefault();
        const submit = byId('socialAuthSubmit');
        submit.disabled = true;
        const previousLabel = submit.textContent;
        submit.textContent = authMode === 'register' ? '注册中…' : '登录中…';
        try {
        const result = await act(authMode, { username: byId('socialUsername').value, password: byId('socialPassword').value });
        if (!result) return;
        user = result.user;
        byId('socialPassword').value = '';
        await refresh();
        await flushPendingRuns();
        say(authMode === 'register' ? '账号已创建' : '登录成功');
        } finally { submit.disabled = false; submit.textContent = previousLabel; }
    });
    byId('socialLogout').addEventListener('click', async () => {
        if (!await act('logout')) return;
        keepToken('');
        user = null; friends = []; scores = []; matches = [];
        renderAll(); say('已退出登录');
    });
    byId('socialSearch').addEventListener('input', event => {
        clearTimeout(searchTimer);
        const q = event.target.value.trim();
        const list = byId('socialSearchResults'); list.replaceChildren();
        if (q.length < 2 || !user) return;
        searchTimer = setTimeout(async () => {
            try {
                const result = await api('search', undefined, undefined, { q });
                list.replaceChildren();
                for (const found of result.users || []) list.append(row(found.username, '添加', () => void act('friend', { userId: found.id })));
                if (!list.childElementCount) list.append(make('p', '没有匹配的玩家。', 'social-muted'));
            } catch (error) { say(error.message); }
        }, 120);
    });
    inviteAccept.addEventListener('click', () => { if (inviteMatch) void acceptInvite(inviteMatch); });
    inviteDecline.addEventListener('click', () => { if (inviteMatch) void declineInvite(inviteMatch); });
    window.addEventListener('keydown', event => {
        if (invite.hidden || !inviteMatch) return;
        if (event.code === 'Escape') { event.preventDefault(); void declineInvite(inviteMatch); }
        else if (event.code === 'Enter') { event.preventDefault(); void acceptInvite(inviteMatch); }
    });
    window.addEventListener('baihua:run', event => { saveRun(event.detail); });
    // pvp.js 只负责画布里的对决，网络与登录态仍由这里持有。
    window.baihuaSocialNet = {
        api,
        notify: say,
        refresh: () => refresh(),
        get user() { return user; },
        isHubOpen: () => !hub.hidden,
    };
    if (document.modelContext?.registerTool) {
        const lifecycle = new AbortController();
        void Promise.resolve(document.modelContext.registerTool({
            name: 'open_baihua_arena',
            title: '打开好友竞技场',
            description: '在游戏内打开好友 PvP 竞技场，显示当前邀请和在线好友。',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            annotations: { readOnlyHint: false },
            execute: async params => {
                if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length) throw new Error('无需参数');
                open('arena', 'tool');
                return { view: 'arena' };
            }
        }, { signal: lifecycle.signal })).catch(() => {});
        window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
    }
    // 3 秒轮询一次：邀请弹窗的延迟上限，也是好友在线状态的刷新频率。
    setInterval(() => { if (user && !document.hidden && !window.baihuaPvp?.isActive()) void refresh(); }, 3000);
    renderAll();
    void refresh();
})();
