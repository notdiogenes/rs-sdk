#!/usr/bin/env bash
set -euo pipefail

source_dir=$1
stamp=$2
# Presentation assets, templates, and report readers reload separately.
revision=$(sha256sum -- "$source_dir/public-status.ts" "$source_dir/dashboard-presentation.ts" \
    "$source_dir/dashboard-activity.ts" "$source_dir/dashboard-session.ts" \
    "$source_dir/dashboard-diagnostics.ts" "$source_dir/dashboard-audit.ts" "$source_dir/dashboard-audit-schema.ts" "$source_dir/dashboard-audit-insights.ts" \
    "$source_dir/dashboard-last-activity.ts" "$source_dir/hosted-bot.ts" \
    "$source_dir/dashboard-fleet-stats.ts" "$source_dir/dashboard-quests.ts" \
    "$source_dir/dashboard-demo.ts" "$source_dir/dashboard-task-catalog.ts" "$source_dir/dashboard-roster.ts" \
    "$source_dir/dashboard-plan.ts" "$source_dir/dashboard-plan-runner.ts" "$source_dir"/tasks/*.ts \
    "$source_dir/../sdk/audit-trace.ts" "$source_dir/../sdk/index.ts" "$source_dir/../sdk/runner.ts" \
    "$source_dir"/tasks/quests/*.ts "$source_dir/../server/webclient/src/lite/runner.ts" \
    "$source_dir/../server/webclient/src/bot/StateCollector.ts" "$source_dir/../server/webclient/src/bot/quest-journal.ts" \
    "$source_dir/../server/content/scripts/player/interfaces/questlist.if" "$source_dir/../server/content/pack/interface.pack")

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
esac
