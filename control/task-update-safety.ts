import type { BotWorldState } from '../sdk/types';

type TaskUpdateState = Pick<BotWorldState, 'tick' | 'inGame' | 'player' | 'modalOpen' | 'dialog' | 'interface' | 'bank' | 'shop' | 'trade' | 'ge'>;

export function classifyTaskUpdateSafety(state: TaskUpdateState | null | undefined, stateAgeMs: number) {
    if (!state?.inGame || !state.player || !Number.isSafeInteger(state.tick) ||
        !Number.isFinite(stateAgeMs) || stateAgeMs < 0 || stateAgeMs > 2_000) return 'unsafe';
    const { player } = state;
    const damageTick = player.combat?.lastDamageTick;
    const minimumHp = Math.min(player.maxHp, Math.max(8, Math.ceil(player.maxHp / 2)));
    const settled = player.isDead === false && Number.isFinite(player.maxHp) && player.maxHp > 0 &&
        Number.isFinite(player.hp) && player.hp > 0 && player.hp >= minimumHp &&
        player.combat?.inCombat === false &&
        state.modalOpen === false && state.dialog?.isOpen === false && state.interface?.isOpen === false &&
        state.bank?.isOpen === false && state.shop?.isOpen === false && !state.trade?.isOpen && !state.ge?.isOpen;
    if (!settled || damageTick === undefined || !Number.isSafeInteger(damageTick) || damageTick < -1 || damageTick > state.tick) {
        return 'unsafe';
    }
    return damageTick < 0 || state.tick - damageTick >= 3 ? 'ready' : 'recovering';
}

export function isSafeTaskUpdateState(state: TaskUpdateState | null | undefined, stateAgeMs: number): boolean {
    return classifyTaskUpdateSafety(state, stateAgeMs) === 'ready';
}
