import {readFile,writeFile,rename,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createResourceFetch} from '../server/resource-fetch.js';
const [url,destination,sha256]=process.argv.slice(2);
if(!/^[a-f0-9]{64}$/.test(sha256||''))throw Error('Invalid download checksum.');
const job=JSON.parse(await readFile(process.env.FREEDOMGATE_RESOURCE_JOB,'utf8'));
const id=process.env.FREEDOMGATE_ACTIVE_MODULE;
const get=createResourceFetch({gateways:()=>job.gateways||[]});
const response=await get(url,{timeoutMs:30000,signal:AbortSignal.timeout(300000),validate:bytes=>{if(createHash('sha256').update(bytes).digest('hex')!==sha256)throw Error('Checksum mismatch');}});
const temporary=destination+'.download';
try{await writeFile(temporary,Buffer.from(await response.arrayBuffer()),{mode:0o600});await rename(temporary,destination);}finally{await rm(temporary,{force:true});}
if(['tor','lantern','outline','frp','mihomo','xray','adguard','zapret'].includes(id))console.log('FG_MODULE_PATH '+id+' '+(response.downloadPath==='direct'?'direct':'gateway'));
