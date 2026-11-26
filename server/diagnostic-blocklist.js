import {readFileSync,writeFileSync,mkdirSync,renameSync,statSync,copyFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {domainToASCII} from 'node:url';
import {isIP} from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import {PublicError} from './public-error.js';

export const diagnosticBlocklistSource=Object.freeze({id:'diagnostic-blocklist',name:'Re:filter',repository:'1andrevich/Re-filter-lists',file:'domains_all.lst',url:'https://github.com/1andrevich/Re-filter-lists',license:'MIT'});
const limits={bytes:16*1024*1024,entries:500000},revision=/^[a-f0-9]{40}$/;
const digest=value=>createHash('sha256').update(value).digest('hex');
function domainName(value){
 const name=domainToASCII(String(value).trim().replace(/\.$/,'').toLowerCase());
 return name.length<=253 && !isIP(name) && name.includes('.') && name.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))?name:null;
}
export function parseDiagnosticBlocklist(text,{stats={}}={}){
 if(Buffer.byteLength(text)>limits.bytes)throw new PublicError('The diagnostic domain list is too large.');
 const domains=new Set();stats.excludedIpEntries=0;
 for(const raw of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
  const line=raw.trim();if(!line || line.startsWith('#'))continue;
  if(isIP(line)){stats.excludedIpEntries++;continue;}
  const name=domainName(line);if(!name)throw new PublicError('Invalid diagnostic domain list.');
  domains.add(name);if(domains.size>limits.entries)throw new PublicError('The diagnostic domain list is too large.');
 }
 if(!domains.size)throw new PublicError('The diagnostic domain list is empty.');
 return [...domains].sort();
}

// An immutable, local diagnostic reference. Never used to generate routing/DNS rules.
export class DiagnosticBlocklist {
 constructor({directory=join(process.env.FREEDOMGATE_STATE_DIR || '/var/lib/freedomgate','diagnostic-blocklist'),fetchImpl=fetch}={}){this.directory=directory;this.fetchImpl=fetchImpl;this.cached=null;this.task=null;}
 read(){
  const path=join(this.directory,'current.json');
  try{
   const info=statSync(path),key=info.ino+':'+info.mtimeMs+':'+info.size;if(info.size>32*1024*1024)throw Error('Invalid cache.');
   if(this.cached?.key===key)return this.cached.value;
   const data=JSON.parse(readFileSync(path,'utf8'));
   if(data.schemaVersion!==1 || !revision.test(data.ref) || !Number.isFinite(Date.parse(data.updatedAt)) || !Array.isArray(data.domains) || !data.domains.length || data.domains.length>limits.entries || data.domains.some(name=>domainName(name)!==name) || digest(data.domains.join('\n'))!==data.sha256)throw Error('Invalid cache.');
   const domains=new Set(data.domains);if(domains.size!==data.domains.length)throw Error('Invalid cache.');
   const value={ref:data.ref,updatedAt:data.updatedAt,count:domains.size,sha256:data.sha256,excludedIpEntries:data.excludedIpEntries || 0,domains};this.cached={key,value};return value;
  }catch{this.cached=null;return null;}
 }
 status(){const data=this.read();return {source:diagnosticBlocklistSource.name,repository:diagnosticBlocklistSource.repository,loaded:!!data,ref:data?.ref || null,updatedAt:data?.updatedAt || null,count:data?.count || 0,excludedIpEntries:data?.excludedIpEntries || 0};}
 snapshot(){
  const data=this.read(),metadata={source:diagnosticBlocklistSource.name,sourceUrl:diagnosticBlocklistSource.url,ref:data?.ref || null,updatedAt:data?.updatedAt || null,count:data?.count || 0};
  return domain=>{
   const name=domainName(domain);
   if(!data || !name)return {...metadata,state:'unavailable',reason:!data?'list-unavailable':'invalid-domain'};
   const labels=name.split('.');let matchedDomain=null;
   for(let index=0;index<labels.length-1;index++){const candidate=labels.slice(index).join('.');if(data.domains.has(candidate)){matchedDomain=candidate;break;}}
   return {...metadata,state:matchedDomain?'listed':'not-listed',matchedDomain,match:matchedDomain?(matchedDomain===name?'exact':'parent-domain'):null};
  };
 }
 update(ref){
  if(!revision.test(ref || ''))return Promise.reject(new PublicError('Invalid diagnostic list revision.'));
  if(this.task)return Promise.reject(new PublicError('Wait for the current update to finish.'));
  this.task=this.install(ref).finally(()=>{this.task=null;});return this.task;
 }
 async install(ref){
  const response=await this.fetchImpl(`https://raw.githubusercontent.com/${diagnosticBlocklistSource.repository}/${ref}/${diagnosticBlocklistSource.file}`,{signal:AbortSignal.timeout(30000),redirect:'error',maxBytes:limits.bytes,validate:bytes=>parseDiagnosticBlocklist(bytes.toString('utf8'))});
  if(!response.ok)throw new PublicError('Could not download the diagnostic domain list.');
  const chunks=[];let size=0;
  if(response.body){for await(const chunk of response.body){size+=chunk.length;if(size>limits.bytes)throw new PublicError('The diagnostic domain list is too large.');chunks.push(Buffer.from(chunk));}}
  else {const data=Buffer.from(await response.text());if(data.length>limits.bytes)throw new PublicError('The diagnostic domain list is too large.');chunks.push(data);}
  const stats={},domains=parseDiagnosticBlocklist(Buffer.concat(chunks).toString('utf8'),{stats});
  const data={schemaVersion:1,ref,updatedAt:new Date().toISOString(),sha256:digest(domains.join('\n')),excludedIpEntries:stats.excludedIpEntries,domains};
  mkdirSync(this.directory,{recursive:true,mode:0o700});
  const current=join(this.directory,'current.json'),temporary=join(this.directory,randomUUID()+'.tmp');
  try{
   writeFileSync(temporary,JSON.stringify(data),{mode:0o600});
   if(this.read())copyFileSync(current,join(this.directory,'previous.json'));
   renameSync(temporary,current);this.cached=null;
  }finally{rmSync(temporary,{force:true});}
  return this.status();
 }
}
