import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

type PresentationModule = typeof import('./dashboard-presentation-entry');
type Presentation = PresentationModule & { revision: string; fleetStyle: string; controls: string };

export function dashboardPresentation(sourceDirectory: string, runtimeDirectory: string) {
    const root = dirname(sourceDirectory);
    const gitDirectory = join(root, '.git');
    const entry = join(sourceDirectory, 'dashboard-presentation-entry.ts');
    let current: Presentation | undefined;
    let failedRevision: string | undefined;
    let loading: Promise<Presentation> | undefined;
    let retryAfter = 0;

    async function git(...args: string[]) {
        const child = Bun.spawn(['git', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
        const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        if (exitCode !== 0) throw new Error(`Cannot load dashboard revision: ${stderr.trim()}`);
        return stdout;
    }

    async function committedRevision() {
        const read = (path: string) => readFile(join(gitDirectory, path), 'utf8').then(text => text.trim()).catch(() => '');
        const head = await read('HEAD');
        const ref = /^ref: (refs\/heads\/[a-z0-9_./-]+)$/i.exec(head)?.[1];
        const revision = ref && !ref.includes('..') ? await read(ref) : head;
        if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) return revision;
        // Packed refs and linked Git worktrees may not have a loose ref.
        return (await git('rev-parse', '--verify', 'HEAD')).trim();
    }

    async function loadRevision(revision: string): Promise<Presentation> {
        // Git updates worktree files before advancing HEAD. Read the immutable
        // blobs for this commit so a page cannot mix markup and assets.
        const source = (file: string) => git('show', `${revision}:${relative(root, file)}`);
        const [fleetStyle, controls, build] = await Promise.all([
            source(join(sourceDirectory, 'dashboard-fleet.css')),
            source(join(sourceDirectory, 'public-status-controls.js')),
            Bun.build({
                entrypoints: [entry],
                target: 'bun',
                format: 'esm',
                plugins: [{
                    name: 'dashboard-commit',
                    setup(builder) {
                        builder.onLoad({ filter: /\.ts$/ }, async ({ path }) =>
                            ({ contents: await source(path), loader: 'ts' }));
                    },
                }],
            }),
        ]);
        const output = build.outputs[0];
        if (!build.success || build.outputs.length !== 1 || !output) throw new Error('Dashboard presentation did not build as one module');
        const directory = await mkdtemp(join(runtimeDirectory, '.presentation-'));
        try {
            const modulePath = join(directory, 'presentation.mjs');
            await writeFile(modulePath, await output.text(), { mode: 0o600 });
            const module: PresentationModule = await import(pathToFileURL(modulePath).href);
            if (typeof module.fleetPage !== 'function' || typeof module.readDashboardAudit !== 'function' ||
                typeof module.auditDashboardLocation !== 'function') throw new Error('Dashboard presentation exports are incomplete');
            return { revision, fleetStyle, controls, ...module };
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }

    return async function loadPresentation() {
        if (loading) return loading;
        loading = (async () => {
            let revision: string | undefined;
            try {
                revision = await committedRevision();
                if (current?.revision === revision) return current;
                if (current && revision === failedRevision && Date.now() < retryAfter) return current;
                current = await loadRevision(revision);
                retryAfter = 0;
                return current;
            } catch (error) {
                if (!current) throw error;
                console.error('Keeping the previous Fleet Desk presentation', error);
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
