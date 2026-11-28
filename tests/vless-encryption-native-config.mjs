import {readFileSync} from 'node:fs';
import {Store} from '../server/store.js';import {gatewayEditor} from '../server/gateway-editor.js';import {manualConfig} from '../shared/manual-gateway.js';
const {outbound}=JSON.parse(readFileSync(0,'utf8')),store=new Store(':memory:');
try{
 const peer=outbound.settings.vnext[0],user=peer.users[0],stream=outbound.streamSettings,security=stream.security || 'none',tls=stream.tlsSettings || {},reality=stream.realitySettings || {};
 const fields={server:peer.address,port:String(peer.port),uuid:user.id,encryption:user.encryption,flow:user.flow || '',network:stream.network,security,sni:tls.serverName || reality.serverName || '',fingerprint:tls.fingerprint || reality.fingerprint || '',publicKey:reality.publicKey || '',shortId:reality.shortId || '',pinnedPeerCertSha256:tls.pinnedPeerCertSha256 || '',alpn:(tls.alpn || []).join(',')};
 const p=store.importProfile({value:manualConfig('vless',fields)}),e=gatewayEditor(store.profileSnapshot(p.id));e.fields.port='1';store.updateProfile(p.id,{editor:e});e.fields.port=String(peer.port);store.updateProfile(p.id,{editor:e});process.stdout.write(store.profileSnapshot(p.id).config.config);
}finally{store.close();}
