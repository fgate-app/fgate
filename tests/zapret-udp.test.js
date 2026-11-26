import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {strategyArgs,strategyProfiles,udpQueuePorts,planStrategy,normalizeUdpSettings} from '../server/zapret.js';
import {ZAPRET_PRESETS,ZAPRET_MARK,zapretMark,ZAPRET_UDP_DEFAULTS} from '../shared/zapret.js';
const onlyUdp={http:false,https:false,quic:false,udp:true,udpServicePorts:'3478-3481,50000-50100'};

test('legacy settings keep QUIC ports and leave general UDP disabled; new settings survive reads',()=>{
 const store=new Store(':memory:');try{
  store.db.prepare('INSERT INTO zapret_settings VALUES(1,?)').run(JSON.stringify({quic:true,udpPorts:'8443'}));
  assert.equal(store.zapretSettings().udp,false);assert.equal(store.zapretSettings().udpPorts,'8443');assert.equal(udpQueuePorts(store.zapretSettings()),'8443');
  const saved=store.updateZapretSettings({...onlyUdp,udpStrategy:'fake-quic',udpRepeats:'8'});
  assert.equal(saved.udpRepeats,8);assert.deepEqual(store.zapretSettings(),saved);
  assert.equal(saved.udpPorts,'8443');assert.equal(saved.udpServicePorts,onlyUdp.udpServicePorts);
 }finally{store.close();}
});
test('general UDP handles recognized and unknown datagrams with a bounded independent strategy',()=>{
 const args=strategyArgs('custom',{...onlyUdp,customStrategy:'multisplit:pos=1'});
 assert.ok(args.includes('--filter-udp='+onlyUdp.udpServicePorts));assert.ok(args.includes('--out-range=-n3'));assert.ok(args.includes('--payload=all'));
 assert.ok(args.includes('--filter-l7=wireguard,stun,discord,dtls,dht,utp_bt,dns,unknown'));
 assert.ok(args.includes('--lua-desync=fake:blob=0x00000000:payload=all:repeats=6'));assert.ok(!args.some(arg=>arg.includes('multisplit') || arg.includes('tcp_md5')));
 const quicFake=strategyArgs('md5sum',{...onlyUdp,udpStrategy:'fake-quic',udpRepeats:9});assert.ok(quicFake.includes('--lua-desync=fake:blob=fake_default_quic:payload=all:repeats=9'));
 assert.deepEqual(strategyArgs('nfqws2',{...onlyUdp,udp:false}),[]);
 assert.deepEqual(planStrategy({...onlyUdp,mode:'tpws'}).protocols,['udp']);assert.equal(planStrategy({...onlyUdp,mode:'tpws'}).strategy,'nfqws2');
});
test('QUIC precedes UDP fallback, stays independent, and all group marks get a UDP profile',()=>{
 const args=strategyArgs('nfqws2',{...onlyUdp,quic:true,udpPorts:'50000'});
 assert.ok(args.indexOf('--filter-l7=quic')<args.indexOf('--payload=all'));assert.equal(args.filter(arg=>arg==='--new').length,1);
 const profiles=strategyProfiles(onlyUdp);
 for(const mark of [ZAPRET_MARK,...ZAPRET_PRESETS.map(p=>zapretMark(p.id))])assert.ok(profiles.includes(`--filter-mark=0x${mark.toString(16)}/0xffffffff`));
 assert.equal(profiles.filter(arg=>arg==='--out-range=-n3').length,ZAPRET_PRESETS.length+1);
});
test('nftables UDP ports form a single merged set and disabling UDP removes its ports',()=>{
 assert.equal(udpQueuePorts({...onlyUdp,quic:true,udpPorts:'443,3479-3483,50001'}),'443,3478-3483,50000-50100');
 assert.equal(udpQueuePorts({...onlyUdp,udp:false}),'');assert.equal(udpQueuePorts({...onlyUdp,udp:false,quic:true}),'443');
 assert.equal(udpQueuePorts({http:false,https:false,quic:false}), '');
});
test('invalid UDP configuration is rejected before persistence',()=>{
 const store=new Store(':memory:');try{
  const before=store.zapretSettings();
  for(const input of [{udp:'yes'},{udpServicePorts:'1-65536'},{udpServicePorts:'443; drop'},{udpServicePorts:'0'},{udpServicePorts:'1,'.repeat(300)},{udpStrategy:'custom'},{udpRepeats:0},{udpRepeats:21},{udpRepeats:1.5},{udpRepeats:''}]){
   assert.throws(()=>store.updateZapretSettings(input));assert.deepEqual(store.zapretSettings(),before);
  }
  assert.deepEqual(normalizeUdpSettings(),ZAPRET_UDP_DEFAULTS);
 }finally{store.close();}
});
