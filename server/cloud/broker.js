// Cloud control plane. Public registration never receives an SSH credential.
// Each instance owns one frps process, token and pair of listener ports.
import https from 'node:https';
import net from 'node:net';
import {cloudSshUser,cloudSshGroup,cloudSshPort,validEd25519Key,cloudAuthorizedKeys} from './ssh-policy.js';
import {readFileSync,writeFileSync,mkdirSync,renameSync,existsSync,readdirSync,chmodSync,chownSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const validIdentity = body => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body?.id || '') && /^[a-f0-9]{64}$/.test(body?.credential || '');
const digest=value=>createHash('sha256').update(value).digest();
export function tenantTLS(host){
 const folder=mkdtempSync(join(tmpdir(),'fg-cloud-cert-'));
 try{execFileSync('openssl',['req','-x509','-newkey','ed25519','-nodes','-days','3650','-keyout',join(folder,'key'),'-out',join(folder,'cert'),'-subj','/CN=FreedomGate Relay','-addext','subjectAltName=IP:'+host],{stdio:'ignore'});return {tlsCert:readFileSync(join(folder,'cert'),'utf8'),tlsKey:readFileSync(join(folder,'key'),'utf8')};}
 finally{rmSync(folder,{recursive:true,force:true});}
}
function probePublicPort(port){
 return new Promise((resolve,reject)=>{
  const socket=net.connect(port,'127.0.0.1');
  socket.once('connect',()=>{socket.destroy();resolve(true);});
  socket.once('error',error=>{socket.destroy();if(error.code==='ECONNREFUSED')resolve(false);else reject(error);});
  socket.setTimeout(1500,()=>socket.destroy(Error('Cloud relay status timed out')));
 });
}
export async function probeRelayPort(row){
 const results=await Promise.allSettled([row.publicPort,row.vlessPort].filter(Boolean).map(probePublicPort));
 if(results.some(result=>result.status==='fulfilled' && result.value))return true;
 const error=results.find(result=>result.status==='rejected');if(error)throw error.reason;
 return false;
}
export class CloudRegistry {
 constructor({dir,host,certificate,key,firstPort=20000,capacity=100,start,probe=probeRelayPort}={}){
  Object.assign(this,{dir,host,certificate,key,firstPort,capacity,start,probe});mkdirSync(dir,{recursive:true,mode:0o700});
 }
 allocatePort(rows,count=1){
  const used=new Set(rows.flatMap(row=>[row.publicPort,row.transportPort,row.vlessPort].filter(Boolean)));
  const end=Math.min(65535,this.firstPort+this.capacity*3-1);
  for(let port=this.firstPort;port+count-1<=end;port++)if(Array.from({length:count},(_,i)=>port+i).every(p=>!used.has(p)))return port;
  throw Object.assign(Error('Capacity reached'),{status:503});
 }
 invite(token,{instanceId=null}={}){
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(token))throw Error('Invalid cloud access token');
  const dir=join(this.dir,'invitations');mkdirSync(dir,{recursive:true,mode:0o700});
  const path=join(dir,digest(token).toString('hex')+'.json');
  writeFileSync(path,JSON.stringify({instanceId}),{mode:0o600,flag:'wx'});
 }
 authorize(body){
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(body.accessToken || ''))throw Object.assign(Error('Invalid cloud access token'),{status:403});
  const path=join(this.dir,'invitations',digest(body.accessToken).toString('hex')+'.json');let invitation;
  try{invitation=JSON.parse(readFileSync(path));}catch{throw Object.assign(Error('Invalid cloud access token'),{status:403});}
  if(invitation.instanceId && invitation.instanceId!==body.id)throw Object.assign(Error('Cloud access token is already assigned'),{status:403});
  return ()=>{if(!invitation.instanceId){writeFileSync(path+'.next',JSON.stringify({instanceId:body.id}),{mode:0o600});renameSync(path+'.next',path);}};
 }
 async status(body){
  if(!validIdentity(body))throw Object.assign(Error('Invalid identity'),{status:400});
  this.authorize(body);let row;
  try{row=JSON.parse(readFileSync(join(this.dir,body.id+'.json')));}catch{throw Object.assign(Error('Cloud instance not found'),{status:404});}
  if(!timingSafeEqual(digest(body.credential),Buffer.from(row.credentialHash,'hex')))throw Object.assign(Error('Unauthorized'),{status:403});
  return {id:row.id,occupied:await this.probe(row)};
 }
 enroll(body){
  if(!validIdentity(body) || body.vlessReality!==undefined && typeof body.vlessReality!=='boolean' || body.sshPublicKey!==undefined && !validEd25519Key(body.sshPublicKey))throw Object.assign(Error('Invalid identity'),{status:400});
  const claim=this.authorize(body);
  const path=join(this.dir,body.id+'.json');let row;
  if(existsSync(path)){
   row=JSON.parse(readFileSync(path));
   if(!timingSafeEqual(digest(body.credential),Buffer.from(row.credentialHash,'hex')))throw Object.assign(Error('Unauthorized'),{status:403});
  }else{
   const rows=readdirSync(this.dir).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(readFileSync(join(this.dir,name))));
   if(rows.length>=this.capacity)throw Object.assign(Error('Capacity reached'),{status:503});
   const port=this.allocatePort(rows,2);
   row={id:body.id,credentialHash:digest(body.credential).toString('hex'),host:this.host,publicPort:port,transportPort:port+1,token:randomBytes(32).toString('hex'),...tenantTLS(this.host)};
   writeFileSync(path+'.next',JSON.stringify(row),{mode:0o600});renameSync(path+'.next',path);
  }
  if(body.vlessReality && !row.vlessPort){const rows=readdirSync(this.dir).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(readFileSync(join(this.dir,name))));row.vlessPort=this.allocatePort(rows);writeFileSync(path+'.next',JSON.stringify(row),{mode:0o600});renameSync(path+'.next',path);}
  claim();
  if(body.sshPublicKey && row.sshPublicKey!==body.sshPublicKey){row.sshPublicKey=body.sshPublicKey;writeFileSync(path+'.next',JSON.stringify(row),{mode:0o600});renameSync(path+'.next',path);}
  // Idempotent: a lost HTTP response does not allocate a new port or token.
  const capabilities=this.start(row);
  const {credentialHash,tlsKey,sshPublicKey,...publicRow}=row;return {...publicRow,...(capabilities?.ssh?{ssh:capabilities.ssh}:{})};
 }
}
export function relayConfig(row){return {udpPacketSize:65535,bindAddr:'0.0.0.0',bindPort:row.transportPort,allowPorts:[{single:row.publicPort},...(row.vlessPort?[{single:row.vlessPort}]:[])],maxPortsPerClient:row.vlessPort?3:2,auth:{method:'token',token:row.token,additionalScopes:['HeartBeats','NewWorkConns']},transport:{tls:{force:true,certFile:'tls.crt',keyFile:'tls.key'},heartbeatTimeout:15},log:{level:'error'},detailedErrorsToClient:false};}
export function systemRelayStarter({dir,certificate,key,sshHostKey,sshPort=cloudSshPort}){
 return row=>{
  const name=cloudSshUser(row.id),folder=join(dir,row.id),unit='freedomgate-cloud-'+row.id+'.service';
  const configChanged=existsSync(join(folder,'frps.json')) && readFileSync(join(folder,'frps.json'),'utf8')!==JSON.stringify(relayConfig(row));
  {
   try{execFileSync('id',['-u',name],{stdio:'ignore'});}catch{execFileSync('useradd',['--system','--home-dir','/nonexistent','--shell','/usr/sbin/nologin',name]);}
   const uid=Number(execFileSync('id',['-u',name])),gid=Number(execFileSync('id',['-g',name]));
   mkdirSync(folder,{recursive:true,mode:0o700});chmodSync(folder,0o700);
   for(const [file,value] of Object.entries({'frps.json':JSON.stringify(relayConfig(row)),'tls.crt':row.tlsCert,'tls.key':row.tlsKey})){
    writeFileSync(join(folder,file),value,{mode:0o400});chownSync(join(folder,file),uid,gid);
   }
   chownSync(folder,uid,gid);chmodSync(folder,0o500);
   const source=`[Unit]\nDescription=FreedomGate isolated cloud relay\nAfter=network-online.target\n[Service]\nUser=${name}\nGroup=${name}\nWorkingDirectory=${folder}\nExecStart=/opt/freedomgate-cloud/frps -c ${folder}/frps.json\nRestart=always\nRestartSec=3\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nTasksMax=64\nMemoryMax=96M\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n`;
   writeFileSync('/etc/systemd/system/'+unit,source,{mode:0o644});execFileSync('systemctl',['daemon-reload']);
  }
  execFileSync('systemctl',['enable','--now',unit],{stdio:'ignore',timeout:15000});
  if(configChanged)execFileSync('systemctl',['restart',unit],{stdio:'ignore',timeout:15000});
  return provisionCloudSsh(row,{sshHostKey,sshPort});
 };
}

export function provisionCloudSsh(row,{sshHostKey,sshPort=cloudSshPort}={}){
 if(!validEd25519Key(sshHostKey))return;
 const name=cloudSshUser(row.id);
 try{execFileSync('id',['-u',name],{stdio:'ignore'});}catch{execFileSync('useradd',['--system','--home-dir','/nonexistent','--shell','/usr/sbin/nologin',name]);}
 execFileSync('usermod',['-a','-G',cloudSshGroup,name]);
 const keys='/etc/freedomgate-cloud/ssh-authorized-keys';mkdirSync(keys,{recursive:true,mode:0o755});chmodSync(keys,0o755);
 writeFileSync(join(keys,name),cloudAuthorizedKeys(row),{mode:0o644});chmodSync(join(keys,name),0o644);
 return {ssh:{username:name,port:sshPort,hostKey:sshHostKey}};
}

export function createBroker(registry,{key,cert}={}){
 const rates=new Map();
 const server=https.createServer({key,cert,minVersion:'TLSv1.2'},async(req,res)=>{
  const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  if(req.method!=='POST'||!['/v1/enroll','/v1/status'].includes(req.url))return send(404,{error:'Not found'});
  const ip=req.socket.remoteAddress,now=Date.now(),rate=rates.get(ip);
  if(rate && rate.until>now && rate.count>=20)return send(429,{error:'Try later'});
  rates.set(ip,rate && rate.until>now?{...rate,count:rate.count+1}:{until:now+60000,count:1});
  if(rates.size>10000)for(const [ip,rate] of rates)if(rate.until<=now)rates.delete(ip);
  try{
   let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>2048)return send(413,{error:'Too large'});}
   let body;try{body=JSON.parse(data);}catch{return send(400,{error:'Invalid JSON'});}
   send(200,req.url==='/v1/status'?await registry.status(body):registry.enroll(body));
  }catch(error){send(error.status || 503,{error:error.status?error.message:'Relay unavailable'});}
 });
 server.maxConnections=128;server.requestTimeout=10000;server.headersTimeout=10000;return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const dir=process.env.FG_CLOUD_STATE || '/var/lib/freedomgate-cloud',host=process.env.FG_CLOUD_HOST;
 if(!net.isIP(host || ''))throw Error('Set FG_CLOUD_HOST to the public cloud IP address.');
 const certificate=readFileSync('/etc/freedomgate-cloud/tls.crt','utf8'),key=readFileSync('/etc/freedomgate-cloud/tls.key','utf8');
 // Tenant users must be able to traverse the parent, but not list other tenants.
 chmodSync(dir,0o711);mkdirSync(join(dir,'relays'),{recursive:true,mode:0o711});chmodSync(join(dir,'relays'),0o711);
 const sshHostKey=process.env.FG_CLOUD_SSH==='1'?readFileSync('/etc/ssh/ssh_host_ed25519_key.pub','utf8').trim().split(/\s+/).slice(0,2).join(' '):null;
 mkdirSync(join(dir,'registry'),{recursive:true,mode:0o700});
 if(sshHostKey){for(const file of readdirSync(join(dir,'registry')).filter(name=>name.endsWith('.json'))){provisionCloudSsh(JSON.parse(readFileSync(join(dir,'registry',file))),{sshHostKey});}}
 const registry=new CloudRegistry({dir:join(dir,'registry'),host,certificate,key,start:systemRelayStarter({dir:join(dir,'relays'),certificate,key,sshHostKey})});
 createBroker(registry,{key,cert:certificate}).listen(Number(process.env.FG_CLOUD_PORT || 7443),'0.0.0.0');
}
