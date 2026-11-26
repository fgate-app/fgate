import {connectionGroupContains} from '../shared/connection-groups.js';
import {randomUUID,createHash} from 'node:crypto';
import {dirname} from 'node:path';
import {Store} from './store.js';
import {configRecords} from '../shared/gateway-config.js';
import {gatewayEditor} from './gateway-editor.js';
import {AccessPointRepository} from './access-points/repository.js';
import {PublicError} from './public-error.js';
import {resourceUrl} from './resource-fetch.js';
import {transaction} from './database.js';
const fail=(message,status=400)=>{throw Object.assign(new PublicError(message),{status});};
function settings(input){if(!input || typeof input!=='object' || input.enabled!==undefined && typeof input.enabled!=='boolean')fail('Select a valid subscription update interval.');const name=String(input.name || '').trim(),intervalHours=Number(input.intervalHours ?? 6);if(!name || name.length>100)fail('Enter a subscription name up to 100 characters.');if(![1,6,12,24].includes(intervalHours))fail('Select a valid subscription update interval.');return {name,intervalHours,enabled:input.enabled!==false};}
const publicRow=row=>({id:row.id,name:row.name,origin:new URL(row.secrets.url).origin,intervalHours:row.intervalHours || 6,enabled:row.enabled!==false,updatedAt:row.updatedAt || null,nextAt:row.nextAt || null,error:row.error || null,count:row.members.length,configCount:Array.isArray(row.secrets.records)?row.secrets.records.length:row.members.length,missing:row.members.filter(m=>m.missing).length});
export class GatewaySubscriptions{
 constructor(store,{fetchImpl,validate=async()=>{},apply=async()=>{},serialize=action=>action(),stateDir=process.env.FREEDOMGATE_STATE_DIR || dirname(process.env.FREEDOMGATE_DB || '.data/freedomgate.sqlite')}={}){
  Object.assign(this,{store,fetchImpl,validate,apply,serialize});this.controller=new AbortController();this.previews=new Map();this.busy=new Set();this.tasks=new Set();this.closed=false;
  this.repository=new AccessPointRepository(store.db,{stateDir,table:'gateway_subscriptions',present:publicRow,notFound:'Subscription not found.'});
 }
 run(action){if(this.closed)return Promise.reject(Object.assign(new PublicError('Subscriptions are shutting down.'),{status:503}));const promise=Promise.resolve().then(action);this.tasks.add(promise);promise.then(()=>this.tasks.delete(promise),()=>this.tasks.delete(promise));return promise;}
 preview(input,options){return this.run(()=>this.performPreview(input,options));}
 save(id,input){return this.run(()=>this.performSave(id,input));}
 refresh(id,options){return this.run(()=>this.performRefresh(id,options));}
 configure(id,input){return this.run(()=>this.performConfigure(id,input));}
 list(){return this.repository.list();}
 membership(){return new Map(this.repository.all().flatMap(row=>row.members.map(m=>[m.profileId,{subscriptionId:row.id,subscriptionName:row.name,subscriptionMissing:!!m.missing}])));}
 cachedRecords(row){return Array.isArray(row.secrets.records)?row.secrets.records:row.members.flatMap(member=>{const snapshot=this.store.profileSnapshot(member.profileId);return snapshot?.config?[{key:member.key,label:member.providerName || snapshot.profile.name,type:gatewayEditor(snapshot).type,snapshot}]:[];});}
 usage(profileId){
  const allGroups=this.store.connectionGroups(),groups=allGroups.filter(group=>connectionGroupContains(allGroups,group.id,profileId));const targets=new Set([profileId,...groups.map(group=>group.id)]);
  return {routes:[...this.store.routeGroups(),...this.store.deviceRoutes()].filter(route=>targets.has(route.routeId)).map(route=>route.name),groups:groups.map(group=>group.name),gateways:this.store.profiles().filter(profile=>profile.gatewayId===profileId).map(profile=>profile.name)};
 }
 nodeDetails(row,records=this.cachedRecords(row)){
  const nodes=[...records,...row.members.filter(member=>!records.some(node=>node.key===member.key)).map(member=>({key:member.key,label:member.providerName,type:this.store.profileSnapshot(member.profileId)?.profile.protocol || ''}))];
  return nodes.map(node=>{const member=row.members.find(member=>member.key===node.key),profile=member?this.store.profileSnapshot(member.profileId)?.profile:null,usage=profile?this.usage(profile.id):{routes:[],groups:[],gateways:[]};return {key:node.key,label:profile?.name || node.label,type:node.type,profileId:profile?.id || null,enabled:!!profile?.enabled,available:records.some(record=>record.key===node.key),usage,inUse:Object.values(usage).some(list=>list.length)};});
 }
 details(id){const row=this.repository.get(id);return {...publicRow(row),url:row.secrets.url,recordsComplete:Array.isArray(row.secrets.records) && row.secrets.recordsComplete!==false,records:this.nodeDetails(row)};}
 isBusy(profileId){return this.repository.all().some(row=>this.busy.has(row.id) && row.members.some(m=>m.profileId===profileId));}
 async download(url,signal){
  const response=await this.fetchImpl(resourceUrl(url),{maxBytes:262144,validate:bytes=>configRecords(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(90000),...(signal?[signal]:[])])});
  if(!response.ok)fail('Could not download the subscription.',502);const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>262144)fail('The subscription is too large.');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('The subscription must use UTF-8.');}
  const temp=new Store(':memory:');
  try{const rows=configRecords(text).map(value=>{
   const profile=temp.importProfile({value}),snapshot=temp.profileSnapshot(profile.id),editor=gatewayEditor(snapshot),f=editor.fields || {};
   const key=createHash('sha256').update(JSON.stringify([profile.name,editor.type,f.server,f.port,f.network,f.path,f.serviceName,f.proto])).digest('hex');
   return {key,label:profile.name,type:editor.type,snapshot};
  });if(new Set(rows.map(row=>row.key)).size!==rows.length)fail('The subscription contains ambiguous duplicate connections.');return rows;
  }catch(error){if(error instanceof PublicError)throw error;fail('The subscription contains unsupported or invalid connections.');}finally{temp.close();}
 }
 async performPreview(input,{signal}={}){
  if(this.closed)fail('Subscriptions are shutting down.',503);const config=settings(input),url=resourceUrl(input.url);
  const rows=await this.download(url,signal);for(const [id,p] of this.previews)if(p.expires<Date.now())this.previews.delete(id);if(this.previews.size>=20)fail('Wait for a subscription preview to expire.',409);
  const token=randomUUID();this.previews.set(token,{...config,url,rows,expires:Date.now()+300000});const old=input.id?this.repository.get(input.id):null;
  return {token,records:old?this.nodeDetails(old,rows):rows.map(({key,label,type})=>({key,label,type})),selected:old?old.members.filter(m=>rows.some(r=>r.key===m.key)).map(m=>m.key):rows.map(row=>row.key)};
 }
 async performSave(id,input){
  const preview=this.previews.get(input.token);if(!preview || preview.expires<Date.now())fail('Load the subscription again before saving.',409);
  if(!Array.isArray(input.selected) || !input.selected.length || new Set(input.selected).size!==input.selected.length || input.selected.some(key=>!preview.rows.some(row=>row.key===key)))fail('Select connections from this subscription.');
  const source=id?this.repository.get(id):{id:randomUUID(),members:[]};
  if(!id && this.list().length>=20)fail('Add no more than 20 subscriptions.');
  const row={...source,name:preview.name,intervalHours:preview.intervalHours,enabled:preview.enabled,secrets:{url:preview.url}};
  const result=await this.sync(row,preview.rows,{selected:input.selected});this.previews.delete(input.token);return result;
 }
 async performConfigure(id,input){
  const source=this.repository.get(id),config=settings(input),url=resourceUrl(input.url);
  let records=this.cachedRecords(source);
  if(input.token){const preview=this.previews.get(input.token);if(!preview || preview.expires<Date.now() || preview.url!==url)fail('Load the subscription again before saving.',409);records=preview.rows;}
  else if(url!==source.secrets.url)fail('Load the subscription again before saving.',409);
  const known=new Set([...records.map(row=>row.key),...source.members.map(member=>member.key)]);
  if(!Array.isArray(input.states) || new Set(input.states.map(row=>row?.key)).size!==input.states.length || input.states.some(row=>!row || !known.has(row.key) || typeof row.enabled!=='boolean') || input.states.length!==known.size)fail('Select connections from this subscription.');
  const states=new Map(input.states.map(row=>[row.key,row.enabled]));
  if(input.states.some(row=>row.enabled && !records.some(record=>record.key===row.key)))fail('This connection is no longer available in the subscription.');
  const selected=[...new Set([...source.members.map(member=>member.key),...input.states.filter(row=>row.enabled).map(row=>row.key)])];
  const row={...source,...config,secrets:{...source.secrets,url}};
  const result=await this.sync(row,records,{selected,states,confirmDisable:input.confirmDisable,downloaded:!!input.token,preserveConfig:!input.token});if(input.token)this.previews.delete(input.token);return result;
 }
 async performRefresh(id,{profileId,signal}={}){
  if(this.busy.has(id))fail('This subscription is already updating.',409);this.busy.add(id);
  try{const row=this.repository.get(id);if(profileId && !row.members.some(m=>m.profileId===profileId))fail('This gateway does not belong to the subscription.');const rows=await this.download(row.secrets.url,signal);return await this.sync(row,rows,{profileId,locked:true});}
  catch(error){const row=this.repository.get(id);row.error='Could not update the subscription. Previous configurations were preserved.';row.nextAt=new Date(Date.now()+15*60000).toISOString();this.repository.save(row);throw error;}
  finally{this.busy.delete(id);}
 }
 async sync(row,rows,{selected=row.members.map(m=>m.key),profileId,locked=false,states,confirmDisable,downloaded=true,preserveConfig=false}={}){
  if(!locked){if(this.busy.has(row.id))fail('This subscription is already updating.',409);this.busy.add(row.id);}
  try{return await this.serialize(async()=>{
   if(this.closed)fail('Subscriptions are shutting down.',503);
   const previous=this.repository.all().find(p=>p.id===row.id),members=row.members.filter(m=>selected.includes(m.key)),detached=row.members.filter(m=>!selected.includes(m.key));
   if(states){const required=members.flatMap(member=>{const profile=this.store.profileSnapshot(member.profileId)?.profile;if(profile?.enabled && states.get(member.key)===false){const usage=this.usage(profile.id);if(Object.values(usage).some(list=>list.length) && !(Array.isArray(confirmDisable) && confirmDisable.includes(profile.id)))return [{profileId:profile.id,key:member.key,name:profile.name,usage}];}return [];});if(required.length)throw Object.assign(new PublicError('Confirm disabling gateways that are in use.'),{status:409,code:'gateway-disable-confirmation-required',inUse:required});}
   const targets=rows.filter(r=>selected.includes(r.key) && (!profileId || members.some(m=>m.profileId===profileId && m.key===r.key)));
   for(const target of targets){const member=members.find(member=>member.key===target.key),old=member?this.store.profileSnapshot(member.profileId):null;if(old && states?.get(target.key)===false)continue;const snapshot=preserveConfig && old?old:target.snapshot;await this.validate(snapshot);this.store.validateGateway?.(snapshot);}
   const touched=new Map(),created=[];
   const restore=()=>transaction(this.store.db,()=>{
    for(const id of created){this.store.db.prepare('DELETE FROM profile_configs WHERE profile_id=?').run(id);this.store.db.prepare('DELETE FROM profiles WHERE id=?').run(id);}
    for(const snapshot of touched.values())this.writeSnapshot(snapshot);
    if(previous)this.repository.save(previous);else this.repository.remove(row.id);
   });
   try{
    transaction(this.store.db,()=>{
     for(const target of targets){
      let member=members.find(m=>m.key===target.key),old=member?this.store.profileSnapshot(member.profileId):null;
      if(member && !old){members.splice(members.indexOf(member),1);member=null;}
      if(old)touched.set(old.profile.id,old);
      const id=old?.profile.id || randomUUID();if(!old)created.push(id);
      const profile=old && preserveConfig?{...old.profile}:old?{...old.profile,protocol:target.snapshot.profile.protocol,engine:target.snapshot.profile.engine,name:old.profile.name===member.providerName?target.label:old.profile.name}:{...target.snapshot.profile,id,enabled:0};

      if(states?.has(target.key))profile.enabled=Number(states.get(target.key));
      this.writeSnapshot({profile,config:preserveConfig && old?old.config:target.snapshot.config});
      if(!member){member={key:target.key,profileId:id};members.push(member);}member.providerName=target.label;member.missing=false;
     }
     for(const member of members.filter(m=>(!profileId || m.profileId===profileId) && !rows.some(r=>r.key===m.key))){const old=this.store.profileSnapshot(member.profileId);if(old){touched.set(old.profile.id,old);this.store.db.prepare('UPDATE profiles SET enabled=0 WHERE id=?').run(member.profileId);}member.missing=true;}
     row.members=members;row.secrets={...row.secrets,recordsComplete:downloaded || (Array.isArray(row.secrets.records) && row.secrets.recordsComplete!==false),records:rows};if(downloaded)row.updatedAt=new Date().toISOString();row.nextAt=new Date(Date.now()+row.intervalHours*3600000).toISOString();row.error=null;this.repository.save(row);
    });
    await this.apply();return {...publicRow(row),detached:detached.length};
   }catch(error){restore();await this.apply().catch(()=>{});throw error;}
  });}finally{if(!locked)this.busy.delete(row.id);}
 }
 writeSnapshot({profile,config}){
  const keys=Object.keys(profile);this.store.db.prepare('INSERT INTO profiles ('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+') ON CONFLICT(id) DO UPDATE SET '+keys.filter(k=>k!=='id').map(k=>k+'=excluded.'+k).join(',')).run(...keys.map(k=>profile[k]));
  this.store.db.prepare('DELETE FROM profile_configs WHERE profile_id=?').run(profile.id);if(config)this.store.db.prepare('INSERT INTO profile_configs VALUES (?,?,?)').run(profile.id,config.engine,config.config);
 }
 forgetProfile(profileId){for(const row of this.repository.all())if(row.members.some(m=>m.profileId===profileId)){row.members=row.members.filter(m=>m.profileId!==profileId);this.repository.save(row);}}
 remove(id){if(this.busy.has(id))fail('This subscription is already updating.',409);this.repository.get(id);this.repository.remove(id);return {ok:true};}
 async tick(){if(this.closed)return;for(const row of this.repository.all())if(row.enabled!==false && !this.busy.has(row.id) && Date.parse(row.nextAt || 0)<=Date.now())await this.refresh(row.id).catch(()=>{});}
 close(){this.closed=true;this.controller.abort();this.previews.clear();return Promise.allSettled([...this.tasks]);}
}
