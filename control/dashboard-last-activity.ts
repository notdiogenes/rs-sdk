import { Database } from 'bun:sqlite';
import { join } from 'node:path';

export type LastActivity = { at: string; reason: string };
export type BotObservation = {
    position?: [x: number, z: number, plane: number | null];
    xp: Record<string, number>;
    inCombat?: boolean;
};
type ActivityTimes = { lastActivity: LastActivity | null; movedAt: string | null; gainedXpAt: string | null };
type StoredActivity = { observation: BotObservation; lastActivity: LastActivity | null;
    movedAt?: string | null; gainedXpAt?: string | null };

export function dashboardLastActivity(directory: string) {
    let database: Database | undefined;
    function store() {
        if (!database) {
            const db = new Database(join(directory, 'last-activity.sqlite'));
            db.run('CREATE TABLE IF NOT EXISTS bot_activity (bot TEXT PRIMARY KEY, data TEXT NOT NULL)');
            database = db;
        }
        return database;
    }

    return function lastActivity(bot: string, observation?: BotObservation): ActivityTimes {
        const db = store();
        const row = db.query('SELECT data FROM bot_activity WHERE bot = ?').get(bot) as { data: string } | null;
        const prior = row ? JSON.parse(row.data) as StoredActivity : null;
        const lastActivity = prior?.lastActivity ?? null;
        const movedAt = prior?.movedAt ?? (lastActivity?.reason.includes('Moved') ? lastActivity.at : null);
        const gainedXpAt = prior?.gainedXpAt ?? (lastActivity?.reason.includes('Gained XP') ? lastActivity.at : null);
        if (!observation) return { lastActivity, movedAt, gainedXpAt };
        const previous = prior?.observation;
        const before = previous?.position;
        const after = observation.position;
        const signals: string[] = [];
        if (before && after && (before[0] !== after[0] || before[1] !== after[1] ||
            (before[2] !== null && after[2] !== null && before[2] !== after[2]))) signals.push('Moved');
        if (previous && Object.entries(observation.xp)
            .some(([skill, xp]) => xp > (previous.xp[skill] ?? xp))) signals.push('Gained XP');
        if (previous?.inCombat !== undefined && observation.inCombat !== undefined &&
            previous.inCombat !== observation.inCombat) {
            signals.push(observation.inCombat ? 'Entered combat' : 'Left combat');
        }
        const at = new Date().toISOString();
        const times = {
            lastActivity: signals.length ? { at, reason: signals.join(' · ') } : lastActivity,
            movedAt: signals.includes('Moved') ? at : movedAt,
            gainedXpAt: signals.includes('Gained XP') ? at : gainedXpAt,
        };
        if (!previous || JSON.stringify(previous) !== JSON.stringify(observation)) {
            db.query('INSERT OR REPLACE INTO bot_activity (bot, data) VALUES (?, ?)').run(bot, JSON.stringify({
                observation, ...times,
            } satisfies StoredActivity));
        }
        return times;
    };
}
