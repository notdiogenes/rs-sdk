import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { dashboardActivity } from './dashboard-activity';
import type { ControllerStatus } from './dashboard-activity';
import { fleetAvailability, type FleetStateReading } from './dashboard-live-state';

type GameState = {
    availability: 'live' | 'stale' | 'offline' | 'unavailable';
    stateAgeMs?: number | null;
    tick?: number;
    player?: { x: number; z: number; hp: number; maxHp: number; inCombat: boolean };
    skills?: { name: string; experience: number }[];
};
type Controller = ReturnType<typeof dashboardActivity>;
type Reading = {
    checkedAt: string;
    controller: Controller | null;
    game: GameState | null;
    movedAt: string | null;
    gainedXpAt: string | null;
};
type Event = { at: string; message: string };

export function dashboardDiagnostics(directory: string) {
    let db: Database | undefined;
    let latest: Reading | undefined;
    let previous: Reading | undefined;
    let history: Event[] = [];

    function load() {
        if (db) return db;
        const database = new Database(join(directory, 'diagnostics.sqlite'));
        database.run('CREATE TABLE IF NOT EXISTS diagnostics (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
        const record = database.query('SELECT data FROM diagnostics WHERE id = 1').get() as { data: string } | null;
        if (record) {
            const saved = JSON.parse(record.data) as { previous: Reading; history: Event[] };
            previous = saved.previous;
            history = saved.history;
        }
        db = database;
        return db;
    }

    function observe(status: ControllerStatus | null, result: FleetStateReading | null | undefined) {
        const controller = status ? dashboardActivity(status) : null;
        const state = result?.state;
        const player = state?.player;
        const game: GameState | null = controller?.bot ? {
            availability: fleetAvailability(result),
            stateAgeMs: result && Number.isFinite(result.stateAge) ? result.stateAge : null,
            tick: state?.tick,
            player: player ? {
                x: player.worldX, z: player.worldZ, hp: player.hp, maxHp: player.maxHp, inCombat: player.combat?.inCombat,
            } : undefined,
            skills: state?.skills,
        } : null;
        const checkedAt = new Date().toISOString();
        const database = load();
        const sameBot = controller?.bot && previous?.controller?.bot === controller.bot;
        const priorGame = sameBot ? previous?.game : null;
        const comparable = game?.availability === 'live' && priorGame?.availability === 'live';
        const moved = comparable && game.player && priorGame.player &&
            (game.player.x !== priorGame.player.x || game.player.z !== priorGame.player.z);
        const gainedXp = comparable && game.skills?.some(skill =>
            priorGame.skills?.some(prior => prior.name === skill.name && prior.experience < skill.experience));
        const reading: Reading = {
            checkedAt, controller, game,
            movedAt: moved ? checkedAt : sameBot ? previous?.movedAt ?? null : null,
            gainedXpAt: gainedXp ? checkedAt : sameBot ? previous?.gainedXpAt ?? null : null,
        };
        const prior = sameBot ? previous?.controller : null;
        const events: Event[] = [];
        const note = (message: string, at = checkedAt) => events.push({ at, message });
        if (controller) {
            if (latest?.controller === null) note('Controller responding again');
            if (controller.client && prior?.client?.startedAt !== controller.client.startedAt) {
                note('Managed client started', controller.client.startedAt);
            } else if (prior?.client && !controller.client) note('Managed client no longer running');
            if (controller.starting && prior?.starting !== controller.starting) note(`Starting ${controller.starting}`);
            if (controller.task && prior?.task?.startedAt !== controller.task.startedAt) {
                note(`Activity started: ${controller.task.name}`, controller.task.startedAt);
            }
            if (controller.startError && prior?.startError !== controller.startError) {
                note(`Start failed: ${controller.startError}`);
            }
            if (controller.lastTask && prior?.lastTask?.finishedAt !== controller.lastTask.finishedAt) {
                const { name, exitCode, finishedAt } = controller.lastTask;
                note(`Activity exited: ${name} (code ${exitCode})`, finishedAt);
            } else if (prior?.task && !controller.task) {
                note(`Activity no longer running: ${prior.task.name}`);
            }
            if (game && priorGame?.availability !== game.availability) note(`Game state: ${game.availability}`);
            previous = reading;
        } else if (latest?.controller !== null) {
            note('Controller did not return status');
        }
        history = [...events.reverse(), ...history].slice(0, 60);
        database.query('INSERT OR REPLACE INTO diagnostics (id, data) VALUES (1, ?)').run(JSON.stringify({ previous, history }));
        latest = reading;
    }

    function read() {
        const game = latest?.game;
        return {
            reading: latest && {
                ...latest,
                game: game && { availability: game.availability, stateAgeMs: game.stateAgeMs, tick: game.tick, player: game.player },
            },
            history: history.slice(0, 20),
        };
    }

    return { observe, read };
}
