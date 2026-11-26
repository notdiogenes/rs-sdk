#!/usr/bin/env bash
set -euo pipefail

repository=notdiogenes/rs-sdk
origin="https://github.com/$repository.git"
checkout="$HOME/rs-sdk-sync"
state="$HOME/.config/rs-sdk-github-sync"
bun=$(command -v bun || true)
bun=${bun:-"$HOME/.bun/bin/bun"}
site=/etc/nginx/sites-available/rs-sdk-control-hostname
enabled=/etc/nginx/sites-enabled/rs-sdk-control-hostname
include_dir=/etc/nginx/rs-sdk-control/https
include_line="    include $include_dir/*.conf;"
service=rs-sdk-github-sync

if [[ $EUID == 0 || ! -x "$bun" ]]; then
    echo 'Run as the regular user with Bun installed.' >&2
    exit 1
fi
if [[ ! -f "$site" || ! "$enabled" -ef "$site" ]] || ! systemctl is-active --quiet nginx; then
    echo 'Install the RS-SDK HTTPS hostname before enabling GitHub sync.' >&2
    exit 1
fi
hostname=$(awk '/^[[:space:]]*server_name/ {sub(/;$/, "", $2); print $2; exit}' "$site")
if [[ ! "$hostname" =~ ^[0-9]+-[0-9]+-[0-9]+-[0-9]+\.sslip\.io$ ]] ||
    ! grep -Eq '^[[:space:]]*listen 443 ssl;' "$site"; then
    echo 'Expected the managed RS-SDK HTTPS site.' >&2
    exit 1
fi
sudo -v

umask 077
mkdir -p "$state"
chmod 0700 "$state"
if [[ ! -e "$state/secret" ]]; then
    "$bun" -e 'import { randomBytes } from "node:crypto"; console.log(randomBytes(32).toString("hex"))' > "$state/secret"
fi
chmod 0600 "$state/secret"

if [[ ! -e "$checkout" ]]; then
    git -c core.hooksPath=/dev/null clone --single-branch --branch main --no-tags "$origin" "$checkout"
fi
if [[ -L "$checkout" || ! -d "$checkout/.git" || -L "$checkout/.git" ||
    $(git -C "$checkout" config --local --get remote.origin.url) != "$origin" ||
    $(git -C "$checkout" branch --show-current) != main || -n $(git -C "$checkout" status --porcelain) ]]; then
    echo "Expected a clean main checkout at $checkout with origin $origin." >&2
    exit 1
fi

scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
git -C "$checkout" show HEAD:control/github-sync.ts > "$scratch/github-sync.ts"
install -m 0600 "$scratch/github-sync.ts" "$state/github-sync.ts"

cat > "$scratch/$service.service" <<EOF
[Unit]
Description=RS-SDK GitHub push sync
Wants=network-online.target
After=network-online.target

[Service]
User=$(id -un)
ExecStart="$bun" --no-env-file "$state/github-sync.ts" "$checkout" "$state" "$repository"
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths="$checkout" "$state"
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
sudo install -m 0644 "$scratch/$service.service" "/etc/systemd/system/$service.service"
sudo systemctl daemon-reload
sudo systemctl enable "$service"
sudo systemctl restart "$service"
curl --fail --silent --show-error --retry 5 --retry-connrefused --max-time 2 \
    http://127.0.0.1:3720/health >/dev/null

sudo install -d -m 0755 "$include_dir"
cat > "$scratch/github-sync.conf" <<'EOF'
    location = /hooks/github-sync {
        client_max_body_size 1m;
        proxy_pass http://127.0.0.1:3720;
        proxy_http_version 1.1;
        proxy_read_timeout 8s;
        access_log off;
    }
EOF
cp "$site" "$scratch/original-site"
if [[ -f "$include_dir/github-sync.conf" ]]; then
    cp "$include_dir/github-sync.conf" "$scratch/original-hook"
fi
if ! grep -Fxq "$include_line" "$site"; then
    awk -v include="$include_line" '
        { print }
        /^[[:space:]]*access_log off;[[:space:]]*$/ { print include; count++ }
        END { exit count != 1 }
    ' "$site" > "$scratch/site"
    sudo install -m 0644 "$scratch/site" "$site"
fi
sudo install -m 0644 "$scratch/github-sync.conf" "$include_dir/github-sync.conf"
if ! sudo nginx -t; then
    sudo install -m 0644 "$scratch/original-site" "$site"
    if [[ -f "$scratch/original-hook" ]]; then
        sudo install -m 0644 "$scratch/original-hook" "$include_dir/github-sync.conf"
    else
        sudo rm -f "$include_dir/github-sync.conf"
    fi
    exit 1
fi
sudo systemctl reload nginx

url="https://$hostname/hooks/github-sync"
status=$(curl --silent --show-error --max-time 8 --resolve "$hostname:443:127.0.0.1" \
    --request POST --output /dev/null --write-out '%{http_code}' "$url")
[[ "$status" == 401 ]] || { echo "Expected HTTP 401 for an unsigned request, got $status." >&2; exit 1; }
printf '\nGitHub payload URL: %s\nWebhook secret file: %s\nSync checkout: %s\n' "$url" "$state/secret" "$checkout"
