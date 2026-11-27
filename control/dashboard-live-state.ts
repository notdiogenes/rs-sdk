import type { FleetBankFrame, FleetStateFrame, FleetViewState } from '../sdk/fleet-telemetry';
import type { BankItem, BotWorldState } from '../sdk/types';
import { hostedBotState, isFreshBotState } from './hosted-bot';

export type FleetStateReading = {
    state: (FleetViewState & { bank?: BotWorldState['bank'] }) | null;
    stateAge: number;
    botStatus?: 'active' | 'stale' | 'dead';
};

export function fleetStateReading(frame: FleetStateFrame): FleetStateReading {
    const stateAge = Date.now() - frame.at;
    return { state: frame.state, stateAge, botStatus: isFreshBotState(stateAge) ? 'active' : 'stale' };
}

export function fleetAvailability(result: FleetStateReading | null | undefined) {
    if (result === undefined) return 'unavailable';
    if (result?.botStatus === 'stale') return 'stale';
    if (!result || result.botStatus === 'dead' || !result.state?.inGame || !result.state.player) return 'offline';
    return isFreshBotState(result.stateAge) ? 'live' : 'stale';
}

export function dashboardClientFeed(recordBank: (items: BankItem[], at: number) => void) {
    let frame: FleetStateFrame | undefined;
    function receive(message: unknown) {
        const update = message as FleetBankFrame | FleetStateFrame | null;
        if (update?.type === 'fleet-state' && Number.isSafeInteger(update.at) && (!frame || update.at >= frame.at)) {
            frame = update;
        }
        if (update?.type === 'fleet-bank' && Number.isSafeInteger(update.at) && Array.isArray(update.items)) {
            try { recordBank(update.items, update.at); }
            catch { console.error('Could not save the bank snapshot'); }
        }
    }
    return { receive, state: () => frame };
}

export function dashboardStateReader() {
    const pending = new Map<string, ReturnType<typeof hostedBotState>>();
    return async function readState(bot: string, directory: string, frame?: FleetStateFrame): Promise<FleetStateReading | null> {
        if (frame) return fleetStateReading(frame);
        const key = `${bot}\0${directory}`;
        let request = pending.get(key);
        if (!request) {
            request = hostedBotState(bot, directory).finally(() => pending.delete(key));
            pending.set(key, request);
        }
        return request;
    };
}
