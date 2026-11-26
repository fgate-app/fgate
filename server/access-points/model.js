import {isIP} from 'node:net';
import {randomBytes,randomUUID,generateKeyPairSync} from 'node:crypto';
export const outlinePrefix='16030100a80101';
export class AccessPointError extends Error{constructor(message,status=400){super(message);this.status=status;}}
export const defaultCloudRealityName='www.gstatic.com';
export function normalizeRealityName(value){
 const name=String(value || '').trim().toLowerCase();
 if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name))throw new AccessPointError('Enter a valid REALITY server name.');
 return name;
}
export function normalizeServer(input){
 const name=String(input?.name || '').trim(),host=String(input?.host || '').trim(),username=String(input?.username || 'root').trim();
 const sshPort=Number(input?.sshPort || 22),transportPort=Number(input?.transportPort || 7443),publicPort=Number(input?.publicPort || 443);
 if(!name || name.length>100)throw new AccessPointError("Specify a name of up to 100 characters.");
 if(!isIP(host))throw new AccessPointError("Enter the VPS IP address.");
 if(!/^[a-z_][a-z0-9_-]{0,31}$/i.test(username))throw new AccessPointError("Enter a valid SSH username.");
 if(![sshPort,transportPort,publicPort].every(port=>Number.isInteger(port)&&port>=1&&port<=65535) || new Set([sshPort,transportPort,publicPort]).size!==3)throw new AccessPointError("SSH, tunnel and VPN ports must differ.");
 const serverName=normalizeRealityName(input?.serverName || 'www.microsoft.com');
 const fingerprint=String(input?.fingerprint || '');
 if(!/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint))throw new AccessPointError("Confirm the SSH host fingerprint.");
 return {name,host,username,sshPort,transportPort,publicPort,serverName,protocol:'vless'};
}
export function createRealityIdentity(){
 const keys=generateKeyPairSync('x25519');
 return {realityPrivate:keys.privateKey.export({format:'jwk'}).d,realityPublic:keys.publicKey.export({format:'jwk'}).x,shortId:randomBytes(8).toString('hex')};
}
export function cloudRealityAvailable(server){return !!(server.managed && Number.isInteger(server.vlessPort) && server.vlessPort>=1024 && server.vlessPort<=65535 && server.secrets.realityPrivate && server.secrets.realityPublic && server.secrets.shortId && server.serverName);}
export function newServer(input){
 const settings=normalizeServer(input);
 return {...settings,id:randomUUID(),createdAt:new Date().toISOString(),state:'draft',enabled:false,stage:null,error:null,fingerprint:input.fingerprint,hostKey:input.hostKey,clients:[],secrets:{token:randomBytes(32).toString('hex'),...createRealityIdentity(),sshKey:input.sshKey,sshPassphrase:typeof input.sshPassphrase==='string'?input.sshPassphrase.slice(0,1024):''}};
}
export function publicServer(server){
 const {secrets,hostKey,clients,...settings}=server;
 if(server.managed){const {host,publicPort,transportPort,platform,...visible}=settings;return {...visible,cloudAddress:server.cloudAddress || '',hasCloudToken:!!secrets.cloudAccessToken,serverName:server.serverName || defaultCloudRealityName,protocols:['shadowsocks',...(cloudRealityAvailable(server)?['vless-reality']:[])],configured:!!server.host,instanceId:secrets.instanceId,clients:clients.map(({id,name,enabled,createdAt})=>({id,name,enabled,createdAt}))};}
 return {...settings,clients:clients.map(({id,name,enabled,createdAt})=>({id,name,enabled,createdAt}))};
}
export function clientLink(server,client){
 if(server.protocol==='shadowsocks'){if(!server.host || !server.publicPort)throw new AccessPointError("Enable cloud access first.");return `ss://${Buffer.from('chacha20-ietf-poly1305:'+client.password).toString('base64url')}@${server.host}:${server.publicPort}/?outline=1&prefix=${encodeURIComponent('\x16\x03\x01\x00\u00a8\x01\x01')}#${encodeURIComponent(client.name)}`;}
 const query=new URLSearchParams({encryption:'none',security:'reality',sni:server.serverName,fp:'chrome',pbk:server.secrets.realityPublic,sid:server.secrets.shortId,type:'tcp',flow:'xtls-rprx-vision',...(server.managed?{'support-x25519mlkem768':'true'}:{})});
 const host=isIP(server.host)===6?'['+server.host+']':server.host;
 return `vless://${client.id}@${host}:${server.publicPort}?${query}#${encodeURIComponent(client.name)}`;
}
export function clientConfig(server,client){
 if(server.protocol==='shadowsocks'){const base={link:clientLink(server,client)};if(cloudRealityAvailable(server))base.alternatives=[{protocol:'vless-reality',...clientConfig({...server,protocol:'vless',publicPort:server.vlessPort},client)}];return base;}
 return {link:clientLink(server,client),mihomo:{'mixed-port':7890,mode:'rule',tun:{enable:true,stack:'system','auto-route':true,'auto-detect-interface':true},dns:{enable:true,'enhanced-mode':'fake-ip',nameserver:['udp://10.255.255.53:53#FreedomGate']},proxies:[{name:'FreedomGate',type:'vless',server:server.host,port:server.publicPort,uuid:client.id,network:'tcp',udp:true,'packet-encoding':'xudp',tls:true,servername:server.serverName,flow:'xtls-rprx-vision','client-fingerprint':'chrome','reality-opts':{'public-key':server.secrets.realityPublic,'short-id':server.secrets.shortId,...(server.managed?{'support-x25519mlkem768':true}:{})}}],rules:['MATCH,FreedomGate']}};
}
