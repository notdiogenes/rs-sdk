# Hosted headless quickstart

Use this workflow for `rs-sdk.maxbittker.com`. Keep one lite client and one SDK
controller per bot. The lite client runs without a browser and a standalone SDK
script attaches to a client that is already running.
[Hosted setup](../README.md#getting-started) · [Lite client](../server/webclient/src/lite/README.md) · [Bot guide](../AGENTS.md#start-a-game-client-scripts-only)

## Get the code and install

Clone [this fork](https://github.com/notdiogenes/rs-sdk) with `git clone https://github.com/notdiogenes/rs-sdk.git`, or use **Code → Download ZIP** on GitHub and extract the archive. Open a terminal in the repository root.
[GitHub archive instructions](https://docs.github.com/en/repositories/working-with-files/using-files/downloading-source-code-archives)

Use Bun `1.3.14`, the version pinned in CI. Install the root and webclient
dependencies from their lockfiles on first setup and after a lockfile changes.
Use these commands for the hosted headless workflow.
[CI workflow](../.github/workflows/ci.yml) · [Hosted setup](../README.md#getting-started)

```sh
bun --version
PUPPETEER_SKIP_DOWNLOAD=true bun install --frozen-lockfile
(cd server/webclient && bun install --frozen-lockfile)
```

For a local development server, install the engine and gateway dependencies as
well. Run `BUILD_VERIFY=false bun run build` from `server/engine` for the CI
content build, or run `bun run start` there to start the engine. Run `bun run watch`
from `server/webclient` and `bun run gateway` from `server/gateway`. Use
`bun run check` from the root for development checks.
[Local server setup](../README.md#running-the-server-locally) · [CI workflow](../.github/workflows/ci.yml)

## Create or reuse a bot

Reuse the bot's existing `bots/<name>/bot.env` if the user wants to resume that
character. For a fresh bot, use `bun bots/create-bot.ts` to generate a name and
password, or append a username to choose the name. The hosted template sets
`SERVER=rs-sdk.maxbittker.com` and `SHOW_CHAT=true`. Keep `bot.env` in the
gitignored bot directory and report the username only.
[Bot creation](../bots/create-bot.ts) · [Hosted template](../bots/_template/bot.env) · [Git ignore rules](../.gitignore)

Set `BOT_NAME` to the exact directory name in each terminal. Start the lite
client from the repository root and leave it running. The runner logs successful
game login and then `Gateway connected, registering`.
[Lite runner](../server/webclient/src/lite/runner.ts)

```sh
BOT_NAME='your-bot-name'
(cd server/webclient && bun src/lite/runner.ts "$BOT_NAME")
```

### HTTPS proxy setup

If HTTPS works through the workspace proxy and Bun fails to upgrade the hosted
WebSocket, save the preload below as `bots/<name>/hosted-proxy.cjs`. Use the
workspace's existing `HTTPS_PROXY` or `https_proxy` value for both the game and
gateway WebSockets. Set `GATEWAY_DIRECT=false` to use the hosted `/gateway` relay.
The runner derives the relay from `SERVER` unless `GATEWAY_URL` overrides it.
Use the same preload for the lite runner and SDK scripts.
[Game WebSocket](../server/webclient/src/io/ClientStream.ts) · [Gateway selection](../server/webclient/src/lite/runner.ts#L356-L379) · [Gateway override](../server/webclient/src/lite/runner.ts#L419-L424)

```javascript
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (!proxy) throw new Error('The workspace HTTPS proxy is unavailable');
const NativeWebSocket = globalThis.WebSocket;

globalThis.WebSocket = class HostedWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
        const options = typeof protocols === 'string' ? { protocols: [protocols] } : { protocols };
        if (new URL(url).origin === 'wss://rs-sdk.maxbittker.com') {
            super(url, { ...options, proxy });
        } else {
            super(url, protocols);
        }
    }
};
```

```sh
RS_SDK_ROOT="$PWD"
(cd server/webclient && GATEWAY_DIRECT=false \
  bun --preload "$RS_SDK_ROOT/bots/$BOT_NAME/hosted-proxy.cjs" src/lite/runner.ts "$BOT_NAME")
```

## Skip Tutorial Island and wait for A Pirate

Save the following as `bots/<name>/await-pirate.ts`. It checks live state, skips
Tutorial Island only when the bot is on the island, and verifies the tutorial's
Lumbridge destination at `(3222, 3222)`. A returning bot continues from its
current location. Use this script for the handoff. The generated `script.ts`
also attempts to chop a tree.
[Tutorial area bounds](../server/content/scripts/tutorial/scripts/util.rs2) · [Tutorial completion](../server/content/scripts/tutorial/scripts/tutorial.rs2#L295-L300) · [Starter script](../bots/_template/script.ts) · [SDK API](../sdk/API.md)

Keep `SHOW_CHAT=true`. Use incoming private messages (types `3` and `7`) and
verify the sender against the exact player name after normalizing case and
spaces. Surface the message to the controlling agent as an in-game instruction
within the user's gameplay request. Keep the SDK session alive while waiting.
[Chat API](../learnings/chat.md) · [Name matching](../sdk/action-quantity.ts)

```typescript
import { runScript } from '../../sdk/runner';

const result = await runScript(async ({ bot, sdk }) => {
    let state = await sdk.waitForReady();
    const { worldX: x, worldZ: z } = state.player;
    const onTutorial = (x >= 3053 && x <= 3156 && z >= 3056 && z <= 3136) ||
        (x >= 3072 && x <= 3118 && z >= 9492 && z <= 9535);

    if (onTutorial) {
        await bot.skipTutorial();
        state = await sdk.waitForCondition(
            s => s.inGame && s.player.worldX === 3222 && s.player.worldZ === 3222,
            10_000
        );
    }

    const username = process.env.BOT_USERNAME;
    console.log(JSON.stringify({ username, x: state.player.worldX, z: state.player.worldZ, waitingFor: 'A Pirate' }));
    for (;;) {
        const message = await sdk.waitForChat({ from: 'A Pirate', types: [3, 7], timeout: 60_000 });
        if (!message || message.sender.trim().toLowerCase().replace(/ +/g, '_') !== 'a_pirate') continue;
        return { sender: message.sender, text: message.text, tick: message.tick };
    }
}, { printState: false });

if (!result.success) process.exitCode = 1;
```

In a second terminal, set `BOT_NAME` and run this from the root.
[Standalone scripts](../README.md#getting-started)

```sh
bun --env-file="bots/$BOT_NAME/bot.env" "bots/$BOT_NAME/await-pirate.ts"
```

With the proxy preload, run this instead.
[SDK gateway selection](../sdk/index.ts)

```sh
GATEWAY_DIRECT=false bun --preload "./bots/$BOT_NAME/hosted-proxy.cjs" \
  --env-file="bots/$BOT_NAME/bot.env" "bots/$BOT_NAME/await-pirate.ts"
```

## Resume and stop

- Check the runner log before starting a second client. Use `bun sdk/cli.ts "$BOT_NAME"`
  for a state check, and keep one controller active. If a disconnect interrupted a
  trade, inspect the partner and inventory delta before requesting another trade.
  [State and trade API](../sdk/API.md) · [Bot guide](../AGENTS.md)
- If the runner reports a revision mismatch, update the checkout and reinstall
  changed dependencies before retrying. If a tutorial skip fails, check the live
  coordinates, dialog, and character-design modal before retrying the tutorial.
  [Revision check](../server/webclient/src/lite/session.ts) · [Tutorial action](../sdk/actions.ts#L144)
- For a normal in-game logout, finish the current controller script and use
  `await sdk.sendClickComponent(2458)` in an attached SDK script. Verify the lite
  runner logs `Game session ended (logged-out)` and the process exits. The log
  confirms the logout after the button dispatch.
  [Logout component](../server/content/pack/interface.pack#L2459) · [Logout trigger](../server/content/scripts/login_logout/logout.rs2) · [Runner shutdown](../server/webclient/src/lite/runner.ts#L435-L447)

## Follow-up automation

- Wrap the workflow in one rerunnable launcher and a read-only status command.
  Keep a single controller. Report username, live location, and waiting status
  without dumping state or credentials. [State API](../sdk/API.md)
- Keep a local record of the last handled private message and completed actions.
  Store trade partner and inventory changes so a restart can reconcile any
  unfinished trade. [Chat history](../learnings/chat.md) · [Trade API](../sdk/API.md)
- Test first login, resume, the exact sender and private-message filter, and
  disconnect handling with a local fixture. Run a separate hosted smoke check
  when updating the pinned revision. [Gateway test fixture](../sdk/test/runner-lifecycle.test.ts) · [Revision check](../server/webclient/src/lite/session.ts)
