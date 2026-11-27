import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotWorldState } from '../sdk/types';
import { dashboardFleetStats } from './dashboard-fleet-stats';

test('bank snapshots preserve game slots and survive closing the bank', () => {
    const path = mkdtempSync(join(tmpdir(), 'fleet-bank-'));
    try {
        const observe = dashboardFleetStats(path);
        const items = [
            { slot: 0, id: 995, name: 'Coins', count: 276083 },
            { slot: 8, id: 560, name: 'Death rune', count: 12 },
            { slot: 575, id: 1277, name: 'Bronze sword', count: 1 },
        ];
        const sample = { player: { combatLevel: 59 }, skills: [], bank: { isOpen: true, items } } as unknown as BotWorldState;
        const expected = { at: 8000, stacks: 3, coins: 276083, items };
        expect(observe('Scout', sample, 8000).bank).toEqual(expected);
        expect(observe('Scout', { ...sample, bank: { isOpen: false, items: [], noteMode: false } }, 9000).bank).toEqual(expected);
        expect(observe('Scout', { ...sample, bank: { ...sample.bank, items: [] } }, 7000).bank).toEqual(expected);
        expect(observe('Scout').bank).toEqual(expected);
        expect(observe('Scout', { ...sample, bank: { ...sample.bank, items: [] } }, 10000).bank).toEqual({
            at: 10000, stacks: 0, coins: 0, items: [],
        });
    } finally {
        rmSync(path, { recursive: true, force: true });
    }
});

test('older balance-only snapshots remain readable', () => {
    const path = mkdtempSync(join(tmpdir(), 'fleet-bank-legacy-'));
    try {
        const observe = dashboardFleetStats(path);
        expect(observe('Scout').bank).toBeNull();
        const legacy = { at: 1000, coins: 42, stacks: 3 };
        const db = new Database(join(path, 'fleet-stats.sqlite'));
        try {
            db.query('INSERT INTO fleet_stats (bot, bank) VALUES (?, ?)').run('Scout', JSON.stringify(legacy));
        } finally {
            db.close();
        }
        expect(observe('Scout').bank).toEqual(legacy);
    } finally {
        rmSync(path, { recursive: true, force: true });
    }
});
