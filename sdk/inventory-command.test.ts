import { expect, test } from 'bun:test';
import { parseInventoryCommand, prepareInventoryCommand } from './inventory-command';

const shrimp = { slot: 3, id: 315, name: 'Shrimps', count: 1, optionsWithIndex: [{ text: 'Eat', opIndex: 2 }] };
const coins = { slot: 4, id: 995, name: 'Coins', count: 701, optionsWithIndex: [] };
const game = {
    inGame: true, player: {}, modalOpen: false, dialog: { isOpen: false },
    shop: { isOpen: false }, bank: { isOpen: false }, inventory: [shrimp, coins],
};
const eat = { action: 'eat', slot: shrimp.slot, id: shrimp.id, count: shrimp.count } as const;
const drop = { action: 'drop', slot: coins.slot, id: coins.id, count: coins.count } as const;

test('validates the requested operation, slot, item and count', () => {
    expect(parseInventoryCommand(drop)).toEqual(drop);
    expect(parseInventoryCommand({ ...drop, slot: 28 })).toBeNull();
    expect(parseInventoryCommand({ ...drop, id: -1 })).toBeNull();
    expect(parseInventoryCommand({ ...drop, count: 0 })).toBeNull();
    expect(parseInventoryCommand({ ...drop, action: 'equip' })).toBeNull();
});

test('rechecks stale slots and inventory blockers before dispatch', () => {
    expect(prepareInventoryCommand(game, { ...drop, count: 700 })).toMatchObject({ status: 409 });
    expect(prepareInventoryCommand(game, { ...drop, slot: shrimp.slot })).toMatchObject({ status: 409 });
    expect(prepareInventoryCommand({ ...game, inGame: false }, drop)).toMatchObject({ status: 409 });
    expect(prepareInventoryCommand({ ...game, bank: { isOpen: true } }, drop)).toMatchObject({ status: 409 });
    expect(prepareInventoryCommand(game, { ...drop, action: 'eat' })).toMatchObject({ status: 422 });
});

test('confirms Eat only when the selected food has been consumed', () => {
    const prepared = prepareInventoryCommand(game, eat);
    if ('status' in prepared) throw new Error(prepared.message);
    expect(prepared.action).toMatchObject({ type: 'useInventoryItem', slot: shrimp.slot, optionIndex: 2 });
    expect(prepared.observed(game)).toBe(false);
    expect(prepared.observed({ ...game, inventory: [{ ...shrimp, slot: 5 }, coins] })).toBe(false);
    expect(prepared.observed({ ...game, inventory: [coins] })).toBe(true);
});

test('confirms Drop only when the whole selected stack leaves the backpack', () => {
    const prepared = prepareInventoryCommand(game, drop);
    if ('status' in prepared) throw new Error(prepared.message);
    expect(prepared.action).toMatchObject({ type: 'dropItem', slot: coins.slot });
    expect(prepared.observed(game)).toBe(false);
    expect(prepared.observed({ ...game, inventory: [shrimp, { ...coins, count: 1 }] })).toBe(false);
    expect(prepared.observed({ ...game, inventory: [shrimp, { ...coins, slot: 5 }] })).toBe(false);
    expect(prepared.observed({ ...game, inventory: [shrimp] })).toBe(true);
});

test('respects custom inventory options in place of Drop', () => {
    const custom = { ...coins, optionsWithIndex: [{ text: 'Destroy', opIndex: 5 }] };
    expect(prepareInventoryCommand({ ...game, inventory: [custom] }, drop)).toMatchObject({ status: 422 });
    custom.optionsWithIndex.push({ text: 'Drop', opIndex: 4 });
    expect(prepareInventoryCommand({ ...game, inventory: [custom] }, drop)).toMatchObject({
        action: { type: 'useInventoryItem', slot: coins.slot, optionIndex: 4 },
    });
});
