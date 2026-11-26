import {isIP} from 'node:net';
import {randomUUID,randomBytes,generateKeyPairSync} from 'node:crypto';
import {AccessPointError} from '../access-points/model.js';
import {fingerprint} from '../access-points/ssh.js';
export function newDeployment(input){
 const name=String(input.name || '').trim(),host=String(input.host || '').trim(),username=String(input.username || 'root').trim();
 const sshPort=Number(input.sshPort ?? 22),publicPort=Number(input.publicPort ?? 443),protocol=input.protocol;
 if(!name || name.length>100)throw new AccessPointError('Specify a name of up to 100 characters.');
 if(!isIP(host))throw new AccessPointError('Enter the VPS IP address.');
 if(!/^[a-z_][a-z0-9_-]{0,31}$/i.test(username))throw new AccessPointError('Enter a valid SSH username.');
 if(![sshPort,publicPort].every(port=>Number.isInteger(port)&&port>0&&port<=65535) || sshPort===publicPort)throw new AccessPointError('SSH and VPN ports must differ.');
 if(!['vless','shadowsocks'].includes(protocol))throw new AccessPointError('Select a supported VPN protocol.');
 const serverName=String(input.serverName || 'www.microsoft.com').trim().toLowerCase();
 if(protocol==='vless' && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(serverName))throw new AccessPointError('Enter a valid REALITY server name.');
 const credentials=sshCredentials(input),keys=generateKeyPairSync('x25519');
 return {id:randomUUID(),name,host,username,sshPort,publicPort,protocol,serverName:protocol==='vless'?serverName:null,hostKey:input.hostKey,fingerprint:input.fingerprint,createdAt:new Date().toISOString(),state:'pending',stage:'checking',profileId:null,error:null,secrets:{...credentials,realityPrivate:keys.privateKey.export({format:'jwk'}).d,realityPublic:keys.publicKey.export({format:'jwk'}).x,shortId:randomBytes(8).toString('hex'),clientId:randomUUID(),password:randomBytes(32).toString('base64url')}};
}
export function sshCredentials(input){
 if(fingerprint(input.hostKey)!==input.fingerprint)throw new AccessPointError('SSH fingerprint mismatch.');
 if(typeof input.sshKey!=='string' || input.sshKey.length>32768 || !input.sshKey.includes('PRIVATE KEY-----'))throw new AccessPointError('Enter the SSH private key.');
 if(typeof input.sshPassphrase==='string' && input.sshPassphrase.length>1024)throw new AccessPointError('SSH passphrase is too long.');
 return {sshKey:input.sshKey,sshPassphrase:String(input.sshPassphrase || '')};
}
export function publicDeployment(row){return Object.fromEntries(['id','name','host','username','sshPort','publicPort','protocol','serverName','fingerprint','createdAt','state','stage','profileId','error','platform'].map(key=>[key,row[key] ?? null]));}
export function deploymentLink(row){
 const host=isIP(row.host)===6?'['+row.host+']':row.host;
 if(row.protocol==='shadowsocks')return `ss://${Buffer.from('chacha20-ietf-poly1305:'+row.secrets.password).toString('base64url')}@${host}:${row.publicPort}#${encodeURIComponent(row.name)}`;
 const query=new URLSearchParams({encryption:'none',security:'reality',sni:row.serverName,fp:'chrome',pbk:row.secrets.realityPublic,sid:row.secrets.shortId,type:'tcp',flow:'xtls-rprx-vision'});
 return `vless://${row.secrets.clientId}@${host}:${row.publicPort}?${query}#${encodeURIComponent(row.name)}`;
}
