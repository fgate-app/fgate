import {isIP} from 'node:net';
import {readFileSync} from 'node:fs';
import {AccessPointError} from '../access-points/model.js';
import {withSsh} from '../access-points/ssh.js';
import {privateNetworks} from '../access-points/runtime.js';
const lock=JSON.parse(readFileSync(new URL('../../packaging/modules.lock.json',import.meta.url),'utf8')).modules.find(row=>row.id==='xray');
export function vpnServerConfig(row){
 const inbound={tag:'vpn',listen:isIP(row.host)===6?'::':'0.0.0.0',port:row.publicPort,protocol:row.protocol==='vless'?'vless':'shadowsocks',settings:row.protocol==='vless'?{clients:[{id:row.secrets.clientId,flow:'xtls-rprx-vision'}],decryption:'none'}:{method:'chacha20-ietf-poly1305',password:row.secrets.password,network:'tcp,udp'}};
 if(row.protocol==='vless')inbound.streamSettings={network:'tcp',security:'reality',realitySettings:{show:false,target:row.serverName+':443',serverNames:[row.serverName],privateKey:row.secrets.realityPrivate,shortIds:[row.secrets.shortId]}};
 return {log:{loglevel:'none'},inbounds:[inbound],outbounds:[{tag:'internet',protocol:'freedom'},{tag:'blocked',protocol:'blackhole'}],routing:{domainStrategy:'IPOnDemand',rules:[{type:'field',ip:privateNetworks,outboundTag:'blocked'}]}};
}
export const vpnProbeScript=`set -eu
[ "$(id -u)" = 0 ]
. /etc/os-release
case "$ID:$VERSION_ID" in debian:12|debian:13|ubuntu:22.04|ubuntu:24.04|ubuntu:26.04) ;; *) exit 2 ;; esac
command -v systemctl >/dev/null
command -v python3 >/dev/null
case "$(uname -m)" in x86_64) echo linux-amd64 ;; aarch64) echo linux-arm64 ;; *) exit 3 ;; esac
`;
export function vpnInstallScript(row,platform){
 if(!/^[a-f0-9-]{36}$/.test(row.id) || !lock.platforms[platform])throw new AccessPointError('Unsupported VPS platform.');
 const dir='/opt/freedomgate-vpn/'+row.id,unit='freedomgate-vpn-'+row.id+'.service',asset=lock.platforms[platform];
 const unitText=`[Unit]\nDescription=FreedomGate VPN\nAfter=network-online.target\nWants=network-online.target\n[Service]\nUser=freedomgate-vpn\nGroup=freedomgate-vpn\nExecStart=${dir}/xray run -config ${dir}/config.json\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=true\nProtectSystem=strict\nProtectHome=true\nPrivateTmp=true\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\nAmbientCapabilities=CAP_NET_BIND_SERVICE\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n`;
 const payload=Buffer.from(JSON.stringify({url:`https://github.com/${lock.repository}/releases/download/${lock.version}/${asset.asset}`,sha256:asset.sha256,config:vpnServerConfig(row),unit:unitText,port:row.publicPort,udp:row.protocol==='shadowsocks',family:isIP(row.host)})).toString('base64');
 return `set -eu
umask 077
${vpnProbeScript}
owner=${row.id}
dest=${dir}
unit=${unit}
unit_path=/etc/systemd/system/$unit
if [ -e "$dest" ]; then
 [ -f "$dest/owner" ] && [ "$(cat "$dest/owner")" = "$owner" ] || exit 10
fi
if [ -e "$unit_path" ]; then
 [ -f "$dest/owner" ] || exit 10
fi
stage=$(mktemp -d /tmp/fg-vpn.XXXXXXXX)
had_previous=0
was_active=0
was_enabled=0
if [ -f "$dest/owner" ]; then
 had_previous=1
 cp -a "$dest" "$stage/previous"
 if [ -e "$unit_path" ]; then cp -a "$unit_path" "$stage/unit.previous"; fi
 if systemctl is-active --quiet "$unit"; then was_active=1; fi
 if systemctl is-enabled --quiet "$unit"; then was_enabled=1; fi
fi
changed=0
phase=prepare
ufw_profile_created=0
app=FreedomGate-${row.id}
rollback() {
 if [ "$changed" = 1 ]; then
  systemctl stop "$unit" >/dev/null 2>&1 || true
  if [ "$had_previous" = 1 ]; then
   rm -rf "$dest"; cp -a "$stage/previous" "$dest"
   if [ -f "$stage/unit.previous" ]; then cp -a "$stage/unit.previous" "$unit_path"; else rm -f "$unit_path"; fi
  else
   systemctl disable "$unit" >/dev/null 2>&1 || true
   rm -f "$unit_path"; rm -rf "$dest"
  fi
  systemctl daemon-reload
  if [ "$had_previous" = 1 ]; then
   if [ "$was_enabled" = 1 ]; then systemctl enable "$unit" >/dev/null 2>&1 || true; else systemctl disable "$unit" >/dev/null 2>&1 || true; fi
   if [ "$was_active" = 1 ]; then systemctl start "$unit" || true; fi
  fi
 fi
 if [ "$ufw_profile_created" = 1 ]; then
  ufw delete allow "$app" >/dev/null 2>&1 || true
  rm -f "/etc/ufw/applications.d/$app"
 fi
}
trap 'result=$?; if [ "$result" -ne 0 ]; then rollback; printf "FREEDOMGATE_VPN_ERROR:%s\\n" "$phase"; fi; rm -rf "$stage"' EXIT
trap 'exit 1' HUP INT TERM
printf '%s' '${payload}' | base64 -d > "$stage/payload.json"
phase=download
python3 - "$stage" <<'PREPARE'
import sys,json,pathlib,urllib.request,hashlib,zipfile,io
folder=pathlib.Path(sys.argv[1]);data=json.loads((folder/'payload.json').read_text())
request=urllib.request.Request(data['url'],headers={'User-Agent':'FreedomGate'})
with urllib.request.urlopen(request,timeout=45) as response: blob=response.read(134217729)
if len(blob)>134217728 or hashlib.sha256(blob).hexdigest()!=data['sha256']:raise ValueError('Invalid Xray archive.')
with zipfile.ZipFile(io.BytesIO(blob)) as archive:
 member=archive.getinfo('xray')
 if member.file_size>134217728:raise ValueError('Invalid Xray binary.')
 (folder/'xray').write_bytes(archive.read(member))
(folder/'config.json').write_text(json.dumps(data['config']))
(folder/'unit').write_text(data['unit'])
PREPARE
phase=config
chmod 755 "$stage/xray"
"$stage/xray" run -test -config "$stage/config.json" >/dev/null 2>&1
phase=port
# Stop only the installation owned by this deployment before testing its port.
if [ "$had_previous" = 1 ]; then changed=1; systemctl stop "$unit"; fi
python3 - "$stage" <<'PORTCHECK'
import socket,json,pathlib,sys
data=json.loads((pathlib.Path(sys.argv[1])/'payload.json').read_text());sockets=[]
try:
 for kind in ([socket.SOCK_STREAM,socket.SOCK_DGRAM] if data['udp'] else [socket.SOCK_STREAM]):
  sock=socket.socket(socket.AF_INET6 if data['family']==6 else socket.AF_INET,kind);sockets.append(sock);sock.bind(('::' if data['family']==6 else '0.0.0.0',data['port']))
finally:
 for sock in sockets:sock.close()
PORTCHECK
phase=service
getent passwd freedomgate-vpn >/dev/null || useradd --system --user-group --home /nonexistent --shell /usr/sbin/nologin freedomgate-vpn
changed=1
install -d -m 750 -o root -g freedomgate-vpn "$dest"
install -m 755 "$stage/xray" "$dest/xray.next"
mv -f "$dest/xray.next" "$dest/xray"
install -m 640 -o root -g freedomgate-vpn "$stage/config.json" "$dest/config.json"
printf '%s' "$owner" > "$dest/owner"
install -m 644 "$stage/unit" "$unit_path"
systemctl daemon-reload
systemctl enable --now "$unit" >/dev/null 2>&1
systemctl restart "$unit"
sleep 2
systemctl is-active --quiet "$unit"
phase=firewall
# Preserve firewall policy: add only a new, uniquely labelled application rule.
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
 mkdir -p /etc/ufw/applications.d
 if [ ! -e "/etc/ufw/applications.d/$app" ]; then
 ufw_profile_created=1
 cat > "/etc/ufw/applications.d/$app" <<'UFWPROFILE'
[FreedomGate-${row.id}]
title=FreedomGate VPN
description=Owned FreedomGate VPN listener
ports=${row.publicPort}/${row.protocol==='shadowsocks'?'tcp|'+row.publicPort+'/udp':'tcp'}
UFWPROFILE
 fi
 ufw allow "$app" >/dev/null
fi
printf 'FREEDOMGATE_VPN_INSTALLED\\n'
`;
}
export async function provisionVpn(row,{ssh=withSsh,progress=()=>{}}={}){
 return ssh(row,async run=>{
  progress('checking');const platform=(await run(vpnProbeScript)).trim();
  if(!['linux-amd64','linux-arm64'].includes(platform))throw new AccessPointError('Supported VPS: Debian 12/13 or Ubuntu 22.04/24.04/26.04, ARM64 or x86-64.');
  progress('installing');const output=await run(vpnInstallScript(row,platform),{timeout:180000,maxOutput:8192,errors:{download:'Could not download or verify Xray on the VPS.',config:'The VPS rejected the VPN configuration.',port:'The VPN port is already in use on the VPS.',service:'The VPN service could not start on the VPS.',firewall:'The VPS firewall rule could not be installed.'}});
  if(!output.includes('FREEDOMGATE_VPN_INSTALLED'))throw new AccessPointError('VPN server installation did not complete.',502);
  progress('verifying');return {platform};
 });
}
