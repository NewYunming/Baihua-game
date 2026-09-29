(() => {
    'use strict';
    const byId = id => document.getElementById(id);
    const hub = byId('socialHub');
    const closeButton = byId('socialClose');
    const status = byId('socialStatus');
    const authForm = byId('socialAuthForm');
    const weapons = ['木剑', '猎户短矛', '精铁长剑', '风暴战斧', '暗影裂刃', '星火链刃', '雷神之锤', '天穹贯日枪'];
    const talents = ['锋锐校准', '轻盈步法', '坚韧护甲', '迅捷出手'];
    const input = { left: false, right: false, attack: false };
    let user = null;
    let friends = [];
    let scores = [];
    let matches = [];
    let leaderboard = [];
    let boardMode = 'story';
    let serverTime = Date.now();
    let activeMatch = null;
    let authMode = 'register';
    let selectedTab = 'profile';
    let openedFrom = 'title';
    let pausedByHub = false;
    let pendingRuns = {};
    let flushingRuns = false;
    let tickBusy = false;
    let lastPendingPoll = 0;
    let searchTimer = null;
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
        if (tab === 'arena' && activeMatch) byId('socialArenaMatch').focus();
    }
    function open(tab = 'profile', source = 'title') {
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
        if (activeMatch && ['pending', 'active'].includes(activeMatch.status)) {
            say('对局尚未结束，请完成对决后返回游戏。');
            return;
        }
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
        const hasMatch = Boolean(activeMatch);
        byId('socialArenaLobby').hidden = hasMatch;
        byId('socialArenaMatch').hidden = !hasMatch;
        if (!hasMatch) {
            const invites = byId('socialInvites');
            const online = byId('socialOnlineFriends');
            invites.replaceChildren(); online.replaceChildren();
            if (!user) { invites.append(make('p', '请先在档案战绩中注册或登录。', 'social-muted')); return; }
            for (const match of matches.filter(item => item.status === 'pending' && item.side === 1)) {
                invites.append(row(`${match.opponentName || '好友'} 邀请你对决`, '接受邀请', () => void acceptMatch(match.id)));
            }
            const ready = friends.filter(friend => friend.status === 'accepted' && serverTime - friend.lastSeen < 15000);
            for (const friend of ready) online.append(row(`${friend.username} 在线`, '发起对决', () => void challenge(friend)));
            if (!invites.childElementCount && !ready.length) online.append(make('p', '暂无在线好友。', 'social-muted'));
            return;
        }
        const match = activeMatch;
        const arena = match.arena;
        const side = match.side;
        const opponent = friends.find(friend => friend.userId === match.opponentId)?.username || match.opponentName || '对手';
        byId('socialRoundTitle').textContent = `第 ${arena.round} 局`;
        byId('socialMatchScore').textContent = `${arena.wins[side]} : ${arena.wins[1 - side]}`;
        byId('socialLoadout').textContent = `共同装备：${weapons[arena.weapon]} · ${talents[arena.talent]}`;
        for (let i = 0; i < 2; i++) {
            const fighter = arena.fighters[i];
            byId(`socialFighter${i}`).style.left = `${fighter.x / 9.6}%`;
            byId(`socialHealth${i}`).style.width = `${fighter.hp}%`;
            byId(`socialHealthLabel${i}`).textContent = `${i === side ? user?.username : opponent} · ${fighter.hp} HP`;
        }
        byId('socialMatchBack').hidden = match.status !== 'finished';
        byId('socialMatchExit').hidden = !['pending', 'active'].includes(match.status);
        byId('socialMatchExit').textContent = match.status === 'pending' ? '取消邀请' : '认输并退出';
        byId('socialMatchMessage').textContent = match.status === 'pending'
            ? '等待好友接受邀请'
            : match.status === 'finished'
                ? `对决结束 · ${arena.wins[side] >= 2 ? '你获胜' : '好友获胜'}`
                : arena.roundEnds
                    ? `本局${arena.winner === side ? '获胜' : '失利'}，下一局即将开始`
                    : '双方同时在线 · 三局两胜';
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
    async function challenge(friend) {
        const result = await act('challenge', { userId: friend.userId });
        if (!result) return;
        activeMatch = await api('match', { id: result.id });
        setTab('arena'); renderArena();
    }
    async function acceptMatch(id) {
        const result = await act('acceptMatch', { id });
        if (!result) return;
        activeMatch = result;
        setTab('arena'); renderArena();
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
    async function tick() {
        if (!activeMatch || tickBusy || document.hidden) return;
        if (activeMatch.status === 'finished') return;
        if (activeMatch.status === 'pending' && Date.now() - lastPendingPoll < 1500) return;
        tickBusy = true;
        try {
            if (activeMatch.status === 'pending') {
                lastPendingPoll = Date.now();
                activeMatch = await api('match', { id: activeMatch.id });
            } else activeMatch = await api('tick', { id: activeMatch.id, ...input });
            if (activeMatch.status === 'cancelled') { activeMatch = null; say('邀请已取消'); }
            renderArena();
            if (activeMatch?.status === 'finished') await refresh();
        } catch (error) { if (!hub.hidden) say(error.message); }
        finally { tickBusy = false; }
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
    byId('socialMatchBack').addEventListener('click', () => { activeMatch = null; renderArena(); });
    byId('socialMatchExit').addEventListener('click', async () => {
        if (!activeMatch) return;
        const result = await act('leaveMatch', { id: activeMatch.id });
        if (!result) return;
        activeMatch = null; input.left = input.right = input.attack = false;
        renderArena(); say(result.status === 'cancelled' ? '邀请已取消' : '已认输并退出对局');
    });
    for (const button of document.querySelectorAll('[data-arena-action]')) {
        const key = button.dataset.arenaAction;
        button.addEventListener('pointerdown', event => { event.preventDefault(); input[key] = true; button.setPointerCapture?.(event.pointerId); });
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, () => { input[key] = false; });
    }
    window.addEventListener('keydown', event => {
        if (hub.hidden || selectedTab !== 'arena' || !activeMatch || activeMatch.status !== 'active') return;
        if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
        const key = { KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', KeyJ: 'attack', Space: 'attack' }[event.code];
        if (key) { input[key] = true; event.preventDefault(); }
    });
    window.addEventListener('keyup', event => {
        const key = { KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', KeyJ: 'attack', Space: 'attack' }[event.code];
        if (key) input[key] = false;
    });
    window.addEventListener('baihua:run', event => { saveRun(event.detail); });
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
    setInterval(() => { if (user && !document.hidden) void refresh(); }, 5000);
    setInterval(() => { void tick(); }, 160);
    renderAll();
    void refresh();
})();
