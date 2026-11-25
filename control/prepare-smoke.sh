#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 || ! "$1" =~ ^[A-Za-z0-9][A-Za-z0-9\ ]{0,11}$ || $EUID == 0 ]]; then
    echo 'Usage (as your regular Linux user): bash control/prepare-smoke.sh BOT_NAME' >&2
    exit 2
fi
bot=$1
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
bun=$(command -v bun || true)
bun=${bun:-"$HOME/.bun/bin/bun"}
config="$HOME/.config/rs-sdk-control/control.json"
directory="$repo/bots/$bot"
task=rs-control-smoke.ts

if [[ ! -s "$HOME/.config/rs-sdk-control/token" ]]; then
    echo 'Install the control API first.' >&2
    exit 1
fi
if [[ -e "$config" ]]; then
    "$bun" -e '
        const [path, name, file] = process.argv.slice(-3);
        const c = await Bun.file(path!).json();
        if (c.bot !== name || !c.tasks || typeof c.tasks !== "object" || Array.isArray(c.tasks) ||
            (Object.hasOwn(c.tasks, "smoke-move") && c.tasks["smoke-move"] !== file)) {
            throw new Error("Existing control.json conflicts with the movement test");
        }
    ' -- "$config" "$bot" "$task"
fi

umask 077
mkdir -p "$directory"
if [[ ! -e "$directory/bot.env" ]]; then
    IFS= read -r -s -p "Existing RS-SDK password for $bot: " bot_password
    printf '\n'
    [[ -n "$bot_password" ]] || { echo 'An existing bot password is required.' >&2; exit 1; }
    (set -o noclobber; printf 'BOT_USERNAME=%s\nPASSWORD=%s\nSERVER=rs-sdk.maxbittker.com\nSHOW_CHAT=false\n' \
        "$bot" "$bot_password" > "$directory/bot.env")
    unset bot_password
fi
launcher() {
    cat <<'TS'
import { runScript } from '../../sdk/runner';
import { moveOneTile } from '../../control/smoke';
const result = await runScript(moveOneTile, { printState: false, timeout: 15000 });
if (!result.success) process.exitCode = 1;
TS
}
if [[ ! -e "$directory/$task" ]]; then
    (set -o noclobber; launcher > "$directory/$task")
elif ! cmp -s "$directory/$task" <(launcher); then
    echo "Existing bot script conflicts with $task" >&2
    exit 1
fi
temp=$(mktemp "${config}.XXXXXX")
trap 'unlink "$temp" 2>/dev/null || true' EXIT
"$bun" -e '
    const [path, output, bot, task] = process.argv.slice(-4);
    const existing = Bun.file(path!);
    const config = await existing.exists() ? await existing.json() : { bot, tasks: {} };
    config.tasks["smoke-move"] = task;
    await Bun.write(output!, JSON.stringify(config, null, 2) + "\n");
' -- "$config" "$temp" "$bot" "$task"
mv -- "$temp" "$config"
printf 'Configured %s for smoke-move. No bot was started.\n' "$bot"
