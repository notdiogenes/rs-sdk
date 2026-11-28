#!/usr/bin/env bash
set -euo pipefail

enable_worker_restart=false
if [[ $# == 1 && $1 == --enable-worker-restart ]]; then
    enable_worker_restart=true
elif [[ $# != 0 ]]; then
    echo 'Usage: bash control/install-public-status.sh [--enable-worker-restart]' >&2
    exit 2
fi

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
config="$HOME/.config/rs-sdk-control"
runtime="$HOME/.config/rs-sdk-public-status"
bun=$(command -v bun || true)
bun=${bun:-"$HOME/.bun/bin/bun"}
service=rs-sdk-public-status
refresh=rs-sdk-public-status-refresh
worker=rs-sdk-fleet-workers
worker_refresh=rs-sdk-fleet-workers-refresh
maintenance=rs-sdk-fleet-maintenance
socket=/run/rs-sdk-fleet-workers/worker.sock
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
for path in "$bun" "$config" "$source_dir" "$active_repo" "$runtime"; do
    [[ "$path" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo "Unsupported service path: $path" >&2; exit 1; }
done
reflog="$(dirname -- "$source_dir")/.git/logs/HEAD"
if [[ ! -r "$reflog" ]]; then
    echo 'Run this installer from the GitHub webhook sync checkout.' >&2
    exit 1
fi
sudo -v

scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT

install_maintenance_units() {
    cat > "$scratch/$maintenance.socket" <<EOF
[Unit]
Description=RS-SDK Fleet Desk worker maintenance socket

[Socket]
ListenStream=/run/rs-sdk-fleet-maintenance.sock
SocketUser=$owner
SocketMode=0600
Accept=yes
MaxConnections=1
RemoveOnStop=yes

[Install]
WantedBy=sockets.target
EOF
    cat > "$scratch/$maintenance@.service" <<'EOF'
[Unit]
Description=Restart the RS-SDK Fleet Desk worker

[Service]
Type=oneshot
TimeoutStartSec=3min
ExecStart=/bin/sh -c 'if /usr/bin/systemctl restart rs-sdk-fleet-workers.service >&2; then echo restarted; else echo failed; exit 1; fi'
StandardInput=socket
StandardOutput=socket
StandardError=journal
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
EOF
    sudo install -o root -g root -m 0644 "$scratch/$maintenance.socket" "$scratch/$maintenance@.service" /etc/systemd/system/
}

if [[ "$enable_worker_restart" == true ]]; then
    if [[ $(systemctl show "$worker.service" --property=LoadState --value) != loaded ]]; then
        echo 'Install the Fleet Desk worker before enabling dashboard restarts.' >&2
        exit 1
    fi
    install_maintenance_units
    sudo systemctl daemon-reload
    sudo systemctl enable --now "$maintenance.socket"
    printf '\nFleet Desk worker restart is enabled.\n'
    exit 0
fi

install -d -m 0700 "$runtime"
web_revision="$runtime/web.sha256"
worker_revision="$runtime/workers.sha256"
cat > "$scratch/$worker.service" <<EOF
[Unit]
Description=RS-SDK Fleet Desk bot worker supervisor
Wants=network-online.target
After=network-online.target rs-sdk-control.service

[Service]
User=$owner
RuntimeDirectory=$worker
RuntimeDirectoryMode=0700
ExecStart=$bun --no-env-file $source_dir/dashboard-worker.ts $active_repo/bots $config $socket
ExecStartPost=/bin/bash $source_dir/dashboard-revision.sh $source_dir $worker_revision record worker
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$runtime
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
cat > "$scratch/$service.service" <<EOF
[Unit]
Description=RS-SDK Fleet Desk web service
Wants=$worker.service
After=$worker.service

[Service]
User=$owner
ExecStart=$bun --no-env-file $source_dir/dashboard-web.ts $runtime $socket
ExecStartPost=/bin/bash $source_dir/dashboard-revision.sh $source_dir $web_revision record web
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=$runtime
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
write_refresh_units() {
    local unit=$1 target=$2 stamp=$3 role=$4
    cat > "$scratch/$unit.service" <<EOF
[Unit]
Description=Reload the RS-SDK Fleet Desk $role service after a source update

[Service]
Type=oneshot
User=$owner
ExecCondition=/bin/bash $source_dir/dashboard-revision.sh $source_dir $stamp changed $role
ExecStart=+/usr/bin/systemctl restart $target.service
EOF
    cat > "$scratch/$unit.path" <<EOF
[Unit]
Description=Watch the RS-SDK sync checkout for $role service updates

[Path]
PathChanged=$reflog

[Install]
WantedBy=multi-user.target
EOF
}
write_refresh_units "$refresh" "$service" "$web_revision" web
write_refresh_units "$worker_refresh" "$worker" "$worker_revision" worker
sudo install -m 0644 "$scratch/$service.service" "$scratch/$worker.service" /etc/systemd/system/
sudo install -m 0644 "$scratch/$refresh.service" "$scratch/$refresh.path" \
    "$scratch/$worker_refresh.service" "$scratch/$worker_refresh.path" /etc/systemd/system/
install_maintenance_units
sudo systemctl daemon-reload

if ! systemctl is-active --quiet "$worker"; then
    # Stop the legacy owner before opening the same plans and audit databases.
    sudo systemctl stop "$service"
fi
sudo systemctl enable --now "$worker"
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
    location = /bots/activity {
        proxy_pass http://127.0.0.1:3721;
        proxy_http_version 1.1;
        proxy_read_timeout 40s;
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
[[ $(curl --silent --show-error --max-time 15 --resolve "$hostname:443:127.0.0.1" \
    --output /dev/null --write-out '%{http_code}' "$url/activity") == 401 ]]
sudo systemctl enable --now "$refresh.path" "$worker_refresh.path" "$maintenance.socket"
printf '\nPublic bot status page: %s\n' "$url"
