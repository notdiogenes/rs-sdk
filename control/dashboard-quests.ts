import { join } from 'node:path';
import type { GameQuestScore } from './dashboard-fleet-stats';

export type QuestColumn = { id: number; name: string };

export async function loadQuestCatalog(): Promise<QuestColumn[]> {
    const content = join(import.meta.dir, '../server/content');
    const [journal, pack] = await Promise.all([
        Bun.file(join(content, 'scripts/player/interfaces/questlist.if')).text(),
        Bun.file(join(content, 'pack/interface.pack')).text(),
    ]);
    const ids = new Map([...pack.matchAll(/^(\d+)=questlist:([^\s]+)\s*$/gm)]
        .map(([, id, name]) => [name, Number(id)]));
    const quests = [...journal.matchAll(/^\[([^\]\r\n]+)\][^\S\r\n]*\r?\n([^[]*)/gm)].flatMap(([, key, block]) => {
        const id = ids.get(key);
        if (id === undefined || !block) return [];
        const field = (pattern: RegExp) => pattern.exec(block)?.[1]?.trim();
        const name = field(/^text=(.+)$/m);
        const position = Number(field(/^y=(\d+)$/m));
        if (!name || !Number.isFinite(position) || field(/^layer=(.+)$/m) !== 'com_0' ||
            field(/^type=(.+)$/m) !== 'text' || field(/^buttontype=(.+)$/m) !== 'normal') return [];
        return [{ id, name, position }];
    });
    return quests.sort((a, b) => a.position - b.position).map(({ id, name }) => ({ id, name }));
}

const lifetime = 5 * 60_000;
type HiscoreScore = { points: number | null; checkedAt: number; source: 'hiscores' };
const cache = new Map<string, { expires: number; result: Promise<HiscoreScore> }>();

export function questHiscore(bot: string) {
    return 'https://rs-sdk.maxbittker.com/hiscores/player/' + encodeURIComponent(bot.toLowerCase().replaceAll(' ', '_'));
}

async function readQuestPoints(bot: string): Promise<HiscoreScore> {
    let points: number | null = null;
    try {
        const response = await fetch(questHiscore(bot), { signal: AbortSignal.timeout(4000), redirect: 'error' });
        if (response.ok) {
            const row = /<a\b[^>]*href="\/hiscores\?category=100\b[^"]*"[^>]*>Quest Points<\/a>\s*<\/td>\s*<td[^>]*>[^<]*<\/td>\s*<td[^>]*>\s*([\d,]+)\s*<\/td>/i
                .exec(await response.text());
            if (row?.[1]) points = Number(row[1].replaceAll(',', ''));
        }
    } catch {
        // Unranked and unavailable scores are both displayed as unreported.
    }
    return { points, checkedAt: Date.now(), source: 'hiscores' };
}

export async function dashboardQuestPoints(bots: { name: string; score?: GameQuestScore }[]) {
    const results: Record<string, GameQuestScore | HiscoreScore> = Object.create(null);
    for (let index = 0; index < bots.length; index += 8) {
        await Promise.all(bots.slice(index, index + 8).map(async ({ name, score }) => {
            if (score) {
                results[name] = score;
                return;
            }
            let entry = cache.get(name);
            if (!entry || entry.expires < Date.now()) {
                entry = { expires: Date.now() + lifetime, result: readQuestPoints(name) };
                cache.set(name, entry);
            }
            results[name] = await entry.result;
        }));
    }
    return results;
}
