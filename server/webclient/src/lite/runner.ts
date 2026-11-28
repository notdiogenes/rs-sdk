// Headless bot runner: a LiteClient session wired to the SDK gateway.
//
// This is BotOverlay minus the browser - same StateCollector, ActionExecutor
// and BotActionQueue, but the gateway socket is a plain Bun WebSocket instead
// of the in-page GatewayConnection (which needs window.location). Controlling
// SDKs (sdk/runner.ts scripts, sdk/cli.ts, MCP execute_code) pair with it
// exactly as they would with a browser tab.
//
//   bun src/lite/runner.ts <botname>          # reads bots/<botname>/bot.env
//
// Run from server/webclient so the '#/*' import map resolves.

import './dom-shim.js';
import { fileURLToPath } from 'node:url';

import { OutdatedClientError } from './net/GameConnection.js';
import { startSession, type LiteSession, type SessionOptions } from './session.js';
import { type ActionResult } from '#/bot/ActionExecutor.js';
import { BotActionQueue, type QueuedBotAction } from '#/bot/ActionQueue.js';
import type { BotAction, BotWorldState } from '#/bot/types.js';
import type { LiteClient } from './LiteClient.js';
import type { FleetBankFrame, FleetStateFrame } from '../../../../sdk/fleet-telemetry';
import { parseInventoryCommand, prepareInventoryCommand,
    type InventoryReply, type InventoryRequest, type InventoryResult } from '../../../../sdk/inventory-command';
import {
    FAST_KBD_RUNTIME_MODE,
    findFastKbdAttackTarget,
    findFastKbdPrayerOffIndices,
    findFastKbdPrayerOnIndices,
    isFastKbdPolicyState,
} from './fast-kbd.js';

const TICK_MS = 20; // matches the browser draw loop that drives BotOverlay.tick()
const RECONNECT_MS = 3000;
const INVENTORY_TIMEOUT_MS = 4500;

export type LiteRunnerMessage = FleetBankFrame | FleetStateFrame | InventoryReply | { type: 'inventory-ready' };

function sendToParent(message: LiteRunnerMessage): void {
    if (!process.connected) return;
    try { process.send?.(message); }
    catch { /* The parent may have closed IPC while the game is still connected. */ }
}

export class LiteGatewayRunner {
    private client: LiteClient;
    private actionQueue = new BotActionQueue();
    private waitTicks = 0;
    private serverTick = 0;
    private lastGameTickAt = -Infinity;
    private lastScriptDispatchTick = -1;
    private inventoryCommand?: {
        request: InventoryRequest;
        deadline: number;
        dispatched?: { tick: number; name: string; observed: (state: BotWorldState) => boolean };
    };
    private lastFastKbdAttackTick = -1;
    private fastKbdPolicyEligible = false;
    private fastKbdWasVisible = false;
    private fastKbdRawWasVisible = false;
    private fastKbdLastState: BotWorldState | null = null;
    private lastFastKbdPrayerOnTick = -1;
    private lastFastKbdPrayerOnIndices: number[] = [];
    private fastKbdPrayerOffPending = false;
    private lastFastKbdPrayerOffDispatchTick = -1;

    private ws: WebSocket | null = null;
    private wsConnected = false;
    private preventReconnect = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private resolvingGateway = false;
    private tickTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private session: LiteSession,
        private gatewayUrl: string,
        private fastKbdAttackEnabled = false,
        private publish?: (message: LiteRunnerMessage) => void,
        private gatewayDirect = true,
    ) {
        this.client = session.client;
        if (this.publish) this.client.setOnBankUpdateCallback(items => {
            this.publish?.({ type: 'fleet-bank', at: Date.now(), items });
        });
        // State collection and action execution go through the client, which
        // activates this bot's interface table first - see LiteClient.activate.
        this.client.setOnGameTickCallback(() => {
            this.serverTick++;
            this.lastGameTickAt = performance.now();
            // Reuse the previous authoritative one-item policy snapshot and
            // probe the newly decoded raw NPC table before full state
            // collection. This puts KBD op2 ahead of reachability, nearby
            // player/loc/item scans, and UI serialization.
            if (this.fastKbdAttackEnabled) {
                const targetIndex = this.fastKbdPolicyEligible
                    ? this.client.findNpcIndexByExactName('King black dragon')
                    : undefined;
                if (targetIndex !== undefined
                    && this.lastFastKbdAttackTick !== this.serverTick) {
                    if (!this.fastKbdRawWasVisible && this.fastKbdLastState) {
                        this.dispatchFastKbdPrayerOn(this.fastKbdLastState);
                    }
                    this.dispatchFastKbdAttack(targetIndex);
                }
                this.fastKbdRawWasVisible = targetIndex !== undefined;
            }
            this.sendState(true);
        });

        this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    }

    connect(): void {
        if (this.ws || this.resolvingGateway) return;
        // Re-checked on every (re)connect, so the direct port is picked up again
        // after a server restart and abandoned if it ever stops answering.
        this.resolvingGateway = true;
        void preferDirectGateway(this.gatewayUrl, this.gatewayDirect).then(url => {
            this.resolvingGateway = false;
            if (!this.ws && !this.preventReconnect) this.open(url);
        });
    }

    private open(url: string): void {
        console.log(`[lite-runner] Connecting to gateway ${url}`);
        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            this.wsConnected = true;
            const { username, password } = this.client.getCredentials();
            console.log(`[lite-runner] Gateway connected, registering as '${username}'`);
            this.send({
                type: 'connected',
                username,
                password,
                clientId: `${username}-lite-${Date.now()}`,
                maxMessageLength: this.client.getMaxMessageLength()
            });
            // Drop queued work from the previous connection (BotOverlay.onConnected)
            const active = this.actionQueue.active;
            this.actionQueue.beginGeneration();
            if (active && this.waitTicks > 0) {
                this.actionQueue.complete(active);
            }
            this.waitTicks = 0;
        };

        this.ws.onmessage = event => {
            try {
                this.handleMessage(JSON.parse(String(event.data)));
            } catch (e) {
                console.error('[lite-runner] Bad gateway message:', e);
            }
        };

        this.ws.onclose = () => {
            this.wsConnected = false;
            this.ws = null;
            if (!this.preventReconnect) {
                console.warn(`[lite-runner] Gateway closed, reconnecting in ${RECONNECT_MS}ms`);
                if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
                this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS);
            }
        };

        this.ws.onerror = () => {
            // onclose follows
        };
    }

    stop(): void {
        this.preventReconnect = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.tickTimer) clearInterval(this.tickTimer);
        this.ws?.close();
        this.session.stop();
    }

    get stopped() {
        return this.session.stopped;
    }

    private send(msg: unknown): void {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    private handleMessage(msg: any): void {
        if (msg.type === 'action') {
            this.onAction(msg.action, msg.actionId || null, msg.actionTimeoutMs);
        } else if (msg.type === 'screenshot_request') {
            // Headless: no canvas. Answer so the requester doesn't hang on a timeout.
            this.send({ type: 'screenshot_response', dataUrl: '', screenshotId: msg.screenshotId });
        } else if (msg.type === 'save_and_disconnect') {
            console.log(`[lite-runner] save_and_disconnect: ${msg.reason || 'session replaced'}`);
            // Closing the game socket triggers the engine-side save, same as browser logout.
            this.stop();
        }
    }

    private onAction(action: BotAction, actionId: string | null, actionTimeoutMs?: number): void {
        const queueTtlMs = actionTimeoutMs === undefined ? undefined : Math.max(0, actionTimeoutMs - 1_000);
        const queued = this.actionQueue.enqueue({ action, actionId }, queueTtlMs);
        if (!queued) {
            const result: ActionResult = {
                success: false,
                message: 'Action queue is full',
                phase: 'validation',
                reason: 'busy'
            };
            if (actionId) this.sendActionResult(actionId, result);
        }
    }

    acceptInventoryCommand(message: unknown): void {
        const request = message as Partial<InventoryRequest> | null;
        if (request?.type !== 'inventory-command' || typeof request.requestId !== 'string') return;
        const command = parseInventoryCommand(request.command);
        if (!command || this.inventoryCommand) {
            this.replyInventory(request.requestId, { status: 409, message: 'The client could not queue this inventory action.' });
            return;
        }
        this.inventoryCommand = {
            request: { type: request.type, requestId: request.requestId, command },
            deadline: performance.now() + INVENTORY_TIMEOUT_MS,
        };
    }

    private replyInventory(requestId: string, result: InventoryResult): void {
        const reply: InventoryReply = { type: 'inventory-result', requestId, result };
        this.publish?.(reply);
    }

    private tickInventory(): boolean {
        const pending = this.inventoryCommand;
        if (!pending) return false;
        const { request, deadline, dispatched } = pending;
        const finish = (result: InventoryResult) => {
            this.inventoryCommand = undefined;
            this.replyInventory(request.requestId, result);
            return true;
        };
        if (performance.now() >= deadline) {
            return finish(dispatched
                ? { status: 422, message: 'The game did not confirm the action. Check the refreshed inventory before retrying.' }
                : { status: 409, message: 'The game client is busy. Try again.' });
        }
        if (dispatched) {
            if (this.serverTick !== dispatched.tick) {
                dispatched.tick = this.serverTick;
                const state = this.client.collectBotState(this.serverTick);
                if (state && dispatched.observed(state)) {
                    const { action, count } = request.command;
                    const message = action === 'eat' ? `Ate ${dispatched.name}.`
                        : `Dropped ${count > 1 ? count.toLocaleString('en-US') + ' × ' : ''}${dispatched.name}.`;
                    return finish({ status: 200, message,
                        inventory: { capturedAt: Date.now(), items: state.inventory } });
                }
            }
            return true;
        }
        if (this.actionQueue.active || this.waitTicks > 0) return false;
        if (performance.now() - this.lastGameTickAt > 3500) {
            return finish({ status: 409, message: 'The game client has no recent inventory state.' });
        }
        // Give the previous script packet a game tick before validating the slot.
        if (this.lastScriptDispatchTick === this.serverTick) return true;
        const prepared = prepareInventoryCommand(this.client.collectBotState(this.serverTick), request.command);
        if ('status' in prepared) return finish(prepared);
        const result = this.client.executeBotAction(prepared.action);
        // OPHELD and DROP are synchronous packet dispatches.
        if (result instanceof Promise || !result.success) {
            return finish({ status: 422, message: 'The game client could not send the inventory action.' });
        }
        pending.dispatched = { tick: this.serverTick, name: prepared.name, observed: prepared.observed };
        return true;
    }

    private tick(): void {
        for (const expired of this.actionQueue.expirePending()) {
            const result: ActionResult = {
                success: false,
                message: `Action expired in queue: ${expired.action.type}`,
                phase: 'validation',
                reason: 'queue_expired'
            };
            if (expired.actionId) this.sendActionResult(expired.actionId, result);
        }

        const activeExpired = this.actionQueue.expireActive();
        if (activeExpired) {
            // `expireActive` releases the queue first, so bypass finishAction's
            // identity guard and report a bounded failure to the controller.
            if (this.actionQueue.isCurrentGeneration(activeExpired) && activeExpired.actionId) {
                this.sendActionResult(activeExpired.actionId, {
                    success: false,
                    message: `Action expired while active: ${activeExpired.action.type}`,
                    phase: 'completion',
                    reason: 'queue_expired'
                });
            }
            this.sendState();
        }

        if (this.tickInventory()) return;

        if (this.waitTicks > 0) {
            this.waitTicks--;
            const active = this.actionQueue.active;
            if (this.waitTicks === 0 && active) {
                this.finishAction(active, { success: true, message: 'Wait complete', phase: 'completion' });
            }
            return;
        }

        if (this.actionQueue.active) return;

        const queued = this.actionQueue.startNext();
        if (!queued) return;

        const action = queued.action;
        this.lastScriptDispatchTick = this.serverTick;
        const resultOrPromise = this.client.executeBotAction(action);

        if (resultOrPromise instanceof Promise) {
            resultOrPromise
                .then(result => this.finishAction(queued, result))
                .catch(e =>
                    this.finishAction(queued, {
                        success: false,
                        message: `Error: ${e}`,
                        phase: 'completion',
                        reason: 'execution_error'
                    })
                );
            return;
        }

        if (action.type === 'wait' && resultOrPromise.success) {
            this.waitTicks = (action as any).ticks || 1;
            return;
        }

        this.finishAction(queued, resultOrPromise);
    }

    private finishAction(entry: QueuedBotAction, result: ActionResult): void {
        if (this.actionQueue.active !== entry) return;

        const publishResult = this.actionQueue.isCurrentGeneration(entry);
        this.actionQueue.complete(entry);
        if (!publishResult) return;

        if (entry.actionId) {
            this.sendActionResult(entry.actionId, result);
        }
        this.sendState();
    }

    private sendActionResult(actionId: string, result: ActionResult): void {
        this.send({ type: 'actionResult', actionId, result });
    }

    private dispatchFastKbdAttack(targetIndex: number): void {
        const result = this.client.interactNpc(targetIndex, 2);
        if (result.success) this.lastFastKbdAttackTick = this.serverTick;
    }

    private dispatchFastKbdPrayerOn(state: BotWorldState): void {
        const emitted: number[] = [];
        for (const prayerIndex of findFastKbdPrayerOnIndices(state)) {
            const result = this.client.executeBotAction({
                type: 'togglePrayer',
                prayerIndex,
                reason: 'runner-fast KBD publication',
            });
            if (!(result instanceof Promise) && result.success) emitted.push(prayerIndex);
        }
        if (emitted.length > 0) {
            this.lastFastKbdPrayerOnTick = this.serverTick;
            this.lastFastKbdPrayerOnIndices = emitted;
        }
    }

    private sendState(gameTick = false): void {
        const publishLocally = gameTick && this.publish !== undefined;
        if (!this.wsConnected && !publishLocally) return;
        const state = this.client.collectBotState(this.serverTick);
        if (!state) return;
        if (publishLocally) {
            const { tick, inGame, player, skills, inventory, questPoints, questJournal } = state;
            this.publish?.({
                type: 'fleet-state', at: Date.now(),
                state: {
                    tick, inGame, skills, inventory, questPoints, questJournal,
                    player: player && {
                        worldX: player.worldX, worldZ: player.worldZ, level: player.level,
                        hp: player.hp, maxHp: player.maxHp, combatLevel: player.combatLevel,
                        combat: { inCombat: player.combat.inCombat },
                    },
                },
            });
        }
        if (!this.wsConnected) return;
        if (this.fastKbdAttackEnabled) {
            const targetIndex = findFastKbdAttackTarget(state);
            if (targetIndex !== undefined && this.lastFastKbdAttackTick !== this.serverTick) {
                // This is intentionally in-process and before state publication:
                // the ordinary SDK path must traverse the gateway twice before
                // the same packet reaches this client.
                this.dispatchFastKbdPrayerOn(state);
                this.dispatchFastKbdAttack(targetIndex);
            }
            if (this.lastFastKbdAttackTick === this.serverTick) {
                state.fastKbdAttackTick = this.serverTick;
            }
            if (this.lastFastKbdPrayerOnTick === this.serverTick) {
                state.fastKbdPrayerOn = {
                    tick: this.serverTick,
                    prayerIndices: this.lastFastKbdPrayerOnIndices,
                };
            }

            const fastKbdVisible = targetIndex !== undefined;
            const policyEligible = isFastKbdPolicyState(state);
            if (this.fastKbdWasVisible && !fastKbdVisible && policyEligible) {
                this.fastKbdPrayerOffPending = true;
            }
            if (fastKbdVisible || !policyEligible) {
                this.fastKbdPrayerOffPending = false;
            }
            const prayerOffIndices = this.lastFastKbdPrayerOffDispatchTick === this.serverTick
                ? []
                : findFastKbdPrayerOffIndices(state, this.fastKbdPrayerOffPending);
            const emittedPrayerOffIndices: number[] = [];
            for (const prayerIndex of prayerOffIndices) {
                const result = this.client.executeBotAction({
                    type: 'togglePrayer',
                    prayerIndex,
                    reason: 'runner-fast KBD removal',
                });
                if (!(result instanceof Promise) && result.success) {
                    emittedPrayerOffIndices.push(prayerIndex);
                }
            }
            if (emittedPrayerOffIndices.length > 0) {
                this.lastFastKbdPrayerOffDispatchTick = this.serverTick;
                state.fastKbdPrayerOff = {
                    tick: this.serverTick,
                    prayerIndices: emittedPrayerOffIndices,
                };
            }
            if (this.fastKbdPrayerOffPending
                && !state.prayers.activePrayers.some(active => active)) {
                this.fastKbdPrayerOffPending = false;
            }
            this.fastKbdPolicyEligible = policyEligible;
            this.fastKbdWasVisible = fastKbdVisible;
            this.fastKbdRawWasVisible = fastKbdVisible;
            this.fastKbdLastState = state;
        }
        this.send({ type: 'state', state });
    }
}

// ------------------------------------------------------------------ CLI entry

function deriveGatewayUrl(server: string): string {
    if (!server) return 'ws://localhost:7780';
    if (server.startsWith('ws://') || server.startsWith('wss://')) return server;
    if (server.startsWith('localhost') || server.startsWith('127.')) {
        return `ws://${server.includes(':') ? server : server + ':7780'}`;
    }
    return `wss://${server}/gateway`;
}

// Same table as sdk/index.ts preferDirectGateway: publish straight to the
// gateway's own TLS port when it answers (compressed frames, no relay through
// the game server's tick thread), else keep the relayed /gateway URL.
const DIRECT_GATEWAYS: Record<string, string> = {
    'wss://rs-sdk.maxbittker.com/gateway': 'wss://rs-sdk.maxbittker.com:7443',
};
async function preferDirectGateway(url: string, enabled: boolean): Promise<string> {
    const direct = DIRECT_GATEWAYS[url];
    if (!direct || !enabled) return url;
    try {
        const res = await fetch(direct.replace(/^ws/, 'http') + '/', { signal: AbortSignal.timeout(3000) });
        return res.ok ? direct : url;
    } catch {
        return url;
    }
}

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
// Older bot.env files use the demo server's former host.
const LEGACY_SERVER_HOSTS: Record<string, string> = { 'rs-sdk-demo.fly.dev': 'rs-sdk.maxbittker.com' };

type LiteRunnerOptions = SessionOptions & { gatewayUrl: string; gatewayDirect: boolean };

export async function readLiteRunnerOptions(envPath: string, cacheDir?: string,
    gatewayDirect = process.env.GATEWAY_DIRECT !== 'false'): Promise<LiteRunnerOptions> {
    const env = Object.fromEntries((await Bun.file(envPath).text()).split('\n')
        .filter(line => line.includes('=') && !line.startsWith('#'))
        .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
    const host = LEGACY_SERVER_HOSTS[env.SERVER ?? ''] ?? (env.SERVER || 'localhost');
    const profanityRaw = (env.PROFANITY_FILTER ?? process.env.PROFANITY_FILTER ?? '').toLowerCase();
    if (!env.BOT_USERNAME || !env.PASSWORD) throw new Error('Lite bot configuration needs BOT_USERNAME and PASSWORD');
    return {
        host, cacheDir, username: env.BOT_USERNAME, password: env.PASSWORD,
        profanityFilter: !['false', '0', 'off', 'no'].includes(profanityRaw), quiet: true,
        gatewayUrl: env.GATEWAY_URL || process.env.GATEWAY_URL || deriveGatewayUrl(host), gatewayDirect,
    };
}

export async function startLiteRunner(options: LiteRunnerOptions, publish?: (message: LiteRunnerMessage) => void) {
    const runtimeMode = await Bun.file(`${repoRoot}bots/logs/fleet-runtime.mode`).text()
        .then(value => value.trim()).catch(() => '');
    const session = await startSession(options);
    console.log(`[lite-runner] '${options.username}' logged into ${options.host}`);
    const fastKbdAttackEnabled = runtimeMode === FAST_KBD_RUNTIME_MODE;
    if (fastKbdAttackEnabled) console.log('[lite-runner] in-process KBD op2 enabled');
    const runner = new LiteGatewayRunner(session, options.gatewayUrl, fastKbdAttackEnabled, publish, options.gatewayDirect);
    runner.connect();
    return runner;
}

if (import.meta.main) {
    const botName = process.argv[2];
    if (!botName) {
        console.error('Usage: bun src/lite/runner.ts <botname>');
        process.exit(1);
    }
    const envPath = process.env.RS_LITE_BOT_ENV || `${repoRoot}bots/${botName}/bot.env`;
    const options = await readLiteRunnerOptions(envPath, process.env.RS_LITE_CACHE_DIR);
    const runner = await startLiteRunner(options, process.connected ? sendToParent : undefined).catch((error: unknown) => {
        // A revision mismatch won't resolve on retry. Tell the supervisor.
        if (error instanceof OutdatedClientError) {
            console.error(`[lite-runner] ${error.message}`);
            process.exit(3);
        }
        throw error;
    });
    if (process.connected) {
        process.on('message', message => runner.acceptInventoryCommand(message));
        sendToParent({ type: 'inventory-ready' });
    }
    process.on('SIGINT', () => {
        console.log('\n[lite-runner] SIGINT, shutting down');
        runner.stop();
        process.exit(0);
    });
    const end = await runner.stopped;
    console.log(`[lite-runner] Game session ended (${end.reason})`, end.error ?? '');
    runner.stop();
    process.exit(end.reason === 'stopped' ? 0 : 1);
}
