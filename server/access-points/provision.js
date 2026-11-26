import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execute,withSsh} from './ssh.js';
import {AccessPointError} from './model.js';
export const probeScript=`set -eu
[ "$(id -u)" = 0 ]
. /etc/os-release
[ "$ID" = ubuntu ]
case "$VERSION_ID" in 22.04|24.04|26.04) ;; *) exit 2 ;; esac
command -v systemctl >/dev/null
command -v python3 >/dev/null
case "$(uname -m)" in x86_64) echo linux-amd64 ;; aarch64) echo linux-arm64 ;; *) exit 3 ;; esac
`;
export async function tlsIdentity(host){
 const folder=await mkdtemp(join(tmpdir(),'fg-relay-tls-'));
 try{
  const result=await execute('openssl',['req','-x509','-newkey','ed25519','-nodes','-days','3650','-keyout',join(folder,'key'),'-out',join(folder,'cert'),'-subj','/CN=FreedomGate Relay','-addext','subjectAltName=IP:'+host],{timeout:15000});
  if(result.code!==0)throw new AccessPointError('Unable to generate relay TLS certificate.',503);
  return {tlsKey:await readFile(join(folder,'key'),'utf8'),tlsCert:await readFile(join(folder,'cert'),'utf8')};
 }finally{await rm(folder,{recursive:true,force:true});}
}
export function frpsConfig(server){return {bindAddr:'0.0.0.0',bindPort:server.transportPort,allowPorts:[{single:server.publicPort}],maxPortsPerClient:1,auth:{method:'token',token:server.secrets.token,additionalScopes:['HeartBeats','NewWorkConns']},transport:{tls:{force:true,certFile:'/etc/freedomgate-relay/tls.crt',keyFile:'/etc/freedomgate-relay/tls.key'}},log:{level:'error'},detailedErrorsToClient:false};}
const unit=`[Unit]
Description=FreedomGate reverse relay
After=network-online.target
Wants=network-online.target
[Service]
User=freedomgate-relay
Group=freedomgate-relay
ExecStart=/opt/freedomgate-relay/frps -c /etc/freedomgate-relay/frps.json
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
UMask=0077
[Install]
WantedBy=multi-user.target
`;
export function installScript(server,binary){
 const files={'frps':binary.toString('base64'),'frps.json':Buffer.from(JSON.stringify(frpsConfig(server))).toString('base64'),'tls.crt':Buffer.from(server.secrets.tlsCert).toString('base64'),'tls.key':Buffer.from(server.secrets.tlsKey).toString('base64'),'unit':Buffer.from(unit).toString('base64')};
 const payload=Buffer.from(JSON.stringify(files)).toString('base64'),sha=createHash('sha256').update(binary).digest('hex');
 return `set -eu
umask 077
${probeScript}
owner=${server.id}
if [ -e /etc/freedomgate-relay ]; then
 [ -f /etc/freedomgate-relay/owner ] && [ "$(cat /etc/freedomgate-relay/owner)" = "$owner" ] || exit 10
fi
# Never replace an unrelated unit or installation.
if [ -e /etc/systemd/system/freedomgate-relay.service ]; then
 [ -f /etc/freedomgate-relay/owner ] || exit 10
fi
python3 - <<'PORTCHECK'
import socket
for port in [${server.transportPort},${server.publicPort}]:
 s=socket.socket()
 try: s.bind(('0.0.0.0',port))
 except OSError:
  import pathlib
  if not pathlib.Path('/etc/freedomgate-relay/owner').exists(): raise
 finally: s.close()
PORTCHECK
stage=$(mktemp -d /tmp/fg-relay.XXXXXXXX)
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT
printf '%s' '${payload}' | base64 -d > "$stage/payload.json"
python3 - "$stage" <<'UNPACK'
import sys,json,base64,pathlib
folder=pathlib.Path(sys.argv[1])
for name,value in json.loads((folder/'payload.json').read_text()).items():
 (folder/name).write_bytes(base64.b64decode(value))
UNPACK
printf '%s  %s\\n' '${sha}' "$stage/frps" | sha256sum -c - >/dev/null
chmod 755 "$stage/frps"
"$stage/frps" verify -c "$stage/frps.json" >/dev/null 2>&1
had_previous=0
if [ -f /etc/freedomgate-relay/owner ]; then
 had_previous=1
 cp -a /etc/freedomgate-relay "$stage/previous-config"
 cp -a /opt/freedomgate-relay/frps "$stage/previous-frps"
 cp -a /etc/systemd/system/freedomgate-relay.service "$stage/previous-unit"
fi
rollback() {
 systemctl stop freedomgate-relay.service >/dev/null 2>&1 || true
 if [ "$had_previous" = 1 ]; then
  rm -rf /etc/freedomgate-relay
  cp -a "$stage/previous-config" /etc/freedomgate-relay
  cp -a "$stage/previous-frps" /opt/freedomgate-relay/frps
  cp -a "$stage/previous-unit" /etc/systemd/system/freedomgate-relay.service
  systemctl daemon-reload
  systemctl restart freedomgate-relay.service || true
 else
  systemctl disable freedomgate-relay.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/freedomgate-relay.service
  rm -rf /etc/freedomgate-relay /opt/freedomgate-relay
  systemctl daemon-reload
 fi
 cleanup
}
trap 'result=$?; if [ "$result" -ne 0 ]; then rollback; else cleanup; fi' EXIT
trap 'exit 1' HUP INT TERM
getent passwd freedomgate-relay >/dev/null || useradd --system --home /nonexistent --shell /usr/sbin/nologin freedomgate-relay
install -d -m 750 -o root -g freedomgate-relay /etc/freedomgate-relay
install -d -m 755 /opt/freedomgate-relay
install -m 755 "$stage/frps" /opt/freedomgate-relay/frps.next
mv -f /opt/freedomgate-relay/frps.next /opt/freedomgate-relay/frps
for item in frps.json tls.crt tls.key; do install -m 640 -o root -g freedomgate-relay "$stage/$item" "/etc/freedomgate-relay/$item"; done
printf '%s' "$owner" > /etc/freedomgate-relay/owner
install -m 644 "$stage/unit" /etc/systemd/system/freedomgate-relay.service
systemctl daemon-reload
if ! systemctl enable --now freedomgate-relay.service >/dev/null 2>&1 || ! systemctl restart freedomgate-relay.service; then exit 11; fi
sleep 2
if ! systemctl is-active --quiet freedomgate-relay.service; then exit 12; fi
# Extend an enabled UFW only for owned listeners. Cloud security groups are external.
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
 ufw allow ${server.transportPort}/tcp comment 'FreedomGate tunnel' >/dev/null
 ufw allow ${server.publicPort}/tcp comment 'FreedomGate VLESS' >/dev/null
fi
trap - HUP INT TERM
printf 'FREEDOMGATE_RELAY_INSTALLED\\n'
`;
}
export async function provision(server,{ssh=withSsh,progress=()=>{}}={}){
 return ssh(server,async run=>{
  progress('checking');const platform=(await run(probeScript)).trim();
  if(!['linux-amd64','linux-arm64'].includes(platform))throw new AccessPointError('Supported VPS: Ubuntu 22.04/24.04/26.04, amd64/arm64.');
  if(!server.secrets.tlsCert)Object.assign(server.secrets,await tlsIdentity(server.host));
  const binary=await readFile(new URL('./bin/'+platform+'/frps',import.meta.url));
  progress('installing');const output=await run(installScript(server,binary),{timeout:180000});
  if(!output.includes('FREEDOMGATE_RELAY_INSTALLED'))throw new AccessPointError('Relay installation did not complete.',502);
  return {platform};
 });
}
