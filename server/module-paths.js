import {releaseModule} from './release-modules.js';
import {existsSync,readFileSync} from 'node:fs';
const root=process.env.FREEDOMGATE_MODULES_DIR || '/opt/freedomgate/modules';
export function moduleBinary(id,binary,fallback){const path=`${root}/${id}/current/${binary}`;return existsSync(path)?path:fallback;}
export function installedModuleVersions(fallback){
 const versions={...fallback};
 for(const id of ['mihomo','xray','adguard','zapret','frp'])try{const value=JSON.parse(readFileSync(`${root}/${id}/current/manifest.json`,'utf8'));if(typeof value.version==='string')versions[id]=value.version;}catch{}
 for(const id of ['tor','lantern'])try{const module=releaseModule(id),manifest=JSON.parse(readFileSync(module.root+'/manifest.json','utf8'));versions[id]=manifest.version===module.version?module.version:'—';}catch{versions[id]='—';}
 return versions;
}
