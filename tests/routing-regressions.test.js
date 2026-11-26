import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.js';
import { createServer } from '../server/index.js';
import { buildMihomoConfig } from '../server/mihomo.js';
import { defaultDnsSettings, validateDnsSettings } from '../server/dns-resolvers.js';

const dns = () => validateDnsSettings(defaultDnsSettings);
test('routing keeps explicit direct, wildcard domains and IPv6 source masks', () => {
  const config = buildMihomoConfig(dns(), {}, {
    profiles: [{id:'direct-id',engine:'direct'}], configs: [],
    devices: [{identifier:'2001:db8::9',routeId:'direct-id'}, {identifier:'aa:bb:cc:dd:ee:ff',routeId:'direct-id'}],
    groups: [{entries:['*.example.com','2001:db8::1','192.0.2.1'],routeId:'direct-id'}],
  });
  assert.match(config,/SRC-IP-CIDR,2001:db8::9\/128,DIRECT/);
  assert.doesNotMatch(config,/aa:bb:cc:dd:ee:ff\/32/);
  assert.match(config,/DOMAIN-WILDCARD,\*\.example.com,DIRECT/);
  assert.match(config,/IP-CIDR6,2001:db8::1\/128,DIRECT/);
  assert.match(config,/IP-CIDR,192.0.2.1\/32,DIRECT/);
});

test('SOCKS credentials decode safely and legacy socks URLs generate a usable proxy', () => {
  const config = buildMihomoConfig(dns(), {}, {
    profiles:[{id:'socks-id',engine:'socks5'}],
    configs:[{profile_id:'socks-id',engine:'socks5',config:'socks://user%40mail:p%22ass%3Aword@[::1]:1081'}],
    groups:[{entries:['example.com'],routeId:'socks-id'}],devices:[],
  });
  assert.ok(config.includes('username: "user@mail"'));
  assert.ok(config.includes('password: '+JSON.stringify('p"ass:word')));
  assert.ok(config.includes('server: "::1"'));
  assert.match(config,/DOMAIN-SUFFIX,example.com,p-socks-id-grp/);
});

test('route API uses its own store, resolves pinned MACs, awaits apply and preserves referenced exits', async () => {
  const store = new Store(':memory:');
  let snapshot, finished=false, fail=false;
  const supervisor={status:()=>({state:'running'}),setRoutes:(...args)=>{snapshot=args;},reapply:async()=>{
    await new Promise(resolve=>setTimeout(resolve,10));finished=true;
    return fail?{ok:false,error:'fixture apply rejected'}:{ok:true};
  }};
  const server=createServer(store,{supervisor});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  let cookie,csrf;
  const request=async(path,method,body)=>{
    const response=await fetch(base+'/api/'+path,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie,'X-CSRF-Token':csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const data=await response.json();
    return {response,data};
  };
  try {
    const setup=await request('auth/setup','POST',{username:'admin',password:'fixture password 12345'});
    cookie=setup.response.headers.get('set-cookie').split(';')[0];csrf=setup.data.csrf;
    const imported=await request('profiles/import','POST',{name:'proxy',value:'socks5://127.0.0.1:9000'});
    assert.equal(imported.response.status,201);
    assert.ok(snapshot[3].some(config=>config.profile_id===imported.data.id));
    finished=false;
    const group=await request('routes/groups','POST',{name:'group',entries:['example.com'],routeId:imported.data.id});
    assert.equal(group.response.status,201);assert.equal(finished,true);
    store.pinStaticLease({mac:'aa:bb:cc:dd:ee:ff',ip:'192.0.2.4'});
    const direct=store.profiles().find(profile=>profile.engine==='direct');
    const device=await request('routes/devices','POST',{name:'device',identifier:'AA:BB:CC:DD:EE:FF',routeId:direct.id});
    assert.equal(device.response.status,201);
    assert.equal(snapshot[0][0].identifier,'192.0.2.4');
    const removed=await request('profiles/'+imported.data.id,'DELETE');
    assert.equal(removed.response.status,400);
    assert.ok(store.profiles().some(profile=>profile.id===imported.data.id));
    fail=true;
    const update=await request('routes/groups/'+group.data.id,'PUT',{name:'changed'});
    assert.equal(update.response.status,400);
    assert.match(update.data.error,/Could not restore routing/);
    assert.equal(store.routeGroups().find(row=>row.id===group.data.id).name,'group');
  } finally {await new Promise(resolve=>server.close(resolve));store.close();}
});

test('zapret is a marked direct exit, never an absent SOCKS listener', () => {
  const config=buildMihomoConfig(dns(),{}, {
    profiles:[{id:'zapret-id',engine:'zapret'}],
    configs:[{profile_id:'zapret-id',engine:'zapret',config:'socks5://127.0.0.1:1080'}],
    devices:[],groups:[{entries:['googlevideo.com'],routeId:'zapret-id'}],
  });
  assert.match(config,/type: direct\n    udp: true\n    routing-mark: 268435456/);
  assert.doesNotMatch(config,/type: socks5|port: 1080/);
  assert.match(config,/DOMAIN-SUFFIX,googlevideo.com,p-zapret-i-grp/);
});
