import type { BankItem, BotWorldState, PlayerState } from './types';

export type FleetViewState = Pick<BotWorldState, 'tick' | 'inGame' | 'skills' | 'inventory' | 'questPoints' | 'questJournal'> & {
    player: Pick<PlayerState, 'worldX' | 'worldZ' | 'level' | 'hp' | 'maxHp' | 'combatLevel'> & {
        combat: Pick<PlayerState['combat'], 'inCombat'>;
    } | null;
};

export type FleetStateFrame = { type: 'fleet-state'; at: number; state: FleetViewState };
export type FleetBankFrame = { type: 'fleet-bank'; at: number; items: BankItem[] };
