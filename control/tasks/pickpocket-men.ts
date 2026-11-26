import { runScript } from '../../sdk/runner';

const log = (stage: string, fields: object = {}) =>
    console.log('[pickpocket-demo] ' + JSON.stringify({ stage, ...fields }));

const onTutorial = (x: number, z: number) =>
    (x >= 3053 && x <= 3156 && z >= 3056 && z <= 3136) ||
    (x >= 3072 && x <= 3118 && z >= 9492 && z <= 9535);

const inLumbridge = (x: number, z: number, plane: number) =>
    plane === 0 && x >= 3200 && x <= 3255 && z >= 3190 && z <= 3250;

const result = await runScript(async ({ sdk, bot }) => {
    const metrics = () => {
        const state = sdk.getState();
        return {
            tick: state?.tick,
            x: state?.player?.worldX,
            z: state?.player?.worldZ,
            hp: state?.player?.hp,
            thievingXp: sdk.getSkill('Thieving')?.experience,
            coins: sdk.countInventoryItems(/^coins$/i),
        };
    };
    const initial = await sdk.waitForReady();
    if (!initial.player) throw new Error('No player state');
    log('attached', metrics());
    if (onTutorial(initial.player.worldX, initial.player.worldZ)) {
        for (let attempt = 1; attempt <= 4; attempt++) {
            const player = sdk.getState()?.player;
            if (player && inLumbridge(player.worldX, player.worldZ, player.level)) break;
            const skip = await bot.skipTutorial();
            log('tutorial-skip', { attempt, success: skip.success, ...metrics() });
            await sdk.waitForCondition(state => {
                const p = state.player;
                return !!p && inLumbridge(p.worldX, p.worldZ, p.level);
            }, 5000).catch(() => {});
        }
    }
    const arrival = sdk.getState()?.player;
    if (!arrival || !inLumbridge(arrival.worldX, arrival.worldZ, arrival.level)) {
        log('lumbridge-unverified', metrics());
        throw new Error('Lumbridge arrival could not be verified');
    }
    log('lumbridge', metrics());

    let attempts = 0;
    let misses = 0;
    let recovering = false;
    while (true) {
        const state = sdk.getState();
        const player = state?.player;
        if (!player || !state?.inGame) throw new Error('Player state unavailable');
        if (recovering || player.hp <= 3 || player.isDead) {
            if (!recovering) log('recovering', metrics());
            recovering = true;
            await sdk.waitForTicks(8);
            const current = sdk.getState()?.player;
            if (current && current.hp >= 6 && !current.isDead) {
                recovering = false;
                log('recovered', metrics());
            }
            continue;
        }
        if (!inLumbridge(player.worldX, player.worldZ, player.level)) {
            log('left-lumbridge', metrics());
            throw new Error('Bot left the Lumbridge training area');
        }
        const target = state.nearbyNpcs.filter(npc => /^man$/i.test(npc.name) && npc.reachable !== false &&
            inLumbridge(npc.x, npc.z, player.level) && npc.optionsWithIndex.some(option => /^pickpocket$/i.test(option.text)))
            .sort((a, b) => a.distance - b.distance)[0];
        if (!target) {
            const spots = [[3222, 3218], [3221, 3228], [3231, 3237]] as const;
            const spot = spots[misses % spots.length] ?? spots[0];
            misses++;
            const walk = await bot.walkTo(spot[0], spot[1], 1, { timeout: 12_000 });
            log('rescan', { destination: spot, success: walk.success, ...metrics() });
            await sdk.waitForTicks(3);
            continue;
        }
        misses = 0;
        const before = metrics();
        const action = await bot.pickpocketNpc(target);
        log('pickpocket', {
            attempt: ++attempts,
            npc: target.name,
            index: target.index,
            optionIndex: target.optionsWithIndex.find(option => /^pickpocket$/i.test(option.text))?.opIndex,
            success: action.success, reason: action.reason, before, after: metrics(),
        });
        await sdk.waitForTicks(action.reason === 'stunned' ? 9 : action.success ? 1 : 3);
    }
}, { printState: false });

if (!result.success) process.exitCode = 1;
