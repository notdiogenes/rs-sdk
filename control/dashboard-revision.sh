#!/usr/bin/env bash
set -euo pipefail

source_dir=$1
stamp=$2
# Old installations continue running until the separate services are installed.
case "${4:-legacy}" in
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
        files=(
            "$source_dir/dashboard-worker.ts" "$source_dir/dashboard-supervisor.ts"
            "$source_dir/dashboard-activity.ts" "$source_dir/dashboard-session.ts" "$source_dir/dashboard-inventory.ts"
            "$source_dir/dashboard-diagnostics.ts" "$source_dir/dashboard-live-state.ts" "$source_dir/dashboard-audit.ts" "$source_dir/dashboard-audit-schema.ts"
            "$source_dir/dashboard-audit-insights.ts" "$source_dir/dashboard-last-activity.ts" "$source_dir/hosted-bot.ts"
            "$source_dir/dashboard-fleet-stats.ts" "$source_dir/dashboard-quests.ts"
            "$source_dir/dashboard-demo.ts" "$source_dir/dashboard-task-catalog.ts" "$source_dir/dashboard-roster.ts" "$source_dir/mining-routes.ts"
            "$source_dir/dashboard-plan.ts" "$source_dir/dashboard-plan-runner.ts" "$source_dir"/tasks/*.ts
            "$source_dir/../sdk/audit-trace.ts" "$source_dir/../sdk/index.ts" "$source_dir/../sdk/runner.ts"
            "$source_dir/../sdk/inventory-command.ts" "$source_dir/../sdk/fleet-telemetry.ts"
            "$source_dir"/tasks/quests/*.ts "$source_dir/../server/webclient/src/lite/runner.ts"
            "$source_dir/../server/webclient/src/lite/LiteClient.ts" "$source_dir/../server/webclient/src/lite/actions.ts"
            "$source_dir/../server/webclient/src/lite/protocol/incoming.ts"
            "$source_dir/../server/webclient/src/bot/StateCollector.ts" "$source_dir/../server/webclient/src/bot/quest-journal.ts"
        )
        ;;
    *) exit 2 ;;
esac
revision=$(sha256sum -- "${files[@]}")

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
