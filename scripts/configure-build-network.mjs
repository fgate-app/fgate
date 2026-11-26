import {readFile,writeFile,rename,access} from 'node:fs/promises';
import {join} from 'node:path';
const [operation,root]=process.argv.slice(2),file=join(root,'package-lock.json'),backup=join(root,'.package-lock.update-original');
if(operation==='restore'){try{await access(backup);await rename(backup,file);}catch(error){if(error.code!=='ENOENT')throw error;}}
else if(operation==='prepare'){
 const base=process.env.FREEDOMGATE_BUILD_PROXY;
 if(!/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/$/.test(base||''))throw Error('Invalid build resource adapter.');
 const bytes=await readFile(file),lock=JSON.parse(bytes);
 function rewrite(value){if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){if(key==='resolved'&&typeof item==='string'&&/^https?:\/\//.test(item))value[key]=base+'resource/'+Buffer.from(item).toString('base64url');else rewrite(item);}}
 rewrite(lock);await writeFile(backup,bytes,{mode:0o600,flag:'wx'});await writeFile(file,JSON.stringify(lock,null,2)+'\n');
}else throw Error('Invalid build resource operation.');
