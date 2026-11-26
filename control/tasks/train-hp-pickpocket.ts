import { runScript } from '../../sdk/runner';

const goal = 60;
const swords = [
    [30, 'Adamant longsword'], [20, 'Mithril longsword'], [5, 'Steel longsword'], [1, 'Iron longsword'],
] as const;
const heal = /^(?:bread|cake|2\/3 cake|slice of cake|chocolate slice|cooked chicken|cooked meat|shrimp|trout|salmon|jug of wine)$/i;
const attackable = /^attack$/i;
const pocket = /^pickpocket$/i;
const guards = /^guard$/i;
const knights = /^knight of ardougne$/i;
const heroes = /^hero$/i;
const guardSpots = [[2651, 3307], [2660, 3308], [2635, 3339]] as const;
const heroSpots = [[2630, 3288], [2642, 3297], [2652, 3318]] as const;
const log = (stage: string, fields: object = {}) =>
    console.log('[pickpocket-demo] ' + JSON.stringify({ stage, ...fields }));

const result = await runScript(async ({ bot, sdk }) => {
    await sdk.waitForReady();
    const level = (name: string) => sdk.getSkill(name)?.baseLevel ?? 0;
    const distance = (x: number, z: number) => {
        const p = sdk.getState()?.player;
        return p && p.level === 0 ? Math.max(Math.abs(p.worldX - x), Math.abs(p.worldZ - z)) : Infinity;
    };
    const metrics = () => {
        const state = sdk.getState();
        const p = state?.player;
        return {
            tick: state?.tick, x: p?.worldX, z: p?.worldZ, hp: p?.hp, maxHp: p?.maxHp,
            hitpoints: level('Hitpoints'), hitpointsXp: sdk.getSkill('Hitpoints')?.experience,
            attack: level('Attack'), strength: level('Strength'), defence: level('Defence'),
            thieving: level('Thieving'), thievingXp: sdk.getSkill('Thieving')?.experience,
            coins: sdk.countInventoryItems(/^coins$/i),
        };
    };
    const closest = (name: RegExp, option: RegExp, combat = false) =>
        sdk.getState()?.nearbyNpcs.filter(npc => name.test(npc.name) && npc.reachable !== false &&
            npc.optionsWithIndex.some(entry => option.test(entry.text)) && (!combat || !npc.inCombat))
            .sort((a, b) => a.distance - b.distance)[0];
    const travel = async (x: number, z: number, tolerance: number, timeout: number) => {
        if (distance(x, z) <= tolerance) return true;
        const walked = await bot.walkTo(x, z, tolerance, { timeout });
        const arrived = distance(x, z) <= tolerance;
        if (!arrived) log('walk-incomplete', { destination: [x, z], message: walked.message, ...metrics() });
        return arrived;
    };
    const buySwords = async () => {
        if (swords.every(([, name]) => sdk.findInventoryItem(name) || sdk.getState()?.equipment.some(item => item.name === name))) return;
        if (!await travel(3203, 3397, 3, 110_000)) return;
        const keeper = closest(/^shop (?:keeper|assistant)$/i, /trade/i);
        if (!keeper || !(await bot.openShop(keeper)).success) return;
        try {
            const stock = sdk.getState()?.shop.shopItems ?? [];
            for (const [, name] of [...swords].reverse()) {
                if (sdk.findInventoryItem(name) || sdk.getState()?.equipment.some(item => item.name === name)) continue;
                const offer = stock.find(item => item.name === name && item.count > 0);
                if (offer) {
                    const bought = await bot.buyFromShop(name, 1);
                    log('equipment-purchase', { item: name, bought: bought.amountBought ?? 0, ...metrics() });
                }
            }
        } finally {
            await bot.closeShop();
        }
    };
    const equipBest = async () => {
        const equipped = sdk.getState()?.equipment.find(item => item.slot === 3);
        for (const [required, name] of swords) {
            if (level('Attack') < required) continue;
            if (equipped?.name === name) return;
            const item = sdk.findInventoryItem(name);
            if (item && (await bot.equipItem(item)).success) {
                log('equipment-upgrade', { item: name, ...metrics() });
                return;
            }
        }
        if (!equipped) {
            const starter = sdk.findInventoryItem(/bronze (?:sword|dagger|axe)/i);
            if (starter) await bot.equipItem(starter);
        }
    };
    const trainStyle = async () => {
        const goalAttack = level('Attack') < 30;
        const skill = goalAttack && level('Attack') <= level('Strength') + 7 ? 'Attack'
            : level('Defence') < 20 && level('Hitpoints') >= 20 && level('Strength') >= 25 ? 'Defence' : 'Strength';
        const style = sdk.getState()?.combatStyle;
        const next = style?.styles.find(entry => entry.trainsSkills.includes(skill));
        if (style && next && style.currentStyle !== next.index) {
            const selected = await sdk.sendSetCombatStyle(next.index);
            if (selected.success) {
                await sdk.waitForCondition(s => s.combatStyle?.currentStyle === next.index, 6000).catch(() => {});
            }
        }
    };
    const waitAlive = async () => {
        if (!sdk.getState()?.player?.isDead) return;
        log('death', metrics());
        await sdk.waitForCondition(s => s.inGame && !!s.player && !s.player.isDead, 90_000);
    };
    const eat = async () => {
        const food = sdk.findInventoryItem(heal);
        return food ? (await bot.eatFood(food)).success : false;
    };
    const rest = async (minimum: number, resupply?: () => Promise<void>) => {
        await waitAlive();
        if (!sdk.getState()?.player || (sdk.getState()?.player?.hp ?? 0) >= minimum) return;
        log('recovering', { minimum, ...metrics() });
        while ((sdk.getState()?.player?.hp ?? 0) < minimum) {
            await waitAlive();
            if (!await eat()) {
                await resupply?.();
                await sdk.waitForTicks(12);
            }
        }
        log('recovered', metrics());
    };

    if (level('Hitpoints') < goal) {
        log('training-hitpoints', { goal, ...metrics() });
        await buySwords().catch(error => log('equipment-shop-unavailable', { message: String(error) }));
        let misses = 0;
        let lastLevel = level('Hitpoints');
        while (level('Hitpoints') < goal) {
            await waitAlive();
            const stronger = level('Attack') >= 12 && level('Hitpoints') >= 15;
            const spots = stronger ? [[3154, 3325], [3156, 3342]] as const : [[3225, 3300], [3185, 3277]] as const;
            const targetName = stronger ? /^(?:cow|cow calf)$/i : /^chicken$/i;
            const spot = spots[misses % spots.length] ?? spots[0];
            const player = sdk.getState()?.player;
            if (!player) throw new Error('Player state unavailable in Hitpoints phase');
            if (player.combat.inCombat) {
                if (player.hp <= Math.max(3, Math.floor(player.maxHp / 4)) && !await eat()) {
                    await bot.walkTo(player.worldX, player.worldZ + 12, 2, { timeout: 10_000 });
                }
                await sdk.waitForTicks(2);
                continue;
            }
            await rest(Math.max(5, Math.ceil(player.maxHp * 0.45)));
            await equipBest();
            await trainStyle();
            const target = closest(targetName, attackable, true);
            if (!target) {
                if (distance(spot[0], spot[1]) > 5) await travel(spot[0], spot[1], 4, 80_000);
                misses++;
                if (misses % 12 === 0) log('combat-rescan', { npc: stronger ? 'Cow' : 'Chicken', ...metrics() });
                await sdk.waitForTicks(3);
                continue;
            }
            const attack = await bot.attack(target);
            if (attack.success) misses = 0;
            else if (++misses % 10 === 0) log('combat-retry', { reason: attack.reason, npc: target.name, ...metrics() });
            await sdk.waitForTicks(2);
            if (level('Hitpoints') > lastLevel) {
                lastLevel = level('Hitpoints');
                log('hitpoints-level', metrics());
            }
        }
    }
    log('hitpoints-goal-reached', { goal, ...metrics() });

    const goToArdougne = async () => {
        if (distance(2662, 3305) <= 50) return;
        log('travelling-to-ardougne', metrics());
        for (let attempt = 0; attempt < 4; attempt++) {
            if (await travel(2662, 3305, 8, 210_000)) return;
            await waitAlive();
        }
        throw new Error('Could not verify East Ardougne arrival');
    };
    const buyFood = async () => {
        if (!await travel(2654, 3311, 4, 35_000)) return;
        const baker = closest(/^baker$/i, /trade/i);
        if (!baker || !(await bot.openShop(baker)).success) return;
        try {
            for (const [name, limit] of [['Cake', 3], ['Chocolate slice', 8], ['Bread', 10]] as const) {
                const item = sdk.getState()?.shop.shopItems.find(entry => entry.name === name && entry.count > 0);
                if (!item) continue;
                const bought = await bot.buyFromShop(name, Math.min(limit, item.count));
                if (bought.amountBought) log('food-restock', { item: name, bought: bought.amountBought, ...metrics() });
            }
        } finally {
            await bot.closeShop();
        }
    };
    const bankLoot = async () => {
        if (!await travel(2656, 3283, 4, 40_000) || !(await bot.openBank()).success) return;
        try {
            for (const name of new Set(sdk.getInventory().map(item => item.name))) {
                if (!/^coins$/i.test(name) && !heal.test(name)) await bot.depositItem(name, -1);
            }
        } finally {
            await bot.closeBank();
        }
    };
    let nextScan = 0;
    let nextFood = 0;
    let successes = 0;
    let lastTarget = '';
    await goToArdougne();
    if (level('Thieving') < 40) throw new Error('This activity needs at least 40 Thieving after Hitpoints training');
    for (;;) {
        await waitAlive();
        await goToArdougne();
        if (sdk.getInventory().length >= 26) await bankLoot().catch(() => {});
        const p = sdk.getState()?.player;
        if (!p) throw new Error('Player state unavailable in pickpocket phase');
        const low = Math.max(8, Math.floor(p.maxHp / 3));
        if (p.hp <= low) {
            await rest(Math.max(low + 4, Math.ceil(p.maxHp / 2)), async () => {
                if (Date.now() < nextFood) return;
                nextFood = Date.now() + 45_000;
                await buyFood().catch(() => {});
            });
        }

        const thieving = level('Thieving');
        const hero = thieving >= 80 ? closest(heroes, pocket) : undefined;
        const knight = thieving >= 55 ? closest(knights, pocket) : undefined;
        const target = hero ?? knight ?? (thieving < 55 ? closest(guards, pocket) : undefined);
        if (!target || (thieving >= 80 && !hero && nextScan % 12 === 0)) {
            const locations = thieving >= 55 ? heroSpots : guardSpots;
            const spot = locations[nextScan % locations.length] ?? locations[0];
            nextScan++;
            if (thieving >= 80 && knight && !hero && distance(2630, 3288) > 8) {
                await travel(2630, 3288, 6, 35_000);
            } else if (!target) {
                await travel(spot[0], spot[1], 4, 30_000);
            }
            if (!target || (knight && !hero && distance(knight.x, knight.z) > 12)) {
                await sdk.waitForTicks(3);
                continue;
            }
        } else {
            nextScan++;
        }
        if (target.name !== lastTarget) {
            lastTarget = target.name;
            log('pickpocket-target', { npc: target.name, ...metrics() });
        }
        const before = metrics();
        const revision = sdk.getState()?.revision;
        const action = await bot.pickpocketNpc(target);
        if (!action.success && action.reason !== 'stunned') await sdk.waitForTicks(5);
        const after = metrics();
        const success = action.success || (after.thievingXp ?? 0) > (before.thievingXp ?? 0) ||
            (sdk.getState()?.gameMessages ?? []).some(message => message.type === 0 &&
                (/^You pick the .*pocket/i.test(message.text)) && (message.observationId != null && revision != null
                    ? message.observationId > revision : message.tick > (before.tick ?? -1)));
        if (success) successes++;
        log('pickpocket', { npc: target.name, success, reason: action.reason, successes, ...after });
        await sdk.waitForTicks(action.reason === 'stunned' ? 11 : success ? 1 : 3);
    }
}, { printState: false });

if (!result.success) process.exitCode = 1;
