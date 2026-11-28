import { createHash } from 'node:crypto';
import { access, constants, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PathfinderLaunch = { implementation: 'native' | 'bun'; command: string[] };

export function bunPathfinder(repo: string, socket: string): PathfinderLaunch {
    return { implementation: 'bun', command: [process.execPath, '--no-env-file', join(repo, 'sdk/pathfinding-server.ts'), socket] };
}

export async function selectPathfinder(repo: string, configDir: string, socket: string,
    implementation = process.env.RS_PATHFINDER_IMPLEMENTATION ?? 'native'): Promise<PathfinderLaunch> {
    if (implementation === 'bun') return bunPathfinder(repo, socket);
    if (implementation !== 'native') throw new Error(`Unknown RS_PATHFINDER_IMPLEMENTATION: ${implementation}`);
    const git = Bun.spawn(['git', 'rev-parse', '--verify', 'HEAD:sdk/native-pathfinder'], {
        cwd: repo, stdout: 'pipe', stderr: 'ignore',
    });
    const [code, stdout] = await Promise.all([git.exited, new Response(git.stdout).text()]);
    const tree = stdout.trim();
    if (code !== 0 || !/^[0-9a-f]{40,64}$/.test(tree)) {
        console.warn('[fleet-pathfinding] Could not identify the native release. Using Bun.');
        return bunPathfinder(repo, socket);
    }
    const native = (binary: string): PathfinderLaunch => ({
        implementation: 'native', command: [binary, socket, join(repo, 'sdk/collision-data.json')],
    });
    const installed = join(configDir, 'pathfinder-releases', tree, 'pathfinder-native');
    try {
        await access(installed, constants.X_OK);
        return native(installed);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[fleet-pathfinding] Native install is unavailable.', error);
    }
    const platform = `${process.platform}-${process.arch}`;
    if (platform === 'linux-x64' || platform === 'linux-arm64') {
        const directory = join(repo, 'server/vendor/native-pathfinder');
        try {
            const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
            const binary = join(directory, platform, 'pathfinder-native');
            if (manifest.sourceTree !== tree) throw new Error('Bundled pathfinder source revision does not match the checkout.');
            await access(binary, constants.X_OK);
            if (createHash('sha256').update(await readFile(binary)).digest('hex') !== manifest.sha256?.[platform]) {
                throw new Error('Bundled pathfinder checksum mismatch.');
            }
            return native(binary);
        } catch (error) {
            console.warn('[fleet-pathfinding] Bundled native release is unavailable.', error);
        }
    }
    console.warn(`[fleet-pathfinding] No matching native release for ${platform} at ${tree}. Using Bun until the worker restarts.`);
    return bunPathfinder(repo, socket);
}

export async function pathfinderHealthy(socket: string): Promise<boolean> {
    try {
        const reply = await fetch('http://pathfinding/health', { unix: socket, signal: AbortSignal.timeout(1000) });
        if (!reply.ok) { await reply.body?.cancel(); return false; }
        const body: unknown = await reply.json();
        return !!body && typeof body === 'object' && 'status' in body && body.status === 'ok';
    } catch {
        return false;
    }
}
