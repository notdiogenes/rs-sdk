import { meleeStylePreferences, meleeTargetSkills, type MeleeGoal } from './melee-training';
import { miningResources, miningSelection, type MiningTask } from './mining-routes';

export const trainingSkills = ['Hitpoints', 'Thieving', 'Attack', 'Strength', 'Defence', 'Runecraft', 'Mining', 'Fishing', 'Cooking'] as const;
export type TrainingSkill = typeof trainingSkills[number];
export type Finish =
    | MeleeGoal
    | { type: 'complete' }
    | { type: 'essence-exhausted' }
    | { type: 'bank-stock'; quantity: number }
    | { type: 'minutes'; minutes: number }
    | { type: 'level'; skill: TrainingSkill; level: number }
    | { type: 'forever' };

export type Requirement =
    | { type: 'level'; skill: TrainingSkill; level: number }
    | { type: 'quest'; task: string };

type ActivityOptionId = 'banking' | 'finishOnEssenceExhausted';
type ActivityOption = { id: ActivityOptionId; type: 'checkbox'; label: string };
export type ActivityOptions = Partial<Record<ActivityOptionId, true>>;
export type ActivitySettingsContract = {
    settingsVersion?: number;
    /** Each migration preserves behavior when moving from its key to the next settings version. */
    settingsMigrations?: Readonly<Record<number, (savedOptions: unknown) => unknown>>;
};

export const initialSettingsVersion = 1;

const pickpocketOptions = [
    { id: 'banking', type: 'checkbox', label: 'Bank loot and restock food' },
] satisfies readonly ActivityOption[];

type Activity = ActivitySettingsContract & {
    label: string;
    category: 'Quests' | 'Combat' | 'Thieving' | 'Runecraft' | 'Mining' | 'Fishing' | 'Smithing' | 'Setup' | 'Legacy';
    usage: 'once' | 'repeatable';
    script: string;
    selectors?: readonly { label: string; value: string }[];
    bankStockItem?: string;
    finishModes?: readonly Finish['type'][];
    requirements?: Requirement[];
    trains?: readonly TrainingSkill[];
    journal?: number;
    options?: readonly ActivityOption[];
};

const level = (skill: TrainingSkill, minimum: number): Requirement => ({ type: 'level', skill, level: minimum });

function pickpocket(target: string, ...requirements: Requirement[]): Activity {
    return {
        label: `Pickpocket ${target}`, category: 'Thieving', usage: 'repeatable', script: 'pickpocket.ts',
        trains: ['Thieving'], options: pickpocketOptions, selectors: [{ label: 'Target', value: target }],
        ...(requirements.length > 0 && { requirements }),
    };
}

function sharkFishing(label: string, location: 'Catherby' | 'Fishing Guild', cook: boolean): Activity {
    const requirements: Requirement[] = [];
    if (location === 'Fishing Guild') {
        requirements.push(level('Fishing', 68));
        if (cook) requirements.push(level('Cooking', 10));
    }
    return {
        label, category: 'Fishing', usage: 'repeatable', script: 'fish-sharks.ts',
        trains: cook ? ['Fishing', 'Cooking'] : ['Fishing'],
        bankStockItem: cook ? 'cooked sharks' : 'raw sharks',
        selectors: [{ label: 'Location', value: location }, { label: 'Catch handling', value: cook ? 'Cook' : 'Keep raw' }],
        ...(requirements.length > 0 && { requirements }),
    };
}

const ores = new Set(['copper', 'tin', 'iron', 'silver', 'gold', 'mithril', 'adamantite']);
const miningTasks = Object.keys(miningResources).flatMap(resource =>
    (['bank', 'power'] as const).map(mode => `mine-${resource}-${mode}` as MiningTask));
const miningActivities = Object.fromEntries<Activity>(miningTasks.map(id => {
    const { resource, mode } = miningSelection(id);
    const name = miningResources[resource].label;
    return [id, {
        label: mode === 'bank' ? `Mine and bank ${name.toLowerCase()}` : `Powermine ${name.toLowerCase()}`,
        category: 'Mining', usage: 'repeatable', script: 'mine-resources.ts', trains: ['Mining'],
        selectors: [{ label: 'Resource', value: name }, { label: 'Method', value: mode === 'bank' ? 'Bank the yield' : 'Powermine' }],
        ...(mode === 'bank' && { bankStockItem: ores.has(resource) ? `${resource} ore` : name.toLowerCase() }),
    } satisfies Activity];
})) as Record<MiningTask, Activity>;

export const activityCatalog = {
    'lost-city': {
        label: 'Lost City', category: 'Quests', usage: 'once', script: 'quests/lost-city.ts', journal: 7367,
    },
    'dragon-maze-recovery': {
        label: 'Check Melzar’s Maze for dropped items', category: 'Setup', usage: 'once',
        script: 'quests/dragon-maze-recovery.ts',
    },
    'dragon-slayer': {
        label: 'Dragon Slayer', category: 'Quests', usage: 'once', script: 'quests/dragon-slayer.ts', journal: 7383,
    },
    'sheep-shearer': {
        label: 'Sheep Shearer', category: 'Quests', usage: 'once', script: 'quests/sheep-shearer.ts', journal: 7344,
    },
    'romeo-and-juliet': {
        label: 'Romeo & Juliet', category: 'Quests', usage: 'once', script: 'quests/romeo-and-juliet.ts', journal: 7343,
    },
    'vampire-slayer': {
        label: 'Vampire Slayer', category: 'Quests', usage: 'once', script: 'quests/vampire-slayer.ts', journal: 7347,
    },
    'ernest-the-chicken': {
        label: 'Ernest the Chicken', category: 'Quests', usage: 'once', script: 'quests/ernest-the-chicken.ts', journal: 7339,
    },
    'goblin-diplomacy': {
        label: 'Goblin Diplomacy', category: 'Quests', usage: 'once', script: 'quests/goblin-diplomacy.ts', journal: 7338,
    },
    'druidic-ritual': {
        label: 'Druidic Ritual', category: 'Quests', usage: 'once', script: 'quests/druidic-ritual.ts', journal: 7355,
    },
    'witchs-house': {
        label: 'Witch’s House', category: 'Quests', usage: 'once', script: 'quests/witchs-house.ts', journal: 7351,
    },
    'black-knights-fortress': {
        label: 'Black Knight’s Fortress', category: 'Quests', usage: 'once', script: 'quests/black-knights-fortress.ts', journal: 7332,
    },
    'dorics-quest': {
        label: 'Doric’s Quest', category: 'Quests', usage: 'once', script: 'quests/dorics-quest.ts', journal: 7336,
    },
    'cooks-assistant': {
        label: 'Cook’s Assistant', category: 'Quests', usage: 'once', script: 'quests/cooks-assistant.ts', journal: 7333,
    },
    'restless-ghost': {
        label: 'The Restless Ghost', category: 'Quests', usage: 'once', script: 'quests/restless-ghost.ts', journal: 7337,
    },
    'train-hitpoints': {
        label: 'Train Hitpoints', category: 'Combat', usage: 'repeatable', script: 'train-hitpoints.ts', trains: ['Hitpoints'],
    },
    'train-cows': {
        label: 'Train melee on cows', category: 'Combat', usage: 'repeatable', script: 'train-cows.ts',
        finishModes: ['minutes', 'level', 'melee-levels', 'forever'],
        requirements: [level('Hitpoints', 15)], trains: ['Attack', 'Strength', 'Defence'],
    },
    'pickpocket-men': pickpocket('Men'),
    'pickpocket-guards': pickpocket('Guards', level('Thieving', 40)),
    'pickpocket-knights': pickpocket('Ardougne Knights', level('Thieving', 55)),
    'pickpocket-paladins': pickpocket('Paladins', level('Thieving', 70)),
    'pickpocket-heroes': pickpocket('Heroes', level('Thieving', 80), level('Hitpoints', 80)),
    'craft-body-runes': {
        label: 'Craft Body runes', category: 'Runecraft', usage: 'repeatable', script: 'craft-body-runes.ts', trains: ['Runecraft'],
        finishModes: ['minutes', 'level', 'essence-exhausted', 'forever'],
        options: [{ id: 'finishOnEssenceExhausted', type: 'checkbox', label: 'Also finish when rune essence runs out' }],
    },
    ...miningActivities,
    'smelt-mithril-falador': {
        label: 'Smelt mithril bars in Falador', category: 'Smithing', usage: 'repeatable',
        script: 'smelt-mithril-falador.ts', bankStockItem: 'mithril bars', finishModes: ['bank-stock'],
    },
    'fish-sharks': sharkFishing('Fish sharks', 'Catherby', false),
    'fish-sharks-cook': sharkFishing('Fish sharks and cook them', 'Catherby', true),
    'fish-sharks-guild': sharkFishing('Fish sharks at the Fishing Guild', 'Fishing Guild', false),
    'fish-sharks-guild-cook': sharkFishing('Fish and cook sharks at the Fishing Guild', 'Fishing Guild', true),
    'skip-tutorial': { label: 'Skip Tutorial Island', category: 'Setup', usage: 'once', script: 'skip-tutorial.ts' },
    'train-hp-pickpocket': {
        label: 'Train Hitpoints, then pickpocket', category: 'Legacy', usage: 'repeatable', script: 'train-hp-pickpocket.ts',
    },
} satisfies Record<string, Activity>;

export type ActivityId = keyof typeof activityCatalog;
export const isActivity = (id: unknown): id is ActivityId => typeof id === 'string' && Object.hasOwn(activityCatalog, id);
export const activity = (id: ActivityId): Activity => activityCatalog[id];
export const activityIds = Object.keys(activityCatalog) as ActivityId[];

export function activityOptionsFor(task: ActivityId, values?: Readonly<Record<string, unknown>>): ActivityOptions | undefined {
    const enabled = activity(task).options?.filter(({ id }) => values?.[id] === true);
    return enabled?.length ? Object.fromEntries(enabled.map(({ id }) => [id, true])) : undefined;
}

export function parseActivityOptions(task: ActivityId, value: unknown): ActivityOptions | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid activity options.');
    const values = value as Record<string, unknown>;
    const options = activity(task).options;
    for (const [id, enabled] of Object.entries(values)) {
        if (!options?.some(option => option.id === id)) throw new Error(`Choose a valid option for this activity. "${id}" is unavailable.`);
        if (typeof enabled !== 'boolean') throw new Error(`Choose a valid option value for "${id}".`);
    }
    return activityOptionsFor(task, values);
}

export function finishModesFor(meta: Activity): readonly Finish['type'][] {
    if (meta.finishModes) return meta.finishModes;
    if (meta.usage === 'once') return ['complete'];
    const modes: Finish['type'][] = ['minutes'];
    if (meta.trains?.length) modes.push('level');
    if (meta.bankStockItem) modes.push('bank-stock');
    modes.push('forever');
    return modes;
}

export const planCatalog = activityIds.flatMap(id => {
    const entry = activity(id);
    if (entry.category === 'Legacy' || entry.category === 'Setup') return [];
    const { script, settingsMigrations, ...meta } = entry;
    const finishModes = finishModesFor(entry);
    const selectors = meta.selectors ?? (meta.category === 'Quests' ? [{ label: 'Quest', value: meta.label }]
        : meta.category === 'Combat' ? [{ label: 'Training activity', value: meta.label }] : []);
    return [{
        id, ...meta, selectors, finishModes,
        ...(finishModes.includes('melee-levels') && { meleeTraining: { skills: meleeTargetSkills, styles: meleeStylePreferences } }),
        settingsVersion: meta.settingsVersion ?? initialSettingsVersion,
        // Older dashboard versions interpret this field as a mandatory bank target.
        ...(finishModes.length === 1 && finishModes[0] === 'bank-stock' && { stockTargetItem: meta.bankStockItem }),
    }];
});

export function onTutorial(x: number, z: number) {
    return (x >= 3053 && x <= 3156 && z >= 3056 && z <= 3136) ||
        (x >= 3072 && x <= 3118 && z >= 9492 && z <= 9535);
}

export function inTutorialDestination(x: number, z: number, plane: number) {
    return plane === 0 && x >= 3200 && x <= 3255 && z >= 3190 && z <= 3250;
}
