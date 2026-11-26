const lifetime = 5 * 60_000;
type QuestSnapshot = { points: number | null; checkedAt: number };
const cache = new Map<string, { expires: number; result: Promise<QuestSnapshot> }>();

export function questHiscore(bot: string) {
    return 'https://rs-sdk.maxbittker.com/hiscores/player/' + encodeURIComponent(bot.toLowerCase().replaceAll(' ', '_'));
}

async function readQuestPoints(bot: string): Promise<QuestSnapshot> {
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
    return { points, checkedAt: Date.now() };
}

export async function dashboardQuestPoints(names: string[]) {
    const results: Record<string, QuestSnapshot> = Object.create(null);
    for (let index = 0; index < names.length; index += 8) {
        await Promise.all(names.slice(index, index + 8).map(async name => {
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
