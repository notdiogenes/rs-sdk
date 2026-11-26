#!/usr/bin/env bash
set -euo pipefail

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
config="$HOME/.config/rs-sdk-control"
runtime="$HOME/.config/rs-sdk-public-status"
bun=$(command -v bun || true)
bun=${bun:-"$HOME/.bun/bin/bun"}
service=rs-sdk-public-status
site=/etc/nginx/sites-enabled/rs-sdk-control-hostname
include_dir=/etc/nginx/rs-sdk-control/https
snippet="$include_dir/public-status.conf"

if [[ $EUID == 0 || ! -x "$bun" || ! -r "$config/token" ]] ||
    ! systemctl is-active --quiet rs-sdk-control || ! systemctl is-active --quiet nginx; then
    echo 'Run as the regular user on the host running the RS-SDK control API and Nginx.' >&2
    exit 1
fi
if [[ ! -f "$site" ]] || ! grep -Fxq "    include $include_dir/*.conf;" "$site"; then
    echo 'Enable the RS-SDK HTTPS hostname with the GitHub sync installer first.' >&2
    exit 1
fi
hostname=$(awk '/^[[:space:]]*server_name/ {sub(/;$/, "", $2); print $2; exit}' "$site")
if [[ ! "$hostname" =~ ^[0-9]+-[0-9]+-[0-9]+-[0-9]+\.sslip\.io$ ]]; then
    echo 'Expected the managed RS-SDK HTTPS site.' >&2
    exit 1
fi
owner=$(id -un)
active_repo=$(systemctl show rs-sdk-control --property=WorkingDirectory --value)
active_owner=$(systemctl show rs-sdk-control --property=User --value)
if [[ "$active_owner" != "$owner" || -z "$active_repo" || ! -d "$active_repo/bots" ]]; then
    echo 'Run as the control service user. Its working directory must contain the bots directory.' >&2
    exit 1
fi
for path in "$bun" "$config" "$runtime" "$active_repo"; do
    [[ "$path" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo "Unsupported service path: $path" >&2; exit 1; }
done
sudo -v

scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
install -d -m 0700 "$runtime"
install -m 0600 "$source_dir/hosted-bot.ts" "$source_dir/public-status.ts" "$runtime/"
cat > "$scratch/$service.service" <<EOF
[Unit]
Description=RS-SDK public bot status page
Wants=network-online.target
After=network-online.target rs-sdk-control.service

[Service]
User=$owner
ExecStart=$bun --no-env-file $runtime/public-status.ts $active_repo/bots $config
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
sudo install -m 0644 "$scratch/$service.service" "/etc/systemd/system/$service.service"
sudo systemctl daemon-reload
sudo systemctl restart "$service"
curl --fail --silent --show-error --retry 4 --retry-connrefused --max-time 15 \
    http://127.0.0.1:3721/bots >/dev/null

cat > "$scratch/public-status.conf" <<'EOF'
    location = /bots {
        proxy_pass http://127.0.0.1:3721;
        proxy_http_version 1.1;
        proxy_set_header Authorization "";
        proxy_read_timeout 15s;
    }
EOF
if [[ -f "$snippet" ]]; then
    cp "$snippet" "$scratch/original"
fi
sudo install -m 0644 "$scratch/public-status.conf" "$snippet"
if ! sudo nginx -t; then
    if [[ -f "$scratch/original" ]]; then
        sudo install -m 0644 "$scratch/original" "$snippet"
    else
        sudo rm -f "$snippet"
    fi
    exit 1
fi
sudo systemctl reload nginx
sudo systemctl enable "$service"

url="https://$hostname/bots"
curl --fail --silent --show-error --max-time 15 --resolve "$hostname:443:127.0.0.1" "$url" >/dev/null
printf '\nPublic bot status page: %s\n' "$url"
