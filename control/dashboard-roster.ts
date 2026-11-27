import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostedBotName } from './hosted-bot';

export type BotProfile = { name: string; directory: string; created?: boolean };

export function dashboardRoster(botsDir: string, runtimeDir: string) {
    // The dashboard service's checkout is read-only. Keep dashboard-created
    // profiles in its private, writable runtime directory.
    const createdDir = join(runtimeDir, 'bots');
    const reserved = new Set<string>();

    async function listDirectory(root: string, created = false) {
        const entries = await readdir(root, { withFileTypes: true }).catch(error => {
            if (error.code === 'ENOENT') return [];
            throw error;
        });
        const profiles = await Promise.all(entries.filter(entry => entry.isDirectory() && hostedBotName.test(entry.name)).map(async entry => {
            const directory = join(root, entry.name);
            return await Bun.file(join(directory, 'bot.env')).exists() ? { name: entry.name, directory, created } : null;
        }));
        return profiles.filter(profile => profile !== null);
    }

    async function list() {
        const [legacy, created] = await Promise.all([listDirectory(botsDir), listDirectory(createdDir, true)]);
        return [...new Map([...created, ...legacy].map(profile => [profile.name.toLowerCase(), profile])).values()];
    }

    async function create(requested: unknown, reservedName?: string) {
        const name = typeof requested === 'string' && requested.trim() ? requested.trim() : 'B' + randomBytes(4).toString('hex');
        if ((requested !== undefined && typeof requested !== 'string') || !/^[a-zA-Z0-9]{1,12}$/.test(name)) {
            throw new Error('Use an alphanumeric name of up to 12 characters, or leave it blank.');
        }
        const key = name.toLowerCase();
        if (reserved.has(key)) throw new Error('A bot with that name is being created.');
        reserved.add(key);
        try {
            const profiles = await list();
            if (reservedName?.toLowerCase() === key || profiles.some(profile => profile.name.toLowerCase() === key)) {
                throw new Error('A bot with that name already exists in the fleet.');
            }
            const directory = join(createdDir, name);
            await mkdir(createdDir, { recursive: true, mode: 0o700 });
            await mkdir(directory, { mode: 0o700 });
            try {
                const password = randomBytes(6).toString('hex');
                await writeFile(join(directory, 'bot.env'),
                    `BOT_USERNAME=${name}\nPASSWORD=${password}\nSERVER=rs-sdk.maxbittker.com\nSHOW_CHAT=false\n`,
                    { flag: 'wx', mode: 0o600 });
            } catch (error) {
                await rm(directory, { recursive: true, force: true });
                throw error;
            }
            return { name, directory, created: true };
        } finally {
            reserved.delete(key);
        }
    }

    return { list, create };
}
