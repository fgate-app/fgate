import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {randomUUID,randomBytes} from 'node:crypto';
import {AccessPointError} from './model.js';
import {validCloudSsh} from '../cloud/ssh-policy.js';
import {validDownloadGateways} from '../resource-fetch.js';
import {connectGatewayTcp} from '../gateway-tunnel.js';
import {cloudSshAvailable,startCloudSsh} from './cloud-ssh.js';
export const MANAGED_ID='freedomgate-cloud';
export function managedPoint(){
 return {id:MANAGED_ID,managed:true,name:'Облачный доступ',protocol:'shadowsocks',enabled:false,state:'stopped',stage:null,error:null,clients:[{id:randomUUID(),name:'FreedomGate',enabled:true,createdAt:new Date().toISOString(),password:randomBytes(32).toString('base64url')}],secrets:{instanceId:randomUUID(),credential:randomBytes(32).toString('hex')},createdAt:new Date().toISOString()};
}
export function managedEndpoint(server){return server?.cloudAddress || '';}
export function managedHost(server){const endpoint=managedEndpoint(server);return endpoint?new URL(endpoint).hostname:'';}
export function normalizeCloudAddress(value){
 let url;try{url=new URL(String(value || '').trim());}catch{throw new AccessPointError('Enter a valid HTTPS cloud address.');}
 if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || url.pathname!=='/')throw new AccessPointError('Enter a valid HTTPS cloud address.');
 return url.origin;
}
export function managedSshCapability(server){const capability=server.secrets?.cloudSsh;return validCloudSsh(capability,server.secrets.instanceId)?capability:null;}
async function cloudRequest(server,config,{signal,gateway,sshTransport,operation}){
 const endpoint=new URL(config.endpoint);let socket,agent;
 const abort=()=>socket?.destroy();signal?.addEventListener('abort',abort,{once:true});
 try{
  signal?.throwIfAborted();
  if(gateway){const up=await connectGatewayTcp({port:gateway.port,username:'fg-geo',password:gateway.secret},1,{address:endpoint.hostname,port:Number(endpoint.port)||443},s=>{socket=s;if(signal?.aborted)s.destroy();});socket=up.socket;}
  if(sshTransport){socket=net.connect(sshTransport.enrollmentPort,'127.0.0.1');await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);socket.once('close',()=>reject(Error('Cloud SSH connection closed')));if(signal?.aborted)socket.destroy();});}
  if(socket){agent=new https.Agent();agent.createConnection=options=>tls.connect({...options,socket,ca:config.certificate,servername:net.isIP(endpoint.hostname)?'':endpoint.hostname,rejectUnauthorized:true});}
  return await new Promise((resolve,reject)=>{
   const request=https.request(config.endpoint+'/v1/'+operation,{method:'POST',ca:config.certificate,...(agent?{agent}:{}),headers:{'Content-Type':'application/json'},timeout:5000,signal},response=>{
    let data='';response.on('error',reject);response.on('data',chunk=>{data+=chunk;if(data.length>16384)request.destroy(Error('Cloud response is too large'));});response.on('end',()=>{
     try{if(response.statusCode===403){reject(new AccessPointError('Cloud access token was rejected.',403));return;}if(response.statusCode!==200)throw Error();const row=JSON.parse(data);
      if(operation==='status'){if(row.id!==server.secrets.instanceId || typeof row.occupied!=='boolean')throw Error();resolve(row);return;}
      if(row.id!==server.secrets.instanceId || (!net.isIP(row.host) || net.isIP(endpoint.hostname) && row.host!==endpoint.hostname) || ![row.publicPort,row.transportPort].every(port=>Number.isInteger(port)&&port>=1024&&port<=65535) || row.publicPort===row.transportPort || row.vlessPort!==undefined && (!Number.isInteger(row.vlessPort) || row.vlessPort<1024 || row.vlessPort>65535 || [row.publicPort,row.transportPort].includes(row.vlessPort)) || !/^[a-f0-9]{64}$/.test(row.token) || typeof row.tlsCert!=='string' || !row.tlsCert.startsWith('-----BEGIN CERTIFICATE-----') || row.ssh!==undefined && !validCloudSsh(row.ssh,server.secrets.instanceId))throw Error();
      resolve(row);
     }catch{reject(Error('Invalid cloud enrollment response'));}
    });
   });
   request.on('timeout',()=>request.destroy(Error('Cloud enrollment timed out')));request.on('error',reject);
   request.end(JSON.stringify({id:server.secrets.instanceId,credential:server.secrets.credential,accessToken:server.secrets.cloudAccessToken,...(operation==='enroll' && server.secrets.realityPrivate?{vlessReality:true}:{}),...(server.secrets.cloudSshPublicKey?{sshPublicKey:server.secrets.cloudSshPublicKey}:{})}));
  });
 }finally{signal?.removeEventListener('abort',abort);agent?.destroy();socket?.destroy();}
}
export const enrollManaged=(server,options)=>managedOperation(server,options,'enroll');
export const checkManagedCloud=(server,options)=>managedOperation(server,options,'status');
async function managedOperation(server,{signal,gateways=[],config,sshConnector=startCloudSsh,onAttempt=()=>{}}={},operation){
 if(!config || server.cloudAddress && server.cloudAddress!==new URL(config.endpoint).origin)config={endpoint:normalizeCloudAddress(managedEndpoint(server))};
 if(!server.secrets.cloudAccessToken)throw new AccessPointError('Enter the cloud access token.');
 const paths=[null,...(cloudSshAvailable(server)?[{ssh:true}]:[]),...validDownloadGateways(gateways).slice(0,8)];
 for(const path of paths){
  signal?.throwIfAborted();let sshTransport;const transport=path?.ssh?'ssh':path?'gateway':'direct';onAttempt({transport,gatewayId:path?.id || null,state:'started'});
  try{
   const attempt=signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000);
   if(path?.ssh)sshTransport=await sshConnector(server,{stateDir:tmpdir(),signal:attempt});
   const row=await cloudRequest(server,config,{signal:attempt,gateway:path?.ssh?null:path,sshTransport,operation});onAttempt({transport,gatewayId:path?.id || null,state:'completed'});return row;
  }catch(error){if(error instanceof AccessPointError && error.status===403)throw error;onAttempt({transport,gatewayId:path?.id || null,state:'failed',reason:error.code || error.name});if(signal?.aborted)throw signal.reason;}
  finally{await sshTransport?.close();}
 }
 throw new AccessPointError('The cloud server is temporarily unavailable.',502);
}
