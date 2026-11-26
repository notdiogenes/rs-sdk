import { execFile } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const [checkout, stateDir, repository] = process.argv.slice(2);
if (!checkout || !stateDir || !repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error('Expected a checkout, state directory, and GitHub owner/repo');
}
const secret = readFileSync(join(stateDir, 'secret'), 'utf8').trim();
if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error('Invalid webhook secret');
const shaPattern = /^[a-f0-9]{40}$/;
const pendingPath = join(stateDir, 'pending');
let pending = existsSync(pendingPath) ? readFileSync(pendingPath, 'utf8') : undefined;
if (pending && !shaPattern.test(pending)) throw new Error('Invalid pending revision');
let syncing = false;
const execute = promisify(execFile);

async function git(...args: string[]) {
    const { stdout } = await execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: checkout,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        timeout: 90_000,
        killSignal: 'SIGKILL',
    });
    return stdout.trim();
}

async function sync(requested: string) {
    if (await git('config', '--local', '--get', 'remote.origin.url') !== `https://github.com/${repository}.git` ||
        await git('branch', '--show-current') !== 'main' ||
        await git('status', '--porcelain') !== '') {
        throw new Error('Expected a clean main checkout with the configured origin');
    }
    const previous = await git('rev-parse', 'HEAD');
    const upstream = 'refs/remotes/origin/main';
    await git('fetch', '--no-tags', 'origin', `+refs/heads/main:${upstream}`);
    await git('merge-base', '--is-ancestor', previous, upstream);
    await git('merge', '--ff-only', upstream);
    console.log('Synced', { requested, previous, revision: await git('rev-parse', 'HEAD') });
}

async function drain() {
    if (syncing) return;
    syncing = true;
    try {
        while (pending) {
            const requested = pending;
            pending = undefined;
            try {
                try {
                    await sync(requested);
                } catch (error) {
                    console.error('Sync attempt failed. Retrying once.', error);
                    await Bun.sleep(3000);
                    await sync(requested);
                }
                if (!pending) unlinkSync(pendingPath);
            } catch (error) {
                console.error('Sync failed. The next push or service restart will retry.', error);
            }
        }
    } finally {
        syncing = false;
    }
}

type Webhook = { repository?: { full_name?: string }; ref?: string; after?: string; deleted?: boolean };

Bun.serve({
    hostname: '127.0.0.1',
    port: 3720,
    maxRequestBodySize: 1024 * 1024,
    async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/health' && request.method === 'GET') return Response.json({ ok: true });
        if (path !== '/hooks/github-sync') return new Response(null, { status: 404 });
        if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });

        const signature = request.headers.get('X-Hub-Signature-256');
        if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return new Response(null, { status: 401 });
        const body = Buffer.from(await request.arrayBuffer());
        const expected = createHmac('sha256', secret).update(body).digest();
        if (!timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'))) {
            return new Response(null, { status: 401 });
        }
        const eventType = request.headers.get('X-GitHub-Event');
        if (eventType !== 'push') return new Response(null, { status: 204 });

        let event: Webhook | null;
        try {
            event = JSON.parse(body.toString());
        } catch {
            return new Response(null, { status: 400 });
        }
        if (event?.repository?.full_name !== repository) return new Response(null, { status: 403 });
        if (event.ref !== 'refs/heads/main' || event.deleted) {
            return new Response(null, { status: 204 });
        }
        if (typeof event.after !== 'string' || !shaPattern.test(event.after)) {
            return new Response(null, { status: 400 });
        }

        const temporaryPath = `${pendingPath}.tmp`;
        writeFileSync(temporaryPath, event.after, { mode: 0o600 });
        renameSync(temporaryPath, pendingPath);
        pending = event.after;
        void drain();
        return new Response(null, { status: 202 });
    },
});

void drain();
