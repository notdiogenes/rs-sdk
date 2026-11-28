import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

function rolloutFixture(run: (fixture: {
    worker: (operation: 'changed' | 'record') => number;
    web: (operation: 'changed' | 'record') => number;
    legacyWorker: (stamp?: string) => void;
    update: (path: string) => void;
}) => void) {
    const directory = mkdtempSync(join(process.cwd(), '.fleet-revision-test-'));
    const source = join(directory, 'control');
    const script = join(import.meta.dir, 'dashboard-revision.sh');
    try {
        mkdirSync(source);
        for (const file of readdirSync(import.meta.dir, { withFileTypes: true })) {
            if (file.isFile()) symlinkSync(join(import.meta.dir, file.name), join(source, file.name));
        }
        for (const dependency of ['sdk', 'server']) {
            symlinkSync(join(import.meta.dir, '..', dependency), join(directory, dependency));
        }
        const revision = (role: 'worker' | 'web', operation: 'changed' | 'record') => {
            const result = Bun.spawnSync(['bash', script, source, join(directory, role), operation, role], {
                stdout: 'pipe', stderr: 'pipe',
            });
            expect(result.stderr.toString()).toBe('');
            return result.exitCode;
        };
        run({
            worker: operation => revision('worker', operation),
            web: operation => revision('web', operation),
            legacyWorker: stamp => writeFileSync(join(directory, 'worker'), (stamp ?? 'old worker checksum') + '\n'),
            update(path) {
                const file = join(source, path);
                mkdirSync(dirname(file), { recursive: true });
                rmSync(file, { force: true });
                writeFileSync(file, '// Changed by the rollout fixture.\n');
            },
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

test('the first live-update deployment leaves an unstamped or legacy worker running', () => {
    rolloutFixture(({ worker, legacyWorker, update }) => {
        expect(worker('changed')).toBe(1);
        legacyWorker();
        update('dashboard-worker.ts');
        expect(worker('changed')).toBe(1);
        legacyWorker('Fleet Desk worker restart inputs v2');
        expect(worker('changed')).toBe(1);
        legacyWorker('Fleet Desk worker restart inputs v3');
        expect(worker('changed')).toBe(1);
        expect(worker('record')).toBe(0);
        expect(worker('changed')).toBe(1);
    });
});

test('only process-owner changes match the worker restart condition after activation', () => {
    rolloutFixture(({ worker, web, update }) => {
        expect(worker('record')).toBe(0);
        expect(web('record')).toBe(0);
        for (const path of [
            'tasks/pickpocket.ts', 'tasks/quests/black-knights-fortress.ts', 'mining-routes.ts',
            'dashboard-plan.ts', 'dashboard-task-catalog.ts', 'dashboard-worker-policy.ts', 'dashboard-worker-api.ts',
            'dashboard-fleet.css', 'public-status-controls.js',
        ]) update(path);
        expect(worker('changed')).toBe(1);
        expect(web('changed')).toBe(1);

        update('dashboard-web.ts');
        expect(web('changed')).toBe(0);
        expect(worker('changed')).toBe(1);

        update('dashboard-revisions.ts');
        expect(worker('changed')).toBe(0);
        expect(worker('record')).toBe(0);

        update('dashboard-plan-runner.ts');
        expect(worker('changed')).toBe(0);
    });
});
