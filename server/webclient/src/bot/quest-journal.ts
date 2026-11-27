import { ButtonType, ComponentType } from '#/config/IfType.js';
import type IfType from '#/config/IfType.js';
import type { QuestJournal, QuestProgress } from '../../../../sdk/types.js';

export const QUEST_JOURNAL_TAB = 2;
export const QUEST_JOURNAL_ID = 638;
export const QUEST_POINTS_VARP = 101; // qp in server/content/pack/varp.pack
const questList = 639;

// IF_SETCOLOUR expands the server's five-bit RGB channels. The cache's
// default red (0xff0000) is deliberately excluded until the server reports it.
const reportedColours: Partial<Record<number, QuestProgress>> = {
    0xf80000: 'not-started',
    0xf8f800: 'in-progress',
    0x00f800: 'complete',
};

export function collectQuestJournal(components: IfType[]): QuestJournal | undefined {
    const progress: QuestJournal = {};
    for (const id of components[questList]?.children ?? []) {
        const quest = components[id];
        if (!quest || quest.type !== ComponentType.TYPE_TEXT || quest.buttonType !== ButtonType.BUTTON_OK) continue;
        const status = reportedColours[quest.colour];
        if (status) progress[id] = status;
    }
    return Object.keys(progress).length ? progress : undefined;
}
