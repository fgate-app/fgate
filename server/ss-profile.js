import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const arch=process.arch==='x64'?'amd64':process.arch;
export const outlineBinary=()=>process.env.FREEDOMGATE_OUTLINE || fileURLToPath(new URL(`./outline/bin/${process.platform}-${arch}/outline-bridge`,import.meta.url));
// Only used by independent legacy transport fixtures; not a runtime dependency.
export const ssPython=()=>process.env.FREEDOMGATE_SS_PYTHON || '/usr/bin/python3';
export function normalizeSsProfile(value){
 const result=spawnSync(outlineBinary(),['--parse'],{input:value,encoding:'utf8',timeout:5000,maxBuffer:65536});
 if(result.error || result.status!==0)throw new Error("Outline SDK: Check the link, cipher and prefix, and install the module.");
 try{return JSON.parse(result.stdout);}catch{throw new Error("Outline SDK: Failed to parse the connection.");}
}
