import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Loaded<T> = { revision: string | undefined; value: T };
type TaskRelease = { revision: string | undefined; path: string; sha: string; release(): Promise<void> };
type Snapshot = { directory: Promise<string>; references: number };

const commitHash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function dashboardRevisions(sourceDirectory: string, runtimeDirectory: string) {
    const source = resolve(sourceDirectory);
    const root = dirname(source);
    const gitDirectory = join(root, '.git');
    const snapshots = new Map<string, Snapshot>();
    const comparisons = new Map<string, Promise<string[]>>();

    async function git(...args: string[]) {
        const child = Bun.spawn(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        if (exitCode !== 0) throw new Error(`Could not read the Fleet Desk checkout: ${stderr.trim()}`);
        return stdout;
    }

    async function head() {
        const read = (path: string) => readFile(join(gitDirectory, path), 'utf8').then(text => text.trim()).catch(() => '');
        const file = await read('HEAD');
        const ref = /^ref: (refs\/heads\/[a-z0-9_./-]+)$/i.exec(file)?.[1];
        const direct = ref && !ref.includes('..') ? await read(ref) : file;
        if (commitHash.test(direct)) return direct;
        // Packed refs and linked worktrees do not have this checkout's loose ref.
        const [detectedRoot, revision] = (await git('rev-parse', '--show-toplevel', '--verify', 'HEAD')).trim().split('\n');
        if (detectedRoot !== root || !revision || !commitHash.test(revision)) {
            throw new Error('The Fleet Desk source is not a Git checkout.');
        }
        return revision;
    }

    async function changedPaths(from: string, to: string): Promise<readonly string[]> {
        if (!commitHash.test(from) || !commitHash.test(to)) throw new Error('Unknown task release.');
        if (from === to) return [];
        const key = `${from}:${to}`;
        let result = comparisons.get(key);
        if (!result) {
            result = git('diff', '--name-only', '-z', from, to, '--').then(body => body.split('\0').filter(Boolean));
            comparisons.set(key, result);
            if (comparisons.size > 32) comparisons.delete(comparisons.keys().next().value!);
        }
        try { return await result; }
        catch (error) { comparisons.delete(key); throw error; }
    }

    async function build<T>(entry: string, revision: string, valid: (module: unknown) => boolean, label: string): Promise<Loaded<T>> {
        // Read source inputs from one immutable commit, even while Git updates the checkout.
        const result = await Bun.build({
            entrypoints: [join(source, entry)],
            target: 'bun',
            format: 'esm',
            packages: 'external',
            plugins: [{
                name: 'fleet-desk-revision',
                setup(builder) {
                    builder.onLoad({ filter: /\.[cm]?[jt]s$|\.json$/ }, async ({ path }) => {
                        const filename = relative(root, path);
                        const suffix = filename.split('.').at(-1);
                        const loader = suffix === 'json' ? 'json' : suffix?.endsWith('ts') ? 'ts' : 'js';
                        return { contents: await git('show', `${revision}:${filename}`), loader };
                    });
                },
            }],
        });
        const output = result.outputs[0];
        if (!result.success || result.outputs.length !== 1 || !output) throw new Error(`Fleet Desk ${label} did not build as one module.`);
        const directory = await mkdtemp(join(runtimeDirectory, '.fleet-policy-'));
        try {
            const modulePath = join(directory, 'policy.mjs');
            await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
            await writeFile(modulePath, await output.text(), { mode: 0o600 });
            const value: unknown = await import(pathToFileURL(modulePath).href);
            if (!valid(value)) throw new Error(`Fleet Desk ${label} is incompatible with the running worker.`);
            return { revision, value: value as T };
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    function load<T>(entry: string, valid: (module: unknown) => boolean, label: string, fallback?: T) {
        let current: Loaded<T> | undefined;
        let failedRevision: string | undefined;
        let retryAfter = 0;
        let loading: Promise<Loaded<T>> | undefined;

        return function loadCurrent() {
            if (loading) return loading;
            loading = (async () => {
                let revision: string | undefined;
                try {
                    revision = await head();
                    if (current?.revision === revision) return current;
                    if (current && revision === failedRevision && Date.now() < retryAfter) return current;
                    current = await build<T>(entry, revision, valid, label);
                    failedRevision = undefined;
                    return current;
                } catch (error) {
                    if (!current) {
                        if (revision === undefined && fallback !== undefined) return { revision, value: fallback };
                        throw error;
                    }
                    console.error(`Keeping the previous Fleet Desk ${label}`, error);
                    failedRevision = revision;
                    retryAfter = Date.now() + 30_000;
                    return current;
                } finally {
                    loading = undefined;
                }
            })();
            return loading;
        };
    }

    async function extractTaskSnapshot(revision: string) {
        const directory = await mkdtemp(join(runtimeDirectory, '.fleet-tasks-'));
        try {
            // Include script imports and runtime assets such as gear wiki pages and the
            // local pathfinder. The archive excludes profiles, credentials, and Git metadata.
            const archive = Bun.spawn(['git', 'archive', '--format=tar', revision, '--',
                'control', 'sdk', 'server/vendor/rsmod-pathfinder', 'wiki/items', ':(exclude)control/dashboard-enrollment.json'], {
                cwd: root, stdout: 'pipe', stderr: 'pipe',
            });
            try {
                const tar = Bun.spawn(['tar', '-xf', '-', '-C', directory], { stdin: archive.stdout, stdout: 'ignore', stderr: 'pipe' });
                const [archiveCode, tarCode, archiveError, tarError] = await Promise.all([
                    archive.exited, tar.exited, new Response(archive.stderr).text(), new Response(tar.stderr).text(),
                ]);
                if (archiveCode !== 0 || tarCode !== 0) {
                    throw new Error(`Could not extract Fleet Desk tasks at ${revision}: ${(archiveError || tarError).trim()}`);
                }
            } finally {
                if (archive.exitCode === null) archive.kill();
            }
            await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
            return directory;
        } catch (error) {
            await rm(directory, { recursive: true, force: true });
            throw error;
        }
    }

    async function taskHash(path: string) {
        return createHash('sha256').update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest('hex');
    }

    async function pinTask(revision: string | undefined, script: string): Promise<TaskRelease> {
        if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)*\.ts$/.test(script)) throw new Error('Invalid Fleet Desk task script.');
        if (revision === undefined) {
            const path = join(source, 'tasks', script);
            return { revision, path, sha: await taskHash(path), async release() {} };
        }
        if (!commitHash.test(revision)) throw new Error('Invalid Fleet Desk task revision.');
        const commit = revision;
        let snapshot = snapshots.get(commit);
        if (!snapshot) {
            snapshot = { directory: extractTaskSnapshot(commit), references: 0 };
            snapshots.set(commit, snapshot);
        }
        snapshot.references++;
        const pinned = snapshot;
        let released = false;
        async function release() {
            if (released) return;
            released = true;
            if (--pinned.references !== 0) return;
            snapshots.delete(commit);
            const directory = await pinned.directory.catch(() => undefined);
            if (directory) await rm(directory, { recursive: true, force: true });
        }
        try {
            const path = join(await pinned.directory, 'control', 'tasks', script);
            return { revision, path, sha: await taskHash(path), release };
        } catch (error) {
            await release();
            throw error;
        }
    }

    return { head, load, pinTask, changedPaths };
}
