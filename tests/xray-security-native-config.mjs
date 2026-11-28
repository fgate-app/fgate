// Exercise the actual importer/editor, with private stdin and no logging.
import {readFileSync} from 'node:fs';
import {Store} from '../server/store.js';
import {gatewayEditor} from '../server/gateway-editor.js';
const {outbound}=JSON.parse(readFileSync(0,'utf8')),store=new Store(':memory:');
try{
 const row=store.importProfile({value:JSON.stringify({outbounds:[outbound]})}),editor=gatewayEditor(store.profileSnapshot(row.id));
 // Reapply advanced values through their form fields, then reopen the saved row.
 const settings=outbound.streamSettings[outbound.streamSettings.security==='tls'?'tlsSettings':'realitySettings'];
 for(const key of ['alpn','pinnedPeerCertSha256','verifyPeerCertByName','spiderX','mldsa65Verify'])if(settings?.[key]!==undefined)editor.fields[key]=Array.isArray(settings[key])?settings[key].join(', '):settings[key];
 editor.fields.server='localhost';store.updateProfile(row.id,{editor});editor.fields.server='127.0.0.1';store.updateProfile(row.id,{editor});
 process.stdout.write(JSON.stringify(JSON.parse(store.profileSnapshot(row.id).config.config).outbounds[0]));
}finally{store.close();}
