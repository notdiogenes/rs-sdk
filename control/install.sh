#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 || $EUID == 0 ]]; then
    echo 'Usage (as your normal Debian user): bash control/install.sh PUBLIC_IPV4 [CALLER_KEY_SHA256]' >&2
    exit 2
fi
public_ip=$1
caller_hash=${2:-}
[[ -z "$caller_hash" || "$caller_hash" =~ ^[a-f0-9]{64}$ ]] ||
    { echo 'The optional caller key hash must be 64 lowercase hexadecimal characters' >&2; exit 2; }
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
bun=$(command -v bun || true)
bun=${bun:-"$HOME/.bun/bin/bun"}
owner=$(id -un)
config="$HOME/.config/rs-sdk-control"
cert_name="rs-sdk-control-$public_ip"
webroot=/var/lib/rs-sdk-control/acme
certbot=/opt/rs-sdk-control-certbot/bin/certbot
site=/etc/nginx/sites-available/rs-sdk-control
enabled=/etc/nginx/sites-enabled/rs-sdk-control

# These paths appear in systemd and Nginx configuration generated below.
for path in "$repo" "$bun" "$config"; do
    [[ "$path" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo "Unsupported install path: $path" >&2; exit 2; }
done
[[ "$owner" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ && -x "$bun" ]] || { echo 'Bun and a regular Linux user are required' >&2; exit 2; }
"$bun" -e 'import {isIPv4} from "node:net"; if (!isIPv4(process.argv.at(-1)!)) process.exit(2)' -- "$public_ip" ||
    { echo 'Enter the Lightsail public IPv4 address' >&2; exit 2; }

sudo apt-get update
sudo apt-get install -y --no-install-recommends nginx python3-venv ca-certificates curl
if [[ ! -x "$certbot" ]]; then
    sudo python3 -m venv /opt/rs-sdk-control-certbot
fi
sudo /opt/rs-sdk-control-certbot/bin/pip install 'certbot>=5.4,<6'

umask 077
mkdir -p "$config"
chmod 700 "$config"
if [[ ! -f "$config/token" ]]; then
    "$bun" -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))' > "$config/token"
fi
chmod 600 "$config/token"
if [[ -n "$caller_hash" ]]; then
    printf '%s\n' "$caller_hash" > "$config/caller.sha256"
    chmod 600 "$config/caller.sha256"
fi
umask 022

sudo tee /etc/systemd/system/rs-sdk-control.service >/dev/null <<EOF
[Unit]
Description=RS-SDK control API
After=network-online.target
Wants=network-online.target

[Service]
User=$owner
WorkingDirectory=$repo
Environment=RS_CONTROL_CONFIG_DIR=$config
Environment=GATEWAY_DIRECT=false
ExecStart=$bun run $repo/control/server.ts
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable rs-sdk-control.service
sudo systemctl restart rs-sdk-control.service
curl --fail --silent --show-error --retry 3 --retry-connrefused http://127.0.0.1:3719/health

sudo install -d -m 0755 "$webroot"
scratch=$(mktemp -d)
trap 'rmdir "$scratch" 2>/dev/null || true' EXIT
nginx_config() {
    {
        cat <<EOF
server {
    listen 80;
    server_name $public_ip;
    location ^~ /.well-known/acme-challenge/ {
        root $webroot;
        try_files \$uri =404;
    }
    location = /health {
        proxy_set_header Authorization "";
        proxy_pass http://127.0.0.1:3719;
        proxy_read_timeout 5s;
    }
    location / { return 404; }
}
EOF
        if [[ "$1" == tls ]]; then
            cat <<EOF
server {
    listen 443 ssl;
    server_name $public_ip;
    ssl_certificate /etc/letsencrypt/live/$cert_name/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$cert_name/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 4k;
    access_log off;
    location / {
        proxy_pass http://127.0.0.1:3719;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_read_timeout 25s;
    }
}
EOF
        fi
    } > "$scratch/site"
    sudo install -m 0644 "$scratch/site" "$site"
    unlink "$scratch/site"
    sudo ln -sfn "$site" "$enabled"
    sudo nginx -t
    sudo systemctl enable --now nginx
    sudo systemctl reload nginx
}

if sudo test -f "/etc/letsencrypt/live/$cert_name/fullchain.pem"; then
    nginx_config tls
else
    nginx_config http
fi
sudo "$certbot" certonly --webroot -w "$webroot" --ip-address "$public_ip" \
    --preferred-profile shortlived --cert-name "$cert_name" --keep-until-expiring \
    --non-interactive --agree-tos --register-unsafely-without-email
nginx_config tls

sudo tee /etc/systemd/system/rs-sdk-control-renew.service >/dev/null <<EOF
[Unit]
Description=Renew the RS-SDK public IP certificate

[Service]
Type=oneshot
ExecStart=$certbot renew --quiet --cert-name $cert_name --deploy-hook "/usr/bin/systemctl reload nginx"
EOF
sudo tee /etc/systemd/system/rs-sdk-control-renew.timer >/dev/null <<'EOF'
[Unit]
Description=Check the RS-SDK public IP certificate twice daily

[Timer]
OnCalendar=*-*-* 00,12:00:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now rs-sdk-control-renew.timer

# Test Nginx and the trusted certificate locally without relying on NAT hairpin.
curl --fail --silent --show-error --resolve "$public_ip:443:127.0.0.1" "https://$public_ip/health"
[[ $(curl --silent --show-error --resolve "$public_ip:443:127.0.0.1" \
    --output /dev/null --write-out '%{http_code}' "https://$public_ip/v1/status") == 401 ]]
printf '\nReady: https://%s/health\n' "$public_ip"
printf 'API token is stored at %s/token. No bot was started.\n' "$config"
