import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import type { BotWorldState } from '../sdk/types';

export const fleetSkills = [
    ['Attack', 'Atk'], ['Strength', 'Str'], ['Defence', 'Def'], ['Hitpoints', 'HP'], ['Ranged', 'Rng'],
    ['Prayer', 'Pray'], ['Magic', 'Mag'], ['Cooking', 'Cook'], ['Woodcutting', 'WC'], ['Fletching', 'Fletch'],
    ['Fishing', 'Fish'], ['Firemaking', 'FM'], ['Crafting', 'Craft'], ['Smithing', 'Smith'], ['Mining', 'Mine'],
    ['Herblore', 'Herb'], ['Agility', 'Agi'], ['Thieving', 'Thief'], ['Runecraft', 'RC'],
] as const;

const minute = 60_000;
type SkillSnapshot = { at: number; combat: number | null; levels: Record<string, number> };
type BankSnapshot = { at: number; stacks: number; coins: number };
type FleetStats = { skills: SkillSnapshot | null; bank: BankSnapshot | null; xpGained: number | null };

const nonnegativeInteger = (value: number | undefined): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function dashboardFleetStats(directory: string) {
    let database: Database | undefined;
    function store() {
        if (!database) {
            const db = new Database(join(directory, 'fleet-stats.sqlite'));
            db.exec(`
                CREATE TABLE IF NOT EXISTS fleet_stats (bot TEXT PRIMARY KEY, skills TEXT, bank TEXT);
                CREATE TABLE IF NOT EXISTS fleet_xp (
                    bot TEXT, minute INTEGER, at INTEGER, experience TEXT, PRIMARY KEY (bot, minute)
                );
            `);
            database = db;
        }
        return database;
    }

    return function observe(bot: string, state?: BotWorldState, at = Date.now()): FleetStats {
        const db = store();
        const prior = db.query('SELECT skills, bank FROM fleet_stats WHERE bot = ?')
            .get(bot) as { skills: string | null; bank: string | null } | null;
        let skills: SkillSnapshot | null = prior?.skills ? JSON.parse(prior.skills) : null;
        let bank: BankSnapshot | null = prior?.bank ? JSON.parse(prior.bank) : null;
        let xpGained: number | null = null;
        const player = state?.player;
        if (!state || !player) return { skills, bank, xpGained };

        const levels: Record<string, number> = {};
        const experience: Record<string, number> = {};
        for (const [name] of fleetSkills) {
            const skill = state.skills?.find(entry => entry.name.toLowerCase() === name.toLowerCase());
            if (!skill) continue;
            if (nonnegativeInteger(skill.baseLevel) && skill.baseLevel > 0) levels[name] = skill.baseLevel;
            if (nonnegativeInteger(skill.experience)) experience[name] = skill.experience;
        }
        const observedBank = state.bank?.isOpen && Array.isArray(state.bank.items)
            ? state.bank.items.filter(item => nonnegativeInteger(item.count) && item.count > 0)
            : undefined;
        db.transaction(() => {
            if (Object.keys(levels).length) {
                const combat = nonnegativeInteger(player.combatLevel) ? player.combatLevel : null;
                skills = { at, combat, levels };
                db.query(`INSERT INTO fleet_stats (bot, skills) VALUES (?, ?)
                    ON CONFLICT (bot) DO UPDATE SET skills = excluded.skills`).run(bot, JSON.stringify(skills));
            }
            if (observedBank) {
                const coins = observedBank.filter(item => item.id === 995).reduce((sum, item) => sum + item.count, 0);
                bank = { at, stacks: observedBank.length, coins };
                db.query(`INSERT INTO fleet_stats (bot, bank) VALUES (?, ?)
                    ON CONFLICT (bot) DO UPDATE SET bank = excluded.bank`).run(bot, JSON.stringify(bank));
            }
            if (!Object.keys(experience).length) return;
            const cutoff = at - 60 * minute;
            db.query('DELETE FROM fleet_xp WHERE bot = ? AND at < ?').run(bot, cutoff);
            const baseline = db.query('SELECT experience FROM fleet_xp WHERE bot = ? AND at <= ? ORDER BY minute LIMIT 1')
                .get(bot, at - minute) as { experience: string } | null;
            db.query('INSERT OR IGNORE INTO fleet_xp (bot, minute, at, experience) VALUES (?, ?, ?, ?)')
                .run(bot, Math.floor(at / minute), at, JSON.stringify(experience));
            if (!baseline) return;
            const previous: Record<string, number> = JSON.parse(baseline.experience);
            const changes = Object.entries(experience).map(([name, xp]) => xp - (previous[name] ?? NaN));
            if (changes.length === Object.keys(previous).length && changes.every(change => change >= 0)) {
                xpGained = changes.reduce((sum, change) => sum + change, 0);
            }
        })();
        return { skills, bank, xpGained };
    };
}
