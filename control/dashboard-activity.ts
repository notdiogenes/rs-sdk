export type ControllerStatus = {
    bot: string | null;
    tasks: string[];
    client: { startedAt: string; stopping: boolean; inventoryActions?: boolean } | null;
    task: {
        name: string;
        startedAt: string;
        stopping: boolean;
        activity?: string;
        recovery?: { since: string; resumeAt: number };
    } | null;
    lastTask?: { name: string; exitCode: number; finishedAt: string; completion?: 'essence-exhausted' | 'bank-stock'; updateId?: string } | null;
};

export function controllerRequest(path: string, authorization: string, payload?: object, signal?: AbortSignal) {
    const headers: Record<string, string> = { Authorization: authorization };
    if (payload) headers['Content-Type'] = 'application/json';
    const timeout = AbortSignal.timeout(12000);
    return fetch('http://127.0.0.1:3719' + path, {
        headers, method: payload ? 'POST' : 'GET', body: payload && JSON.stringify(payload),
        redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
}

export function createDashboardActivity(transport: typeof controllerRequest) {
    type Start = { bot: string; name: string; cancel: AbortController; done: Promise<void> };
    let starting: Start | undefined;
    let stopping = false;
    let startError: { bot: string; message: string } | undefined;

    function dashboardActivity(state: ControllerStatus) {
        return {
            ...state,
            starting: starting?.bot === state.bot ? starting.name : null,
            startError: startError?.bot === state.bot ? startError.message : null,
        };
    }

    async function command(path: string, auth: string, payload: object) {
        const response = await transport(path, auth, payload);
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(typeof body.error === 'string' ? body.error : 'The controller rejected the request.');
        }
    }

    async function waitForClient(job: Start, auth: string) {
        const signal = AbortSignal.any([job.cancel.signal, AbortSignal.timeout(75000)]);
        let tick: number | undefined;
        while (!signal.aborted) {
            const response = await transport('/v1/state', auth, undefined, signal);
            if (response.ok) {
                const state = await response.json();
                if (state.availability === 'live' && typeof state.tick === 'number') {
                    // A single fresh frame can be cached from a previous session.
                    if (tick !== undefined && state.tick !== tick) return;
                    tick = state.tick;
                }
            }
            const status = await transport('/v1/status', auth, undefined, signal);
            if (status.ok) {
                const current = await status.json() as ControllerStatus;
                if (current.bot !== job.bot || !current.client || current.client.stopping) {
                    throw new Error('The managed game client exited before it was ready.');
                }
            }
            await Bun.sleep(1000);
        }
        signal.throwIfAborted();
    }

    async function startActivity(job: Start, auth: string, state: ControllerStatus) {
        try {
            if (!state.client) await command('/v1/client/start', auth, {});
            await waitForClient(job, auth);
            job.cancel.signal.throwIfAborted();
            await command('/v1/task/start', auth, { task: job.name });
        } catch (failure) {
            if (!job.cancel.signal.aborted) {
                const message = failure instanceof Error && failure.name === 'Error'
                    ? failure.message : 'The managed client did not become ready or the controller stopped responding.';
                startError = { bot: job.bot, message };
            }
        } finally {
            if (starting === job) starting = undefined;
        }
    }

    async function cancelStart() {
        const job = starting;
        job?.cancel.abort();
        await job?.done;
    }

    async function handleActivity(request: Request, token: string, session?: string, expectedBot?: string) {
        const reply = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
        if (request.method !== 'GET' && request.method !== 'POST') {
            return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
        }
        const auth = request.headers.get('Authorization') ?? (session ? `Bearer ${token}` : null);
        if (!auth?.startsWith('Bearer ')) return reply({ error: 'Unauthorized' }, 401);
        try {
            const response = await transport('/v1/status', auth);
            if (!response.ok) return reply({ error: 'Could not authenticate or read controller status.' }, response.status);
            const state = await response.json() as ControllerStatus;
            if (expectedBot && state.bot !== expectedBot) return reply({ error: 'The configured bot changed.' }, 409);
            if (request.method === 'GET') return reply(dashboardActivity(state));
            const body = await request.json().catch(() => null);
            if (!state.bot || state.bot !== body?.bot) return reply({ error: 'The configured bot changed.' }, 409);
            if (stopping) return reply({ error: 'The activity is stopping.' }, 409);

            const serviceAuth = `Bearer ${token}`;
            if (body.action === 'stop') {
                stopping = true;
                try {
                    await cancelStart();
                    await command('/v1/task/stop', serviceAuth, {});
                    startError = undefined;
                    return reply({ ok: true });
                } finally {
                    stopping = false;
                }
            }
            if (body.action !== 'start' || typeof body.task !== 'string' || !state.tasks.includes(body.task)) {
                return reply({ error: 'Choose a configured activity.' }, 400);
            }
            if (state.task || starting || state.client?.stopping) {
                return reply({ error: 'Another activity or client operation is in progress.' }, 409);
            }
            startError = undefined;
            const job: Start = { bot: state.bot, name: body.task, cancel: new AbortController(), done: Promise.resolve() };
            starting = job;
            job.done = startActivity(job, serviceAuth, state);
            return reply({ phase: 'starting', task: job.name }, 202);
        } catch (failure) {
            return reply({ error: failure instanceof Error ? failure.message : 'The controller did not respond.' }, 503);
        }
    }

    return { dashboardActivity, handleActivity, cancelStart };
}

export const { dashboardActivity, handleActivity } = createDashboardActivity(controllerRequest);
