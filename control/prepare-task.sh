#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 || ! "$1" =~ ^[a-z][a-z0-9-]{0,63}$ || $EUID == 0 ]]; then
    echo 'Usage (as your regular Linux user): bash control/prepare-task.sh TASK_NAME' >&2
    exit 2
fi
task=$1
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
bun=$(command -v bun || true)
bun=${bun:-"$HOME/.bun/bin/bun"}
config="$HOME/.config/rs-sdk-control/control.json"
source="$repo/control/tasks/$task.ts"
[[ -f "$source" && -f "$config" ]] ||
    { echo 'The packaged task and an existing control profile are required.' >&2; exit 1; }

bot=$("$bun" -e '
    const [path, task] = process.argv.slice(-2);
    const config = await Bun.file(path!).json();
    if (typeof config.bot !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ]{0,11}$/.test(config.bot) ||
        !config.tasks || typeof config.tasks !== "object" || Array.isArray(config.tasks)) {
        throw new Error("Invalid control profile");
    }
    if (Object.hasOwn(config.tasks, task!) && config.tasks[task!] !== task + ".ts") {
        throw new Error("Task name already points to a different script");
    }
    console.log(config.bot);
' -- "$config" "$task")
directory="$repo/bots/$bot"
destination="$directory/$task.ts"
[[ -s "$directory/bot.env" ]] || { echo 'The configured bot is missing bot.env.' >&2; exit 1; }
umask 077
if [[ -L "$destination" ]]; then
    echo "Refusing a symlink task file: $destination" >&2
    exit 1
elif [[ ! -e "$destination" ]]; then
    (set -o noclobber; cat "$source" > "$destination")
elif ! cmp -s "$source" "$destination"; then
    echo "Existing bot script differs from $source. Review them before registering it." >&2
    exit 1
fi
temp=$(mktemp "${config}.XXXXXX")
trap 'unlink "$temp" 2>/dev/null || true' EXIT
"$bun" -e '
    const [path, output, bot, task] = process.argv.slice(-4);
    const config = await Bun.file(path!).json();
    if (config.bot !== bot || (Object.hasOwn(config.tasks, task!) && config.tasks[task!] !== task + ".ts")) {
        throw new Error("Control profile changed during setup");
    }
    config.tasks[task!] = task + ".ts";
    await Bun.write(output!, JSON.stringify(config, null, 2) + "\n");
' -- "$config" "$temp" "$bot" "$task"
mv -- "$temp" "$config"
printf 'Registered %s for %s. No task was started.\n' "$task" "$bot"
