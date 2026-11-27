import type { ActionResult, BotAction, BotWorldState } from './types';

export const auditEnabled = process.env.RS_ACTIVITY_AUDIT === '1';
export const auditPrefix = '[rs-activity-audit] ';

export function auditEvent(kind: string, name: string, data: object = {}) {
    if (auditEnabled) console.log(auditPrefix + JSON.stringify({ kind, name, ...data }));
}

export function auditFrame(state: BotWorldState | null | undefined) {
    const p = state?.player;
    if (!state) return null;
    return {
        tick: state.tick, revision: state.revision,
        player: p && { x: p.worldX, z: p.worldZ, plane: p.level, hp: p.hp, inCombat: p.combat?.inCombat },
        modal: state.modalInterface, dialog: state.dialog?.isOpen,
        rejected: state.opFeedback?.opRejectedCount,
        questPoints: state.questPoints,
    };
}

const traced = new Set([
    'walkTo', 'interactLoc', 'interactNpc', 'talkToNpc', 'pickupItem', 'useInventoryItem', 'useEquipmentItem',
    'useItemOnItem', 'useItemOnLoc', 'useItemOnNpc', 'clickDialogOption', 'clickComponent', 'clickComponentWithOption',
    'bankDeposit', 'bankWithdraw', 'shopBuy', 'closeModal', 'setCombatStyle', 'spellOnNpc', 'togglePrayer',
]);
const keys = ['x', 'z', 'locId', 'npcIndex', 'itemId', 'slot', 'itemSlot', 'sourceSlot', 'targetSlot', 'optionIndex',
    'componentId', 'spellComponent', 'amount', 'style', 'prayerIndex', 'running'] as const;

export function auditAction(action: BotAction, state: BotWorldState | null | undefined) {
    if (!auditEnabled || !traced.has(action.type)) return;
    const parameters = Object.fromEntries(keys.flatMap(key => {
        const value = (action as unknown as Record<string, unknown>)[key];
        return typeof value === 'number' || typeof value === 'boolean' ? [[key, value]] : [];
    }));
    const npc = state?.nearbyNpcs?.find(n => n.index === parameters.npcIndex);
    const loc = state?.nearbyLocs?.find(l => l.id === parameters.locId && l.x === parameters.x && l.z === parameters.z);
    const object = npc ?? loc;
    const item = state?.inventory?.find(i => i.slot === (parameters.itemSlot ?? parameters.slot ?? parameters.sourceSlot));
    const option = object?.optionsWithIndex?.find(o => o.opIndex === parameters.optionIndex)?.text;
    const dialogChoice = action.type === 'clickDialogOption'
        ? state?.dialog?.options?.find(o => o.index === parameters.optionIndex)?.text : undefined;
    return {
        parameters,
        target: object && { id: object.id, name: object.name, x: object.x, z: object.z, reachable: object.reachable },
        item: item && { id: item.id, name: item.name, count: item.count },
        option: option ?? dialogChoice,
        before: auditFrame(state),
    };
}

export function auditDispatch(action: BotAction, context: NonNullable<ReturnType<typeof auditAction>>,
    result: ActionResult | undefined, elapsedMs: number, state: BotWorldState | null | undefined) {
    auditEvent('action', action.type, {
        ...context, elapsedMs, after: auditFrame(state), outcome: result?.success ? 'dispatched' : 'failed',
        reason: result?.reason, resultPhase: result?.phase,
        message: result?.message,
    });
}

/** Include selected system feedback only. Player chat never enters the trace. */
export function auditFeedback(state: BotWorldState | null | undefined, tick: number) {
    return state?.gameMessages?.filter(message => message.type === 0 && !message.sender && message.tick >= tick &&
        /can.t reach|cannot reach|not enough|too (?:far|low)|door is locked|won.t open|climb|pull lever|you find|you unlock|stunned|caught|spotted|quest complete/i.test(message.text))
        .slice(-6).map(({ tick, text }) => ({ tick, text }));
}

export function auditState(state: BotWorldState) {
    return {
        ...auditFrame(state),
        skills: state.skills?.map(s => ({ name: s.name, xp: s.experience, level: s.baseLevel })),
        inventory: state.inventory?.map(i => ({ id: i.id, name: i.name, count: i.count })),
        equipment: state.equipment?.map(i => ({ id: i.id, name: i.name })),
        journal: state.questJournal && Object.entries(state.questJournal).filter(([, value]) => value !== 'not-started'),
    };
}
