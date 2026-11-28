import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { selectPathfinder } from './dashboard-pathfinder';

let repo: string;
let config: string;
let socket: string;
let tree: string;
let manifest: string;
let bundled: string;
const platform = `${process.platform}-${process.arch}`;
function write(path: string, content: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
}
function git(...args: string[]) {
    const run = Bun.spawnSync(['git', ...args], { cwd: repo });
    expect(run.exitCode).toBe(0);
    return run.stdout.toString().trim();
}
beforeEach(() => {
    repo = mkdtempSync(join(process.cwd(), '.fleet-pathfinder-'));
    config = join(repo, 'config');
    socket = join(repo, 'pathfinding.sock');
    write(join(repo, 'sdk/native-pathfinder/Cargo.toml'), 'fixture');
    git('init', '-q');
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
    tree = git('rev-parse', 'HEAD:sdk/native-pathfinder');
    manifest = join(repo, 'server/vendor/native-pathfinder/manifest.json');
    bundled = join(dirname(manifest), platform, 'pathfinder-native');
    write(bundled, 'test executable');
    chmodSync(bundled, 0o755);
    write(manifest, JSON.stringify({
        sourceTree: tree, sha256: { [platform]: createHash('sha256').update('test executable').digest('hex') },
    }));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

test('a matching native installation takes precedence, and Bun can be forced for rollback', async () => {
    const installed = join(config, 'pathfinder-releases', tree, 'pathfinder-native');
    write(installed, 'test executable');
    chmodSync(installed, 0o755);
    expect(await selectPathfinder(repo, config, socket, 'native')).toEqual({
        implementation: 'native', command: [installed, socket, join(repo, 'sdk/collision-data.json')],
    });
    expect((await selectPathfinder(repo, config, socket, 'bun')).command).toEqual([
        process.execPath, '--no-env-file', join(repo, 'sdk/pathfinding-server.ts'), socket,
    ]);
    await expect(selectPathfinder(repo, config, socket, 'typo')).rejects.toThrow('Unknown RS_PATHFINDER_IMPLEMENTATION');
});

test.skipIf(platform !== 'linux-x64' && platform !== 'linux-arm64')('a bundled executable must match its digest and native source revision', async () => {
    expect((await selectPathfinder(repo, config, socket, 'native')).command[0]).toBe(bundled);
    write(bundled, 'mismatched payload');
    expect((await selectPathfinder(repo, config, socket, 'native')).implementation).toBe('bun');
    write(bundled, 'test executable');
    write(join(repo, 'sdk/native-pathfinder/Cargo.toml'), 'updated');
    git('add', 'sdk');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'new core');
    expect((await selectPathfinder(repo, config, socket, 'native')).implementation).toBe('bun');
});
