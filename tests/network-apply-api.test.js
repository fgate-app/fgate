import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';

test('one network action applies and persists settings, while rejected changes keep the saved configuration', async () => {
  const store = new Store(':memory:');
  const interfaces = [{name:'eth0',type:'ethernet',carrier:true},{name:'wlan0',type:'wifi',state:'up',carrier:true}];
  const original = {uplink:{interface:'eth0'},client:{interface:'wlan0',type:'ap',ssid:'original',password:'testpass123',subnet:'10.20.0.1/24'},dhcp:{start:'10.20.0.100',end:'10.20.0.200'}};
  store.updateNetworkSettings(original,interfaces);
  let rejected = false, applied;
  const server = createServer(store, {interfaces:()=>interfaces, networkApply:async setup=>{applied=setup;return rejected?{ok:false,error:'helper rejected'}:{ok:true};},zapretApply:async()=>({ok:true})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port+'/api/';
  try {
    const login=await fetch(url+'auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'fixture password 12345'})});
    const session=await login.json();
    const headers={'Content-Type':'application/json',Cookie:login.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':session.csrf};
    const draft=structuredClone(original);draft.client.ssid='new network';
    const response=await fetch(url+'network/apply',{method:'POST',headers,body:JSON.stringify(draft)});
    assert.equal(response.status,200);assert.equal(applied.client.ssid,'new network');assert.equal(store.networkSettings().client.ssid,'new network');
    rejected=true;draft.client.ssid='rejected network';
    const failed=await fetch(url+'network/apply',{method:'POST',headers,body:JSON.stringify(draft)});
    assert.equal(failed.status,502);assert.equal(store.networkSettings().client.ssid,'new network');
    const saved=await(await fetch(url+'network',{headers})).json();assert.equal(saved.setup.client.ssid,'new network');
  } finally {await new Promise(resolve=>server.close(resolve));store.close();}
});
