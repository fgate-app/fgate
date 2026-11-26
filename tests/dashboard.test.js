import test from 'node:test';import assert from 'node:assert/strict';
import {createDashboardTraffic,connectedDeviceCount} from '../server/dashboard.js';
test('dashboard traffic uses global counters, coalesces, handles resets and unavailable core',async()=>{
 let time=0,calls=0,data={uploadTotal:100,downloadTotal:200,connections:[{},{}]};let failed=false;
 const collect=createDashboardTraffic(async()=>{calls++;if(failed)throw Error('offline');return data;},{now:()=>time});
 const [a,b]=await Promise.all([collect(),collect()]);assert.deepEqual(a,b);assert.equal(calls,1);assert.equal(a.uploadRate,null);assert.equal(a.connections,2);
 time=5000;data={...data,uploadTotal:600,downloadTotal:1200};assert.equal((await collect()).uploadRate,100);assert.equal((await collect()).downloadRate,200);
 time=10000;data={...data,uploadTotal:1,downloadTotal:1};assert.equal((await collect()).uploadRate,null);
 time=15000;failed=true;assert.equal((await collect()).available,false);
 time=20000;failed=false;assert.equal((await collect()).uploadRate,null,'recovery establishes a fresh baseline');
});
test('connected devices count deduplicates actual stations rather than remembered leases',async()=>{
 const setup={client:{type:'ap',interface:'wlan0'}};
 assert.equal(await connectedDeviceCount(setup,{run:async()=>({stdout:'Station aa:bb:cc:dd:ee:ff (on wlan0)\n\tsignal: -42 dBm\nStation AA:BB:CC:DD:EE:FF (on wlan0)\nStation 11:22:33:44:55:66 (on wlan0)\n'})}),2);
 assert.equal(await connectedDeviceCount(setup,{run:async()=>({stdout:''})}),0);
 assert.equal(await connectedDeviceCount(setup,{run:async()=>{throw Error('unavailable');}}),null);
 assert.equal(await connectedDeviceCount({client:{type:'ap',interface:';bad'}}),null);
});
test('dashboard API requires auth and returns aggregates without connection metadata',async()=>{
 const {Store}=await import('../server/store.js'),{createServer}=await import('../server/index.js');const store=new Store(':memory:');
 const supervisor={status:()=>({state:'running'}),controller:async()=>({uploadTotal:1024,downloadTotal:2048,connections:[{metadata:{host:'private-marker.example'}}]})};
 const server=createServer(store,{supervisor});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  assert.equal((await fetch(base+'/api/dashboard')).status,401);
  const setup=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'test password 12345'})});
  const response=await fetch(base+'/api/dashboard',{headers:{Cookie:setup.headers.get('set-cookie').split(';')[0]}});assert.equal(response.status,200);const data=await response.json();
  assert.equal(data.traffic.uploadTotal,1024);assert.equal(data.traffic.connections,1);assert.equal(data.counts.gateways,4);assert.equal(data.counts.accessPoints,0);assert.ok(!JSON.stringify(data).includes('private-marker'));assert.ok(data.memory.total>0);
 }finally{await new Promise(r=>server.close(r));store.close();}
});

test('top proxies attribute each flow once, retain closed-flow bytes and rank five gateways',async()=>{
 let time=0;
 const profiles=Array.from({length:7},(_,i)=>({id:String(i).padStart(8,'0'),name:'Gateway '+i,engine:'mihomo',enabled:true}));
 let connections=profiles.map((p,i)=>({id:p.id,chains:['p-'+p.id+'-grp','p-'+p.id,'p-'+p.id],upload:10,download:i*100}));
 const collect=createDashboardTraffic(async()=>({uploadTotal:1000,downloadTotal:5000,connections}),{now:()=>time,profiles:()=>profiles});
 const first=await collect();assert.equal(first.topProxies.length,5);assert.equal(first.topProxies[0].name,'Gateway 6');assert.equal(first.topProxies[0].download,600);
 time=5000;connections=[{...connections[6],download:650}];const second=await collect();assert.equal(second.topProxies[0].download,650);assert.equal(second.topProxies[1].download,500,'closed flows remain in observed totals');
 time=10000;connections=[];assert.equal((await collect()).topProxies[0].download,650);
});
