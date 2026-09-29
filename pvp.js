// 好友实时对决客户端：本地预测 + 服务器权威帧同步。
// 画面复用正式游戏的地图、天气、角色与武器绘制，所以这里只负责状态同步和 HUD。
// 以 classic script 加载，和 index.html 内联脚本共享全局词法作用域
// （tiles/camera/currentBiome/keys/Player/Weapon/Projectile/drawMap…），
// 构建脚本会把它排在 pvp-sim.js 之后、social.js 之前。
(() => {
    'use strict';

    const POLL_MS = 100;      // 服务器同步间隔；再快会撞上 Function 冷启动与配额
    const SNAP_PX = 14;       // 预测误差在此范围内就保留本地预测，避免橡皮筋
    const DESYNC_PX = 96;     // 超过这个距离说明预测彻底跑偏，整帧回滚到权威状态
    const BANNER_MS = 1900;
    // 对手快照到达间隔不均匀（轮询+网络抖动），每帧插值会"包没到就停住、包一到就跳"。
    // 改成渲染 FOE_DELAY_MS 之前的对手、在两份快照之间插值，突刺就被摊成匀速；
    // 断流时按最后一段速度外推 FOE_EXTRAP_MS，再久才原地等。
    const FOE_DELAY_MS = 180;
    const FOE_EXTRAP_MS = 220;
    const FOE_MAX_STEP = 18;  // 对手绘制位置单帧最大位移；插值路径本身匀速，
                              // 只有起缓冲/断流恢复这类不连续点才会触发限速
    const GLIDE_DECAY = 0.85; // 自身坐标被服务器纠正后，画面每帧收回的比例
    const CONFIRM_MS = 3000;  // 认输需要在这个时间窗内按两次 Esc

    const sim = () => globalThis.PvpSim;
    const net = () => window.baihuaSocialNet;

    let active = false;
    let leaving = false;
    let match = null;
    let foeName = '对手';
    let server = null;   // 最近一次服务器权威状态
    let local = null;    // 本地预测状态（结构与服务器一致）
    let avatars = [null, null];
    let avatarKey = '';
    let foeDraw = null;
    let foeBuf = [];          // 对手坐标快照缓冲 [{t, x, y}]，供插值取用
    const glide = { x: 0, y: 0 }; // 自身被纠正时的画面补偿，逐帧衰减到 0
    let banner = null;
    let notice = '';
    let result = '';
    let armedAt = 0;
    let shake = 0;
    let seenHp = 0;
    let pollAt = 0;
    let polling = false;
    const input = { left: false, right: false, jump: false, attack: false, reload: false };
    const shotPool = [];

    function loadoutOf(arena) {
        return sim().weaponAt(arena.seed, arena.round);
    }

    function findWeaponData(name) {
        for (const rarity of ['COMMON', 'RARE', 'EPIC', 'LEGENDARY']) {
            const found = (WEAPON_DATABASE[rarity] || []).find(item => item.name === name);
            if (found) return { data: found, rarity };
        }
        return { data: WEAPON_DATABASE.COMMON[0], rarity: 'COMMON' };
    }

    // 用模拟器的种子地图覆盖正式游戏的 tiles，并切到对应群系，
    // 这样 drawSky/drawMap/天气粒子全部原样可用。
    function buildWorld(arena) {
        const s = sim();
        if (!s || !arena) return;
        const biome = BIOMES[arena.biome] ? arena.biome : 'plains';
        if (currentBiome !== BIOMES[biome]) {
            currentBiome = BIOMES[biome];
            spawnWeatherParticles(currentBiome.weather);
        }
        const next = s.generateTiles(arena.seed);
        for (let y = 0; y < MAP_HEIGHT; y++) {
            if (!tiles[y] || tiles[y].length !== MAP_WIDTH) tiles[y] = new Array(MAP_WIDTH).fill(0);
            const row = next[y] || [];
            for (let x = 0; x < MAP_WIDTH; x++) tiles[y][x] = row[x] || 0;
        }
    }

    function ensureAvatars(arena) {
        const key = `${arena.seed}:${arena.round}`;
        if (key === avatarKey && avatars[0] && avatars[1]) return;
        avatarKey = key;
        const loadout = loadoutOf(arena);
        const { data, rarity } = findWeaponData(loadout.name);
        avatars = arena.fighters.map(fighter => {
            const avatar = new Player(fighter.x, fighter.y);
            avatar.weapon = new Weapon(data, rarity);
            avatar.baseMaxHp = sim().MAX_HP;
            avatar.maxHp = sim().MAX_HP;
            avatar.hp = sim().MAX_HP;
            avatar.upgrades = { damage: 0, hp: 0, range: 0, ammo: 0, reloadSpeed: 0 };
            avatar.passives = [];
            avatar.ammo = avatar.weapon.getMagazineSize();
            avatar.reloadMax = Math.max(1, avatar.weapon.getReloadFrames());
            avatar.invincible = 0;
            avatar.tempShield = 0;
            return avatar;
        });
    }

    // 把权威/预测出的战斗数值灌进 Player 实例，只用它的绘制能力，不调用它的 update。
    function poseAvatar(index, fighter) {
        const avatar = avatars[index];
        if (!avatar) return;
        avatar.x = fighter.x;
        avatar.y = fighter.y;
        avatar.vx = fighter.vx;
        avatar.vy = fighter.vy;
        avatar.facing = fighter.facing;
        avatar.onGround = fighter.onGround;
        avatar.hp = fighter.hp;
        avatar.attacking = fighter.attackTimer > 0;
        avatar.attackTimer = fighter.attackTimer;
        avatar.attackDuration = Math.max(1, fighter.attackDuration);
        avatar.attackSequence = fighter.attackSeq;
        avatar.hurtTimer = fighter.hurtTimer;
        avatar.walkFrame = fighter.walkFrame;
        avatar.walkTimer = fighter.walkTimer;
        avatar.ammo = fighter.ammo;
        avatar.reloadTimer = fighter.reloadTimer;
        avatar.reloadMax = Math.max(1, avatar.reloadMax || 1);
    }

    function readInput() {
        input.left = Boolean(keys['KeyA'] || keys['ArrowLeft']);
        input.right = Boolean(keys['KeyD'] || keys['ArrowRight']);
        input.jump = Boolean(keys['Space'] || keys['KeyW'] || keys['ArrowUp']);
        input.attack = Boolean(keys['KeyJ'] || mousePressed);
        input.reload = Boolean(keys['KeyR']);
    }

    function setBanner(text, sub) {
        banner = { text, sub: sub || '', until: Date.now() + BANNER_MS };
    }

    function start(info, names = {}) {
        const s = sim();
        if (!s || !info || !info.arena) return false;
        match = info;
        foeName = names.opponent || '对手';
        server = info.arena;
        local = server.status === 'active' || server.status === 'roundEnd' ? structuredClone(server) : null;
        avatars = [null, null];
        avatarKey = '';
        foeDraw = null;
        foeBuf = [];
        glide.x = 0;
        glide.y = 0;
        banner = null;
        result = '';
        armedAt = 0;
        shake = 0;
        notice = server.status === 'pending' ? '等待好友接受邀请…' : '';
        seenHp = s.MAX_HP;
        buildWorld(server);
        generateClouds();
        if (local) {
            ensureAvatars(local);
            foeDraw = { x: local.fighters[1 - match.side].x, y: local.fighters[1 - match.side].y };
            foeBuf = [{ t: performance.now(), x: foeDraw.x, y: foeDraw.y }];
        }
        stopMusic();
        stopBossMusic();
        manualPaused = false;
        resetPauseForStateTransition();
        gameState = 'pvp';
        syncTouchControlsVisibility();
        active = true;
        leaving = false;
        pollAt = 0;
        void poll();
        return true;
    }

    function stop(message) {
        if (!active) return;
        active = false;
        leaving = false;
        match = null;
        local = null;
        server = null;
        result = '';
        banner = null;
        foeDraw = null;
        foeBuf = [];
        glide.x = 0;
        glide.y = 0;
        avatars = [null, null];
        avatarKey = '';
        input.left = input.right = input.jump = input.attack = input.reload = false;
        clearInputState();
        resetToTitle();
        if (message) net()?.notify?.(message);
    }

    async function leave(surrender) {
        const api = net()?.api;
        const target = match;
        leaving = true;
        if (!api || !target) { stop(); return; }
        try {
            if (surrender) await api('leaveMatch', { id: target.id });
        } catch { /* 退出优先，认输失败不影响本机收尾 */ }
        stop(surrender ? '已认输并退出对局' : '');
    }

    function applyServer(next) {
        if (!active || leaving || !next || !match || next.id !== match.id) return;
        const wasPending = match.status === 'pending';
        match = next;
        const arena = next.arena;
        if (next.status === 'cancelled') { stop('邀请已取消'); return; }
        if (!arena) { stop('对局状态已失效'); return; }
        server = arena;
        notice = '';
        buildWorld(arena);

        if (arena.status === 'pending') {
            notice = '等待好友接受邀请…';
            local = null;
            return;
        }
        if (arena.status === 'finished') {
            local = null;
            result = arena.wins[match.side] >= 2 ? 'win' : 'lose';
            setBanner(result === 'win' ? '你赢了这场对决' : '好友赢下这场对决',
                `${arena.wins[match.side]} : ${arena.wins[1 - match.side]}`);
            return;
        }

        if (wasPending) setBanner('第 1 局 · 开始', loadoutOf(arena).name);

        if (!local || local.round !== arena.round || local.status !== arena.status) {
            local = structuredClone(arena);
            foeDraw = null;
            foeBuf = [];
            glide.x = 0;
            glide.y = 0;
            ensureAvatars(local);
            seenHp = local.fighters[match.side].hp;
            if (!wasPending) {
                setBanner(`第 ${arena.round} 局`, loadoutOf(arena).name);
            }
            return;
        }

        // 血量、局分、对手状态一律以服务器为准；自己的坐标在误差范围内保留预测值。
        const mine = local.fighters[match.side];
        const theirs = local.fighters[1 - match.side];
        const freshMine = arena.fighters[match.side];
        const freshTheirs = arena.fighters[1 - match.side];
        const drift = Math.max(Math.abs(mine.x - freshMine.x), Math.abs(mine.y - freshMine.y));
        // 纠正坐标时把差值记进 glide，让画面（角色+镜头）逐帧滑过去而不是瞬移。
        if (drift > SNAP_PX) {
            glide.x += mine.x - freshMine.x;
            glide.y += mine.y - freshMine.y;
        }
        if (drift > DESYNC_PX) {
            local = structuredClone(arena);
            foeDraw = null;
            return;
        }
        if (drift > SNAP_PX) { mine.x = freshMine.x; mine.y = freshMine.y; mine.vx = freshMine.vx; mine.vy = freshMine.vy; }
        mine.hp = freshMine.hp;
        mine.kbT = freshMine.kbT;
        mine.kbx = freshMine.kbx;
        mine.attackCooldown = Math.min(mine.attackCooldown, freshMine.attackCooldown);
        Object.assign(theirs, freshTheirs);
        foeBuf.push({ t: performance.now(), x: freshTheirs.x, y: freshTheirs.y });
        if (foeBuf.length > 40) foeBuf.shift();
        local.projectiles = structuredClone(arena.projectiles);
        local.wins = arena.wins.slice();
        local.tick = arena.tick;
        local.roundStartTick = arena.roundStartTick;
        local.roundEndTick = arena.roundEndTick;
        local.winner = arena.winner;
        local.status = arena.status;
        local.inputs[1 - match.side] = arena.inputs[1 - match.side];
    }

    async function poll() {
        if (!active || leaving || polling || !match) return;
        const now = performance.now();
        if (now - pollAt < POLL_MS) return;
        pollAt = now;
        const api = net()?.api;
        if (!api) return;
        polling = true;
        try {
            const waiting = match.status === 'pending' || server?.status === 'pending';
            const next = waiting
                ? await api('match', { id: match.id })
                : await api('tick', { id: match.id, ...input });
            if (!active) return;
            applyServer(next);
        } catch (error) {
            const message = error?.message || '连接中断';
            if (message.includes('登录')) { stop('登录已失效，请重新登录'); return; }
            notice = message;
        } finally {
            polling = false;
        }
    }

    function predict() {
        const s = sim();
        if (!local || !s) return;
        if (local.status !== 'active' && local.status !== 'roundEnd') return;
        local.inputs[match.side] = input;
        s.stepMatch(local, 1, performance.now());
    }

    function updateCamera() {
        const me = local.fighters[match.side];
        // 镜头带上 glide：坐标被纠正时整个画面一起滑，避免背景瞬移。
        camera.x = me.x + glide.x - CONFIG.CANVAS_WIDTH / 2 + sim().FIGHTER_W / 2;
        camera.y = me.y + glide.y - CONFIG.CANVAS_HEIGHT / 2 + sim().FIGHTER_H / 2;
        camera.x = Math.max(0, Math.min(camera.x, MAP_WIDTH * CONFIG.TILE_SIZE - CONFIG.CANVAS_WIDTH));
        camera.y = Math.max(0, Math.min(camera.y, MAP_HEIGHT * CONFIG.TILE_SIZE - CONFIG.CANVAS_HEIGHT));
    }

    // 取"FOE_DELAY_MS 之前"的对手坐标：在缓冲里找目标时刻两侧快照线性插值；
    // 快照断流时沿最后一段速度外推，超过 FOE_EXTRAP_MS 就停在最后一份快照上。
    function sampleFoe(now) {
        const target = now - FOE_DELAY_MS;
        while (foeBuf.length > 2 && foeBuf[1].t <= target) foeBuf.shift();
        const a = foeBuf[0];
        if (!a) return null;
        if (foeBuf.length === 1 || target <= a.t) return a;
        const b = foeBuf[1];
        if (target >= b.t) {
            const dt = Math.max(1, b.t - a.t);
            const over = Math.min(target - b.t, FOE_EXTRAP_MS);
            return { x: b.x + (b.x - a.x) / dt * over, y: b.y + (b.y - a.y) / dt * over };
        }
        const k = (target - a.t) / Math.max(1, b.t - a.t);
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    }

    function update() {
        if (!active) return;
        updateClouds();
        readInput();
        if (shake > 0) shake = Math.max(0, shake - 0.6);
        if (!local || !local.fighters) return;
        predict();
        if (local.status !== 'active' && local.status !== 'roundEnd') return;
        ensureAvatars(local);
        updateCamera();
        const me = local.fighters[match.side];
        if (me.hp < seenHp) { shake = Math.max(shake, 4.5); seenHp = me.hp; }
        else if (me.hp > seenHp) seenHp = me.hp;
        const foe = local.fighters[1 - match.side];
        const want = sampleFoe(performance.now());
        if (want) {
            if (!foeDraw) foeDraw = { x: want.x, y: want.y };
            else {
                const dx = want.x - foeDraw.x;
                const dy = want.y - foeDraw.y;
                const dist = Math.hypot(dx, dy);
                const k = dist > FOE_MAX_STEP ? FOE_MAX_STEP / dist : 1;
                foeDraw.x += dx * k;
                foeDraw.y += dy * k;
            }
        } else if (!foeDraw) foeDraw = { x: foe.x, y: foe.y };
        glide.x = Math.abs(glide.x) < 0.4 ? 0 : glide.x * GLIDE_DECAY;
        glide.y = Math.abs(glide.y) < 0.4 ? 0 : glide.y * GLIDE_DECAY;
    }

    function drawShots(g, arena) {
        const loadout = loadoutOf(arena);
        arena.projectiles.forEach((shot, index) => {
            let body = shotPool[index];
            if (!body) {
                body = new Projectile(0, 0, 0, 0, 0, loadout.color, 'player', {});
                shotPool[index] = body;
            }
            body.x = shot.x;
            body.y = shot.y;
            body.vx = shot.vx;
            body.vy = shot.vy;
            body.size = shot.sz;
            body.color = loadout.color;
            body.model = loadout.model;
            body.owner = shot.o === match.side ? 'player' : 'enemy';
            body.trail.length = 0;
            body.draw(g);
        });
    }

    function drawFoeMarker(g, foe) {
        const screenX = getNearestWrappedScreenX(foe.x);
        const screenY = foe.y - camera.y;
        const margin = 26;
        const inside = screenX > -margin && screenX < CONFIG.CANVAS_WIDTH + margin
            && screenY > -margin && screenY < CONFIG.CANVAS_HEIGHT + margin;
        if (inside) return;
        const cx = Math.max(margin, Math.min(CONFIG.CANVAS_WIDTH - margin, screenX));
        const cy = Math.max(margin + 34, Math.min(CONFIG.CANVAS_HEIGHT - margin, screenY));
        const angle = Math.atan2(screenY - cy, screenX - cx);
        g.save();
        g.translate(cx, cy);
        g.rotate(angle);
        g.fillStyle = '#FF8A80';
        g.strokeStyle = '#2A0B0B';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(12, 0); g.lineTo(-8, -8); g.lineTo(-8, 8);
        g.closePath();
        g.fill();
        g.stroke();
        g.restore();
        g.save();
        g.fillStyle = '#FFCDD2';
        g.font = 'bold 12px "Courier New", monospace';
        g.textAlign = 'center';
        g.fillText(foeName, cx, cy - 16);
        g.restore();
    }

    function drawHealthBar(g, x, hp, mine) {
        const width = 300;
        const ratio = Math.max(0, Math.min(1, hp / sim().MAX_HP));
        g.save();
        g.fillStyle = 'rgba(0,0,0,0.55)';
        g.fillRect(x, 12, width, 24);
        g.fillStyle = mine ? '#4DD07E' : '#E4696F';
        if (mine) g.fillRect(x + 2, 14, (width - 4) * ratio, 20);
        else g.fillRect(x + width - 2 - (width - 4) * ratio, 14, (width - 4) * ratio, 20);
        g.strokeStyle = '#0B1B24';
        g.lineWidth = 2;
        g.strokeRect(x, 12, width, 24);
        g.fillStyle = '#FFFFFF';
        g.font = 'bold 13px "Courier New", monospace';
        g.textAlign = mine ? 'left' : 'right';
        g.shadowColor = '#000';
        g.shadowBlur = 3;
        g.fillText(`${mine ? '你' : foeName} · ${Math.max(0, Math.round(hp))}`, mine ? x + 8 : x + width - 8, 29);
        g.restore();
    }

    function drawHud(g, arena) {
        const s = sim();
        const me = local ? local.fighters[match.side] : null;
        const foe = local ? local.fighters[1 - match.side] : null;
        if (me && foe) {
            drawHealthBar(g, 14, me.hp, true);
            drawHealthBar(g, CONFIG.CANVAS_WIDTH - 314, foe.hp, false);
        }

        g.save();
        g.textAlign = 'center';
        g.shadowColor = '#000';
        g.shadowBlur = 4;
        g.fillStyle = '#FFE28A';
        g.font = 'bold 20px "Courier New", monospace';
        const wins = arena.wins || [0, 0];
        g.fillText(`${wins[match.side]} : ${wins[1 - match.side]}`, CONFIG.CANVAS_WIDTH / 2, 30);
        g.font = '13px "Courier New", monospace';
        g.fillStyle = '#DCEBF0';
        if (arena.status === 'active') {
            const left = Math.max(0, s.ROUND_TICKS - ((local?.tick || 0) - arena.roundStartTick));
            const seconds = Math.ceil(left / 60);
            g.fillText(`第 ${arena.round} 局 · 三局两胜 · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`,
                CONFIG.CANVAS_WIDTH / 2, 50);
        } else {
            g.fillText(`第 ${arena.round} 局`, CONFIG.CANVAS_WIDTH / 2, 50);
        }
        g.fillStyle = '#B9E7D1';
        g.fillText(`共同装备：${loadoutOf(arena).name}`, CONFIG.CANVAS_WIDTH / 2, 70);
        g.restore();

        if (foe && foeDraw) {
            const offscreen = { x: foeDraw.x, y: foeDraw.y };
            drawFoeMarker(g, offscreen);
        }

        g.save();
        g.font = '12px "Courier New", monospace';
        g.fillStyle = 'rgba(220,235,240,0.75)';
        g.textAlign = 'left';
        g.fillText('A/D 移动 · 空格跳 · J 攻击 · R 装填 · Esc 认输', 14, CONFIG.CANVAS_HEIGHT - 14);
        if (notice) {
            g.textAlign = 'center';
            g.fillStyle = '#FFD54F';
            g.font = 'bold 14px "Courier New", monospace';
            g.fillText(notice, CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT - 34);
        }
        if (armedAt && Date.now() - armedAt < CONFIRM_MS) {
            g.textAlign = 'center';
            g.fillStyle = '#FF8A80';
            g.font = 'bold 15px "Courier New", monospace';
            g.fillText('再按一次 Esc 认输并退出', CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT - 56);
        }
        g.restore();
    }

    function drawCenterCard(g, title, lines) {
        g.save();
        g.fillStyle = 'rgba(2,7,14,0.72)';
        g.fillRect(0, 0, CONFIG.CANVAS_WIDTH, CONFIG.CANVAS_HEIGHT);
        g.textAlign = 'center';
        g.fillStyle = '#FFE28A';
        g.font = 'bold 34px "Courier New", monospace';
        g.fillText(title, CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 - 20);
        g.font = '16px "Courier New", monospace';
        g.fillStyle = '#DCEBF0';
        lines.forEach((line, index) => {
            g.fillText(line, CONFIG.CANVAS_WIDTH / 2, CONFIG.CANVAS_HEIGHT / 2 + 16 + index * 26);
        });
        g.restore();
    }

    function render(g) {
        if (!active) return;
        drawSky();
        drawBackdropDetails();
        drawClouds();

        const arena = local || server;
        g.save();
        if (shake > 0 && !reducedMotion) g.translate((Math.random() - 0.5) * shake * 2, (Math.random() - 0.5) * shake * 1.4);
        drawMap();

        if (arena && arena.fighters && avatars[0] && avatars[1]) {
            const foeIndex = 1 - match.side;
            const foe = arena.fighters[foeIndex];
            const drawn = { ...foe, x: foeDraw ? foeDraw.x : foe.x, y: foeDraw ? foeDraw.y : foe.y };
            poseAvatar(foeIndex, drawn);
            avatars[foeIndex].draw(g);
            const mineNow = arena.fighters[match.side];
            poseAvatar(match.side, { ...mineNow, x: mineNow.x + glide.x, y: mineNow.y + glide.y });
            avatars[match.side].draw(g);
            drawShots(g, arena);
        }

        drawWeatherParticles(currentBiome.weather);
        g.restore();

        if (!arena || arena.status === 'pending') {
            drawCenterCard(g, '好友对决', [
                `${foeName} 尚未接受邀请`,
                '保持这个页面打开，对方接受后会自动开始',
                '按 Esc 取消邀请',
            ]);
            return;
        }
        if (arena.status === 'roundEnd') {
            const win = arena.winner === match.side;
            drawCenterCard(g, win ? '本局获胜' : '本局失利', [
                `${arena.wins[match.side]} : ${arena.wins[1 - match.side]}`,
                '下一局即将开始',
            ]);
        }
        if (result) {
            drawCenterCard(g, result === 'win' ? '对决胜利' : '对决落败', [
                `最终 ${arena.wins[match.side]} : ${arena.wins[1 - match.side]}`,
                '按 Esc 返回主菜单',
            ]);
        } else if (banner && Date.now() < banner.until) {
            drawCenterCard(g, banner.text, banner.sub ? [banner.sub] : []);
        }
        drawHud(g, arena);
    }

    function onEscape() {
        if (!active) return;
        if (result) { stop(); return; }
        if (match?.status === 'pending' || server?.status === 'pending') { void leave(false); return; }
        if (armedAt && Date.now() - armedAt < CONFIRM_MS) { armedAt = 0; void leave(true); return; }
        armedAt = Date.now();
    }

    setInterval(() => { if (active) void poll(); }, POLL_MS);

    window.baihuaPvp = {
        start,
        stop: () => stop(),
        isActive: () => active,
    };
    window.baihuaPvpUpdate = update;
    window.baihuaPvpRender = render;
    window.baihuaPvpEscape = onEscape;
})();
