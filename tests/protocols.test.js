import test from 'node:test';
import assert from 'node:assert/strict';
import { protocols, getProtocol } from '../web/src/lib/protocols.js';
test('protocol icon registry has unique identifiers and safe fallbacks',()=>{
 assert.equal(new Set(protocols.map(p=>p.id)).size,protocols.length);
 for(const p of protocols){assert.ok(p.path.length>0);assert.match(p.color,/^#[0-9a-f]{6}$/i);assert.equal(getProtocol(p.id).id,p.id);for(const alias of p.aliases)assert.equal(getProtocol(alias).id,p.id);}
 assert.equal(getProtocol('WG').id,'wireguard');assert.equal(getProtocol('hy2').id,'hysteria2');assert.equal(getProtocol('unsupported').id,'other');assert.equal(getProtocol(null).id,'other');
 assert.equal(getProtocol('outline').kind,'provided');
});

test('provided icons share geometry across protocol families and Direct uses Material',()=>{
 assert.deepEqual(getProtocol('vmess').shapes,getProtocol('vless').shapes);
 for(const protocol of ['ssr','outline','shadowsocks','ss2022'])assert.deepEqual(getProtocol(protocol).shapes,getProtocol('ss').shapes);
 assert.equal(getProtocol('direct').source,'Material Design Icons');
 assert.equal(getProtocol('socks4').label,'SOCKS4');
 assert.deepEqual(getProtocol('socks5').shapes,getProtocol('socks4').shapes);
 assert.ok(getProtocol('vless').shapes.some(shape=>shape.fillRule==='evenodd'));
});

test('Tor and Lantern have original square SVG symbols instead of the unknown icon',()=>{
 for(const id of ['tor','lantern']){
  const item=getProtocol(id);assert.equal(item.id,id);assert.equal(item.kind,'symbol');assert.equal(item.source,'FreedomGate SVG');assert.equal(item.viewBox,'0 0 24 24');assert.ok(item.shapes.length>1);
  assert.notEqual(item.path,getProtocol('other').path);
 }
});
