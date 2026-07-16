const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error('index.html 中未找到游戏脚本');

const gradient = { addColorStop() {} };
const ctx = new Proxy({
    globalAlpha: 1,
    save() {},
    restore() {},
    createLinearGradient() { return gradient; },
    createRadialGradient() { return gradient; },
    measureText(text) { return { width: String(text).length * 8 }; }
}, {
    get(target, property) {
        if (property in target) return target[property];
        return () => {};
    },
    set(target, property, value) {
        target[property] = value;
        return true;
    }
});

function makeElement() {
    const listeners = {};
    const classes = new Set();
    const attributes = {};
    return {
        style: {},
        textContent: '',
        value: '',
        hidden: false,
        disabled: false,
        dataset: {},
        classList: {
            add(...names) { names.forEach(name => classes.add(name)); },
            remove(...names) { names.forEach(name => classes.delete(name)); },
            contains(name) { return classes.has(name); },
            toggle(name, force) {
                const shouldAdd = force === undefined ? !classes.has(name) : Boolean(force);
                if (shouldAdd) classes.add(name);
                else classes.delete(name);
                return shouldAdd;
            }
        },
        addEventListener(type, handler) {
            if (!listeners[type]) listeners[type] = [];
            listeners[type].push(handler);
        },
        dispatchEvent(event) {
            if (!event.target) event.target = this;
            if (!event.__stopWrapped) {
                const originalStop = event.stopPropagation;
                event.stopPropagation = function () {
                    this.cancelBubble = true;
                    if (originalStop) originalStop.call(this);
                };
                event.__stopWrapped = true;
            }
            for (const handler of listeners[event.type] || []) {
                handler.call(this, event);
            }
            if (!event.cancelBubble && this.parentElement) {
                this.parentElement.dispatchEvent(event);
            }
            return !event.defaultPrevented;
        },
        setAttribute(name, value) { attributes[name] = String(value); },
        getAttribute(name) { return attributes[name]; },
        querySelectorAll() { return []; },
        getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 540 }; },
        setPointerCapture() {}
    };
}

const canvas = makeElement();
canvas.getContext = () => ctx;
const touchButtonTags = [...html.matchAll(/<button\b[^>]*>/g)]
    .map(match => match[0])
    .filter(tag => /\bclass="[^"]*\btouch-btn\b[^"]*"/.test(tag));
const touchActionsFromHtml = touchButtonTags.map(tag => tag.match(/\bdata-action="([^"]+)"/)?.[1]);
const touchButtonMocks = touchActionsFromHtml.map(action => {
    const button = makeElement();
    button.dataset.action = action;
    return button;
});
const touchControls = makeElement();
touchButtonMocks.forEach(button => { button.parentElement = touchControls; });
touchControls.querySelectorAll = selector => selector === '.touch-btn' ? touchButtonMocks : [];
const documentElement = makeElement();
const cssVariables = {};
documentElement.style.setProperty = (name, value) => { cssVariables[name] = String(value); };
documentElement.style.getPropertyValue = name => cssVariables[name] || '';
const documentEvents = makeElement();
const windowEvents = makeElement();
const touchPauseButton = makeElement();
touchPauseButton.parentElement = touchControls;
const volumeSlider = makeElement();
volumeSlider.value = '100';
const touchSizeSlider = makeElement();
touchSizeSlider.value = '100';
touchSizeSlider.disabled = true;
const pauseTouchSizeRow = makeElement();
pauseTouchSizeRow.hidden = true;
const reloadButton = touchButtonMocks.find(button => button.dataset.action === 'reload');
const elements = {
    gameCanvas: canvas,
    gameContainer: makeElement(),
    instructions: makeElement(),
    touchControls,
    fullscreenButton: makeElement(),
    touchPauseButton,
    reloadButton,
    pauseMenu: makeElement(),
    pauseContinueButton: makeElement(),
    pauseRestartButton: makeElement(),
    volumeSlider,
    volumeValue: makeElement(),
    pauseTouchSizeRow,
    touchSizeSlider,
    touchSizeValue: makeElement(),
    rotateHint: makeElement(),
    liveStatus: makeElement()
};

const documentMock = {
    hidden: false,
    fullscreenElement: null,
    fullscreenEnabled: true,
    documentElement,
    getElementById(id) { return elements[id]; },
    addEventListener: documentEvents.addEventListener,
    dispatchEvent: documentEvents.dispatchEvent
};

const windowMock = {
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener: windowEvents.addEventListener,
    dispatchEvent: windowEvents.dispatchEvent,
    matchMedia() { return { matches: false }; },
    setTimeout(callback) { callback(); return 0; },
    visualViewport: { width: 1280, height: 720, addEventListener() {} }
};

const assertions = `
    const assert = (condition, message) => {
        if (!condition) throw new Error(message);
    };

    // 武器数据覆盖与品质池
    const weaponNames = new Set();
    const validBalanceProfiles = new Set(Object.keys(WEAPON_BALANCE_PROFILES));
    const expectedWeaponHp = {
        COMMON: { melee: 0, ranged: 0 },
        RARE: { melee: 20, ranged: 10 },
        EPIC: { melee: 50, ranged: 25 },
        LEGENDARY: { melee: 100, ranged: 50 }
    };
    for (const rarity of RARITY_ORDER) {
        assert(WEAPON_DATABASE[rarity].some(item => item.model === 'bow'), rarity + ' 缺少弓');
        assert(WEAPON_DATABASE[rarity].some(item => ['pistol', 'rifle', 'shotgun'].includes(item.model)), rarity + ' 缺少枪械');

        for (const data of WEAPON_DATABASE[rarity]) {
            assert(!weaponNames.has(data.name), '武器名称重复：' + data.name);
            weaponNames.add(data.name);
            if (data.category === 'ranged') {
                assert(validBalanceProfiles.has(data.balanceProfile), data.name + ' 缺少显式远程平衡类型');
            }
            const weapon = new Weapon(data, rarity);
            assert(validBalanceProfiles.has(weapon.balanceProfile), data.name + ' 的平衡类型无效');
            assert(weapon.hpBonus === expectedWeaponHp[rarity][weapon.isRanged ? 'ranged' : 'melee'], data.name + ' 的生命加成档位错误');
            if (weapon.balanceProfile === 'bow') {
                assert(weapon.damage === data.baseDamage * 2, data.name + ' 的弓伤害未翻倍');
                assert(weapon.reloadFrames === 60, data.name + ' 的弓装填未延长到 1 秒');
            } else if (weapon.balanceProfile === 'automatic') {
                assert(weapon.damage === data.baseDamage * 0.35, data.name + ' 的连发伤害未进一步降低');
                assert(weapon.getProjectileKnockback() < 2, data.name + ' 的连发击退仍然过高');
            } else if (data.category === 'ranged') {
                assert(weapon.damage === Math.max(1, data.baseDamage * 0.5), data.name + ' 的远程伤害未精确减半');
            } else {
                assert(weapon.damage === data.baseDamage, data.name + ' 的近战伤害被意外修改');
            }
        }
    }
    const expandedModels = new Set(Object.values(WEAPON_DATABASE).flat().map(item => item.model));
    for (const model of ['spear', 'twinblade', 'whip', 'crossbow', 'carbine', 'staff', 'launcher']) {
        assert(expandedModels.has(model), '新增武器类别缺失：' + model);
    }
    assert(Object.keys(ATTACK_PROFILES).length >= 8, '近战攻击动画类型不足');

    let rejectedUnknownProfile = false;
    try {
        new Weapon({ name: '非法测试枪', model: 'beam', category: 'ranged', balanceProfile: 'unknown', baseDamage: 10 }, 'COMMON');
    } catch (error) {
        rejectedUnknownProfile = true;
    }
    assert(rejectedUnknownProfile, '未知远程平衡类型未被拒绝');
    let rejectedMissingProfile = false;
    try {
        new Weapon({ name: '漏配测试枪', model: 'carbine', category: 'ranged', baseDamage: 10 }, 'COMMON');
    } catch (error) {
        rejectedMissingProfile = true;
    }
    assert(rejectedMissingProfile, '缺失远程平衡类型时没有快速报错');

    const expectedFragments = {
        'damage-1': ['damageBonus', 16, '永久攻击力 +16'],
        'damage-2': ['damageBonus', 28, '永久攻击力 +28'],
        'damage-3': ['damageBonus', 40, '永久攻击力 +40'],
        'hp-1': ['hpBonus', 24, '永久生命上限 +24'],
        'hp-2': ['hpBonus', 44, '永久生命上限 +44'],
        'hp-3': ['hpBonus', 68, '永久生命上限 +68'],
        'range-1': ['rangeBonus', 14, '近战攻击距离 +14'],
        'range-2': ['rangeBonus', 24, '近战攻击距离 +24'],
        'range-3': ['rangeBonus', 36, '近战攻击距离 +36'],
        'ammo-1': ['ammoBonus', 4, '远程弹药容量 +4'],
        'ammo-2': ['ammoBonus', 8, '远程弹药容量 +8'],
        'ammo-3': ['ammoBonus', 12, '远程弹药容量 +12'],
        'reload-1': ['reloadSpeedBonus', 0.16, '远程装填时间 -16%'],
        'reload-2': ['reloadSpeedBonus', 0.26, '远程装填时间 -26%'],
        'reload-3': ['reloadSpeedBonus', 0.36, '远程装填时间 -36%']
    };
    assert(ENCHANT_POOL.length === Object.keys(expectedFragments).length, '碎片数量发生意外变化');
    for (const fragment of ENCHANT_POOL) {
        const [field, value, desc] = expectedFragments[fragment.id] || [];
        assert(field && fragment[field] === value && fragment.desc === desc, fragment.id + ' 的数值或描述错误');
        assert(!fragment.desc.includes('翻倍'), fragment.id + ' 出现不应展示的调整说明');
    }

    // 六种地形必须拥有独立音乐主题。
    const biomeMusicKeys = Object.values(BIOMES).map(biome => biome.musicKey);
    assert(biomeMusicKeys.length === CONFIG.BIOME_LIST.length, '地形与音乐主题数量不一致');
    assert(new Set(biomeMusicKeys).size === CONFIG.BIOME_LIST.length, '不同地形复用了同一个音乐键');
    assert(biomeMusicKeys.every(key => BIOME_MUSIC[key] && BIOME_MUSIC[key].pattern.length >= 12), '存在缺失或过短的地形音乐');
    assert(new Set(biomeMusicKeys.map(key => JSON.stringify(BIOME_MUSIC[key].pattern))).size === biomeMusicKeys.length, '不同地形的旋律并不独立');

    // 即使随机序列固定，武器奖励也必须严格无放回生成三张。
    const originalRandomForChoices = Math.random;
    Math.random = () => 0;
    const forcedChoices = generateWeaponChoices(3, 'COMMON');
    Math.random = originalRandomForChoices;
    assert(forcedChoices.length === 3, '极端随机序列下武器奖励不足三张');
    assert(new Set(forcedChoices.map(choice => choice.name)).size === 3, '武器奖励出现重复卡');

    // 弓严格一箭一装，基础装填为 60 个 60Hz 逻辑帧。
    gameState = 'playing';
    player.resetProgression();
    const bow = new Weapon(WEAPON_DATABASE.COMMON.find(item => item.model === 'bow'), 'COMMON');
    player.setWeapon(bow);
    player.attackCooldown = 0;
    projectiles.length = 0;
    player.tryAttack();
    assert(projectiles.length === 1, '弓未生成玩家投射物');
    assert(player.ammo === 0, '弓射击后仍有已装填箭矢');
    assert(player.attacking && player.attackTimer > 0, '最后一箭触发装填时吞掉了射击动画');
    assert(player.reloadTimer === 60 && player.reloadMax === 60, '弓装填不是严格 60 帧');
    assert(player.getAttackBox() === null, '远程武器错误生成近战命中盒');
    for (let frame = 0; frame < 59; frame++) player.update();
    assert(player.ammo === 0 && player.reloadTimer === 1, '弓在 1 秒前提前完成装填');
    player.update();
    assert(player.ammo === 1 && player.reloadTimer === 0, '弓在 60 帧后未完成装填');

    // 不同近战招式拥有独立时序、有效窗口和判定形状。
    const spearData = WEAPON_DATABASE.COMMON.find(item => item.model === 'spear');
    player.setWeapon(new Weapon(spearData, 'COMMON'));
    player.attackCooldown = 0;
    player.tryAttack();
    assert(player.getAttackBox() === null, '长矛在蓄力起始帧提前命中');
    const spearProfile = player.weapon.attackProfile;
    const spearActiveProgress = (spearProfile.activeStart + spearProfile.activeEnd) / 2;
    player.attackTimer = player.attackDuration * (1 - spearActiveProgress);
    const spearBox = player.getAttackBox();
    assert(spearBox && spearBox.height === 18, '长矛没有使用窄长突刺判定');

    const twinbladeData = WEAPON_DATABASE.RARE.find(item => item.model === 'twinblade');
    player.setWeapon(new Weapon(twinbladeData, 'RARE'));
    player.attacking = true;
    player.attackDuration = player.weapon.attackProfile.duration;
    player.attackTimer = player.attackDuration * 0.5;
    const spinBox = player.getAttackBox();
    assert(spinBox && spinBox.x < player.x && spinBox.x + spinBox.width > player.x + player.width, '双头刃旋转攻击不能命中身后');
    const spinRadius = player.getAttackReach();
    const spinCenterX = player.x + player.width / 2;
    const spinCenterY = player.y + player.height / 2;
    const outsideSpinCorner = { x: spinCenterX + spinRadius - 1, y: spinCenterY + spinRadius - 1, width: 2, height: 2 };
    const behindSpinTarget = { x: spinCenterX - spinRadius + 2, y: spinCenterY - 4, width: 8, height: 8 };
    assert(!player.attackIntersects(outsideSpinCorner), '旋转攻击仍能命中可见圆轨迹外的矩形角落');
    assert(player.attackIntersects(behindSpinTarget), '旋转攻击圆判定不能命中身后目标');

    // 枪械扩容与永久成长换武器保留。
    const gun = new Weapon(WEAPON_DATABASE.RARE.find(item => item.model === 'rifle'), 'RARE');
    player.setWeapon(gun);
    const baseMagazine = player.getMagazineSize();
    player.applyEnchant(ENCHANT_POOL.find(fragment => fragment.id === 'ammo-1'));
    player.applyEnchant(ENCHANT_POOL.find(fragment => fragment.id === 'damage-1'));
    assert(player.getMagazineSize() === baseMagazine + 4, '扩容碎片未增加枪械弹容');
    assert(Math.abs(player.getAttackDamage() - (gun.damage + 5.28)) < 1e-9, '远程 +16 攻击碎片未按 33% 生效');
    player.resetProgression();
    const crossbow = new Weapon(WEAPON_DATABASE.COMMON.find(item => item.model === 'crossbow'), 'COMMON');
    player.setWeapon(crossbow);
    const crossbowEnchantPool = generateEnchantChoices(ENCHANT_POOL.length, crossbow);
    assert(crossbowEnchantPool.every(fragment => !fragment.ammoBonus), '固定单发手弩仍会抽到无效扩容碎片');
    player.applyEnchant(ENCHANT_POOL.find(fragment => fragment.id === 'ammo-1'));
    assert(player.getMagazineSize() === 1 && player.ammo === 1, '固定单发手弩被扩容碎片错误扩容');
    player.applyEnchant(ENCHANT_POOL.find(fragment => fragment.id === 'damage-1'));
    const permanentDamage = player.upgrades.damage;
    player.setWeapon(new Weapon(WEAPON_DATABASE.EPIC.find(item => item.model === 'sword'), 'EPIC'));
    assert(player.upgrades.damage === permanentDamage && player.getAttackDamage() > player.weapon.damage, '换武器丢失永久伤害成长');
    const gunMagazineSizes = new Set(
        Object.values(WEAPON_DATABASE).flat().filter(item => item.category === 'ranged' && item.model !== 'bow').map(item => item.magazine)
    );
    assert(gunMagazineSizes.size >= 4, '不同枪型没有形成差异化载弹量');

    const damageFragment = ENCHANT_POOL.find(fragment => fragment.id === 'damage-3');
    const measureVolley = (data, rarity, upgraded = false) => {
        player.resetProgression();
        player.setWeapon(new Weapon(data, rarity));
        if (upgraded) player.applyEnchant(damageFragment);
        player.ammo = player.getMagazineSize();
        player.reloadTimer = 0;
        projectiles.length = 0;
        player.fireRangedWeapon();
        return {
            totalDamage: projectiles.reduce((sum, projectile) => sum + projectile.dmg, 0),
            projectiles: [...projectiles]
        };
    };
    const bowData = WEAPON_DATABASE.COMMON.find(data => data.balanceProfile === 'bow');
    const pistolData = WEAPON_DATABASE.COMMON.find(data => data.balanceProfile === 'semi');
    const autoData = WEAPON_DATABASE.RARE.find(data => data.balanceProfile === 'automatic');
    const shotgunData = WEAPON_DATABASE.EPIC.find(data => data.balanceProfile === 'pellet');
    for (const [data, rarity] of [[bowData, 'COMMON'], [pistolData, 'COMMON'], [autoData, 'RARE'], [shotgunData, 'EPIC']]) {
        const base = measureVolley(data, rarity);
        const upgraded = measureVolley(data, rarity, true);
        assert(Math.abs((upgraded.totalDamage - base.totalDamage) - 13.2) < 1e-9, data.name + ' 的 +40 远程碎片总增伤不是 13.2');
    }
    const bowShot = measureVolley(bowData, 'COMMON').projectiles[0];
    const pistolShot = measureVolley(pistolData, 'COMMON').projectiles[0];
    const autoShot = measureVolley(autoData, 'RARE').projectiles[0];
    assert(autoShot.knockback < pistolShot.knockback && pistolShot.knockback < bowShot.knockback, '连发、半自动与弓的击退档位顺序错误');
    assert(autoShot.knockbackFrames === 3, '连发武器击退持续时间未缩短');
    const zeroKnockbackProjectile = new Projectile(0, 0, 1, 0, 1, '#fff', 'player', { knockback: 0 });
    assert(zeroKnockbackProjectile.knockback === 0, '显式零击退被默认值覆盖');

    // 新碎片数值必须实际进入角色成长，装填加速仍保留安全上限。
    player.resetProgression();
    player.applyEnchant(ENCHANT_POOL.find(fragment => fragment.id === 'hp-1'));
    player.applyEnchant(ENCHANT_POOL.find(fragment => fragment.id === 'range-1'));
    assert(player.maxHp === CONFIG.PLAYER_MAX_HP + 24, '生命碎片没有提供 24 点生命上限');
    assert(player.weapon.getAttackRange(player.upgrades.range) === 54, '延展碎片没有提供 14 点近战范围');
    player.setWeapon(gun);
    player.applyEnchant(ENCHANT_POOL.find(fragment => fragment.id === 'reload-3'));
    assert(player.upgrades.reloadSpeed === 0.36, '装填碎片 III 没有提供 36% 装填加速');
    player.applyEnchant(ENCHANT_POOL.find(fragment => fragment.id === 'reload-3'));
    assert(player.upgrades.reloadSpeed === 0.55 && player.weapon.getReloadFrames(player.upgrades.reloadSpeed) === Math.round(gun.reloadFrames * 0.45), '装填加速安全上限失效');

    // 远程池没有射程碎片，同时枪械池包含弹容碎片。
    const rangedPool = ENCHANT_POOL.filter(fragment => fragment.class === 'all' || fragment.class === 'ranged');
    assert(!rangedPool.some(fragment => fragment.rangeBonus), '远程奖励池混入射程碎片');
    assert(rangedPool.some(fragment => fragment.ammoBonus), '远程奖励池缺少弹容碎片');

    // 护盾先承伤，溢出伤害再进入生命。
    currentWave = 3;
    gameState = 'playing';
    enemiesRemaining = 2;
    const warden = new Enemy(300, 200, 3, 'warden');
    assert(ENEMY_TYPES.warden.baseHp > 72, '护盾精英生命值没有提高');
    assert(ENEMY_TYPES.warden.shield >= 55 * 5, '护盾精英基础护盾不足原值的 5 倍');
    assert(warden.isEliteType && !warden.empowered, '护盾守卫没有作为固定精英类型');
    const hpBeforeShieldHit = warden.hp;
    const shieldBeforeHit = warden.shield;
    warden.takeDamage(10, 1, 4, 'shield-test-1');
    assert(warden.hp === hpBeforeShieldHit, '护盾未优先吸收伤害');
    assert(warden.shield === shieldBeforeHit - 10, '护盾扣减数值错误');
    warden.takeDamage(warden.shield + 5, 1, 4, 'shield-test-2');
    assert(warden.shield === 0 && warden.hp === hpBeforeShieldHit - 5, '破盾溢出伤害未进入生命');

    // 激光与护盾精英在同一波中各自最多出现一个；跃袭尸属于普通怪。
    assert(ENEMY_TYPES.leaper.leaper && !ENEMY_TYPES.leaper.elite, '跃袭尸没有作为普通怪接入');
    const leaper = new Enemy(220, 120, 4, 'leaper');
    leaper.onGround = true;
    leaper.leapCooldown = 0;
    leaper.update({ x: 350, y: 120, width: 28, height: 32, takeDamage() {} });
    assert(leaper.leapBoostFrames > 0 && Math.abs(leaper.leapVx) > leaper.speed, '跃袭尸没有执行扑击行为');
    const originalRandomForSpawns = Math.random;
    Math.random = () => 0.999;
    currentWave = 5;
    gameMode = 'story';
    spawnEnemiesForWave();
    Math.random = originalRandomForSpawns;
    assert(enemies.filter(enemy => enemy.type === 'warden').length === 1, '确定性生成下护盾精英不是恰好 1 个');
    assert(enemies.filter(enemy => enemy.type === 'prism').length === 1, '确定性生成下激光精英不是恰好 1 个');
    assert(enemies.filter(enemy => ['warden', 'prism'].includes(enemy.type)).every(enemy => enemy.isEliteType), '特殊敌人未标记为精英');
    assert(!['warden', 'prism'].includes(chooseEnemyType(5, { warden: 1, prism: 1 })), '达到单波上限后仍能抽到受限精英');

    // 混沌怪物只在无尽模式出现；同一种子稳定，不同种子产生有边界的外观和属性。
    const enemyTypesBeforeChaos = JSON.stringify(ENEMY_TYPES);
    const chaosA = createChaosProfile(21, 0x12345678);
    const chaosB = createChaosProfile(21, 0x12345678);
    assert(JSON.stringify(chaosA) === JSON.stringify(chaosB), '同一种子没有生成稳定的混沌怪物');
    const chaosSignatures = new Set();
    for (let seed = 1; seed <= 96; seed++) {
        const profile = createChaosProfile(31, seed);
        chaosSignatures.add([
            profile.baseType, profile.traitId, profile.mutationId, profile.color,
            profile.shape, profile.pattern, profile.eyeCount, profile.hornCount,
            profile.baseHp, profile.baseDmg, profile.speed
        ].join('|'));
        assert(Number.isFinite(profile.baseHp) && profile.baseHp >= 18 && profile.baseHp <= 190, '混沌怪物生命值越界');
        assert(Number.isFinite(profile.baseDmg) && profile.baseDmg >= 5 && profile.baseDmg <= 26, '混沌怪物攻击力越界');
        assert(Number.isFinite(profile.speed) && profile.speed >= 0.55 && profile.speed <= 3.2, '混沌怪物速度越界');
        assert(Number.isFinite(profile.knockResist) && profile.knockResist >= 0.55 && profile.knockResist <= 2.15, '混沌怪物抗击退越界');
        assert(profile.width >= 18 && profile.width <= 44 && profile.height >= 23 && profile.height <= 52, '混沌怪物体型越界');
        assert(profile.eyeCount >= 1 && profile.eyeCount <= 3 && profile.hornCount >= 0 && profile.hornCount <= 2, '混沌怪物外观参数越界');
        assert(!(profile.ranged && profile.leaper), '混沌怪物同时获得远程和跃袭行为');
    }
    assert(chaosSignatures.size >= 80, '混沌怪物随机组合的多样性不足');
    assert(JSON.stringify(ENEMY_TYPES) === enemyTypesBeforeChaos, '生成混沌怪物时污染了基础敌人配置');

    const chaosEnemy = new Enemy(250, 120, 21, 'chaos', chaosA);
    const chaosSnapshot = JSON.stringify(chaosEnemy.chaosProfile);
    assert(chaosEnemy.isChaos && !chaosEnemy.isEliteType && !chaosEnemy.empowered, '混沌怪物被错误归类为固定精英或强化怪');
    chaosEnemy.draw(ctx);
    chaosEnemy.draw(ctx);
    assert(JSON.stringify(chaosEnemy.chaosProfile) === chaosSnapshot, '绘制过程改变了混沌怪物的随机外观');

    gameMode = 'story';
    assert(!shouldSpawnChaosEnemy(21, 0, () => 0), '主线模式错误生成混沌怪物');
    gameMode = 'endless';
    assert(!shouldSpawnChaosEnemy(20, 0, () => 0), '无尽 Boss 波错误生成混沌怪物');
    assert(shouldSpawnChaosEnemy(21, 0, () => 0), '无尽普通波无法生成混沌怪物');
    assert(!shouldSpawnChaosEnemy(21, getChaosSpawnCap(21), () => 0), '混沌怪物超过单波数量上限');

    Math.random = () => 0;
    currentWave = CHAOS_SPAWN_RULES.startWave;
    const expectedEndlessEnemyCount = Math.min(
        CONFIG.MAX_ENEMIES_PER_WAVE,
        CONFIG.BASE_ENEMIES_PER_WAVE + Math.floor((currentWave - 1) * 1.35)
    );
    spawnEnemiesForWave();
    Math.random = originalRandomForSpawns;
    assert(enemies.filter(enemy => enemy.isChaos).length === getChaosSpawnCap(currentWave), '无尽波次没有按上限替换生成混沌怪物');
    assert(enemies.length === expectedEndlessEnemyCount && totalEnemiesInWave === expectedEndlessEnemyCount, '混沌怪物作为额外敌人改变了本波总量');
    gameMode = 'story';

    // 玩家投射物必须实际接入普通敌人的全局命中分支。
    player.setWeapon(gun);
    player.x = 40;
    player.y = 80;
    player.vx = 0;
    player.vy = 0;
    const projectileTarget = new Enemy(340, 80, 2, 'tank');
    const targetHpBefore = projectileTarget.hp;
    enemies = [projectileTarget];
    enemiesRemaining = 2;
    totalEnemiesInWave = 2;
    activeBoss = null;
    projectiles.length = 0;
    projectiles.push(new Projectile(345, 90, 0, 0, 7, '#fff', 'player', { gravity: 0 }));
    gameState = 'playing';
    update();
    assert(projectileTarget.hp === targetHpBefore - 7, '玩家远程投射物未伤害普通敌人');

    // 激光必须经过蓄力，再进入发射阶段且一次爆发只伤害一次。
    const prism = new Enemy(220, 200, 5, 'prism');
    player.x = 300;
    player.y = 200;
    player.hp = player.maxHp;
    player.invincible = 0;
    prism.laserDirection = 1;
    prism.laserY = player.y + player.height / 2;
    prism.laserCharge = 1;
    const hpBeforeLaser = player.hp;
    prism.updateLaser(player, player.x - prism.x);
    assert(prism.laserFire === CONFIG.LASER_FIRE_FRAMES, '激光蓄力结束后未进入发射阶段');
    assert(player.hp === hpBeforeLaser, '激光在蓄力阶段提前造成伤害');
    prism.updateLaser(player, player.x - prism.x);
    const hpAfterLaser = player.hp;
    player.invincible = 0;
    prism.updateLaser(player, player.x - prism.x);
    assert(hpAfterLaser < hpBeforeLaser, '激光发射阶段未造成伤害');
    assert(player.hp === hpAfterLaser, '同一激光爆发重复结算伤害');

    const previousPlayerX = player.x;
    camera.x = 0;
    player.x = 600;
    const offscreenPrism = new Enemy(1050, 200, 5, 'prism');
    offscreenPrism.laserCooldown = 0;
    offscreenPrism.updateLaser(player, player.x - offscreenPrism.x);
    assert(offscreenPrism.laserCharge === 0, '屏外激光精英仍能开始蓄力');
    player.x = previousPlayerX;

    // 主线第 10 波通关后进入无尽奖励，选择后从第 11 波开始；第 20 波仍为 Boss。
    player.invincible = 0;
    player.hp = player.maxHp;
    gameMode = 'story';
    currentWave = CONFIG.BOSS_WAVE;
    gameState = 'playing';
    waveCompletionHandled = false;
    onWaveComplete();
    assert(gameState === 'win', '主线第 10 波未进入通关选择');
    startEndlessMode();
    assert(gameMode === 'endless' && gameState === 'reward' && currentWave === 10, '无尽模式入口状态错误');
    assert(!weaponRewardRefreshAvailable, '无尽模式的碎片奖励错误继承了武器刷新机会');
    chooseReward(0);
    assert(gameState === 'playing' && currentWave === 11, '无尽模式未从第 11 波开始');
    assert(isBossWave(20), '无尽模式第 20 波不是周期 Boss');
    currentWave = 12;
    gameState = 'playing';
    waveCompletionHandled = false;
    prepareWaveRewards();
    assert(currentRewardType === 'weapon' && rewardQueue.includes('enchant'), '无尽武器奖励后没有继续提供永久属性碎片');

    // 武器奖励可整组刷新或保留当前武器；刷新不消费后续奖励，跳过仍进入碎片奖励。
    assert(typeof refreshWeaponReward === 'function' && typeof skipWeaponReward === 'function', '缺少武器奖励刷新或跳过功能');
    assert(WEAPON_REWARD_BUTTONS.refresh && WEAPON_REWARD_BUTTONS.skip, '缺少武器奖励操作按钮布局');
    assert(Object.values(WEAPON_REWARD_BUTTONS).every(button => button.y > 420 && button.y + button.h <= CONFIG.CANVAS_HEIGHT), '武器奖励按钮遮挡卡片或超出画布');
    assert(weaponRewardRefreshAvailable, '新的武器奖励页没有刷新机会');
    const equippedBeforeRefresh = player.weapon;
    const queueBeforeRefresh = JSON.stringify(rewardQueue);
    const namesBeforeRefresh = new Set(weaponChoices.map(weapon => weapon.name));
    assert(refreshWeaponReward(), '武器奖励全部刷新失败');
    assert(player.weapon === equippedBeforeRefresh, '刷新武器选项时错误更换了装备');
    assert(JSON.stringify(rewardQueue) === queueBeforeRefresh, '刷新武器选项时错误消费了后续奖励');
    assert(weaponChoices.length === 3 && weaponChoices.every(weapon => !namesBeforeRefresh.has(weapon.name)), '全部刷新后仍保留旧武器卡或不足三张');
    assert(!weaponRewardRefreshAvailable, '成功刷新后仍保留刷新机会');
    const choicesAfterRefresh = weaponChoices.map(weapon => weapon.name).join('|');
    assert(!refreshWeaponReward(), '同一武器奖励页允许第二次刷新');
    assert(weaponChoices.map(weapon => weapon.name).join('|') === choicesAfterRefresh, '第二次刷新调用修改了武器选项');
    assert(JSON.stringify(rewardQueue) === queueBeforeRefresh, '第二次刷新调用消费了后续奖励');
    mouseX = WEAPON_REWARD_BUTTONS.refresh.x + 10;
    mouseY = WEAPON_REWARD_BUTTONS.refresh.y + 10;
    updateHoveredChoice();
    assert(hoveredRewardAction !== 'refresh', '刷新机会用完后按钮仍可悬停点击');
    assert(skipWeaponReward(), '跳过新武器失败');
    assert(gameState === 'reward' && currentRewardType === 'enchant', '跳过新武器后未进入本关碎片奖励');
    assert(!weaponRewardRefreshAvailable, '进入碎片奖励后仍残留武器刷新机会');
    assert(player.weapon === equippedBeforeRefresh, '跳过新武器却更换了当前装备');
    rewardQueue = ['weapon'];
    openNextReward();
    assert(currentRewardType === 'weapon' && weaponRewardRefreshAvailable, '下一次武器奖励页没有恢复一次刷新机会');

    // 无尽死亡生成不可变结算快照，并停止所有音乐。
    runStats = createRunStats('story', 0);
    gameMode = 'endless';
    beginEndlessStats(1000);
    currentWave = 17;
    runStats.endlessKills = 23;
    runStats.endlessEliteKills = 4;
    runStats.endlessBossKills = 1;
    runStats.endlessWavesCleared = 6;
    runStats.endlessDamageDealt = 1234.5;
    runStats.endlessDamageTaken = 321;
    runStats.endlessMeleeAttacks = 18;
    runStats.endlessRangedAttacks = 27;
    runStats.endlessProjectilesFired = 31;
    runStats.endlessWeaponsClaimed = 2;
    runStats.endlessFragmentsClaimed = 7;
    runStats.endlessActivePlayMs = 60000;
    player.setWeapon(new Weapon(WEAPON_DATABASE.LEGENDARY.find(item => item.model === 'spear'), 'LEGENDARY'));
    player.upgrades.damage = 14;
    gameState = 'playing';
    musicPlaying = true;
    currentMusicKey = 'plains';
    bossMusicPlaying = true;
    assert(enterGameOver('laser', 61000), '无尽死亡未进入结算状态');
    assert(gameState === 'gameover' && lastRunSummary.mode === 'endless', '无尽死亡总结类型错误');
    assert(lastRunSummary.reachedWave === 17 && lastRunSummary.wavesCleared === 6, '无尽止步波次或完成波数错误');
    assert(lastRunSummary.kills === 23 && lastRunSummary.eliteKills === 4 && lastRunSummary.bossKills === 1, '无尽击杀统计错误');
    assert(lastRunSummary.durationMs === 60000 && lastRunSummary.damageDealt === 1234.5, '无尽时长或伤害统计错误');
    assert(lastRunSummary.weaponsClaimed === 2 && lastRunSummary.fragmentsClaimed === 7, '无尽奖励选择统计错误');
    assert(!musicPlaying && !bossMusicPlaying && currentMusicKey === null, '死亡后音乐没有全部停止');
    const frozenSummary = lastRunSummary;
    const frozenUpgradeDamage = frozenSummary.upgrades.damage;
    player.upgrades.damage = 999;
    assert(frozenSummary.upgrades.damage === frozenUpgradeDamage, '死亡总结不是不可变数据快照');
    restartGame();
    assert(gameState === 'playing' && gameMode === 'story' && currentWave === 1, '重新远征没有从主线第 1 波开始');
    assert(runStats.kills === 0 && lastRunSummary === null, '重新远征没有清空旧统计');
    assert(!weaponRewardRefreshAvailable, '重新远征后残留武器刷新机会');

    // 存活时间只累计真正运行的逻辑帧；页面暂停会停止并清理音乐。
    gameState = 'playing';
    gameMode = 'endless';
    runStats = createRunStats('endless');
    recordActivePlayTime(FIXED_STEP_MS);
    assert(Math.abs(runStats.activePlayMs - FIXED_STEP_MS) < 1e-9 && Math.abs(runStats.endlessActivePlayMs - FIXED_STEP_MS) < 1e-9, '有效游玩时长未按逻辑帧累计');
    assert(formatDuration(FIXED_STEP_MS * 60) === '0:01', '60Hz 浮点累计导致存活时间少显示 1 秒');
    gameState = 'reward';
    recordActivePlayTime(1000);
    assert(Math.abs(runStats.activePlayMs - FIXED_STEP_MS) < 1e-9, '奖励页面时间被计入存活时长');
    gameState = 'playing';
    pagePaused = false;
    musicPlaying = true;
    currentMusicKey = 'plains';
    setPagePaused(true);
    assert(pagePaused && !musicPlaying && currentMusicKey === null, '页面暂停时没有清理地形音乐');
    setPagePaused(false);

    // 同帧最后击杀与致命敌弹必须始终先判玩家死亡，不能依赖弹丸数组顺序。
    const resolveMutualHit = incomingFirst => {
        clearInputState();
        gameMode = 'story';
        currentWave = 2;
        gameState = 'playing';
        waveCompletionHandled = false;
        runStats = createRunStats('story');
        lastRunSummary = null;
        activeBoss = null;
        player.setWeapon(gun);
        player.x = 80;
        player.y = 0;
        player.vx = 0;
        player.vy = 0;
        player.hp = 5;
        player.invincible = 0;
        player.attacking = false;
        player.reloadTimer = 0;
        const finalEnemy = new Enemy(360, 0, 1, 'zombie');
        finalEnemy.speed = 0;
        enemies = [finalEnemy];
        enemiesRemaining = 1;
        totalEnemiesInWave = 1;
        projectiles.length = 0;
        const incoming = new Projectile(player.x + 4, player.y + 4, 0, 0, 999, '#f00', 'enemy', { size: 18, gravity: 0 });
        const outgoing = new Projectile(finalEnemy.x + finalEnemy.width / 2, finalEnemy.y + finalEnemy.height / 2, 0, 0, finalEnemy.hp + 1, '#0ff', 'player', { size: 18, gravity: 0 });
        projectiles.push(...(incomingFirst ? [incoming, outgoing] : [outgoing, incoming]));
        update();
        return gameState;
    };
    assert(resolveMutualHit(true) === 'gameover', '同帧互杀在敌弹先入数组时没有判定死亡');
    assert(resolveMutualHit(false) === 'gameover', '同帧互杀在玩家弹先入数组时没有判定死亡');
    restartGame();

    // 生命周期清理不允许残弹跨波。
    projectiles.push(new Projectile(1, 1, 1, 0, 1, '#fff', 'enemy'));
    clearCombatTransients(true);
    assert(projectiles.length === 0, '战斗瞬态清理后仍有残留弹幕');

    // 触屏全屏、禁止长按、换弹键与状态可见性。
    assert(/data-action="reload"[^>]*aria-label="手动换弹"/.test(sourceHtml), '触屏区缺少明确的换弹按钮');
    assert(sourceHtml.includes('-webkit-touch-callout: none') && sourceHtml.includes('user-select: none'), '触屏按钮缺少长按选择保护');
    assert(/id="touchPauseButton"[^>]*aria-label="暂停游戏"/.test(sourceHtml), '触屏区缺少顶部暂停键');
    assert(/id="pauseMenu"[^>]*role="dialog"/.test(sourceHtml), '缺少可访问的暂停菜单');
    assert(sourceHtml.includes('pixel-sword-shape') && sourceHtml.includes('pixel-boot') && sourceHtml.includes('pixel-heart'), '触屏操作没有使用像素图标');
    assert(sourceHtml.includes('.touch-btn.attack-btn') && sourceHtml.includes('--touch-arc-near'), '右侧操作键没有采用攻击键为核心的弧形布局');
    const boundTouchButtons = touchControlsEl.querySelectorAll('.touch-btn');
    assert(boundTouchButtons.length === 6, '触屏按钮数量或事件绑定对象不完整');
    assert(
        boundTouchButtons.map(button => button.dataset.action).sort().join(',') === ['left', 'right', 'jump', 'reload', 'attack', 'heal'].sort().join(','),
        '实际 HTML 的触屏 action 集合不完整'
    );

    const previousInitAudio = initAudio;
    const previousStartMusic = startMusic;
    const gestureOrder = [];
    initAudio = () => { gestureOrder.push('audio'); };
    startMusic = () => {};

    const dispatchKey = (code, repeat = false) => {
        const event = {
            type: 'keydown',
            code,
            repeat,
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() {}
        };
        window.dispatchEvent(event);
        return event;
    };

    restartGame();
    disableTouchMode();
    const pauseKey = dispatchKey('Escape');
    assert(pauseKey.defaultPrevented && manualPaused && pagePaused, 'Esc 没有暂停战斗');
    assert(pauseMenuEl.getAttribute('aria-hidden') === 'false', 'Esc 暂停后菜单没有显示');
    assert(pauseTouchSizeRowEl.hidden && touchSizeSliderEl.disabled, '电脑模式错误显示触屏按键大小设置');
    const pausedActiveTime = runStats.activePlayMs;
    gameLoop(previousFrameTime + FIXED_STEP_MS * 3);
    assert(runStats.activePlayMs === pausedActiveTime, '暂停时逻辑循环仍累计有效战斗时间');
    const pausedAttackButton = boundTouchButtons.find(button => button.dataset.action === 'attack');
    pausedAttackButton.dispatchEvent({
        type: 'pointerdown',
        pointerId: 17,
        preventDefault() {},
        stopPropagation() {}
    });
    assert(!mousePressed && !touchActive.attack, '暂停时触屏攻击键仍写入输入状态');
    dispatchKey('Escape', true);
    assert(manualPaused, '长按 Esc 的重复 keydown 意外恢复了游戏');
    dispatchKey('KeyJ');
    assert(!keys.KeyJ, '暂停时仍接收战斗按键');
    window.dispatchEvent({ type: 'blur' });
    window.dispatchEvent({ type: 'focus' });
    assert(manualPaused && pagePaused, '窗口失焦再聚焦后手动暂停被意外解除');
    dispatchKey('Escape');
    assert(!manualPaused && !pagePaused && pauseMenuEl.getAttribute('aria-hidden') === 'true', 'Esc 没有恢复游戏并关闭菜单');
    window.dispatchEvent({ type: 'blur' });
    assert(pagePaused && !manualPaused, '窗口失焦没有自动暂停');
    window.dispatchEvent({ type: 'focus' });
    assert(!pagePaused, '窗口重新聚焦后没有恢复自动暂停');

    enableTouchMode(false);
    assert(!pauseTouchSizeRowEl.hidden && !touchSizeSliderEl.disabled, '触屏暂停菜单没有启用按键大小设置');
    const touchPauseEvent = {
        type: 'click',
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {}
    };
    touchPauseButtonEl.dispatchEvent(touchPauseEvent);
    assert(touchPauseEvent.defaultPrevented && manualPaused && touchControlsEl.classList.contains('paused'), '顶部触屏暂停键没有暂停游戏');
    touchPauseButtonEl.dispatchEvent({
        type: 'click',
        preventDefault() {},
        stopPropagation() {}
    });
    assert(!manualPaused && !pagePaused && pauseMenuEl.getAttribute('aria-hidden') === 'true', '顶部触屏暂停键无法再次点击恢复游戏');
    touchPauseButtonEl.dispatchEvent({
        type: 'click',
        preventDefault() {},
        stopPropagation() {}
    });
    pauseContinueButtonEl.dispatchEvent({ type: 'click' });
    assert(!manualPaused && pauseMenuEl.getAttribute('aria-hidden') === 'true', '继续游戏按钮没有关闭暂停菜单');

    currentWave = 7;
    gameMode = 'endless';
    killCount = 19;
    touchPauseButtonEl.dispatchEvent({
        type: 'click',
        preventDefault() {},
        stopPropagation() {}
    });
    pauseRestartButtonEl.dispatchEvent({ type: 'click' });
    assert(gameState === 'playing' && gameMode === 'story' && currentWave === 1 && killCount === 0, '暂停菜单的重新开始没有重置主线');
    assert(!manualPaused && !pagePaused && pauseMenuEl.getAttribute('aria-hidden') === 'true', '重新开始后暂停状态没有清理');

    musicGain = { gain: { value: 0 } };
    sfxGain = { gain: { value: 0 } };
    volumeSliderEl.value = '0';
    volumeSliderEl.dispatchEvent({ type: 'input' });
    assert(musicGain.gain.value === 0 && sfxGain.gain.value === 0 && volumeValueEl.textContent === '0%', '音量滑条无法完全静音');
    volumeSliderEl.value = '40';
    volumeSliderEl.dispatchEvent({ type: 'input' });
    assert(Math.abs(musicGain.gain.value - 0.048) < 1e-9 && Math.abs(sfxGain.gain.value - 0.12) < 1e-9, '音量滑条没有同步调节音乐与音效');
    assert(volumeValueEl.textContent === '40%', '音量滑条数值没有更新');

    touchSizeSliderEl.value = '75';
    touchSizeSliderEl.dispatchEvent({ type: 'input' });
    const smallTouchButton = parseFloat(document.documentElement.style.getPropertyValue('--touch-btn-size'));
    touchSizeSliderEl.value = '135';
    touchSizeSliderEl.dispatchEvent({ type: 'input' });
    const largeTouchButton = parseFloat(document.documentElement.style.getPropertyValue('--touch-btn-size'));
    assert(largeTouchButton > smallTouchButton, '触屏按键大小滑条没有改变实际布局');
    assert(touchSizeValueEl.textContent === '135%', '触屏按键大小数值没有更新');
    updateTouchControlsLayout();
    assert(parseFloat(document.documentElement.style.getPropertyValue('--touch-btn-size')) === largeTouchButton, '重新计算布局后触屏按键缩放倍率丢失');
    window.visualViewport.width = 360;
    window.visualViewport.height = 240;
    updateTouchControlsLayout();
    const narrowButton = parseFloat(document.documentElement.style.getPropertyValue('--touch-btn-size'));
    const narrowGap = parseFloat(document.documentElement.style.getPropertyValue('--touch-gap'));
    const narrowOffset = parseFloat(document.documentElement.style.getPropertyValue('--touch-offset'));
    const narrowActionWidth = parseFloat(document.documentElement.style.getPropertyValue('--touch-action-width'));
    assert(2 * narrowButton + narrowGap + narrowActionWidth + 2 * narrowOffset <= 360, '窄横屏最大按键尺寸导致左右操作区重叠');
    assert(['1', '2'].includes(document.documentElement.style.getPropertyValue('--touch-icon-scale')), '像素图标使用了会产生亚像素模糊的连续缩放');
    window.visualViewport.width = 1280;
    window.visualViewport.height = 720;
    updateTouchControlsLayout();

    const prepareTouchModeClick = () => {
        gestureOrder.length = 0;
        gameState = 'title';
        touchMode = false;
        document.fullscreenElement = null;
        document.webkitFullscreenElement = null;
        document.msFullscreenElement = null;
        document.webkitIsFullScreen = false;
    };
    const makeTitlePointerEvent = (type, pointerType, pointerId = 1) => ({
        type,
        button: 0,
        pointerType,
        pointerId,
        clientX: TITLE_BUTTONS.touch.x + TITLE_BUTTONS.touch.w / 2,
        clientY: TITLE_BUTTONS.touch.y + TITLE_BUTTONS.touch.h / 2,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {}
    });

    let standardCalls = 0;
    let standardReceiver = null;
    let standardOptions = null;
    document.documentElement.requestFullscreen = function (options) {
        gestureOrder.push('fullscreen');
        standardCalls++;
        standardReceiver = this;
        standardOptions = options;
        document.fullscreenElement = this;
        document.dispatchEvent({ type: 'fullscreenchange' });
        return Promise.resolve();
    };
    prepareTouchModeClick();
    canvas.dispatchEvent(makeTitlePointerEvent('pointerdown', 'touch', 11));
    assert(standardCalls === 0 && gameState === 'title', '触屏在 pointerdown 阶段提前请求全屏或开局');
    canvas.dispatchEvent(makeTitlePointerEvent('pointerup', 'touch', 11));
    assert(standardCalls === 1, '触屏 pointerup 没有调用 requestFullscreen');
    assert(gestureOrder[0] === 'fullscreen' && gestureOrder[1] === 'audio', '全屏请求不是手势链中的首个受限调用');
    assert(standardReceiver === document.documentElement, '网页全屏没有优先使用根元素');
    assert(standardOptions && standardOptions.navigationUI === 'hide', '标准全屏请求没有隐藏浏览器导航界面');
    assert(document.fullscreenElement === document.documentElement, '全屏成功后 fullscreenElement 未更新');
    assert(fullscreenButtonEl.style.display === 'none', '已经全屏仍显示全屏重试按钮');
    assert(gameState === 'playing' && touchMode, '标准全屏申请后没有进入触屏游戏');

    delete document.documentElement.requestFullscreen;
    let webkitCalls = 0;
    gameContainer.webkitRequestFullscreen = function () {
        gestureOrder.push('fullscreen');
        webkitCalls++;
        document.webkitFullscreenElement = this;
    };
    prepareTouchModeClick();
    canvas.dispatchEvent(makeTitlePointerEvent('pointerdown', 'touch', 12));
    canvas.dispatchEvent(makeTitlePointerEvent('pointerup', 'touch', 12));
    assert(webkitCalls === 1, '缺少标准 API 时没有调用 WebKit 全屏接口');
    assert(gameState === 'playing' && touchMode, 'WebKit 全屏申请后没有进入触屏游戏');

    delete gameContainer.webkitRequestFullscreen;
    let rejectionHandled = false;
    document.documentElement.requestFullscreen = () => ({
        catch(handler) {
            rejectionHandled = true;
            handler(new Error('fullscreen denied'));
        }
    });
    prepareTouchModeClick();
    canvas.dispatchEvent(makeTitlePointerEvent('pointerdown', 'touch', 13));
    canvas.dispatchEvent(makeTitlePointerEvent('pointerup', 'touch', 13));
    assert(rejectionHandled, '没有处理全屏 Promise 拒绝');
    assert(fullscreenButtonEl.style.display === 'block', '全屏被拒绝后没有提供重试按钮');
    assert(gameState === 'playing' && touchMode, '全屏 Promise 拒绝阻断了进入触屏游戏');

    document.documentElement.requestFullscreen = () => {
        throw new Error('fullscreen unavailable');
    };
    prepareTouchModeClick();
    let synchronousFailureEscaped = false;
    try {
        canvas.dispatchEvent(makeTitlePointerEvent('pointerdown', 'mouse', 14));
    } catch (error) {
        synchronousFailureEscaped = true;
    }
    assert(!synchronousFailureEscaped, '同步全屏异常逃逸到点击处理器');
    assert(gameState === 'playing' && touchMode, '同步全屏异常阻断了进入触屏游戏');

    delete document.documentElement.requestFullscreen;
    prepareTouchModeClick();
    canvas.dispatchEvent(makeTitlePointerEvent('pointerdown', 'touch', 15));
    canvas.dispatchEvent(makeTitlePointerEvent('pointerup', 'touch', 15));
    assert(gameState === 'playing' && touchMode, '无全屏 API 时没有进入沉浸触屏模式');
    assert(fullscreenButtonEl.style.display === 'none', '不支持全屏的浏览器仍显示无效全屏按钮');
    assert(gameContainer.style.width === '1280px' && gameContainer.style.height === '720px', '沉浸触屏容器没有铺满动态视口');

    let policyBlockedCalls = 0;
    document.fullscreenEnabled = false;
    document.documentElement.requestFullscreen = () => {
        policyBlockedCalls++;
        return Promise.reject(new Error('fullscreen policy blocked'));
    };
    prepareTouchModeClick();
    canvas.dispatchEvent(makeTitlePointerEvent('pointerdown', 'touch', 16));
    canvas.dispatchEvent(makeTitlePointerEvent('pointerup', 'touch', 16));
    assert(policyBlockedCalls === 0, '全屏策略已禁止时仍发起请求');
    assert(gameState === 'playing' && touchMode, '全屏策略禁止时没有进入沉浸触屏模式');
    assert(fullscreenButtonEl.style.display === 'none', '全屏策略禁止时仍显示无效重试按钮');
    document.fullscreenEnabled = true;
    delete document.documentElement.requestFullscreen;

    for (const eventType of ['contextmenu', 'selectstart', 'dragstart']) {
        for (const button of [...boundTouchButtons, touchPauseButtonEl]) {
            const event = {
                type: eventType,
                defaultPrevented: false,
                preventDefault() { this.defaultPrevented = true; },
                stopPropagation() {}
            };
            button.dispatchEvent(event);
            assert(event.defaultPrevented, (button.dataset.action || 'pause') + ' 的 ' + eventType + ' 没有冒泡到触屏层并被阻止');
        }
    }

    const reloadButton = boundTouchButtons.find(button => button.dataset.action === 'reload');
    gameState = 'playing';
    touchMode = true;
    syncTouchControlsVisibility();
    player.setWeapon(new Weapon(WEAPON_DATABASE.COMMON.find(item => item.model === 'sword'), 'COMMON'));
    assert(reloadButtonEl.hidden && reloadButtonEl.disabled && reloadButtonEl.getAttribute('aria-hidden') === 'true', '近战武器仍显示触屏换弹键');
    player.setWeapon(gun);
    assert(!reloadButtonEl.hidden && !reloadButtonEl.disabled && reloadButtonEl.getAttribute('aria-hidden') === 'false', '远程武器没有即时显示触屏换弹键');
    player.ammo = Math.max(0, player.getMagazineSize() - 1);
    player.reloadTimer = 0;
    const reloadPointer = {
        type: 'pointerdown',
        pointerId: 21,
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {}
    };
    reloadButton.dispatchEvent(reloadPointer);
    assert(reloadPointer.defaultPrevented && player.reloadTimer > 0, '触屏换弹键没有启动手动装填');
    reloadButton.dispatchEvent({ ...reloadPointer, type: 'pointerup', preventDefault() {}, stopPropagation() {} });
    assert(!touchActive.reload, '松开换弹键后触屏状态没有复位');

    gameState = 'reward';
    syncTouchControlsVisibility();
    assert(touchControlsEl.style.display === 'none', '奖励页仍显示并拦截触屏战斗按钮');
    gameState = 'playing';
    syncTouchControlsVisibility();
    assert(touchControlsEl.style.display === 'block', '回到战斗后触屏按钮没有恢复');

    // 无 Pointer Events 的旧 Safari/WebView 也必须能点击标题、奖励、通关和死亡界面。
    const previousHandleTitleClick = handleTitleClick;
    const previousHandleRewardClick = handleRewardClick;
    const previousHandleWinClick = handleWinClick;
    const previousHandleGameOverClick = handleGameOverClick;
    const legacyCanvasRoutes = [];
    handleTitleClick = () => { legacyCanvasRoutes.push('title'); };
    handleRewardClick = () => { legacyCanvasRoutes.push('reward'); };
    handleWinClick = () => { legacyCanvasRoutes.push('win'); };
    handleGameOverClick = () => { legacyCanvasRoutes.push('gameover'); };
    const legacyTouchEnd = () => ({
        type: 'touchend',
        changedTouches: [{ clientX: 480, clientY: 270 }],
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {}
    });
    for (const state of ['title', 'reward', 'win', 'gameover']) {
        gameState = state;
        const event = legacyTouchEnd();
        canvas.dispatchEvent(event);
        assert(event.defaultPrevented, '旧触屏 ' + state + ' 点击没有阻止浏览器默认手势');
    }
    assert(legacyCanvasRoutes.join(',') === 'title,reward,win,gameover', '旧触屏 Canvas 状态路由不完整');
    handleTitleClick = previousHandleTitleClick;
    handleRewardClick = previousHandleRewardClick;
    handleWinClick = previousHandleWinClick;
    handleGameOverClick = previousHandleGameOverClick;

    delete gameContainer.webkitRequestFullscreen;
    initAudio = previousInitAudio;
    startMusic = previousStartMusic;
    disableTouchMode();

    assert(FIXED_STEP_MS === 1000 / 60, '逻辑循环不是固定 60Hz 步长');
    console.log('game logic smoke tests: OK');
`;

const execute = new Function(
    'window',
    'document',
    'requestAnimationFrame',
    'performance',
    'sourceHtml',
    match[1] + assertions
);

execute(windowMock, documentMock, () => 0, globalThis.performance, html);
