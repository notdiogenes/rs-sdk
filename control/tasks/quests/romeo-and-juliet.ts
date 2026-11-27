import { auditEvent } from '../../../sdk/audit-trace';
import { runScript } from '../../../sdk/runner';
import { prepareQuestStep, changeFloor, groundItem, journalText, questLog, questPhase, waitForQuestJournal, readQuest, talk, walk } from './shared';

const journal = 7343;
const quest = 'Romeo & Juliet';
const juliet = { x: 3158, z: 3425 };
const stairs = { x: 3156, z: 3435 };
const keep = /^(?:message|cadava berries|cadava potion)$/i;
const choices = [/i guess i could find him/i, /certainly,? i will do so/i, /can i help find her/i];

const result = await runScript(async ctx => {
    const { sdk } = ctx;
    await sdk.waitForReady();
    questPhase('quest-journal-preflight');
    await waitForQuestJournal(ctx, journal, 'available', 15_000);
    questPhase('quest-prepare');
    const status = () => readQuest(ctx, journal);
    if (status() === 'complete') { questLog('quest-already-complete', { quest }); return; }
    const leaveHouse = async () => {
        const p = sdk.getState()?.player;
        if (p?.level === 1 && Math.max(Math.abs(p.worldX - juliet.x), Math.abs(p.worldZ - juliet.z)) < 15) {
            await changeFloor(ctx, 'down', stairs.x, stairs.z);
        }
    };
    const prepare = (slots: number) => prepareQuestStep(ctx, { slots, keep, bank: [3185, 3440], beforeBank: leaveHouse });
    const visitRomeo = async () => {
        await leaveHouse();
        await walk(ctx, 3211, 3425, 4);
        await talk(ctx, /^romeo$/i, [...choices, /he sent me to the apothecary/i]);
    };
    const visitJuliet = async () => {
        if (sdk.getState()?.player?.level !== 1) {
            await walk(ctx, stairs.x, stairs.z, 2);
            await changeFloor(ctx, 'up', stairs.x, stairs.z);
        }
        await walk(ctx, juliet.x, juliet.z, 3);
        await talk(ctx, /^juliet$/i, choices);
        await leaveHouse();
    };
    const visitApothecary = async () => {
        await leaveHouse();
        await walk(ctx, 3195, 3404, 4);
        await talk(ctx, /^apothecary$/i, []);
    };
    questPhase('romeo-journal-steps');
    questLog('quest-start', { quest });
    let previous = '';
    let attempts = 0;
    for (let step = 0; step < 18 && status() !== 'complete'; step++) {
        const text = await journalText(ctx, journal, /^romeo & juliet$/i);
        const has = (name: RegExp) => !!sdk.findInventoryItem(name);
        const milestone = text + JSON.stringify(sdk.getInventory().map(item => item.id));
        attempts = milestone === previous ? attempts + 1 : 0;
        previous = milestone;
        if (attempts) auditEvent('setback', 'romeo-journal-unchanged', { step: step + 1, repeats: attempts, journal: text.slice(-240) });
        if (attempts > 1) throw new Error('Quest journal is unchanged: ' + text.slice(-180));
        if (/i have to find romeo.*tell him what.s happened/i.test(text)) {
            questPhase('romeo-report');
            await visitRomeo();
        } else if (/i went to the apothecary regarding making this.*bring him some/i.test(text)) {
            questPhase('romeo-prepare-potion');
            if (has(/^cadava potion$/i)) await visitJuliet();
            else if (has(/^cadava berries$/i)) await visitApothecary();
            else {
                await leaveHouse();
                await prepare(1);
                await groundItem(ctx, /^cadava berries$/i, 3272, 3369);
                questLog('quest-ingredient', { quest, item: 'Cadava berries' });
            }
        } else if (/i need to find the apothecary/i.test(text)) {
            questPhase('romeo-apothecary');
            await visitApothecary();
        } else if (/i should find father lawrence/i.test(text)) {
            questPhase('romeo-father-lawrence');
            await leaveHouse();
            await walk(ctx, 3254, 3475, 4);
            await talk(ctx, /^father lawrence$/i, []);
        } else if (/i should take the message.*to romeo/i.test(text)) {
            questPhase('romeo-deliver-message');
            if (has(/^message$/i)) await visitRomeo();
            else {
                await prepareQuestStep(ctx, { keep, withdraw: [{ name: 'Message', count: 1 }], bank: [3185, 3440], beforeBank: leaveHouse });
                if (has(/^message$/i)) await visitRomeo();
                else await visitJuliet();
            }
        } else if (/i can start this quest/i.test(text)) {
            questPhase('romeo-start');
            await visitRomeo();
        } else if (/i should go and speak to juliet/i.test(text)) {
            questPhase('romeo-meet-juliet');
            await prepare(1);
            await visitJuliet();
        } else {
            throw new Error('Unrecognized Romeo & Juliet journal page: ' + text.slice(-180));
        }
    }
    await waitForQuestJournal(ctx, journal, 'complete', 12_000);
    questLog('quest-complete', { quest, evidence: 'journal', questPoints: sdk.getState()?.questPoints });
}, { printState: false, timeout: 900_000 });

if (!result.success) {
    questLog('quest-failed', { quest, error: result.error?.message });
    process.exitCode = 1;
}
