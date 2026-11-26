#!/usr/bin/env bash
set -euo pipefail

source_dir=$1
stamp=$2
revision=$(sha256sum -- "$source_dir/public-status.ts" "$source_dir/public-status-controls.js" \
    "$source_dir/dashboard-activity.ts" "$source_dir/dashboard-session.ts" \
    "$source_dir/dashboard-diagnostics.ts" "$source_dir/dashboard-last-activity.ts" "$source_dir/hosted-bot.ts")

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
