import { join } from 'node:path';
import type { BotWorldState } from '../sdk/types';

export const hostedBotName = /^[A-Za-z0-9][A-Za-z0-9 ]{0,11}$/;
export const isFreshBotState = (age: number) => Number.isFinite(age) && age >= 0 && age <= 10_000;

export async function botCredentials(bot: string, directory: string) {
    const contents = await Bun.file(join(directory, 'bot.env')).text();
    const values = new Map<string, string>();
    for (const raw of contents.split('\n')) {
        const line = raw.trim();
        const separator = line.indexOf('=');
        if (line.startsWith('#') || separator < 1) continue;
        values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
    const username = values.get('BOT_USERNAME');
    const password = values.get('PASSWORD');
    const server = values.get('SERVER');
    if (username !== bot || !password || server !== 'rs-sdk.maxbittker.com' || values.has('GATEWAY_URL')) {
        throw new Error('Expected a matching bot.env for the hosted demo server, with no GATEWAY_URL override');
    }
    return { username, password };
}

export async function hostedBotState(bot: string, directory: string) {
    const { username, password } = await botCredentials(bot, directory);
    const url = new URL(`/state/${encodeURIComponent(username)}`, 'https://rs-sdk.maxbittker.com');
    // The hosted engine relays the query string to the gateway. Never log this URL.
    url.searchParams.set('password', password);
    const response = await fetch(url, { signal: AbortSignal.timeout(7000), redirect: 'error' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Game gateway request failed');
    return await response.json() as {
        state: BotWorldState | null;
        stateAge: number;
        botStatus?: 'active' | 'stale' | 'dead';
    };
}
