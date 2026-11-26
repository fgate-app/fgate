#!/bin/sh
# Operator bootstrap. Devices enroll over trusted HTTPS with an invitation.
set -eu
[ "$(id -u)" = 0 ]
: "${FG_CLOUD_HOST:?Set FG_CLOUD_HOST to the public cloud IP address}"
# Provision a certificate trusted by devices before running this installer.
[ -s /etc/freedomgate-cloud/tls.crt ] && [ -s /etc/freedomgate-cloud/tls.key ] || { echo 'Install a trusted TLS certificate and key in /etc/freedomgate-cloud first.' >&2; exit 1; }
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends nodejs openssl ca-certificates openssh-server openssh-client
node --input-type=module -e 'import {isIP} from "node:net"; if(!isIP(process.env.FG_CLOUD_HOST || ""))throw Error("FG_CLOUD_HOST must be an IP address.")'
install -d -m 755 /opt/freedomgate-cloud /etc/freedomgate-cloud
install -d -m 711 /var/lib/freedomgate-cloud
install -m 644 "$root/server/cloud/broker.js" /opt/freedomgate-cloud/broker.mjs
install -m 644 "$root/server/cloud/ssh-policy.js" /opt/freedomgate-cloud/ssh-policy.js
install -m 644 "$root/server/cloud/package.json" /opt/freedomgate-cloud/package.json
getent group freedomgate-cloud-ssh >/dev/null || groupadd --system freedomgate-cloud-ssh
install -d -m 755 /etc/freedomgate-cloud/ssh-authorized-keys
ssh-keygen -A
node --input-type=module -e 'import {cloudSshdConfig} from "./server/cloud/ssh-policy.js"; process.stdout.write(cloudSshdConfig)' > /etc/freedomgate-cloud/sshd_config
/usr/sbin/sshd -t -f /etc/freedomgate-cloud/sshd_config
install -m 755 "$root/server/access-points/bin/linux-amd64/frps" /opt/freedomgate-cloud/frps
cat > /etc/systemd/system/freedomgate-cloud-ssh.service <<'UNIT'
[Unit]
Description=FreedomGate restricted cloud SSH forwarding
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/sbin/sshd -D -e -f /etc/freedomgate-cloud/sshd_config
RuntimeDirectory=freedomgate-cloud-ssh
Restart=always
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
TasksMax=256
MemoryMax=128M
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/freedomgate-cloud.service <<'UNIT'
[Unit]
Description=FreedomGate cloud enrollment
After=network-online.target
Wants=network-online.target
[Service]
Environment=FG_CLOUD_SSH=1
EnvironmentFile=/etc/freedomgate-cloud/environment
ExecStart=/usr/bin/node /opt/freedomgate-cloud/broker.mjs
Restart=always
RestartSec=3
UMask=0077
PrivateTmp=yes
ProtectHome=yes
[Install]
WantedBy=multi-user.target
UNIT
umask 077
printf 'FG_CLOUD_HOST=%s\n' "$FG_CLOUD_HOST" > /etc/freedomgate-cloud/environment
systemctl daemon-reload
systemctl enable --now freedomgate-cloud-ssh.service freedomgate-cloud.service
systemctl restart freedomgate-cloud.service
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
 ufw allow 2222/tcp comment 'FreedomGate SSH fallback'
 ufw allow 7443/tcp comment 'FreedomGate enrollment'
 ufw allow 20000:20299/tcp comment 'FreedomGate relays'
 ufw allow 20000:20299/udp comment 'FreedomGate relays'
fi
systemctl is-active freedomgate-cloud.service
