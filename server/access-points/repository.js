import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {publicServer,AccessPointError} from './model.js';
export class AccessPointRepository{
 constructor(db,{stateDir,table='access_points',present=publicServer,notFound='Access point not found.'}){
  if(!['access_points','gateway_deployments','gateway_subscriptions'].includes(table))throw Error('Invalid encrypted repository.');
  this.db=db;this.stateDir=stateDir;this.table=table;this.present=present;this.notFound=notFound;
  db.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
 }
 key(){
  if(this.master)return this.master;
  mkdirSync(this.stateDir,{recursive:true,mode:0o700});const path=join(this.stateDir,'access-points.key');
  try{this.master=readFileSync(path);}catch(error){if(error.code!=='ENOENT')throw error;try{writeFileSync(path,randomBytes(32),{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}this.master=readFileSync(path);}
  if(this.master.length!==32)throw new AccessPointError('Access point key is invalid.',503);return this.master;
 }
 encode(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key(),iv);const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);return JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});}
 decode(value){const row=JSON.parse(value),cipher=createDecipheriv('aes-256-gcm',this.key(),Buffer.from(row.iv,'base64'));cipher.setAuthTag(Buffer.from(row.tag,'base64'));return JSON.parse(Buffer.concat([cipher.update(Buffer.from(row.data,'base64')),cipher.final()]).toString());}
 all(){return this.db.prepare(`SELECT value FROM ${this.table} ORDER BY rowid`).all().map(row=>this.decode(row.value));}
 get(id){const row=this.db.prepare(`SELECT value FROM ${this.table} WHERE id=?`).get(id);if(!row)throw new AccessPointError(this.notFound,404);return this.decode(row.value);}
 list(){return this.all().map(this.present);}
 save(server){this.db.prepare(`INSERT INTO ${this.table} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(server.id,this.encode(server));return this.present(server);}
 remove(id){this.db.prepare(`DELETE FROM ${this.table} WHERE id=?`).run(id);}
}
