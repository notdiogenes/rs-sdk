#!/usr/bin/env bash
set -euo pipefail

source_dir=$1
stamp=$2
role=${4:-legacy}
# Old installations continue running until the separate services are installed.
case "$role" in
    legacy)
        if [[ "$3" == changed ]]; then exit 1; fi
        if [[ "$3" == record ]]; then exit 0; fi
        exit 2
        ;;
    web)
        files=(
            "$source_dir/dashboard-web.ts" "$source_dir/dashboard-presentation.ts" "$source_dir/dashboard-quests.ts"
            "$source_dir/../server/content/scripts/player/interfaces/questlist.if" "$source_dir/../server/content/pack/interface.pack"
        )
        ;;
    worker)
        # Activate changes to the live plan and roster managers with a controlled restart.
        # ExecStartPost records the new stamp after the service starts.
        worker_stamp_version='Fleet Desk worker restart inputs v8'
        if [[ "$3" == changed ]]; then
            if [[ ! -r "$stamp" ]] || ! IFS= read -r installed_version < "$stamp" ||
                [[ "$installed_version" != "$worker_stamp_version" ]]; then
                exit 1
            fi
        fi
        # Only dependencies of the long-lived worker, pathfinder and client
        # belong here. The worker reloads plan policy and starts task scripts
        # from the selected release on demand.
        files=(
            "$source_dir/dashboard-worker.ts" "$source_dir/dashboard-supervisor.ts" "$source_dir/dashboard-monitor.ts"
            "$source_dir/dashboard-task-activity.ts" "$source_dir/dashboard-revisions.ts"
            "$source_dir/dashboard-task-update.ts" "$source_dir/task-update-safety.ts"
            "$source_dir/dashboard-activity.ts" "$source_dir/dashboard-session.ts" "$source_dir/dashboard-inventory.ts"
            "$source_dir/dashboard-diagnostics.ts" "$source_dir/dashboard-live-state.ts" "$source_dir/dashboard-audit.ts" "$source_dir/dashboard-audit-schema.ts"
            "$source_dir/dashboard-audit-insights.ts" "$source_dir/dashboard-last-activity.ts" "$source_dir/hosted-bot.ts"
            "$source_dir/dashboard-fleet-stats.ts" "$source_dir/dashboard-quests.ts"
            "$source_dir/dashboard-demo.ts" "$source_dir/dashboard-roster.ts" "$source_dir/dashboard-plan-runner.ts"
            "$source_dir/dashboard-runtime-groups.ts" "$source_dir/dashboard-runtime-pools.ts"
            "$source_dir/runtime-task-host.ts" "$source_dir/runtime-task-worker.ts"
            "$source_dir/../sdk/audit-trace.ts"
            "$source_dir/../sdk/"pathfinding*.ts "$source_dir/../sdk/collision-data.json"
            "$source_dir/../server/vendor/rsmod-pathfinder/rsmod-pathfinder.js" "$source_dir/../server/vendor/rsmod-pathfinder/rsmod_bg.wasm"
            "$source_dir/../sdk/inventory-command.ts" "$source_dir/../sdk/fleet-telemetry.ts"
            "$source_dir/../server/webclient/src/lite/runner.ts" "$source_dir/../server/webclient/src/lite/pool.ts"
            "$source_dir/../server/webclient/src/lite/session.ts" "$source_dir/../server/webclient/src/lite/net/GameConnection.ts"
            "$source_dir/../server/webclient/src/lite/LiteClient.ts" "$source_dir/../server/webclient/src/lite/actions.ts"
            "$source_dir/../server/webclient/src/lite/protocol/incoming.ts"
            "$source_dir/../server/webclient/src/bot/StateCollector.ts" "$source_dir/../server/webclient/src/bot/quest-journal.ts"
        )
        ;;
    *) exit 2 ;;
esac
revision=$(sha256sum -- "${files[@]}")
if [[ "$role" == worker ]]; then
    revision="$worker_stamp_version"$'\n'"$revision"
fi

case "$3" in
    changed)
        [[ ! -f "$stamp" || $(cat -- "$stamp") != "$revision" ]]
        ;;
    record)
        temp=$(mktemp "$stamp.XXXXXX")
        trap 'rm -f -- "$temp"' EXIT
        printf '%s\n' "$revision" > "$temp"
        mv -- "$temp" "$stamp"
        ;;
    *) exit 2 ;;
esac
