import { expect, test } from 'bun:test';
import type { BotWorldState } from '../sdk/types';
import { activityAffected, upgradeActivityOptions } from './dashboard-activity-compatibility';
import { checkStepCompatibility, nextWork, parseSteps, PlanConfigurationConflict, type Step } from './dashboard-plan';

test('a mining route release changes mining tasks without flagging fishing', () => {
    const paths = ['control/tasks/mine-resources.ts', 'control/mining-routes.ts', 'control/mining-service.test.ts'];
    expect(activityAffected('mine-adamantite-bank', paths)).toBe(true);
    expect(activityAffected('fish-sharks-cook', paths)).toBe(false);
    expect(activityAffected('fish-sharks-cook', ['control/bank-locations.ts'])).toBe(true);
    expect(activityAffected('mine-coal-bank', ['control/bank-locations.ts'])).toBe(true);
    expect(activityAffected('fish-sharks', ['control/public-status-controls.js', 'sdk/test/mine-rock.test.ts'])).toBe(false);
    expect(activityAffected('fish-sharks', ['sdk/actions.ts'])).toBe(true);
    expect(activityAffected('train-hitpoints', ['control/tasks/adventure.ts'])).toBe(true);
    expect(activityAffected('fish-sharks', ['control/tasks/adventure.ts'])).toBe(false);
    expect(activityAffected('lost-city', ['control/tasks/quests/quest-combat.ts'])).toBe(true);
    expect(activityAffected('lost-city', ['control/tasks/quests/dragon-slayer.ts'])).toBe(false);
    expect(activityAffected('fish-sharks', ['control/tasks/new-shared-helper.ts'])).toBe(true);
    expect(activityAffected('fish-sharks', ['control/new-shared-helper.ts'])).toBe(true);
    expect(activityAffected('train-cows', ['control/tasks/update-checkpoint.ts'])).toBe(true);
    const bankStock = ['control/tasks/bank-stock.ts'];
    expect(activityAffected('fish-sharks-guild-cook', bankStock)).toBe(true);
    expect(activityAffected('mine-iron-bank', bankStock)).toBe(true);
    expect(activityAffected('smelt-mithril-falador', bankStock)).toBe(true);
    expect(activityAffected('craft-body-runes', bankStock)).toBe(false);
    const smithingTraining = 'control/tasks/mithril-smithing-training.ts';
    expect(activityAffected('smelt-mithril-falador', [smithingTraining])).toBe(true);
    expect(activityAffected('smelt-mithril-falador', ['control/tasks/update-checkpoint.ts'])).toBe(true);
    expect(activityAffected('fish-sharks-cook', [smithingTraining])).toBe(false);
    expect(activityAffected('lost-city', ['control/tasks/update-checkpoint.ts'])).toBe(false);
});

test('stored legacy steps validate under their original settings version before launch', () => {
    const step = parseSteps([{ task: 'pickpocket-heroes', finish: { type: 'forever' }, options: { banking: true } }])[0]!;
    expect(step.configurationVersion).toBe(1);
    const { configurationVersion, ...legacy } = step;
    expect(checkStepCompatibility(legacy)).toEqual({ status: 'compatible', step, migrated: false });

    const future = { ...legacy, configurationVersion: 2 };
    expect(checkStepCompatibility(future)).toMatchObject({ status: 'review', reason: expect.stringContaining('unsupported') });
    expect(() => nextWork(future, {} as BotWorldState)).toThrow(PlanConfigurationConflict);

    const removed = { ...legacy, options: { oldBanking: true } } as Step;
    const before = structuredClone(removed);
    expect(checkStepCompatibility(removed)).toMatchObject({ status: 'review', reason: expect.stringContaining('"oldBanking"') });
    expect(removed).toEqual(before);

    const unsupportedFinish: Step = { ...legacy, finish: { type: 'bank-stock', quantity: 6000 } };
    expect(checkStepCompatibility(unsupportedFinish)).toMatchObject({ status: 'review', reason: expect.stringContaining('finish condition') });
    expect(() => nextWork(unsupportedFinish, {} as BotWorldState)).toThrow(PlanConfigurationConflict);
});

test('an explicit settings migration can preserve both parts of a split option', () => {
    const savedOptions = { banking: true };
    const contract = { settingsVersion: 2, settingsMigrations: {
        1: (options: unknown) => (options as typeof savedOptions | undefined)?.banking
            ? { bankFood: true, depositLoot: true }
            : undefined,
    } };
    expect(upgradeActivityOptions('Pickpocketing', contract, undefined, savedOptions)).toEqual({ bankFood: true, depositLoot: true });
    expect(upgradeActivityOptions('Pickpocketing', contract, 1, undefined)).toBeUndefined();
    expect(() => upgradeActivityOptions('Pickpocketing', { settingsVersion: 2 }, 1, savedOptions)).toThrow('settings changed');
    expect(savedOptions).toEqual({ banking: true });

    const incomplete = { settingsVersion: 3, settingsMigrations: {
        1: (input: unknown) => { (input as typeof savedOptions).banking = false; return input; },
    } };
    expect(() => upgradeActivityOptions('Pickpocketing', incomplete, 1, savedOptions)).toThrow('settings changed');
    expect(savedOptions).toEqual({ banking: true });
});
