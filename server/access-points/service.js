import {cloudSshAvailable,createCloudSshIdentity} from './cloud-ssh.js';
import {validDownloadGateways} from '../resource-fetch.js';
import {assertNoAccessPointGateway} from '../gateway-recursion.js';
import {AccessPointTraffic} from './traffic.js';
import {policyUsers,accessUsername} from './identity.js';
import {randomUUID,randomBytes} from 'node:crypto';
import {managedPoint,MANAGED_ID,enrollManaged,managedHost,managedSshCapability,managedEndpoint,normalizeCloudAddress} from './managed.js';
import {dirname} from 'node:path';
import {isIP} from 'node:net';
import {existsSync} from 'node:fs';
import {AccessPointRepository} from './repository.js';
import {newServer,normalizeServer,publicServer,AccessPointError,clientConfig,createRealityIdentity,defaultCloudRealityName,normalizeRealityName} from './model.js';
import {inspectHost,withSsh,fingerprint} from './ssh.js';
import {provision} from './provision.js';
import {AccessPointRuntime} from './runtime.js';
export class AccessPointService{
 constructor(store,{stateDir=process.env.FREEDOMGATE_STATE_DIR || dirname(process.env.FREEDOMGATE_DB || '.data/freedomgate.sqlite'),runtime,install=provision,inspect=inspectHost,prepare=async()=>{},enroll=enrollManaged,gateways=()=>[],sshCapability=managedSshCapability,managedEndpoint,normalizeCloudAddress}={}){
  this.traffic=new AccessPointTraffic(store.db);this.connections=()=>({available:false,connections:[]});this.identities=new Map();
  this.repository=new AccessPointRepository(store.db,{stateDir});this.runtime=runtime || new AccessPointRuntime({stateDir});this.install=install;this.inspect=inspect;this.prepare=prepare;this.jobs=new Map();this.connecting=new Map();this.connectAttempts=new Map();this.transportGateways=new Map();this.gateways=gateways;this.sshCapability=sshCapability;this.sshTransports=new Set();this.closed=false;this.enroll=enroll;this.runtime.onTraffic=(id,generation,users)=>this.traffic.observe(id,generation,users);
  store.validateGateway=snapshot=>assertNoAccessPointGateway(snapshot,this.repository.all());
  this.metricsTimer=setInterval(()=>Promise.allSettled([...this.runtime.entries?.keys?.() || []].map(id=>this.runtime.sample(id))),2000);this.metricsTimer.unref();
  if(!this.repository.all().some(point=>point.id===MANAGED_ID))this.repository.save(managedPoint());
 }
 async list(){
  this.describe([]);const rows=this.repository.all().sort((a,b)=>Number(!!b.managed)-Number(!!a.managed));return Promise.all(rows.map(async server=>{const value=publicServer(server);if(server.managed)value.cloudAddress=managedEndpoint(server);const live=this.connections();const counters=this.traffic.clients(server.id);value.traffic=this.traffic.total(server.id);value.clients=value.clients.map(client=>({...client,traffic:counters[client.id] || {upload:0,download:0},online:server.enabled && client.enabled?(live.available?live.connections.some(row=>row.active && row.inboundName==='fg-remote' && row.inboundUser===accessUsername(server.id,client.id)):null):false}));value.activeClients=server.enabled?(live.available?value.clients.filter(client=>client.online).length:null):0;if(server.enabled && !this.jobs.has(server.id)){const state=await this.runtime.status(server.id);if(server.managed)value.connectionTransport=this.runtime.entries?.get(server.id)?.transport || null;value.state=state==='stopped'&&server.error?'error':state;value.stage=null;}return value;}));
 }
 async moduleState(){
  if(!this.runtime.frpc)return 'unknown';
  if(!existsSync(this.runtime.frpc))return 'unavailable';
  const states=await Promise.all([...this.runtime.entries.keys()].map(id=>this.runtime.status(id).catch(()=> 'unknown')));
  return ['error','unknown','connecting','active'].find(state=>states.includes(state)) || 'stopped';
 }
 describe(connections){for(const [key,value] of this.repository.all().flatMap(point=>point.clients.map(client=>[accessUsername(point.id,client.id),{accessPointId:point.id,accessPointName:point.name,accessClientId:client.id,sourceKind:'device',sourceName:client.name,clientOnline:true}])))this.identities.set(key,value);const registry=this.identities;return connections.map(row=>row.inboundName==='fg-remote' && registry.has(row.inboundUser)?{...row,...registry.get(row.inboundUser)}:row);}
 async remoteClients(){return (await this.list()).filter(point=>!point.managed || point.configured).flatMap(point=>point.clients.map(client=>({id:client.id,accessPointId:point.id,accessPointName:point.name,hostname:client.name,ip:'',mac:'',expiresAt:null,staticIp:null,online:client.online,traffic:client.traffic,remote:true})));}
 inspectHost(input){return this.inspect(input);}
 create(input){
  const server=newServer(input);
  if(this.repository.all().some(other=>other.host===server.host))throw new AccessPointError("This VPS is already added.");
  return this.repository.save(server);
 }
 busy(id,{allowConnectionCancel=false}={}){if(this.clientUpdates?.has(id))throw new AccessPointError("Access point is busy.",409);if(this.jobs.has(id) && !(allowConnectionCancel && this.connecting.has(id)))throw new AccessPointError(this.connecting.has(id)?'Access point is busy.':'Installation is already running.',409);}
 async mutatePoint(id,action,options){
  this.busy(id,options);this.clientUpdates ||= new Set();this.clientUpdates.add(id);
  try{return await action();}finally{this.clientUpdates.delete(id);}
 }
 async startRuntime(server,options={}){
  let gateway=options.gateway;
  if(!Object.hasOwn(options,'gateway') && server.managed){
   const selected=this.transportGateways.get(server.id);
   gateway=validDownloadGateways(this.gateways()).find(row=>row.id===selected);
  }
  return this.runtime.start(server,{gateway,ssh:options.ssh ?? (server.managed && this.sshTransports.has(server.id)),signal:options.signal});
 }
 async syncPolicy(){
  const servers=this.repository.all().filter(server=>server.enabled).map(server=>server.managed&&!server.host?{...server,host:managedHost(server)}:server).filter(server=>server.host);
  await this.prepare(servers.filter(server=>isIP(server.host)).map(server=>server.host+'/'+(isIP(server.host)===6?128:32)),policyUsers(servers));
 }
 installServer(id){
  this.busy(id);const server=this.repository.get(id);if(server.managed)return this.connectManaged(server);server.state='installing';server.stage='checking';server.error=null;this.repository.save(server);
  const task=(async()=>{
   try{
    const result=await this.install(server,{progress:stage=>{server.stage=stage;this.repository.save(server);}});
    server.platform=result.platform;server.enabled=true;server.stage='connecting';server.state='connecting';this.repository.save(server);
    await this.syncPolicy();await this.startRuntime(server);server.stage=null;this.repository.save(server);
   }catch(error){server.state='error';server.error=error instanceof AccessPointError?error.message:'Unable to set up the access point.';this.repository.save(server);}
   finally{this.jobs.delete(id);}
  })();this.jobs.set(id,task);return publicServer(server);
 }
 connectManaged(server){
  if(this.connecting.has(server.id))return publicServer(this.repository.get(server.id));
  const connection={controller:new AbortController()},signal=connection.controller.signal;
  const current=()=>!this.closed && !signal.aborted && this.connecting.get(server.id)===connection && this.repository.get(server.id).enabled;
  server.enabled=true;server.state='connecting';server.stage='connecting';server.error=null;this.repository.save(server);
  this.connecting.set(server.id,connection);this.connectAttempts.set(server.id,Date.now());
  const task=Promise.resolve().then(async()=>{
   let abort;
   const activate=async()=>{
    const candidates=[{gateway:null,ssh:false},...(this.runtime.supportsCloudSsh && cloudSshAvailable(server)?[{gateway:null,ssh:true}]:[]),...validDownloadGateways(this.gateways()).map(gateway=>({gateway,ssh:false}))];
    for(const {gateway,ssh} of candidates){
     if(!current())return false;
     try{
      await this.syncPolicy();if(!current())return false;
      await this.startRuntime(server,{gateway,ssh,signal});connection.gatewayId=gateway?.id || null;connection.ssh=ssh;
      const ready=this.runtime.waitActive?await this.runtime.waitActive(server.id,{signal}):true;
      if(!current()){await this.runtime.stop(server.id);return false;}
      if(!ready)continue;
      if(ssh)this.sshTransports.add(server.id);else this.sshTransports.delete(server.id);
      if(gateway)this.transportGateways.set(server.id,gateway.id);else this.transportGateways.delete(server.id);
      server.stage=null;server.error=null;this.repository.save(server);return true;
     }catch{if(!current()){await this.runtime.stop(server.id);return false;}}
    }
    return false;
   };
   try{
    signal.throwIfAborted();
    const enroll=async()=>{
     await this.syncPolicy();if(!current())return false;
     const cancelled=new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
     const row=await Promise.race([this.enroll(server,{signal,gateways:validDownloadGateways(this.gateways())}),cancelled]).finally(()=>signal.removeEventListener('abort',abort));
     if(!current())return false;
     Object.assign(server,{host:row.host,publicPort:row.publicPort,transportPort:row.transportPort,platform:'managed',...(row.vlessPort?{vlessPort:row.vlessPort}:{})});
     Object.assign(server.secrets,{token:row.token,tlsCert:row.tlsCert,cloudSshRegisteredKey:server.secrets.cloudSshPublicKey,...(row.ssh?{cloudSsh:row.ssh}:{})});this.repository.save(server);return true;
    };
    if(this.runtime.supportsCloudVlessReality){let changed=false;if(!server.secrets.realityPrivate || !server.secrets.realityPublic || !server.secrets.shortId){Object.assign(server.secrets,createRealityIdentity());changed=true;}if(!server.serverName){server.serverName=defaultCloudRealityName;changed=true;}if(changed)this.repository.save(server);}
    if(this.runtime.supportsCloudSsh && !server.secrets.cloudSshPrivateKey){const identity=await createCloudSshIdentity();Object.assign(server.secrets,{cloudSshPrivateKey:identity.privateKey,cloudSshPublicKey:identity.publicKey});this.repository.save(server);}
    if(this.runtime.supportsCloudSsh && !server.secrets.cloudSsh){const capability=this.sshCapability(server);if(capability){server.secrets.cloudSsh=capability;this.repository.save(server);}}
    // A configured relay does not require the enrollment service on every restart.
    const cached=isIP(server.host || '') && Number.isInteger(server.publicPort) && server.publicPort>0 && server.publicPort<=65535 && Number.isInteger(server.transportPort) && server.transportPort>0 && server.transportPort<=65535 && server.publicPort!==server.transportPort && /^[a-f0-9]{64}$/.test(server.secrets.token || '') && server.secrets.tlsCert?.startsWith('-----BEGIN CERTIFICATE-----');
    if(cached && this.runtime.supportsCloudVlessReality && !server.vlessPort){try{if(!await enroll())return;}catch{if(!current())return;}}
    if(cached && (!this.runtime.supportsCloudSsh || server.secrets.cloudSshRegisteredKey===server.secrets.cloudSshPublicKey)){try{if(await activate())return;}catch{if(!current())return;}}
    if(!await enroll())return;
    if(!await activate())throw Error('Cloud relay is unavailable');
   }catch(error){
    if(current()){
     let active=false;try{active=await this.runtime.status(server.id)==='active';}catch{}
     if(current()){if(active){if(connection.ssh)this.sshTransports.add(server.id);else this.sshTransports.delete(server.id);if(connection.gatewayId)this.transportGateways.set(server.id,connection.gatewayId);else this.transportGateways.delete(server.id);}server.state=active?'active':'error';server.stage=null;server.error=active?null:error instanceof AccessPointError?error.message:"The cloud server is temporarily unavailable. The connection will recover automatically.";this.repository.save(server);}
    }
   }
   finally{
    if(abort)signal.removeEventListener('abort',abort);
    if(this.connecting.get(server.id)===connection)this.connecting.delete(server.id);
    if(this.jobs.get(server.id)===task)this.jobs.delete(server.id);
   }
  });connection.task=task;this.jobs.set(server.id,task);return publicServer(server);
 }
 async configureCloud(id,input){
  return this.mutatePoint(id,async()=>{
   const server=this.repository.get(id);
   if(!server.managed)throw new AccessPointError('Not a cloud access point.');
   if(!input?.enabled && !String(input?.address || '').trim() && !String(input?.token || '').trim())return this.changeEnabled(id,false);
   const address=normalizeCloudAddress(input?.address),token=String(input?.token || '').trim(),enabled=input?.enabled===true;
   if(token && !/^[A-Za-z0-9_-]{32,256}$/.test(token))throw new AccessPointError('Enter a valid cloud access token.');
   const serverName=normalizeRealityName(input?.serverName ?? server.serverName ?? defaultCloudRealityName),nameChanged=serverName!==(server.serverName || defaultCloudRealityName);
   const addressChanged=address!==managedEndpoint(server);
   const credentialsChanged=addressChanged || !!token && token!==server.secrets.cloudAccessToken;
   if((enabled || credentialsChanged) && !token && (!server.secrets.cloudAccessToken || addressChanged))throw new AccessPointError('Enter the cloud access token.');
   // Saving an unchanged form must not disconnect all clients.
   if(!credentialsChanged && !nameChanged)return this.changeEnabled(id,enabled);
   await this.changeEnabled(id,false);
   const updated=this.repository.get(id);updated.cloudAddress=address;updated.serverName=serverName;
   if(token)updated.secrets.cloudAccessToken=token;
   if(credentialsChanged)delete updated.secrets.cloudSshRegisteredKey;
   if(addressChanged){for(const key of ['token','tlsCert','cloudSsh'])delete updated.secrets[key];delete updated.host;delete updated.publicPort;delete updated.transportPort;delete updated.vlessPort;}
   this.repository.save(updated);
   return enabled?this.changeEnabled(id,true):publicServer(updated);
  },{allowConnectionCancel:true});
 }
 updateCredentials(id,input){
  this.busy(id);const server=this.repository.get(id);
  if(server.managed)throw new AccessPointError("Built-in access point settings are managed automatically.",403);
  const checked=normalizeServer({...server,username:input.username,sshPort:input.sshPort,fingerprint:input.fingerprint});
  if(fingerprint(input.hostKey)!==input.fingerprint)throw new AccessPointError('SSH fingerprint mismatch.');
  server.username=checked.username;server.sshPort=checked.sshPort;server.fingerprint=input.fingerprint;server.hostKey=input.hostKey;
  if(input.sshKey){server.secrets.sshKey=input.sshKey;server.secrets.sshPassphrase=String(input.sshPassphrase || '');}
  return this.repository.save(server);
 }
 async setEnabled(id,enabled){
  return this.mutatePoint(id,()=>this.changeEnabled(id,enabled),{allowConnectionCancel:!enabled});
 }
 async changeEnabled(id,enabled){
  const server=this.repository.get(id);
  if(server.enabled===enabled && (!enabled || await this.runtime.status(id)==='active'))return publicServer(server);
  if(server.managed && enabled)return this.connectManaged(server);
  if(enabled && !server.secrets.tlsCert)throw new AccessPointError('Install the VPS relay first.');
  server.enabled=enabled;server.state=enabled?'connecting':'stopped';if(!enabled)server.stage=null;server.error=null;this.repository.save(server);
  if(!enabled){this.connectAttempts.delete(id);this.transportGateways.delete(id);this.sshTransports.delete(id);const connection=this.connecting.get(id);if(connection){connection.controller.abort();await connection.task;}await this.runtime.stop(id);}
  await this.syncPolicy();
  if(enabled)await this.startRuntime(server);
  return publicServer(server);
 }
 async saveClients(id,input){
  this.busy(id);this.clientUpdates ||= new Set();
  if(this.clientUpdates.has(id))throw new AccessPointError("Access point is busy.",409);
  const previous=this.repository.get(id),server=structuredClone(previous),seen=new Set();
  if(!Array.isArray(input?.clients) || input.clients.length>100)throw new AccessPointError('Maximum 100 clients per access point.');
  server.clients=input.clients.map(item=>{
   const name=String(item?.name || '').trim();
   if(!name || name.length>100)throw new AccessPointError("Enter a client name up to 100 characters.");
   if(item.id){
    const old=previous.clients.find(client=>client.id===item.id);
    if(!old || seen.has(item.id))throw new AccessPointError('Client not found.',400);
    seen.add(item.id);return {...old,name,enabled:item.enabled!==false};
   }
   return {id:randomUUID(),name,enabled:item.enabled!==false,createdAt:new Date().toISOString(),...(server.protocol==='shadowsocks'?{password:randomBytes(32).toString('base64url')}:{})};
  });
  this.clientUpdates.add(id);
  try{
   this.repository.save(server);
   if(server.enabled){await this.syncPolicy();await this.startRuntime(server);}
   return this.repository.save(server);
  }catch(error){
   this.repository.save(previous);
   if(previous.enabled){try{await this.syncPolicy();await this.startRuntime(previous);}catch{}}
   throw error;
  }finally{this.clientUpdates.delete(id);}
 }
 async addClient(id,input){
  return this.mutatePoint(id,async()=>{
  const server=this.repository.get(id),name=String(input?.name || '').trim();
  if(!name || name.length>100)throw new AccessPointError("Enter a client name up to 100 characters.");
  if(server.clients.length>=100)throw new AccessPointError('Maximum 100 clients per access point.');
  const client={id:randomUUID(),name,...(server.protocol==='shadowsocks'?{password:randomBytes(32).toString('base64url')}:{}),enabled:true,createdAt:new Date().toISOString()};server.clients.push(client);
  this.repository.save(server);if(server.enabled){await this.syncPolicy();await this.startRuntime(server);}
  this.repository.save(server);return {id:client.id,name,enabled:true,createdAt:client.createdAt};
  });
 }
 async changeClient(id,clientId,input,{remove=false}={}){
  return this.mutatePoint(id,async()=>{
  const server=this.repository.get(id),client=server.clients.find(client=>client.id===clientId);
  if(!client)throw new AccessPointError('Client not found.',404);
  if(remove)server.clients=server.clients.filter(client=>client.id!==clientId);else{
   if(Object.hasOwn(input,'name')){const name=String(input.name || '').trim();if(!name || name.length>100)throw new AccessPointError("Enter a client name up to 100 characters.");client.name=name;}
   if(Object.hasOwn(input,'enabled'))client.enabled=input.enabled===true;
  }
  this.repository.save(server);if(server.enabled){await this.syncPolicy();await this.startRuntime(server);}return this.repository.save(server);
  });
 }
 exportClient(id,clientId){
  const server=this.repository.get(id),client=server.clients.find(client=>client.id===clientId);
  if(!client || !client.enabled)throw new AccessPointError('Client is disabled or not found.',404);
  return clientConfig(server,client);
 }
 async remove(id){
  return this.mutatePoint(id,async()=>{
  const server=this.repository.get(id);
  if(server.managed)throw new AccessPointError("Built-in access points can only be disabled.",403);
  if(server.secrets.tlsCert)await withSsh(server,async run=>run(`set -eu\nif [ ! -e /etc/freedomgate-relay ]; then exit 0; fi\n[ "$(cat /etc/freedomgate-relay/owner)" = '${server.id}' ]\nsystemctl disable --now freedomgate-relay.service >/dev/null 2>&1\nrm -f /etc/systemd/system/freedomgate-relay.service\nrm -rf /etc/freedomgate-relay /opt/freedomgate-relay\nsystemctl daemon-reload\n`));
  await this.runtime.stop(id);this.repository.remove(id);await this.syncPolicy();return {ok:true};
  });
 }
 async restore(){
  // Interrupted installations must never appear ready after restart.
  for(const server of this.repository.all()){
   if(server.state==='installing'){server.state='error';server.stage=null;server.error='Installation was interrupted. Retry to continue.';this.repository.save(server);}
  }
  await this.syncPolicy();
  await Promise.all(this.repository.all().filter(server=>server.enabled).map(server=>server.managed?Promise.resolve(this.connectManaged(server)):this.startRuntime(server).catch(()=>{})));
  this.timer=setInterval(()=>this.reconcile().catch(()=>{}),15000);this.timer.unref();
 }
 async reconcile(){
  if(this.reconciling || this.closed)return;this.reconciling=true;
  try{for(const server of this.repository.all().filter(server=>server.enabled&&!this.jobs.has(server.id)&&!this.clientUpdates?.has(server.id))){const state=await this.runtime.status(server.id);if(this.jobs.has(server.id)||this.clientUpdates?.has(server.id))continue;if(['error','stopped'].includes(state) || server.managed && state==='connecting' && Date.now()-(this.connectAttempts.get(server.id) || 0)>=30000){const current=this.repository.get(server.id);if(!current.enabled)continue;if(current.managed)this.connectManaged(current);else await this.mutatePoint(current.id,()=>this.startRuntime(this.repository.get(current.id))).catch(()=>{});}}}
  finally{this.reconciling=false;}
 }
 async close(){this.closed=true;clearInterval(this.timer);clearInterval(this.metricsTimer);for(const connection of this.connecting.values())connection.controller.abort();await Promise.allSettled(this.jobs.values());await this.runtime.close();}
}
