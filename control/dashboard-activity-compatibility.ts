import { activity, activityIds, initialSettingsVersion, isActivity, type ActivityId, type ActivitySettingsContract } from './dashboard-task-catalog';

export function upgradeActivityOptions(label: string, contract: ActivitySettingsContract, configurationVersion: number | undefined,
    savedOptions: unknown): unknown {
    const version = configurationVersion === undefined ? initialSettingsVersion : configurationVersion;
    const current = contract.settingsVersion ?? initialSettingsVersion;
    if (!Number.isSafeInteger(version) || !Number.isSafeInteger(current) || version < initialSettingsVersion || version > current) {
        throw new Error(`${label} has an unsupported saved settings version. Review this step before continuing.`);
    }
    let options = version === current ? savedOptions : structuredClone(savedOptions);
    for (let from = version; from < current; from++) {
        const migrate = contract.settingsMigrations?.[from];
        if (!migrate) throw new Error(`${label} settings changed from version ${version} to ${current}. Review the saved options before continuing.`);
        options = migrate(options);
    }
    return options;
}

const taskDirectory = 'control/tasks/';
const scripts = new Set(activityIds.map(task => activity(task).script));
const usesAdventure = (script: string) => ['pickpocket.ts', 'train-hitpoints.ts', 'train-hp-pickpocket.ts'].includes(script);
const checkpointScripts = new Set([
    'craft-body-runes.ts', 'fish-sharks.ts', 'mine-resources.ts', 'pickpocket.ts', 'smelt-mithril-falador.ts',
    'train-cows.ts', 'train-hitpoints.ts', 'train-hp-pickpocket.ts',
]);
const questCombat = new Set(['quests/dragon-slayer.ts', 'quests/lost-city.ts']);

export function activityAffected(task: ActivityId, paths: readonly string[]): boolean {
    if (!isActivity(task)) return true;
    const { script, category } = activity(task);
    return paths.some(path => {
        if (/\.test\.[cm]?[jt]sx?$/.test(path) || path.startsWith('sdk/test/') || path.startsWith('sdk/docs/')) return false;
        if (path.startsWith('sdk/') || path.startsWith('server/vendor/rsmod-pathfinder/')) return true;
        if (['package.json', 'bun.lock', 'bun.lockb'].includes(path)) return true;
        if (path === 'control/mining-routes.ts') return category === 'Mining';
        if (path === 'control/dashboard-task-activity.ts' && script === 'craft-body-runes.ts') return true;
        if (path === 'control/bank-locations.ts' || path === 'control/dashboard-task-activity.ts') {
            return category === 'Mining' || category === 'Fishing' || category === 'Smithing';
        }
        if (path === 'control/task-update-safety.ts' || path === 'control/tasks/update-checkpoint.ts') return checkpointScripts.has(script);
        if (path === 'control/dashboard-worker-policy.ts') return true;
        if (path === 'control/dashboard-task-catalog.ts') return usesAdventure(script);
        if (path.startsWith('wiki/items/')) return script === 'train-cows.ts';
        if (!path.startsWith(taskDirectory)) return /^control\/(?!dashboard-|public-status)[^/]+\.[cm]?[jt]s$/.test(path);

        const changed = path.slice(taskDirectory.length);
        if (changed === script) return true;
        if (scripts.has(changed)) return false;
        if (changed === 'bank-stock.ts') return ['mine-resources.ts', 'fish-sharks.ts', 'smelt-mithril-falador.ts'].includes(script);
        if (changed === 'adventure.ts') return usesAdventure(script);
        if (changed === 'mithril-smithing-training.ts') return script === 'smelt-mithril-falador.ts';
        if (changed === 'tutorial.ts') return script === 'pickpocket.ts' || script === 'skip-tutorial.ts';
        if (changed === 'quests/shared.ts') return script.startsWith('quests/');
        if (changed === 'quests/quest-combat.ts') return questCombat.has(script);
        if (changed === 'quests/dragon-slayer-return.ts' || changed === 'quests/dragon-slayer-smithing.ts') {
            return script === 'quests/dragon-slayer.ts';
        }
        // A new helper may be shared. Treat it as a possible task change until scoped.
        return true;
    });
}
