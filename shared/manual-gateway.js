import {mihomoTypes,nativePrefix,mihomoFields,mihomoFromDraft} from './mihomo-proxy.js';
import {hysteria2Fields,normalizeHysteria2} from './hysteria2.js';
export const proxyTypes=[{value:'vless',label:'VLESS'},{value:'ss',label:'Shadowsocks / Outline'},{value:'socks5',label:'SOCKS5'},{value:'hysteria2',label:'Hysteria 2'},{value:'wireguard',label:'WireGuard'},{value:'openvpn',label:'OpenVPN'}];
export const manualFields={
 hysteria2:hysteria2Fields,
 vless:['server','port','uuid','security','sni','fingerprint','publicKey','shortId','flow','network','path','host','serviceName'],
 ss:['server','port','cipher','password','prefix'],
 socks5:['server','port','username','password'],
 wireguard:['server','port','private-key','public-key','pre-shared-key','ip','ipv6','allowed-ips'],
 openvpn:['server','port','proto','username','password','ca','cert','key','tls-auth','key-direction','tls-crypt','cipher','auth'],
};
const nativeLabels={ss:'Shadowsocks',ssr:'ShadowsocksR',socks5:'SOCKS5',http:'HTTP / HTTPS',vmess:'VMess',vless:'VLESS',snell:'Snell',trojan:'Trojan',hysteria:'Hysteria',hysteria2:'Hysteria 2',wireguard:'WireGuard',tuic:'TUIC',shadowquic:'ShadowQUIC','gost-relay':'Gost Relay',ssh:'SSH',mieru:'Mieru',anytls:'AnyTLS',sudoku:'Sudoku',masque:'MASQUE',trusttunnel:'TrustTunnel',openvpn:'OpenVPN',tailscale:'Tailscale',zerotier:'ZeroTier',easytier:'EasyTier'};
for(const type of mihomoTypes){proxyTypes.push({value:nativePrefix+type,label:nativeLabels[type]+(proxyTypes.some(item=>item.value===type)?' (mihomo)':'')});manualFields[nativePrefix+type]=mihomoFields(type);}
export const fieldLabels={server:'Сервер',port:'Порт',uuid:'UUID',security:'Защита',sni:'SNI',fingerprint:'Fingerprint',publicKey:'Публичный ключ Reality',shortId:'Short ID',flow:'Flow',network:'Транспорт',path:'Путь',host:'Host',serviceName:'Имя сервиса gRPC',prefix:'Prefix (hex)',cipher:'Шифр',password:'Пароль',username:'Логин','private-key':'Приватный ключ','public-key':'Публичный ключ','pre-shared-key':'Preshared key',ip:'IPv4 интерфейса',ipv6:'IPv6 интерфейса','allowed-ips':'AllowedIPs',proto:'Протокол',ca:'CA сертификат',cert:'Сертификат клиента',key:'Приватный ключ клиента','tls-auth':'TLS Auth','key-direction':'Направление ключа','tls-crypt':'TLS Crypt',auth:'Алгоритм аутентификации','skip-cert-verify':'Skip certificate verification',obfs:'Obfuscation','obfs-password':'Obfuscation password'};
Object.assign(fieldLabels,{'psk':'Pre-shared key','token':'Token','protocol':'Protocol','servername':'Server name','tls':'TLS','udp':'UDP','auth-str':'Authentication','up':'Upload bandwidth','down':'Download bandwidth','transport':'Transport','network-name':'Network name','network-secret':'Network secret','hostname':'Hostname','auth-key':'Authentication key','exit-node':'Exit node','skip-cert-verify':'Skip certificate verification'});
export const fieldOptions={obfs:['','salamander'],security:['none','tls','reality'],network:['tcp','raw','ws','grpc','httpupgrade','xhttp','splithttp'],proto:['udp','tcp'],cipher:['chacha20-ietf-poly1305','aes-128-gcm','aes-256-gcm','2022-blake3-aes-128-gcm','2022-blake3-aes-256-gcm'],flow:['','xtls-rprx-vision']};
export function visibleFields(type,draft){return (manualFields[type] || []).filter(f=>{
 if(type==='hysteria2')return f!=='obfs-password' || draft.obfs==='salamander';
 if(type!=='vless')return true;
 if(['sni','fingerprint'].includes(f))return draft.security!=='none';
 if(['publicKey','shortId'].includes(f))return draft.security==='reality';
 if(['path','host'].includes(f))return ['ws','httpupgrade','xhttp','splithttp'].includes(draft.network);
 if(f==='serviceName')return draft.network==='grpc';
 return true;
});}
export function manualConfig(type,draft){
 if(type.startsWith(nativePrefix))return JSON.stringify({mihomo:mihomoFromDraft(type.slice(nativePrefix.length),draft)});
 const port=Number(draft.port),server=String(draft.server || '').trim().replace(/^\[|\]$/g,'');
 if(!server || /[\s/?#@]/.test(server) || !Number.isInteger(port) || port<1 || port>65535)throw new Error(type==='hysteria2'?'Specify a server and a port from 1 to 65535.':"Enter a server and a port from 1 to 65535.");
 if(type==='hysteria2'){
  if(!['',undefined,'true','false'].includes(draft['skip-cert-verify']))throw Error('Invalid Hysteria 2 configuration.');
  return JSON.stringify(normalizeHysteria2({type,server,port,password:draft.password || '',sni:draft.sni || '',fingerprint:draft.fingerprint || '',obfs:draft.obfs || '', 'obfs-password':draft.obfs==='salamander'?(draft['obfs-password'] || ''):'','skip-cert-verify':draft['skip-cert-verify']==='true'}));
 }
 const authority=(server.includes(':')?'['+server+']':server)+':'+port;
 if(type==='vless'){
  if(!draft.uuid?.trim())throw new Error("Enter a UUID.");
  if(draft.security==='reality' && !draft.publicKey?.trim())throw new Error("Enter the Reality public key.");
  const q=new URLSearchParams({security:draft.security || 'none',type:draft.network || 'tcp'});
  for(const [f,k] of Object.entries({sni:'sni',fingerprint:'fp',publicKey:'pbk',shortId:'sid',flow:'flow',path:'path',host:'host',serviceName:'serviceName'}))if(visibleFields(type,draft).includes(f) && draft[f])q.set(k,draft[f]);
  return 'vless://'+encodeURIComponent(draft.uuid)+'@'+authority+'?'+q;
 }
 if(type==='ss'){
  if(!draft.password || !draft.cipher)throw new Error("Enter a cipher and password.");
  if(draft.prefix && !/^(?:[0-9a-fA-F]{2})+$/.test(draft.prefix))throw new Error("Prefix must contain hexadecimal bytes.");
  return 'ss://'+btoa(String.fromCharCode(...new TextEncoder().encode(draft.cipher+':'+draft.password)))+'@'+authority+(draft.prefix?'?prefix='+draft.prefix.match(/../g).map(b=>'%'+b).join(''):'');
 }
 if(type==='socks5')return 'socks5://'+(draft.username?encodeURIComponent(draft.username)+':'+encodeURIComponent(draft.password || '')+'@':'')+authority;
 const p={type,server,port,udp:true};
 for(const f of manualFields[type])if(!['server','port'].includes(f) && draft[f])p[f]=draft[f];
 if(type==='wireguard')p['allowed-ips']=(draft['allowed-ips'] || '0.0.0.0/0, ::/0').split(',').map(v=>v.trim());
 return JSON.stringify(p);
}
