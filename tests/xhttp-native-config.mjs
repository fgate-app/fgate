import {readFileSync,mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../server/store.js';import {gatewayEditor} from '../server/gateway-editor.js';import {manualConfig} from '../shared/manual-gateway.js';import {XraySupervisor} from '../server/xray.js';
const input=JSON.parse(readFileSync(0,'utf8')),folder=mkdtempSync(join(tmpdir(),'fg-xhttp-native-')),store=new Store(':memory:'),runtime=new XraySupervisor({binary:process.execPath,stateDir:folder});
try{
 const p=store.importProfile({value:manualConfig('vless',input.fields)}),e=gatewayEditor(store.profileSnapshot(p.id));Object.assign(e.fields,input.edits);store.updateProfile(p.id,{editor:e});
 if(input.wrapEndpoint){const outer=store.importProfile({value:'socks5://127.0.0.1:'+input.wrapEndpoint.port});store.updateProfile(p.id,{gatewayId:outer.id});}
 runtime.validate=async()=>{};runtime.start=entry=>{entry.process={};};runtime.ready=async()=>{};
 const prepared=await runtime.prepare([{...store.profileSnapshot(p.id).config,wrapEndpoint:input.wrapEndpoint}]);await prepared.commit();process.stdout.write(readFileSync(runtime.entries.get(p.id).path,'utf8'));
}finally{store.close();rmSync(folder,{recursive:true,force:true});}
