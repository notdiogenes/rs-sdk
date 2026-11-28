import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dashboardRevisions } from './dashboard-revisions';

function fixture() {
    const root = mkdtempSync(join(process.cwd(), '.fleet-revision-test-'));
    const source = join(root, 'control');
    const runtime = join(root, 'runtime');

    function put(path: string, contents: string) {
        const target = join(root, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents);
    }

    function git(...args: string[]) {
        const result = Bun.spawnSync(['git', '-c', 'user.name=Fleet Desk test', '-c', 'user.email=fleet@example.test',
            '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, stderr: 'pipe' });
        if (!result.success) throw new Error(result.stderr.toString());
        return result.stdout.toString().trim();
    }

    mkdirSync(source);
    mkdirSync(runtime);
    const revisions = dashboardRevisions(source, runtime);
    function commit(label: string) {
        git('add', 'control', 'sdk', 'server', 'wiki');
        git('commit', '-qm', label);
        return git('rev-parse', 'HEAD');
    }

    return { root, put, git, commit, revisions, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('reloads a committed module as a unit, retaining the last compatible policy', async () => {
    const repo = fixture();
    try {
        repo.git('init', '-q');
        repo.put('control/policy.ts', "export { label } from './catalog';");
        repo.put('control/catalog.ts', "export const label = 'first';");
        repo.put('sdk/file.ts', '');
        repo.put('server/vendor/rsmod-pathfinder/file.js', '');
        repo.put('wiki/items/file.md', '');
        const firstRevision = repo.commit('First');
        repo.git('pack-refs', '--all');
        const load = repo.revisions.load<{ label: string }>('policy.ts', module =>
            typeof (module as { label?: unknown }).label === 'string', 'test policy');
        const first = await load();
        expect(first).toEqual({ revision: firstRevision, value: { label: 'first' } });

        repo.put('control/catalog.ts', "export const label = 'second';");
        expect(await load()).toBe(first);
        const secondRevision = repo.commit('Second');
        repo.put('control/catalog.ts', "export const label = 'uncommitted';");
        const [second, same] = await Promise.all([load(), load()]);
        expect(second).toBe(same);
        expect(second).toEqual({ revision: secondRevision, value: { label: 'second' } });

        repo.put('control/catalog.ts', 'export const label = 3;');
        repo.commit('Incompatible');
        expect(await load()).toBe(second);

        repo.put('control/catalog.ts', "export const label = 'third';");
        const fixedRevision = repo.commit('Fixed');
        expect(await load()).toEqual({ revision: fixedRevision, value: { label: 'third' } });
    } finally {
        repo.close();
    }
});

test('pins task source and assets until the last task using that revision is released', async () => {
    const repo = fixture();
    try {
        repo.git('init', '-q');
        const script = "import { readFileSync } from 'node:fs';\n" +
            "import { version } from '../../sdk/input';\n" +
            "console.log(version + ' ' + readFileSync(new URL('../../wiki/items/item.md', import.meta.url), 'utf8'));";
        repo.put('control/tasks/work.ts', script);
        repo.put('control/dashboard-enrollment.json', '{}');
        repo.put('sdk/input.ts', "export const version = 'first';");
        repo.put('server/vendor/rsmod-pathfinder/file.js', '');
        repo.put('wiki/items/item.md', 'old asset');
        const first = repo.commit('First');
        const old = await repo.revisions.pinTask(first, 'work.ts');
        const same = await repo.revisions.pinTask(first, 'work.ts');
        expect(old.path).toBe(same.path);
        expect(old.sha).toBe(createHash('sha256').update(script).digest('hex'));
        expect(await Bun.file(join(dirname(old.path), '../dashboard-enrollment.json')).exists()).toBe(false);

        repo.put('sdk/input.ts', "export const version = 'second';");
        repo.put('wiki/items/item.md', 'new asset');
        const second = repo.commit('Second');
        repo.put('sdk/input.ts', "export const version = 'uncommitted';");
        const next = await repo.revisions.pinTask(second, 'work.ts');
        expect(next.path).not.toBe(old.path);
        function scriptOutput(path: string) {
            const result = Bun.spawnSync([process.execPath, '--no-env-file', path], { cwd: repo.root, stderr: 'pipe' });
            if (!result.success) throw new Error(result.stderr.toString());
            return result.stdout.toString().trim();
        }
        await old.release();
        expect(scriptOutput(same.path)).toBe('first old asset');
        expect(scriptOutput(next.path)).toBe('second new asset');
        await same.release();
        await same.release();
        expect(await Bun.file(old.path).exists()).toBe(false);
        expect(await Bun.file(next.path).exists()).toBe(true);
        await next.release();
        expect(await Bun.file(next.path).exists()).toBe(false);
    } finally {
        repo.close();
    }
});

test('uses the supplied legacy policy and script paths outside a Git checkout', async () => {
    const repo = fixture();
    try {
        const fallback = { label: 'legacy' };
        const load = repo.revisions.load('policy.ts', () => false, 'test policy', fallback);
        expect(await load()).toEqual({ revision: undefined, value: fallback });
        repo.put('control/tasks/work.ts', 'export {};');
        const release = await repo.revisions.pinTask(undefined, 'work.ts');
        expect(release.path).toBe(join(repo.root, 'control/tasks/work.ts'));
        await release.release();
        expect(await Bun.file(release.path).exists()).toBe(true);
        await expect(repo.revisions.pinTask(undefined, '../not-a-task.ts')).rejects.toThrow('Invalid Fleet Desk task script.');
    } finally {
        repo.close();
    }
});
