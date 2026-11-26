#!/usr/bin/env bash
set -euo pipefail

directory="$HOME/.config/rs-sdk-public-status"
site=/etc/nginx/sites-enabled/rs-sdk-control-hostname
bun=$(command -v bun || true)
bun=${bun:-"$HOME/.bun/bin/bun"}
if [[ $EUID == 0 || ! -x "$bun" || ! -r "$site" || ! -d "$directory" ]]; then
    echo 'Run as the dashboard service user on Lightsail after installing the dashboard.' >&2
    exit 1
fi
hostname=$(awk '/^[[:space:]]*server_name/ {sub(/;$/, "", $2); print $2; exit}' "$site")
if [[ ! "$hostname" =~ ^[0-9]+-[0-9]+-[0-9]+-[0-9]+\.sslip\.io$ ]]; then
    echo 'Expected the managed RS-SDK HTTPS site.' >&2
    exit 1
fi

IFS= read -rs -p 'New dashboard password (12–128 characters): ' password
printf '\n'
IFS= read -rs -p 'Confirm dashboard password: ' confirmation
printf '\n'
if [[ "$password" != "$confirmation" || ${#password} -lt 12 || ${#password} -gt 128 ]]; then
    echo 'The passwords must match and contain 12–128 characters.' >&2
    exit 1
fi
umask 077
temp=$(mktemp "$directory/password.XXXXXX")
trap 'rm -f -- "$temp"' EXIT
printf '%s' "$password" | "$bun" --no-env-file -e '
    const password = await Bun.stdin.text();
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    console.log(JSON.stringify({ hash, origin: process.argv.at(-1) }));
' -- "https://$hostname" > "$temp"
unset password confirmation
mv -f -- "$temp" "$directory/password.json"
printf 'Dashboard password saved. Sign in at https://%s/bots\n' "$hostname"
