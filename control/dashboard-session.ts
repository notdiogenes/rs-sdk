import { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

const cookieName = '__Secure-rs-sdk-dashboard';
const cookieLifetime = 400 * 24 * 60 * 60;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function sessionCookie(value: string) {
    return `${cookieName}=${value}; Path=/bots; Secure; HttpOnly; SameSite=Strict; Max-Age=${value ? cookieLifetime : 0}`;
}

export function dashboardSessions(directory: string) {
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

    async function handle(request: Request, action: string) {
        const reply = (data: object, status = 200, headers?: Record<string, string>) =>
            Response.json(data, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
        try {
            const config = await settings();
            if (action === 'status' && request.method === 'GET') {
                const cookie = await authenticate(request);
                return reply({ configured: Boolean(config), signedIn: Boolean(cookie) }, 200, cookie ? { 'Set-Cookie': cookie } : undefined);
            }
            if (request.method !== 'POST' || !['login', 'logout'].includes(action)) {
                return reply({ error: 'Unsupported session request.' }, 405);
            }
            if (!config) return reply({ error: 'Set the dashboard password on Lightsail first.' }, 409);
            if (request.headers.get('Origin') !== config.origin ||
                request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') {
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
                const db = store();
                const id = randomBytes(32).toString('hex');
                const version = digest(config.hash);
                const previous = sessionId(request);
                db.transaction(() => {
                    db.query('DELETE FROM sessions WHERE version <> ?').run(version);
                    if (previous) db.query('DELETE FROM sessions WHERE id = ?').run(digest(previous));
                    db.query('INSERT INTO sessions (id, version) VALUES (?, ?)').run(digest(id), version);
                })();
                return reply({ signedIn: true }, 200, { 'Set-Cookie': sessionCookie(id) });
            } finally {
                verifying = false;
            }
        } catch {
            return reply({ error: 'Dashboard sign-in is unavailable.' }, 503);
        }
    }

    return { authenticate, handle };
}
