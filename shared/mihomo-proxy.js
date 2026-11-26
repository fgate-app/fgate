import {parseDocument} from 'yaml';
import {mihomoSchema} from './mihomo-schema.js';
export const mihomoTypes=Object.keys(mihomoSchema);
export const nativePrefix='mihomo:';
const common={type:'string',name:'string',udp:'boolean',tfo:'boolean',mptcp:'boolean','ip-version':'string',smux:'object'};
const owned=new Set(['dialer-proxy','interface-name','routing-mark','state-dir','provider-name','planet']);
const forbidden=new Set(['__proto__','prototype','constructor']);
const fail=()=>{throw Error('Invalid mihomo proxy configuration.');};
function inspect(value,depth=0){
 if(depth>16)fail();
 if(value===null || typeof value==='string' || typeof value==='boolean')return;
 if(typeof value==='number'){if(!Number.isFinite(value))fail();return;}
 if(Array.isArray(value)){if(value.length>2000)fail();value.forEach(v=>inspect(v,depth+1));return;}
 if(!value || typeof value!=='object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail();
 for(const [key,v] of Object.entries(value)){
  if(forbidden.has(key) || owned.has(key) || /(?:^|[-_])(?:file|path-file)$/.test(key))throw Error('External files and runtime routing options are not allowed in a proxy.');
  if(['certificate','ca','cert','tls-auth','tls-crypt','tls-crypt-v2'].includes(key) && typeof v==='string' && v && !v.includes('-----BEGIN '))throw Error('Use inline keys and certificates instead of file paths.');
  if(depth>0 && key==='private-key' && typeof v==='string' && v && !v.includes('-----BEGIN '))throw Error('Use inline keys and certificates instead of file paths.');
  inspect(v,depth+1);
 }
}
export function normalizeMihomoProxy(input){
 inspect(input);
 if(!input || Array.isArray(input) || !Object.hasOwn(mihomoSchema,input.type))throw Error('Unsupported mihomo proxy type.');
 const p=JSON.parse(JSON.stringify(input)),schema={...common,...mihomoSchema[p.type]};
 for(const [key,value] of Object.entries(p)){
  const expected=schema[key];
  if(!expected)throw Error('Unknown mihomo proxy option: '+key);
  const actual=Array.isArray(value)?'array':value===null?'null':typeof value;
  if(actual!==expected)throw Error('Invalid mihomo proxy option: '+key);
  if(expected==='number' && !Number.isSafeInteger(value))throw Error('Invalid mihomo proxy option: '+key);
 }
 if(p.type==='easytier'){
  if(p.listeners?.length || p['mapped-listeners']?.length || p['proxy-networks']?.length || p['enable-exit-node']===true || p['no-listener']===false)throw Error('External files and runtime routing options are not allowed in a proxy.');
  p['no-listener']=true;
 }
 if(p['private-key'] && !['wireguard','masque','easytier'].includes(p.type) && !p['private-key'].includes('-----BEGIN '))throw Error('Use inline keys and certificates instead of file paths.');
 if(p.type==='openvpn' && p.key && !p.key.includes('-----BEGIN '))throw Error('Use inline keys and certificates instead of file paths.');
 if(!['tailscale','zerotier','easytier'].includes(p.type)){
  if(p.type==='wireguard' && p.peers?.length){if(p.peers.some(peer=>typeof peer.server!=='string' || !Number.isInteger(peer.port) || peer.port<1 || peer.port>65535))fail();}
  else if(typeof p.server!=='string' || !p.server || /[\s/?#@]/.test(p.server) || !Number.isInteger(p.port) || p.port<1 || p.port>65535)throw Error('Specify a server and a port from 1 to 65535.');
 }
 const required={ss:['cipher','password'],ssr:['cipher','password','protocol','obfs'],vmess:['uuid'],vless:['uuid'],trojan:['password'],snell:['psk'],anytls:['password'],mieru:['username','password'],shadowquic:['username','password'],ssh:['username'],sudoku:['key'],masque:['private-key','public-key'],trusttunnel:['username','password'],wireguard:['private-key'],zerotier:['network']};
 for(const key of required[p.type] || [])if(typeof p[key]!=='string' || !p[key].trim())throw Error('Missing mihomo proxy option: '+key);
 if(p.type==='tuic' && !p.token && !(p.uuid && p.password))throw Error('TUIC requires a token or UUID and password.');
 if(p.type==='ssh' && !p.password && !p['private-key'])throw Error('SSH requires a password or inline private key.');
 if(p.type==='hysteria2' && !p.password)throw Error('Missing mihomo proxy option: password');
 if(p.type==='masque' && p.network!=='h3-l4proxy' && !p.ip && !p.ipv6)throw Error('Specify the MASQUE interface address.');
 if(p.type==='hysteria2' && p['hop-interval'] && !/^\d+(?:-\d+)?$/.test(p['hop-interval']))throw Error('Invalid mihomo proxy option: hop-interval');
 if(p.type==='wireguard'){
  const validKey=value=>typeof value==='string' && /^[A-Za-z0-9+/]{43}=$/.test(value);
  if(!validKey(p['private-key']) || (p.peers?.length?p.peers.some(peer=>!validKey(peer['public-key']) || peer['pre-shared-key'] && !validKey(peer['pre-shared-key'])):!validKey(p['public-key'])) || p['pre-shared-key'] && !validKey(p['pre-shared-key']))throw Error('Invalid WireGuard keys.');
  if(!p.ip && !p.ipv6)throw Error('Specify the WireGuard interface address.');
 }
 if(p.type==='openvpn' && (!p.ca || !(p.cert && p.key) && !(p.username && p.password)))throw Error('OpenVPN requires a CA and credentials or a client certificate and key.');
 if(p.name!==undefined)delete p.name;
 return p;
}
export function parseMihomoDocument(text){
 let root;
 try{const doc=parseDocument(text,{uniqueKeys:true,schema:'core'});if(doc.errors.length)fail();root=doc.toJS({maxAliasCount:20});}catch{throw Error('Invalid YAML or JSON configuration.');}
 if(!root || typeof root!=='object')throw Error('Unknown format. Supported: proxy links, mihomo YAML/JSON, OpenVPN and WireGuard.');
 const rows=Array.isArray(root)?root:root?.proxies ?? (root?.type?[root]:null);
 if(!Array.isArray(rows) || !rows.length || rows.length>200)throw Error('Specify one proxy or a list of up to 200 proxies.');
 return rows.map(node=>{normalizeMihomoProxy(node);return JSON.stringify({mihomo:node});});
}
function decode64(value){try{return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)));}catch{throw Error('Invalid proxy link encoding.');}}
export const nativeLinkPattern=/^(trojan|vmess|ssr|tuic|hysteria|anytls|http|https|ssh):\/\//i;
export function parseMihomoLink(link){
 if(/^vmess:\/\//i.test(link)){
  let data;try{data=JSON.parse(decode64(link.slice(8).split('#')[0]));}catch{throw Error('Invalid VMess link.');}
  const p={type:'vmess',name:data.ps || '',server:data.add,port:Number(data.port),uuid:data.id,alterId:Number(data.aid || 0),cipher:data.scy || 'auto',tls:data.tls==='tls',network:data.net || 'tcp',udp:true};
  if(data.tls && data.tls!=='tls')throw Error('Unsupported VMess link transport.');
  if(data.type && !['none','http'].includes(data.type))throw Error('Unsupported VMess link transport.');
  if(data.type==='http' && p.network==='tcp')p.network='http';
  if(data.allowInsecure!==undefined){if(![true,false,0,1,'0','1','true','false'].includes(data.allowInsecure))throw Error('Invalid VMess link.');p['skip-cert-verify']=[true,1,'1','true'].includes(data.allowInsecure);}
  if(data.sni)p.servername=data.sni;
  if(data.alpn)p.alpn=String(data.alpn).split(',');
  if(data.fp)p['client-fingerprint']=data.fp;
  if(p.network==='ws')p['ws-opts']={path:data.path || '/',headers:{Host:data.host || data.add}};
  else if(p.network==='grpc')p['grpc-opts']={'grpc-service-name':data.path || ''};
  else if(!['tcp','http','h2'].includes(p.network))throw Error('Unsupported VMess link transport.');
  if(p.network==='h2')p['h2-opts']={host:[data.host || data.add],path:data.path || '/'};
  if(p.network==='http')p['http-opts']={path:[data.path || '/'],headers:{Host:[data.host || data.add]}};
  normalizeMihomoProxy(p);return p;
 }
 if(/^ssr:\/\//i.test(link)){
  const raw=decode64(link.slice(6)),[main,query='']=raw.split('/?'),match=/^(.*):(\d+):([^:]+):([^:]+):([^:]+):([^:]*)$/.exec(main);
  if(!match)throw Error('Invalid ShadowsocksR link.');const q=new URLSearchParams(query);
  for(const key of q.keys())if(q.getAll(key).length>1)throw Error('Invalid proxy link parameter: '+key);
  for(const key of q.keys())if(!['remarks','group','obfsparam','protoparam'].includes(key))throw Error('Unsupported proxy link parameter: '+key);
  const p={type:'ssr',server:match[1].replace(/^\[|\]$/g,''),port:Number(match[2]),protocol:match[3],cipher:match[4],obfs:match[5],password:decode64(match[6]),udp:true};
  for(const [source,target] of [['remarks','name'],['obfsparam','obfs-param'],['protoparam','protocol-param']])if(q.has(source))p[target]=decode64(q.get(source));
  normalizeMihomoProxy(p);return p;
 }
 let u;try{u=new URL(link);}catch{throw Error('Invalid proxy link.');}
 const scheme=u.protocol.slice(0,-1).toLowerCase(),q=u.searchParams;
 for(const key of q.keys())if(q.getAll(key).length>1)throw Error('Invalid proxy link parameter: '+key);
 if(u.pathname && u.pathname!=='/')throw Error('Unsupported proxy link transport.');
 const p={type:scheme==='https'?'http':scheme,name:decodeURIComponent(u.hash.slice(1)),server:u.hostname.replace(/^\[|\]$/g,''),port:Number(u.port || (scheme==='http'?80:scheme==='ssh'?22:443))};
 const decode=value=>decodeURIComponent(value);
 if(['http','https','ssh'].includes(scheme)){if(u.username)p.username=decode(u.username);if(u.password)p.password=decode(u.password);if(scheme==='https')p.tls=true;}
 else if(scheme==='tuic'){if(u.password){p.uuid=decode(u.username);p.password=decode(u.password);}else p.token=decode(u.username);}
 else if(scheme==='hysteria'){if(q.has('auth'))p['auth-str']=q.get('auth');}
 else p.password=decode(u.username)+(u.password?':'+decode(u.password):'');
 const strings={sni:'sni',peer:'sni',alpn:'alpn',fp:'client-fingerprint',obfs:'obfs',upmbps:'up',downmbps:'down',protocol:'protocol',congestion_control:'congestion-controller',udp_relay_mode:'udp-relay-mode'};
 const allowed=new Set([...Object.keys(strings),'insecure','allowInsecure','allow_insecure','type','path','host','serviceName','auth','security']);
 if(q.has('security') && q.get('security')!=='tls')throw Error('Unsupported proxy link transport.');
 if(q.has('security')){if(scheme==='http')p.tls=true;else if(scheme==='ssh')throw Error('Unsupported proxy link parameter: security');}
 if(q.has('auth') && scheme!=='hysteria')throw Error('Unsupported proxy link parameter: auth');
 for(const [key,value] of q){if(!allowed.has(key))throw Error('Unsupported proxy link parameter: '+key);if(strings[key])p[strings[key]]=key==='alpn'?value.split(','):value;}
 for(const key of ['insecure','allowInsecure','allow_insecure'])if(q.has(key)){if(!['0','1','true','false'].includes(q.get(key)))throw Error('Invalid proxy link parameter: '+key);p['skip-cert-verify']=['1','true'].includes(q.get(key));}
 if(['path','host','serviceName'].some(key=>q.has(key)) && !q.has('type'))throw Error('Unsupported proxy link transport.');
 if((q.has('path') || q.has('host')) && q.get('type')!=='ws' || q.has('serviceName') && q.get('type')!=='grpc')throw Error('Unsupported proxy link transport.');
 if(q.has('type')){p.network=q.get('type');if(p.network==='ws')p['ws-opts']={path:q.get('path') || '/',headers:{Host:q.get('host') || p.server}};else if(p.network==='grpc')p['grpc-opts']={'grpc-service-name':q.get('serviceName') || ''};else if(p.network!=='tcp')throw Error('Unsupported proxy link transport.');}
 normalizeMihomoProxy(p);return p;
}

const primary=['server','port','username','password','uuid','token','cipher','psk','protocol','obfs','sni','servername','tls','skip-cert-verify','udp','private-key','public-key','ip','ipv6','auth-str','up','down','transport','key','network','network-name','network-secret','hostname','auth-key','exit-node'];
export function mihomoFields(type){return primary.filter(key=>Object.hasOwn(mihomoSchema[type] || {},key)).concat('options');}
export function mihomoDraft(node){
 const p=normalizeMihomoProxy(node),fields=mihomoFields(p.type),draft={};
 for(const key of fields)if(key!=='options')draft[key]=p[key]===undefined?'':String(p[key]);
 const options=Object.fromEntries(Object.entries(p).filter(([key])=>key!=='type' && !fields.includes(key)));
 draft.options=JSON.stringify(options,null,2);return draft;
}
export function mihomoFromDraft(type,draft){
 let options;try{options=JSON.parse(draft.options || '{}');}catch{throw Error('Advanced proxy options must be a JSON object.');}
 if(!options || Array.isArray(options) || typeof options!=='object')throw Error('Advanced proxy options must be a JSON object.');
 if(Object.keys(options).some(key=>key==='type' || key==='name' || mihomoFields(type).includes(key)))throw Error('Set basic proxy options in their dedicated fields.');
 const node={...options,type};
 for(const key of mihomoFields(type)){
  if(key==='options' || draft[key]===undefined || draft[key]==='')continue;
  const kind=mihomoSchema[type][key],value=draft[key];
  if(kind==='boolean' && !['true','false'].includes(value))throw Error('Invalid mihomo proxy option: '+key);
  node[key]=kind==='boolean'?value==='true':kind==='number'?Number(value):value;
 }
 return normalizeMihomoProxy(node);
}
