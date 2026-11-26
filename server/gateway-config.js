import {normalizeHysteria2} from '../shared/hysteria2.js';
import {isIP} from 'node:net';
const fail=message=>{throw new Error(message);};
const key=value=>typeof value==='string' && /^[A-Za-z0-9+/]{43}=$/.test(value);
export function normalizeNativeProxy(input) {
 const p=structuredClone(input);
 if(p?.type==='hysteria2')return normalizeHysteria2(p);
 if(!p || !['wireguard','openvpn'].includes(p.type))fail("Unsupported connection type.");
 if(typeof p.server!=='string' || !p.server || /[\s/]/.test(p.server) || !Number.isInteger(p.port) || p.port<1 || p.port>65535)fail("Enter a server and a port from 1 to 65535.");
 if(p.mtu!==undefined && (!Number.isInteger(p.mtu) || p.mtu<576 || p.mtu>65535))fail("Invalid MTU.");
 const common=['type','server','port','udp'];
 let allowed;
 if(p.type==='wireguard'){
  if(!key(p['private-key']) || !key(p['public-key']) || (p['pre-shared-key'] && !key(p['pre-shared-key'])))fail("Invalid WireGuard keys.");
  if((p.ip && isIP(p.ip)!==4) || (p.ipv6 && isIP(p.ipv6)!==6))fail("Invalid WireGuard interface address.");
  if(!isIP(p.ip || '') && !isIP(p.ipv6 || ''))fail("Specify the WireGuard interface address.");
  if(p['allowed-ips'] && (!Array.isArray(p['allowed-ips']) || p['allowed-ips'].some(c=>{const [ip,n,...rest]=String(c).split('/');return rest.length || !isIP(ip) || n===undefined || !/^\d+$/.test(n) || Number(n)>(isIP(ip)===4?32:128);})))fail("Invalid AllowedIPs.");
  allowed=['private-key','public-key','pre-shared-key','ip','ipv6','allowed-ips','mtu'];
 }else{
  if(!['udp','tcp'].includes(p.proto))fail("Specify the OpenVPN protocol: UDP or TCP.");
  for(const f of ['ca','cert','key','tls-auth','tls-crypt','tls-crypt-v2'])if(p[f] && !String(p[f]).includes('-----BEGIN '))fail("OpenVPN requires embedded certificates and keys.");
  if(!p.ca || (!(p.cert && p.key) && !(p.username && p.password)))fail("OpenVPN requires a CA and either a client certificate and key or a username and password.");
  for(const f of ['ping','ping-restart'])if(p[f]!==undefined && (!Number.isInteger(p[f]) || p[f]<0))fail("Invalid OpenVPN interval.");
  allowed=['proto','ca','cert','key','tls-auth','tls-crypt','tls-crypt-v2','key-direction','username','password','cipher','auth','data-ciphers','data-ciphers-fallback','comp-lzo','ping','ping-restart','mtu'];
 }
 return Object.fromEntries([...common,...allowed].filter(k=>p[k]!==undefined && p[k]!=='').map(k=>[k,p[k]]));
}
export function parseWireGuard(value){
 const sections={}; let current;
 for(const raw of value.split(/\r?\n/)){
  const line=raw.replace(/\s*[#;].*$/, '').trim();if(!line)continue;
  const section=/^\[(\w+)\]$/.exec(line);
  if(section){if(sections[section[1]])fail("Only one WireGuard peer is supported.");current=sections[section[1]]={};continue;}
  const entry=/^([\w]+)\s*=\s*(.*)$/.exec(line);if(!current || !entry)fail("Invalid WireGuard configuration.");current[entry[1]]=entry[2];
 }
 const i=sections.Interface || {},p=sections.Peer || {},endpoint=/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(p.Endpoint || '');
 if(!endpoint)fail("Specify a WireGuard endpoint with a port.");
 const addresses=(i.Address || '').split(',').map(a=>a.trim().split('/')[0]);
 return normalizeNativeProxy({type:'wireguard',server:endpoint[1] || endpoint[2],port:Number(endpoint[3]),'private-key':i.PrivateKey,'public-key':p.PublicKey,'pre-shared-key':p.PresharedKey,ip:addresses.find(a=>isIP(a)===4),ipv6:addresses.find(a=>isIP(a)===6),'allowed-ips':(p.AllowedIPs || '0.0.0.0/0,::/0').split(',').map(a=>a.trim()),...(i.MTU?{mtu:Number(i.MTU)}:{}),udp:true});
}
export function parseOpenVPN(value,credentials={}){
 const p={type:'openvpn',proto:'udp',port:1194,udp:true};
 const body=value.replace(/<(ca|cert|key|tls-auth|tls-crypt|tls-crypt-v2|auth-user-pass)>\s*([\s\S]*?)<\/\1>/g,(_,name,content)=>{if(name==='auth-user-pass'){const [username,password]=content.trim().split(/\r?\n/);Object.assign(p,{username,password});}else p[name]=content.trim();return '';});
 const strings=new Set(['cipher','auth','key-direction','comp-lzo','data-ciphers-fallback']);
 for(const raw of body.split(/\r?\n/)){
  const line=raw.trim();if(!line || /^[#;]/.test(line))continue;
  const [directive,...args]=line.split(/\s+/),v=args.join(' ');
  if(directive==='remote'){if(p.server)fail("Only one OpenVPN remote is supported.");p.server=args[0];p.port=Number(args[1] || 1194);if(args[2])p.proto=args[2].startsWith('tcp')?'tcp':'udp';}
  else if(directive==='proto')p.proto=v.startsWith('tcp')?'tcp':v;
  else if(strings.has(directive))p[directive]=v;
  else if(directive==='data-ciphers')p[directive]=v.split(':');
  else if(['ping','ping-restart','tun-mtu'].includes(directive))p[directive==='tun-mtu'?'mtu':directive]=Number(v);
  else if(['ca','cert','key','tls-auth','tls-crypt','tls-crypt-v2'].includes(directive))fail("Upload an OpenVPN configuration with embedded certificates and keys.");
 }
 if(credentials.username)p.username=credentials.username;
 if(credentials.password)p.password=credentials.password;
 return normalizeNativeProxy(p);
}
