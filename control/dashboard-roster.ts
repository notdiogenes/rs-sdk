import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
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

    async function saveProfile(name: string, password: string, reservedName?: string) {
        const key = name.toLowerCase();
        if (reserved.has(key)) throw new Error('A bot with that name is being added.');
        reserved.add(key);
        try {
            const profiles = await list();
            if (reservedName?.toLowerCase() === key || profiles.some(profile => profile.name.toLowerCase() === key)) {
                throw new Error('A bot with that name already exists in the fleet.');
            }
            const directory = join(createdDir, name);
            await mkdir(createdDir, { recursive: true, mode: 0o700 });
            const pending = await mkdtemp(join(createdDir, '.profile-'));
            try {
                await writeFile(join(pending, 'bot.env'),
                    `BOT_USERNAME=${name}\nPASSWORD=${password}\nSERVER=rs-sdk.maxbittker.com\nSHOW_CHAT=false\n`,
                    { flag: 'wx', mode: 0o600 });
                await rename(pending, directory);
            } catch (error) {
                await rm(pending, { recursive: true, force: true });
                throw error;
            }
            return { name, directory, created: true };
        } finally {
            reserved.delete(key);
        }
    }

    async function create(requested: unknown, reservedName?: string) {
        const name = typeof requested === 'string' && requested.trim() ? requested.trim() : 'B' + randomBytes(4).toString('hex');
        if ((requested !== undefined && typeof requested !== 'string') || !/^[a-zA-Z0-9]{1,12}$/.test(name)) {
            throw new Error('Use an alphanumeric name of up to 12 characters, or leave it blank.');
        }
        return saveProfile(name, randomBytes(6).toString('hex'), reservedName);
    }

    async function register(requested: unknown, password: unknown, reservedName?: string) {
        const name = typeof requested === 'string' ? requested.replaceAll('_', ' ').trim() : '';
        if (!hostedBotName.test(name)) {
            throw new Error('Enter a game username with 1–12 characters using letters, digits, or spaces.');
        }
        // The game login uses single-byte strings, and bot.env readers trim values.
        if (typeof password !== 'string' || password !== password.trim() || !/^[\x20-\x7e\u00a0-\u00ff]{1,20}$/.test(password)) {
            throw new Error('Enter a 1–20 character game password with supported characters and no leading or trailing spaces.');
        }
        return saveProfile(name, password, reservedName);
    }

    return { list, create, register };
}
