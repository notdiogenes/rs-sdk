#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || $EUID == 0 ]]; then
    echo 'Usage (as your regular Linux user): bash control/add-ip-hostname.sh PUBLIC_IPV4' >&2
    exit 2
fi
public_ip=$1
bun=$(command -v bun || true)
bun=${bun:-"$HOME/.bun/bin/bun"}
"$bun" -e 'import {isIPv4} from "node:net"; if (!isIPv4(process.argv.at(-1)!)) process.exit(2)' -- "$public_ip" ||
    { echo 'Enter the Lightsail public IPv4 address' >&2; exit 2; }

hostname="${public_ip//./-}.sslip.io"
certbot=/opt/rs-sdk-control-certbot/bin/certbot
cert_name="rs-sdk-control-hostname-$public_ip"
webroot=/var/lib/rs-sdk-control/acme
site=/etc/nginx/sites-available/rs-sdk-control-hostname
enabled=/etc/nginx/sites-enabled/rs-sdk-control-hostname
dropin=/etc/systemd/system/rs-sdk-control-renew.service.d

if [[ ! -x "$certbot" ]] || ! systemctl is-active --quiet rs-sdk-control ||
    ! systemctl is-active --quiet nginx ||
    ! systemctl is-enabled --quiet rs-sdk-control-renew.timer; then
    echo 'Run control/install.sh successfully before adding the hostname.' >&2
    exit 1
fi
if ! getent ahostsv4 "$hostname" | awk -v ip="$public_ip" '$1 == ip {found=1} END {exit !found}'; then
    echo "DNS did not resolve $hostname to $public_ip" >&2
    exit 1
fi

scratch=$(mktemp -d)
trap 'rmdir "$scratch" 2>/dev/null || true' EXIT
configure_nginx() {
    {
        cat <<EOF
server {
    listen 80;
    server_name $hostname;
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
    server_name $hostname;
    ssl_certificate /etc/letsencrypt/live/$cert_name/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$cert_name/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 4k;
    access_log off;
    include /etc/nginx/rs-sdk-control/https/*.conf;
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
    if [[ "$1" == tls ]]; then
        sudo install -d -m 0755 /etc/nginx/rs-sdk-control/https
    fi
    sudo nginx -t
    sudo systemctl reload nginx
}

if ! sudo test -f "/etc/letsencrypt/live/$cert_name/fullchain.pem"; then
    configure_nginx http
fi
sudo "$certbot" certonly --webroot -w "$webroot" -d "$hostname" \
    --cert-name "$cert_name" --keep-until-expiring \
    --non-interactive --agree-tos --register-unsafely-without-email
configure_nginx tls

sudo install -d -m 0755 "$dropin"
sudo tee "$dropin/hostname.conf" >/dev/null <<EOF
[Service]
ExecStart=$certbot renew --quiet --cert-name $cert_name --deploy-hook "/usr/bin/systemctl reload nginx"
EOF
sudo systemctl daemon-reload

curl --fail --silent --show-error --resolve "$hostname:443:127.0.0.1" "https://$hostname/health"
[[ $(curl --silent --show-error --resolve "$hostname:443:127.0.0.1" \
    --output /dev/null --write-out '%{http_code}' "https://$hostname/v1/status") == 401 ]]
printf '\nReady: https://%s/health\n' "$hostname"
