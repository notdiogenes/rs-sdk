import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import './dom-shim.js';

import IfType from '#/config/IfType.js';
import ObjType from '#/config/ObjType.js';
import Packet from '#/io/Packet.js';
import { ServerProt } from '#/io/ServerProt.js';
import { dashboardFleetStats } from '../../../../control/dashboard-fleet-stats';
import { dashboardClientFeed, dashboardStateReader, fleetAvailability } from '../../../../control/dashboard-live-state';
import { BANK_INV_ID } from './actions.js';
import { captureBaseInterfaces, resetBaseInterfaces } from './interfaces.js';
import { LiteClient } from './LiteClient.js';
import { dispatch } from './protocol/incoming.js';

test('bank packets save slots and counts immediately, including a visit between dashboard reads', () => {
    const directory = mkdtempSync(join(tmpdir(), 'bank-telemetry-'));
    const priorInterfaces = IfType.list;
    const itemDefinition = spyOn(ObjType, 'list').mockImplementation(id => ({ id, name: 'Coins' }) as ObjType);
    try {
        const bank = new IfType();
        bank.linkObjType = new Int32Array(576);
        bank.linkObjNumber = new Int32Array(576);
        resetBaseInterfaces();
        IfType.list = [];
        IfType.list[BANK_INV_ID] = bank;
        captureBaseInterfaces();

        const writer = dashboardFleetStats(directory);
        const reader = dashboardFleetStats(directory);
        const feed = dashboardClientFeed((items, at) => writer.recordBank('Scout', items, at));
        const client = new LiteClient({ connection: {} as never, locIndex: {} as never, username: 'Scout', password: '' });
        let at = 1000;
        client.setOnBankUpdateCallback(items => feed.receive({ type: 'fleet-bank', at: at++, items }));

        function bankPacket(opcode: number, write: (packet: Packet) => void) {
            const packet = Packet.alloc(1);
            packet.p2(BANK_INV_ID);
            write(packet);
            const size = packet.pos;
            packet.pos = 0;
            dispatch(client, opcode, packet, size);
        }

        bankPacket(ServerProt.UPDATE_INV_FULL, packet => packet.p2(0));
        const updateCoins = (packet: Packet) => {
            packet.p2(32768 + 575); // Two-byte unsigned smart slot.
            packet.p2(996); // Inventory packets encode item IDs plus one.
            packet.p1(255);
            packet.p4(276083);
        };
        bankPacket(ServerProt.UPDATE_INV_PARTIAL, updateCoins);
        bankPacket(ServerProt.UPDATE_INV_STOP_TRANSMIT, () => {});
        expect(client.getBankItems()).toEqual([]);
        bankPacket(ServerProt.UPDATE_INV_PARTIAL, updateCoins);
        writer.recordBank('Scout', [], 1000); // An older legacy sample arrived late.

        expect(reader('Scout').bank).toEqual({ at: 1001, stacks: 1, coins: 276083,
            items: [{ slot: 575, id: 995, name: 'Coins', count: 276083 }] });
        expect(reader.bankOverview()).toEqual([{ name: 'Scout', at: 1001, stacks: 1, coins: 276083 }]);

        bankPacket(ServerProt.UPDATE_INV_FULL, packet => packet.p2(0));
        expect(reader('Scout').bank).toEqual({ at: 1002, stacks: 0, coins: 0, items: [] });
    } finally {
        itemDefinition.mockRestore();
        resetBaseInterfaces();
        IfType.list = priorInterfaces;
        captureBaseInterfaces();
        rmSync(directory, { recursive: true, force: true });
    }
});

test('managed live state avoids gateway reads and expires from its capture time', async () => {
    const feed = dashboardClientFeed(() => {});
    const read = dashboardStateReader();
    const at = Date.now();
    const player = { worldX: 1, worldZ: 2, level: 0, hp: 5, maxHp: 10, combatLevel: 3, combat: { inCombat: false } };
    const state = { tick: 10, inGame: true, skills: [], inventory: [], player };
    feed.receive({ type: 'fleet-state', at, state });
    feed.receive({ type: 'fleet-state', at: at - 100, state: { ...state, tick: 9 } });
    const frame = feed.state()!;
    const result = await read('Scout', '/unconfigured-bot', frame);
    expect(result?.state?.tick).toBe(10);
    expect(fleetAvailability(result)).toBe('live');
    expect(fleetAvailability(await read('Scout', '/unconfigured-bot', { ...frame, at: at - 10_001 }))).toBe('stale');
});
