import { auditEnabled, auditEvent, auditFrame } from '../../sdk/audit-trace';
import { runScript } from '../../sdk/runner';
import { readFileSync } from 'node:fs';

const planned = process.env.RS_PLANNED === '1';
const melee = ['Attack', 'Strength', 'Defence'] as const;
const focus = melee.find(skill => skill === process.env.RS_ACTIVITY_SKILL);
const cow = /^(cow|cow calf)$/i;
const swords = ['Adamant longsword', 'Mithril longsword', 'Steel longsword'];
const swordRequirements = [30, 20, 5] as const;
const edible = /^(lobster|trout|salmon|kebab|bread|cooked meat|shrimp|cake)$/i;
const stackable = new Map<string, boolean>();

function isStackable(name: string, count: number) {
    if (count > 1 || /^coins$/i.test(name)) return true;
    if (!stackable.has(name)) {
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        let yes = false;
        try {
            yes = /\*\*Stackable\*\*\s*\|\s*Yes/i.test(
                readFileSync(new URL(`../../wiki/items/${slug}.md`, import.meta.url), 'utf8'),
            );
        } catch {}
        stackable.set(name, yes);
    }
    return stackable.get(name);
}

const result = await runScript(async ({ sdk, bot }) => {
    let current = '';
    const phase = (name: string) => {
        if (!auditEnabled || current === name) return;
        current = name;
        auditEvent('phase', name, { focus, state: auditFrame(sdk.getState()) });
    };
    phase('combat-requirements');
    await sdk.waitForReady();
    const stats = () => melee.map(name => {
        const skill = sdk.getSkill(name);
        if (!skill) throw new Error(`Missing ${name} in game state`);
        return skill;
    });

    async function equipBest() {
        const equipped = sdk.getState()?.equipment.find(item => item.slot === 3);
        for (const [i, name] of swords.entries()) {
            if ((sdk.getSkill('Attack')?.baseLevel ?? 0) < (swordRequirements[i] ?? Infinity)) continue;
            if (equipped?.name === name) return;
            const item = sdk.getInventory().find(item => item.name === name);
            if (item) {
                const result = await bot.equipItem(item);
                auditEvent(result.success ? 'milestone' : 'setback', result.success ? 'combat-equipped' : 'combat-equip-failed',
                    { item: item.name, message: result.message });
                if (result.success) return;
            }
        }
    }

    async function buryBones() {
        for (const bone of sdk.getInventory().filter(item => /bones$/i.test(item.name))) {
            const bury = bone.optionsWithIndex?.find(option => /^bury$/i.test(option.text));
            const sent = await sdk.sendUseItem(bone.slot, bury?.opIndex ?? 1);
            const observed = sent.success && await sdk.waitForCondition(s => !s.inventory.some(item => item.slot === bone.slot && item.id === bone.id), 4000).catch(() => null);
            auditEvent(observed ? 'milestone' : 'setback', observed ? 'combat-bones-buried' : 'combat-bury-unconfirmed',
                { item: bone.name, slot: bone.slot, sent: sent.success, message: sent.message });
        }
    }

    async function bankIfFull() {
        if (sdk.getInventory().length < 27) return;
        phase('combat-banking');
        const slotsBefore = sdk.getInventory().length;
        const coinsBefore = sdk.findInventoryItem(/^coins$/i)?.count ?? 0;
        const gateApproach = await bot.walkTo(3267, 3228, 1);
        if (!gateApproach.success) throw new Error(gateApproach.message);
        const gate = sdk.getState()?.nearbyLocs.find(loc => /gate/i.test(loc.name) && loc.x >= 3267 && loc.x <= 3270 && Math.abs(loc.z - 3228) <= 2);
        if (!gate) throw new Error('Al Kharid toll gate not found');
        await sdk.sendInteractLoc(gate.x, gate.z, gate.id, 1);
        await sdk.waitForTicks(2);
        for (let i = 0; i < 10; i++) {
            const dialog = sdk.getState()?.dialog;
            if (!dialog?.isOpen) break;
            const yes = dialog.options.find(option => /^yes\b/i.test(option.text));
            if (!yes && dialog.options.some(option => /^(no|cancel)\b/i.test(option.text))) break;
            await sdk.sendClickDialog(yes?.index ?? 0);
            await sdk.waitForTicks(1);
        }
        const crossed = await bot.walkTo(3277, 3227, 2);
        if (!crossed.success) throw new Error(crossed.message);
        const walked = await bot.walkTo(3269, 3167, 3);
        if (!walked.success) throw new Error(walked.message);
        const bank = await bot.openBank();
        if (!bank.success) throw new Error(bank.message);
        for (const name of new Set(sdk.getInventory().map(item => item.name))) {
            if (swords.includes(name) || edible.test(name)) continue;
            const coinsToDeposit = (sdk.findInventoryItem(/^coins$/i)?.count ?? 0) - 20;
            if (name === 'Coins' && coinsToDeposit <= 0) continue;
            const deposit = await bot.depositItem(name, name === 'Coins' ? coinsToDeposit : -1);
            if (!deposit.success) throw new Error(deposit.message);
        }
        await bot.closeBank();
        console.log('Banked at Al Kharid');
        const slotsAfter = sdk.getInventory().length;
        auditEvent('check', 'combat-bank-space', { outcome: slotsAfter < 27 ? 'complete' : 'failed',
            slotsBefore, slotsAfter, coinsBefore, coinsAfter: sdk.findInventoryItem(/^coins$/i)?.count ?? 0 });
        if (slotsAfter >= 27) throw new Error('Al Kharid bank trip did not free inventory space');
        auditEvent('milestone', 'combat-banked-loot', { slotsFreed: slotsBefore - slotsAfter });
    }

    console.log('Starting cow training', stats().map(skill => [skill.name, skill.baseLevel, skill.experience]));
    let fights = 0;
    let misses = 0;
    for (;;) {
        await equipBest();
        await buryBones();
        const before = stats();
        if (!planned && before.every(skill => skill.baseLevel >= 99)) {
            console.log('Confirmed 99/99/99', before);
            auditEvent('milestone', 'combat-goal-reached');
            return;
        }
        await bankIfFull();
        const player = sdk.getState()?.player;
        if (player && player.hp < Math.max(8, player.maxHp / 3)) {
            phase('combat-recovery');
            const food = sdk.getInventory().find(item => edible.test(item.name));
            if (food) {
                const result = await bot.eatFood(food);
                auditEvent(result.success ? 'milestone' : 'setback', result.success ? 'food-eaten' : 'food-eat-failed',
                    { item: food.name, hpBefore: player.hp, hpGained: result.hpGained, message: result.message });
            } else if (player.hp <= 6) {
                auditEvent('check', 'combat-food-available', { outcome: 'failed', hp: player.hp });
                throw new Error('Low HP and out of food');
            }
        }

        const skill = before.find(s => s.name === focus) ?? before.filter(s => s.baseLevel < 99).sort((a, b) => a.experience - b.experience)[0] ?? (planned ? before[0] : undefined);
        if (!skill) throw new Error('Could not select the next melee skill');
        const combat = sdk.getState()?.combatStyle;
        const style = combat?.styles.find(s => s.trainsSkills.includes(skill.name));
        if (!style) throw new Error(`No combat style for ${skill.name}`);
        if (combat?.currentStyle !== style.index) {
            phase('combat-style');
            await sdk.sendSetCombatStyle(style.index);
            await sdk.waitForCondition(s => s.combatStyle?.currentStyle === style.index, 6000);
            auditEvent('milestone', 'combat-style-confirmed', { skill: skill.name, index: style.index });
        }
        let roundStarted = performance.now();
        if (!sdk.getState()?.player?.combat.inCombat) {
            let target = sdk.findNearbyNpc(cow, { reachable: true });
            if (!target) {
                phase('combat-search');
                const penSpots = [[3254, 3258], [3265, 3262], [3248, 3284], [3258, 3292]] as const;
                const [x, z] = penSpots[misses % penSpots.length] ?? penSpots[0];
                const walk = await bot.walkTo(x, z, 2);
                console.log('Cow pen rescan', { x, z, success: walk.success, message: walk.message });
                await sdk.waitForTicks(3);
                target = sdk.findNearbyNpc(cow, { reachable: true });
                if (!target) auditEvent('setback', 'combat-target-unavailable', { waypoint: { x, z },
                    misses: misses + 1, walk: { success: walk.success, message: walk.message }, after: auditFrame(sdk.getState()) });
                if (!target && ++misses >= 20) throw new Error('No reachable cow after rescanning the Lumbridge pen');
                if (!target) continue;
            }
            phase('combat-fight');
            roundStarted = performance.now();
            const attack = await bot.attack(target);
            auditEvent(attack.success ? 'milestone' : 'setback', attack.success ? 'combat-engaged' : 'combat-engage-failed',
                { target: { id: target.id, index: target.index, x: target.x, z: target.z }, skill: skill.name,
                    reason: attack.reason, message: attack.message, after: auditFrame(sdk.getState()) });
            if (!attack.success) {
                await sdk.waitForTicks(3);
                if (++misses >= 12) throw new Error(`Could not engage a cow: ${attack.message}`);
                continue;
            }
            console.log('Attacking', target.name, target.x, target.z, 'for', skill.name);
        }
        phase('combat-fight');
        misses = 0;
        await sdk.waitForCondition(s => !!s.player && (!s.player.combat.inCombat || s.player.isDead), 60000);
        const experience = before.map(s => ({ skill: s.name,
            gained: Math.max(0, (sdk.getSkill(s.name)?.experience ?? s.experience) - s.experience) }));
        const xpGained = experience.reduce((sum, s) => sum + s.gained, 0);
        auditEvent(xpGained ? 'milestone' : 'setback', xpGained ? 'combat-round-xp-gained' : 'combat-round-no-xp',
            { xpGained, experience, elapsedMs: Math.round(performance.now() - roundStarted), after: auditFrame(sdk.getState()) });
        if (sdk.getState()?.player?.isDead) {
            phase('combat-respawn');
            auditEvent('setback', 'activity-death', { before: auditFrame(sdk.getState()) });
            console.log('Waiting for respawn');
            await sdk.waitForCondition(s => s.inGame && !!s.player && !s.player.isDead, 90000);
            auditEvent('milestone', 'activity-respawned', { after: auditFrame(sdk.getState()) });
        }
        phase('combat-loot');
        await sdk.waitForTicks(1);
        for (const item of await sdk.scanGroundItems(12)) {
            if (item.reachable === false || (!/bones$/i.test(item.name) && !isStackable(item.name, item.count))) continue;
            if (sdk.getInventory().length >= 28 && !sdk.getInventory().some(slot => slot.id === item.id && isStackable(slot.name, slot.count))) continue;
            const picked = await bot.pickupItem(item);
            auditEvent(picked.success ? 'milestone' : 'setback', picked.success ? 'combat-loot-picked' : 'combat-loot-failed',
                { item: item.name, count: item.count, x: item.x, z: item.z, message: picked.message });
            if (picked.success && /bones$/i.test(item.name)) await buryBones();
        }
        const after = stats();
        if (after.some(now => before.some(previous => previous.name === now.name && now.experience > previous.experience))) fights++;
        console.log(JSON.stringify({ fightsWithXp: fights, tick: sdk.getState()?.tick, skills: after.map(s => [s.name, s.baseLevel, s.experience]) }));
    }
}, { printState: false });
if (!result.success) process.exitCode = 1;
