import {readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
// Counters live separately from generated engine/network configuration.
export function trafficState(path){
 return {
  load(){try{const data=JSON.parse(readFileSync(path,'utf8'));if(data.version!==1)return null;return data;}catch{return null;}},
  save(value){mkdirSync(dirname(path),{recursive:true,mode:0o700});const temporary=path+'.new';writeFileSync(temporary,JSON.stringify({version:1,...value}),{mode:0o600});renameSync(temporary,path);},
 };
}
