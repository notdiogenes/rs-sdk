import { Database } from 'bun:sqlite';
import { join } from 'node:path';

export type LastActivity = { at: string; reason: string };
export type BotObservation = {
    position?: [x: number, z: number, plane: number | null];
    xp: Record<string, number>;
    inCombat?: boolean;
};
type StoredActivity = { observation: BotObservation; lastActivity: LastActivity | null };

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

    return function lastActivity(bot: string, observation?: BotObservation): LastActivity | null {
        const db = store();
        const row = db.query('SELECT data FROM bot_activity WHERE bot = ?').get(bot) as { data: string } | null;
        const prior = row ? JSON.parse(row.data) as StoredActivity : null;
        if (!observation) return prior?.lastActivity ?? null;
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
        const last = signals.length ? { at: new Date().toISOString(), reason: signals.join(' · ') } : prior?.lastActivity ?? null;
        if (!previous || JSON.stringify(previous) !== JSON.stringify(observation)) {
            db.query('INSERT OR REPLACE INTO bot_activity (bot, data) VALUES (?, ?)').run(bot, JSON.stringify({
                observation, lastActivity: last,
            } satisfies StoredActivity));
        }
        return last;
    };
}
