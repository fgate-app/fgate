// Offline parser acceptance only; this does not claim live network support (FG-16.2).
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {gatewayEditor} from '../server/gateway-editor.js';
import {normalizeXrayProfile} from '../server/xray-profile.js';
import {combinations,uri} from './fixtures/vless-matrix.js';
const binary=process.env.FREEDOMGATE_XRAY_BINARY || '/opt/freedomgate/modules/xray/current/xray';
const dir=mkdtempSync(join(tmpdir(),'fg-vless-native-')),store=new Store(':memory:'),cases=[];
try{
 for(const item of combinations){
  const link=new URL(uri(item));link.searchParams.set('pbk',Buffer.alloc(32,1).toString('base64url'));
  const row=store.importProfile({value:link.href}),editor=gatewayEditor(store.profileSnapshot(row.id));editor.fields.port='8443';store.updateProfile(row.id,{editor});
  const root=normalizeXrayProfile(store.profileSnapshot(row.id).config.config),file=join(dir,'config.json');
  writeFileSync(file,JSON.stringify({...root,log:{loglevel:'error'},inbounds:[{listen:'127.0.0.1',port:18080,protocol:'socks',settings:{auth:'noauth'}}]}),{mode:0o600});
  execFileSync(binary,['run','-test','-c',file],{stdio:'pipe',timeout:10000});cases.push({...item,passed:true});
 }
 assert.equal(cases.length,19);console.log(JSON.stringify({task:'FG-16.1',version:execFileSync(binary,['version'],{encoding:'utf8'}).split('\n')[0],cases,liveTrafficTested:false}));
}finally{store.close();rmSync(dir,{recursive:true,force:true});}
