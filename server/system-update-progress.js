export const systemUpdateStages=Object.freeze({source:2,archive:5,cache:6,torDownload:7,dependencies:8,runtime:12,reuse:16,tor:22,lantern:32,outline:42,backup:48,web:57,frp:67,modules:75,package:83,activate:89,restart:94,health:98,complete:100});
export function installerProgress(line){const match=/^FG_UPDATE_STAGE ([a-z]+)$/.exec(line);return match&&Object.hasOwn(systemUpdateStages,match[1])?{stage:match[1],progress:systemUpdateStages[match[1]],stageStartedAt:Date.now(),action:null}:null;}

export function componentProgress(line){
 const stage=/^FG_MODULE_STAGE (tor|lantern|outline|frp|mihomo|xray|adguard|zapret) (checking|downloading|building|extracting|verifying|packaging|reuse|complete) ([0-9]{1,3})$/.exec(line);
 if(stage&&Number(stage[3])<=100)return {id:stage[1],stage:stage[2],progress:Number(stage[3])};
 const path=/^FG_MODULE_PATH (tor|lantern|outline|frp|mihomo|xray|adguard|zapret) (direct|gateway)$/.exec(line);
 return path?{id:path[1],downloadPath:path[2]}:null;
}
