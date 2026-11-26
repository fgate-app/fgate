import {dirname} from 'node:path';
import {AccessPointRepository} from '../access-points/repository.js';
import {AccessPointError} from '../access-points/model.js';
import {inspectHost} from '../access-points/ssh.js';
import {newDeployment,publicDeployment,deploymentLink,sshCredentials} from './model.js';
import {provisionVpn} from './provision.js';
export class GatewayDeploymentService{
 constructor(store,{stateDir=process.env.FREEDOMGATE_STATE_DIR || dirname(process.env.FREEDOMGATE_DB || '.data/freedomgate.sqlite'),inspect=inspectHost,install=provisionVpn,apply=async()=>{}}={}){
  Object.assign(this,{store,inspect,install,apply});this.jobs=new Map();this.closed=false;
  this.repository=new AccessPointRepository(store.db,{stateDir,table:'gateway_deployments',present:publicDeployment,notFound:'VPN deployment not found.'});
  for(const row of this.repository.all())if(['pending','installing'].includes(row.state)){row.state='error';row.stage=null;row.error='VPN deployment was interrupted. Reconnect with SSH and retry.';delete row.secrets.sshKey;delete row.secrets.sshPassphrase;this.repository.save(row);}
 }
 list(){return this.repository.list().reverse();}
 key(id){const row=this.repository.get(id);if(row.state!=='completed')throw new AccessPointError('Finish deploying the VPN before exporting its key.',409);return {link:deploymentLink(row)};}
 get(id){return publicDeployment(this.repository.get(id));}
 create(input){
  if(this.closed)throw new AccessPointError('VPN deployment service is shutting down.',503);
  const row=newDeployment(input);
  if(this.repository.all().some(other=>other.host===row.host && other.publicPort===row.publicPort))throw new AccessPointError('A VPN deployment already uses this VPS port. Resume that deployment or choose another port.',409);
  if(this.jobs.size>=2)throw new AccessPointError('Wait for a VPN deployment to finish.',409);
  this.repository.save(row);return this.start(row);
 }
 retry(id,input){
  const row=this.repository.get(id);
  if(row.state==='completed')throw new AccessPointError('This VPN is already deployed.',409);
  if(this.jobs.has(id))throw new AccessPointError('VPN deployment is already running.',409);
  if(input.hostKey!==row.hostKey || input.fingerprint!==row.fingerprint)throw new AccessPointError('SSH fingerprint mismatch.');
  Object.assign(row.secrets,sshCredentials(input));return this.start(row);
 }
 findImportedProfile(row){
  const link=deploymentLink(row);
  for(const profile of this.store.profiles()){
   const config=this.store.profileSnapshot(profile.id)?.config;
   if(row.protocol==='shadowsocks' && config?.engine==='outline' && config.config===link)return profile.id;
   if(row.protocol==='vless' && config?.engine==='xray')try{const peers=JSON.parse(config.config).outbounds?.flatMap(outbound=>outbound.settings?.vnext || []);if(peers?.some(peer=>peer.address===row.host && peer.port===row.publicPort && peer.users?.some(user=>user.id===row.secrets.clientId)))return profile.id;}catch{}
  }
  return null;
 }
 start(row){
  if(this.closed)throw new AccessPointError('VPN deployment service is shutting down.',503);
  if(this.jobs.size>=2)throw new AccessPointError('Wait for a VPN deployment to finish.',409);
  row.state='installing';row.stage='checking';row.error=null;this.repository.save(row);
  const task=Promise.resolve().then(async()=>{
   try{
    const result=await this.install(row,{progress:stage=>{row.stage=stage;this.repository.save(row);}});row.platform=result.platform;row.stage='adding';this.repository.save(row);
    let created=false;
    if(!row.profileId || !this.store.profiles().some(profile=>profile.id===row.profileId)){
     row.profileId=this.findImportedProfile(row);
     if(!row.profileId){
      try{const profile=this.store.importProfile({name:row.name,value:deploymentLink(row)});row.profileId=profile.id;created=true;}
      catch{throw new AccessPointError('VPN server is installed, but its key could not be imported. Check the VPN modules and retry.',502);}
     }
     this.repository.save(row);
    }
    try{await this.apply();}catch{if(created){this.store.removeProfile(row.profileId);row.profileId=null;await this.apply().catch(()=>{});}throw new AccessPointError('VPN server is installed, but the local gateway could not start. Retry to finish adding it.',502);}
    row.state='completed';row.stage=null;
   }catch(error){row.state='error';row.stage=null;row.error=error instanceof AccessPointError?error.message:'Unable to deploy the VPN server. Check SSH access and retry.';}
   finally{delete row.secrets.sshKey;delete row.secrets.sshPassphrase;try{this.repository.save(row);}catch{console.error('FreedomGate: VPN deployment state could not be saved.');}this.jobs.delete(row.id);}
  });this.jobs.set(row.id,task);return publicDeployment(row);
 }
 async close(){this.closed=true;await Promise.allSettled(this.jobs.values());}
}
