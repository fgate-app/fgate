import {expandConnectionGroup} from '../shared/connection-groups.js';
import {CATALOG_FILE,configurationCatalog,compactConfigurationCatalog,mergeConfigurationCatalog} from './configuration-catalog.js';
import {randomBytes,randomUUID,scrypt as derive,createCipheriv,createDecipheriv} from 'node:crypto';
import {promisify} from 'node:util';
import {mkdirSync,readFileSync,writeFileSync,renameSync,readdirSync,unlinkSync,lstatSync,statfsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {Store} from './store.js';
import {Auth} from './auth.js';
import {AccessPointRepository} from './access-points/repository.js';
import {transaction} from './database.js';
import {readRoutePresets} from './route-presets.js';
import {HttpError} from './http.js';
const scrypt=promisify(derive);
const TABLES=['profiles','settings','profile_configs','dns_settings','zapret_settings','filter_rule_state','network_settings','route_groups','device_routes','local_routes','adguard_settings','static_leases','connection_groups','users'];
const SECRET_TABLES=['access_points','gateway_deployments','gateway_subscriptions'];
const FILES=['adguard/AdGuardHome.yaml','domain-lists/catalog.json'];
export const BACKUP_LIMIT=64*1024*1024;
const fail=(message,status=400)=>new HttpError(status,message);
export const generateBackupSecret=()=>randomBytes(32).toString('base64url');
function secretBytes(secret){if(typeof secret!=='string'||secret.length<16||secret.length>256)throw fail('The encryption secret must be 16–256 characters.');return secret;}
function base64(value,length){
 if(typeof value!=='string'||value.length%4!==0||/[^A-Za-z0-9+/=]/.test(value))throw fail('Invalid configuration file.');
 const bytes=Buffer.from(value,'base64');
 if(bytes.toString('base64')!==value||(length!==undefined && bytes.length!==length))throw fail('Invalid configuration file.');
 return bytes;
}
export async function encryptConfiguration(snapshot,secret){
 secretBytes(secret);const plain=Buffer.from(JSON.stringify(snapshot));if(plain.length>BACKUP_LIMIT)throw fail('Configuration file is too large.',413);
 const salt=randomBytes(32),iv=randomBytes(12),key=await scrypt(secret,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
 try{const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('FreedomGate configuration v1'));
 return {format:'freedomgate-configuration',version:1,kdf:'scrypt-32768-8-1',salt:salt.toString('base64'),iv:iv.toString('base64'),data:Buffer.concat([cipher.update(plain),cipher.final()]).toString('base64'),tag:cipher.getAuthTag().toString('base64')};
 }finally{key.fill(0);plain.fill(0);}
}
export async function decryptConfiguration(file,secret){
 secretBytes(secret);if(!file||file.format!=='freedomgate-configuration'||file.version!==1||file.kdf!=='scrypt-32768-8-1')throw fail('Unsupported configuration file version.');
 if(typeof file.data!=='string'||file.data.length>Math.ceil(BACKUP_LIMIT/3)*4)throw fail('Configuration file is too large.',413);
 const salt=base64(file.salt,32),iv=base64(file.iv,12),tag=base64(file.tag,16),data=base64(file.data);
 const key=await scrypt(secret,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024});let plain;
 try{const cipher=createDecipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('FreedomGate configuration v1'));cipher.setAuthTag(tag);plain=Buffer.concat([cipher.update(data),cipher.final()]);return JSON.parse(plain.toString('utf8'));}
 catch{throw fail('The encryption secret is incorrect or the configuration file is damaged.');}finally{key.fill(0);plain?.fill(0);}
}
const existsTable=(db,table)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
export class ConfigurationBackups{
 constructor(store,{stateDir=process.env.FREEDOMGATE_STATE_DIR||dirname(process.env.FREEDOMGATE_DB||'.data/freedomgate.sqlite')}={}){this.store=store;this.stateDir=stateDir;this.folder=join(stateDir,'configuration-backups');}
 repository(table){return new AccessPointRepository(this.store.db,{stateDir:this.stateDir,table,present:value=>value});}
 capture(){
  const tables=Object.fromEntries(TABLES.map(table=>[table,existsTable(this.store.db,table)?this.store.db.prepare(`SELECT * FROM ${table}`).all().map(row=>({...row})):[]]));
  const repositories=Object.fromEntries(SECRET_TABLES.map(table=>[table,existsTable(this.store.db,table)?this.repository(table).all():[]]));
  const files={};for(const file of FILES){try{const path=join(this.stateDir,file);if(!lstatSync(path).isFile())throw fail('Invalid configuration state.',500);if(lstatSync(path).size>BACKUP_LIMIT)throw fail('Configuration file is too large.',413);files[file]=readFileSync(path).toString('base64');}catch(error){if(error.code!=='ENOENT')throw error;}}
  return this.portable({format:'freedomgate-snapshot',version:2,createdAt:new Date().toISOString(),tables,repositories,files});
 }
 // Lists are stored once as module data; route groups carry only stable references.
 portable(snapshot){
  const files={...snapshot.files};let catalog=null;
  if(files[CATALOG_FILE]){
   try{catalog=configurationCatalog(JSON.parse(base64(files[CATALOG_FILE]).toString('utf8')));}catch{throw fail('Invalid configuration file.');}
  }
  const selected=compactConfigurationCatalog(snapshot.tables.route_groups,catalog,snapshot.createdAt);
  delete files[CATALOG_FILE];
  if(selected.catalog)files[CATALOG_FILE]=Buffer.from(JSON.stringify(selected.catalog)).toString('base64');
  return {...snapshot,version:2,tables:{...snapshot.tables,route_groups:selected.groups},files};
 }
 validate(snapshot,{factory=false}={}){
  if(!snapshot||snapshot.format!=='freedomgate-snapshot'||![1,2].includes(snapshot.version)||!snapshot.tables||!snapshot.repositories||!snapshot.files)throw fail('Invalid configuration file.');
  if(Object.keys(snapshot.tables).some(t=>!TABLES.includes(t))||Object.keys(snapshot.repositories).some(t=>!SECRET_TABLES.includes(t))||Object.keys(snapshot.files).some(f=>!FILES.includes(f)))throw fail('Unsupported configuration file contents.');
  const temp=new Store(':memory:');new Auth(temp.db);
  try{
   for(const table of TABLES){const rows=snapshot.tables[table];if(!Array.isArray(rows)||rows.length>100000)throw fail('Invalid configuration file.');const columns=temp.db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name);
    for(const row of rows)if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(c=>!columns.includes(c))||Object.values(row).some(v=>v!==null&&!['string','number'].includes(typeof v)))throw fail('Invalid configuration file.');
   }
   const jsonFields={settings:['value'],dns_settings:['value'],zapret_settings:['value'],filter_rule_state:['value'],network_settings:['value'],route_groups:['entries','dns_policy','domain_presets'],adguard_settings:['value'],connection_groups:['members']};
   for(const [table,fields]of Object.entries(jsonFields))for(const row of snapshot.tables[table])for(const field of fields)if(row[field]!==undefined)JSON.parse(row[field]);
   for(const row of snapshot.tables.route_groups){
    const refs=JSON.parse(row.domain_presets || '[]');
    if(!Array.isArray(refs)||refs.length>64||readRoutePresets(row.domain_presets).length!==refs.length||new Set(refs.map(ref=>ref.id)).size!==refs.length)throw fail('Invalid configuration file.');
   }
   for(const row of snapshot.tables.users)if(!['admin','operator','viewer'].includes(row.role)||! /^[a-f0-9]{32}:[a-f0-9]{128}$/.test(row.password_hash))throw fail('Invalid configuration file.');
   const gatewayMap=new Map(snapshot.tables.profiles.map(row=>[row.id,row.gateway_id]));
   for(const id of gatewayMap.keys()){const visited=new Set();let current=id;while(current){if(visited.has(current))throw fail('Invalid gateway references in configuration.');visited.add(current);current=gatewayMap.get(current);}}
   this.writeTables(temp.db,snapshot.tables);
   if(!factory&&!temp.db.prepare("SELECT 1 FROM users WHERE role='admin' AND disabled=0").get())throw fail('The configuration must contain an active administrator.');
   const ids=new Set(snapshot.tables.profiles.map(r=>r.id)),groups=new Set(snapshot.tables.connection_groups.map(r=>r.id));
   for(const row of snapshot.tables.profiles)if(row.gateway_id&&!ids.has(row.gateway_id))throw fail('Invalid gateway references in configuration.');
   for(const row of snapshot.tables.profile_configs)if(!ids.has(row.profile_id))throw fail('Invalid gateway references in configuration.');
   const nestedGroups=snapshot.tables.connection_groups.map(row=>({...row,members:JSON.parse(row.members)}));
   for(const row of nestedGroups){if(!Array.isArray(row.members)||!row.members.length||row.members.length>100||row.members.some(id=>typeof id!=='string'||(!ids.has(id)&&!groups.has(id))))throw fail('Invalid gateway references in configuration.');expandConnectionGroup(nestedGroups,row.id,{rejectCycles:true});}
   for(const row of [...snapshot.tables.route_groups,...snapshot.tables.device_routes])if(row.route_id&&!['block','direct','reject'].includes(row.route_id)&&!ids.has(row.route_id)&&!groups.has(row.route_id))throw fail('Invalid gateway references in configuration.');
   for(const table of SECRET_TABLES){const rows=snapshot.repositories[table];if(!Array.isArray(rows)||rows.length>10000||new Set(rows.map(r=>r?.id)).size!==rows.length||rows.some(r=>!r||typeof r.id!=='string'||!r.id.length))throw fail('Invalid encrypted repository contents.');}
   for(const value of Object.values(snapshot.files))base64(value);
  }catch(error){if(error instanceof HttpError)throw error;throw fail('Invalid configuration file.');}finally{temp.close();}
  return this.portable(snapshot);
 }
 writeTables(db,tables){for(const table of [...TABLES].reverse())db.exec(`DELETE FROM ${table}`);for(const table of TABLES)for(const row of tables[table]){const columns=Object.keys(row);db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(c=>row[c]));}}
 apply(snapshot){
  const previous={};for(const file of FILES){try{previous[file]=readFileSync(join(this.stateDir,file));}catch(error){if(error.code!=='ENOENT')throw error;previous[file]=null;}}
  const writeFile=(file,bytes)=>{const path=join(this.stateDir,file);if(bytes===null){try{unlinkSync(path);}catch(error){if(error.code!=='ENOENT')throw error;}return;}mkdirSync(dirname(path),{recursive:true,mode:0o700});const pending=path+'.restore-'+randomUUID();writeFileSync(pending,bytes,{mode:0o600,flag:'wx'});renameSync(pending,path);};
  try{transaction(this.store.db,()=>{this.writeTables(this.store.db,snapshot.tables);for(const table of SECRET_TABLES){const repo=this.repository(table);this.store.db.exec(`DELETE FROM ${table}`);for(const row of snapshot.repositories[table])repo.save(row);}this.store.db.exec('DELETE FROM sessions');for(const table of ['access_point_traffic','events','system_journal_state'])if(existsTable(this.store.db,table))this.store.db.exec(`DELETE FROM ${table}`);for(const file of FILES){
     // The catalogue is module data: keep the target installation and add missing saved lists.
     if(file==='domain-lists/catalog.json'){
      if(snapshot.files[file]!==undefined){
       const saved=configurationCatalog(JSON.parse(base64(snapshot.files[file]).toString('utf8')));let local;
       try{local=JSON.parse(previous[file]?.toString('utf8') || 'null');}catch{}
       const merged=mergeConfigurationCatalog(saved,local);
       if(merged===local)continue;
       writeFile(file,Buffer.from(JSON.stringify(merged)));
      }
      continue;
     }
     writeFile(file,snapshot.files[file]===undefined?null:base64(snapshot.files[file]));
    }this.store.refreshDomainPresets();});}
  catch(error){for(const [file,bytes]of Object.entries(previous))writeFile(file,bytes);throw error;}
 }
 factory(){const temp=new Store(':memory:');new Auth(temp.db);try{const snapshot={format:'freedomgate-snapshot',version:1,createdAt:new Date().toISOString(),tables:Object.fromEntries(TABLES.map(t=>[t,temp.db.prepare(`SELECT * FROM ${t}`).all()])),repositories:Object.fromEntries(SECRET_TABLES.map(t=>[t,[]])),files:{}};return this.validate(snapshot,{factory:true});}finally{temp.close();}}
 localSecret(){mkdirSync(this.folder,{recursive:true,mode:0o700});const path=join(this.folder,'backup.key');try{writeFileSync(path,generateBackupSecret(),{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}if(!lstatSync(path).isFile()||lstatSync(path).size!==43)throw fail('Invalid backup file.');return readFileSync(path,'utf8');}
 path(id){if(!/^[a-f0-9-]{36}$/.test(id))throw fail('Backup not found.',404);return join(this.folder,id+'.fgbackup');}
 list(){try{return readdirSync(this.folder).filter(f=>/^[a-f0-9-]{36}\.fgbackup$/.test(f)).map(file=>{const stat=lstatSync(join(this.folder,file));if(!stat.isFile())throw fail('Invalid backup file.');return {id:file.slice(0,-9),createdAt:stat.mtime.toISOString(),size:stat.size};}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}catch(error){if(error.code==='ENOENT')return [];throw error;}}
 async create(){if(this.list().length>=20)throw fail('The backup limit has been reached. Delete an old backup first.',409);const id=randomUUID(),file=await encryptConfiguration(this.capture(),this.localSecret());const data=JSON.stringify(file),space=statfsSync(this.folder);if(space.bavail*space.bsize<Buffer.byteLength(data)+16*1024*1024)throw fail('Not enough space to save a configuration backup.',507);const pending=this.path(id)+'.pending';try{writeFileSync(pending,data,{mode:0o600,flag:'wx',flush:true});renameSync(pending,this.path(id));}finally{try{unlinkSync(pending);}catch(error){if(error.code!=='ENOENT')throw error;}}return this.list().find(row=>row.id===id);}
 async read(id){let file;try{const path=this.path(id);if(!lstatSync(path).isFile()||lstatSync(path).size>90*1024*1024)throw fail('Invalid backup file.');file=JSON.parse(readFileSync(path,'utf8'));}catch(error){if(error.code==='ENOENT')throw fail('Backup not found.',404);throw error;}return this.validate(await decryptConfiguration(file,this.localSecret()));}
 remove(id){try{unlinkSync(this.path(id));}catch(error){if(error.code==='ENOENT')throw fail('Backup not found.',404);throw error;}}
}
