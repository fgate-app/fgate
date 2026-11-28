import {readFileSync} from 'node:fs';
import {Store} from '../server/store.js';
import {gatewayEditor} from '../server/gateway-editor.js';
const {outbound,mux}=JSON.parse(readFileSync(0,'utf8')),store=new Store(':memory:');
try{
 const row=store.importProfile({value:JSON.stringify({outbounds:[outbound]})}),editor=gatewayEditor(store.profileSnapshot(row.id));
 Object.assign(editor.fields,{muxEnabled:String(!!mux),muxConcurrency:String(mux?.concurrency ?? 128),muxXudpConcurrency:String(mux?.xudpConcurrency ?? 16),muxUdp443:mux?.xudpProxyUDP443 || 'reject'});
 store.updateProfile(row.id,{editor});process.stdout.write(JSON.stringify(JSON.parse(store.profileSnapshot(row.id).config.config).outbounds[0]));
}finally{store.close();}
