import { Database } from 'bun:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { link, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const cookieName = '__Secure-rs-sdk-dashboard';
const cookieLifetime = 400 * 24 * 60 * 60;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function sessionCookie(value: string) {
    return `${cookieName}=${value}; Path=/bots; Secure; HttpOnly; SameSite=Strict; Max-Age=${value ? cookieLifetime : 0}`;
}

export function dashboardSessions(directory: string, getOrigin: () => Promise<string>, enrollmentPath: string) {
    const settingsPath = join(directory, 'password.json');
    let database: Database | undefined;
    let nextAttempt = 0;
    let verifying = false;

    function store() {
        if (!database) {
            database = new Database(join(directory, 'sessions.sqlite'));
            database.run('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, version TEXT NOT NULL)');
        }
        return database;
    }

    async function settings(): Promise<{ hash: string; origin: string } | undefined> {
        const settingsFile = Bun.file(settingsPath);
        if (!await settingsFile.exists()) return;
        const result = await settingsFile.json();
        if (typeof result.hash !== 'string' || !result.hash.startsWith('$argon2id$') ||
            typeof result.origin !== 'string' || !/^https:\/\/[0-9]+-[0-9]+-[0-9]+-[0-9]+\.sslip\.io$/.test(result.origin)) {
            throw new Error('Invalid dashboard password configuration');
        }
        return result;
    }

    function sessionId(request: Request) {
        const value = request.headers.get('Cookie')?.split(';').map(part => part.trim())
            .find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
        return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
    }

    async function authenticate(request: Request) {
        const id = sessionId(request);
        if (!id) return;
        const config = await settings();
        if (!config) return;
        if (request.method !== 'GET' && request.method !== 'HEAD' &&
            request.headers.get('Origin') !== config.origin) return;
        const row = store().query('SELECT id FROM sessions WHERE id = ? AND version = ?').get(digest(id), digest(config.hash));
        return row ? sessionCookie(id) : undefined;
    }

    async function handle(request: Request, action: string, { programmatic = false } = {}) {
        const reply = (data: object, status = 200, headers?: Record<string, string>) =>
            Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
        try {
            const config = await settings();
            if (action === 'status' && request.method === 'GET') {
                const cookie = await authenticate(request);
                return reply({ configured: Boolean(config), signedIn: Boolean(cookie) }, 200, cookie ? { 'Set-Cookie': cookie } : undefined);
            }
            if (request.method !== 'POST' || !['setup', 'login', 'logout'].includes(action)) {
                return reply({ error: 'Unsupported session request.' }, 405);
            }
            if (action === 'setup') {
                if (config) return reply({ error: 'The dashboard password has already been set.' }, 409);
                const origin = await getOrigin();
                if (request.headers.get('Origin') !== origin) return reply({ error: 'Open the HTTPS dashboard to set the password.' }, 403);
                const body = await request.json().catch(() => null);
                const enrollmentFile = Bun.file(enrollmentPath);
                const enrollment = await enrollmentFile.exists() ? await enrollmentFile.json() : null;
                if (typeof body?.code !== 'string' || !/^[a-f0-9]{64}$/.test(body.code) ||
                    typeof enrollment?.digest !== 'string' || !/^[a-f0-9]{64}$/.test(enrollment.digest) ||
                    typeof enrollment.expiresAt !== 'number' || Date.now() >= enrollment.expiresAt ||
                    !timingSafeEqual(Buffer.from(digest(body.code), 'hex'), Buffer.from(enrollment.digest, 'hex'))) {
                    return reply({ error: 'Open a valid dashboard setup link.' }, 401);
                }
                if (typeof body?.password !== 'string' || body.password.length < 12 || body.password.length > 128) {
                    return reply({ error: 'Choose a password with 12–128 characters.' }, 400);
                }
                const hash = await Bun.password.hash(body.password, { algorithm: 'argon2id' });
                const temporary = settingsPath + '.' + randomBytes(12).toString('hex');
                await writeFile(temporary, JSON.stringify({ hash, origin }), { mode: 0o600, flag: 'wx' });
                try {
                    await link(temporary, settingsPath);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                    return reply({ error: 'The dashboard password has already been set.' }, 409);
                } finally {
                    await unlink(temporary);
                }
                return signedIn(hash, request, reply);
            }
            if (!config) return reply({ error: 'Set the dashboard password on Lightsail first.' }, 409);
            const origin = request.headers.get('Origin');
            const isProgrammaticLogin = programmatic && action === 'login' && origin === null;
            if ((!isProgrammaticLogin && origin !== config.origin) ||
                request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
                return reply({ error: 'Open the HTTPS dashboard to sign in.' }, 403);
            }
            if (action === 'logout') {
                const id = sessionId(request);
                if (id) store().query('DELETE FROM sessions WHERE id = ?').run(digest(id));
                return reply({ signedIn: false }, 200, { 'Set-Cookie': sessionCookie('') });
            }
            const { password } = await request.json().catch(() => ({})) ?? {};
            if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
                return reply({ error: 'Incorrect dashboard password.' }, 401);
            }
            if (verifying || Date.now() < nextAttempt) {
                return reply({ error: 'Wait a few seconds before trying again.' }, 429, { 'Retry-After': '5' });
            }
            nextAttempt = Date.now() + 5000;
            verifying = true;
            try {
                if (!await Bun.password.verify(password, config.hash)) return reply({ error: 'Incorrect dashboard password.' }, 401);
                return signedIn(config.hash, request, reply);
            } finally {
                verifying = false;
            }
        } catch {
            return reply({ error: 'Dashboard sign-in is unavailable.' }, 503);
        }
    }

    function signedIn(hash: string, request: Request, reply: (data: object, status: number, headers: Record<string, string>) => Response) {
        const db = store();
        const id = randomBytes(32).toString('hex');
        const version = digest(hash);
        const previous = sessionId(request);
        db.transaction(() => {
            if (previous) db.query('DELETE FROM sessions WHERE id = ?').run(digest(previous));
            db.query('INSERT INTO sessions (id, version) VALUES (?, ?)').run(digest(id), version);
        })();
        return reply({ signedIn: true }, 200, { 'Set-Cookie': sessionCookie(id) });
    }

    return { authenticate, handle };
}
