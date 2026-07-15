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
    return {
        style: {},
        textContent: '',
        classList: { add() {}, remove() {} },
        addEventListener(type, handler) {
            if (!listeners[type]) listeners[type] = [];
            listeners[type].push(handler);
        },
        dispatchEvent(event) {
            for (const handler of listeners[event.type] || []) {
                handler.call(this, event);
            }
            return !event.defaultPrevented;
        },
        setAttribute() {},
        querySelectorAll() { return []; },
        getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 540 }; },
        setPointerCapture() {}
    };
}

const canvas = makeElement();
canvas.getContext = () => ctx;
const elements = {
    gameCanvas: canvas,
    gameContainer: makeElement(),
    instructions: makeElement(),
    touchControls: makeElement(),
    rotateHint: makeElement(),
    liveStatus: makeElement()
};

const documentMock = {
    hidden: false,
    fullscreenElement: null,
    documentElement: { style: { setProperty() {} } },
    getElementById(id) { return elements[id]; },
    addEventListener() {}
};

const windowMock = {
    innerWidth: 1280,
    innerHeight: 720,
    addEventListener() {},
    matchMedia() { return { matches: false }; },
    setTimeout(callback) { callback(); return 0; },
    visualViewport: { addEventListener() {} }
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

    // 触摸/手写笔要在 pointerup 的用户激活阶段请求全屏；失败不能阻断开局。
    const previousInitAudio = initAudio;
    const previousStartMusic = startMusic;
    initAudio = () => {};
    startMusic = () => {};
    const prepareTouchModeClick = () => {
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
        preventDefault() { this.defaultPrevented = true; }
    });

    let standardCalls = 0;
    let standardReceiver = null;
    let standardOptions = null;
    gameContainer.requestFullscreen = function (options) {
        standardCalls++;
        standardReceiver = this;
        standardOptions = options;
        return Promise.resolve();
    };
    delete gameContainer.webkitRequestFullscreen;
    delete gameContainer.webkitRequestFullScreen;
    prepareTouchModeClick();
    canvas.dispatchEvent(makeTitlePointerEvent('pointerdown', 'touch', 11));
    assert(standardCalls === 0 && gameState === 'title', '触屏在 pointerdown 阶段提前请求全屏或开局');
    canvas.dispatchEvent(makeTitlePointerEvent('pointerup', 'touch', 11));
    assert(standardCalls === 1, '触屏 pointerup 没有调用 requestFullscreen');
    assert(standardReceiver === gameContainer, 'requestFullscreen 调用对象错误');
    assert(standardOptions && standardOptions.navigationUI === 'hide', '标准全屏请求没有隐藏浏览器导航界面');
    assert(gameState === 'playing' && touchMode, '标准全屏申请后没有进入触屏游戏');

    delete gameContainer.requestFullscreen;
    let webkitCalls = 0;
    gameContainer.webkitRequestFullscreen = function () {
        webkitCalls++;
    };
    prepareTouchModeClick();
    canvas.dispatchEvent(makeTitlePointerEvent('pointerdown', 'touch', 12));
    canvas.dispatchEvent(makeTitlePointerEvent('pointerup', 'touch', 12));
    assert(webkitCalls === 1, '缺少标准 API 时没有调用 WebKit 全屏接口');
    assert(gameState === 'playing' && touchMode, 'WebKit 全屏申请后没有进入触屏游戏');

    delete gameContainer.webkitRequestFullscreen;
    let rejectionHandled = false;
    gameContainer.requestFullscreen = () => ({
        catch(handler) {
            rejectionHandled = true;
            handler(new Error('fullscreen denied'));
        }
    });
    prepareTouchModeClick();
    canvas.dispatchEvent(makeTitlePointerEvent('pointerdown', 'touch', 13));
    canvas.dispatchEvent(makeTitlePointerEvent('pointerup', 'touch', 13));
    assert(rejectionHandled, '没有处理全屏 Promise 拒绝');
    assert(gameState === 'playing' && touchMode, '全屏 Promise 拒绝阻断了进入触屏游戏');

    gameContainer.requestFullscreen = () => {
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

    delete gameContainer.requestFullscreen;
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
    match[1] + assertions
);

execute(windowMock, documentMock, () => 0, globalThis.performance);
