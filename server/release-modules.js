import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const platform=process.platform+'-'+(process.arch==='x64'?'amd64':process.arch);
export function releaseModule(id){
 if(!['tor','lantern'].includes(id))throw Error('Unknown release module.');
 const lock=JSON.parse(readFileSync(new URL('../packaging/'+id+'.lock.json',import.meta.url),'utf8'));
 return {version:lock.version,root:fileURLToPath(new URL('./'+id+'/bin/'+platform+'/'+lock.version+'/',import.meta.url))};
}
