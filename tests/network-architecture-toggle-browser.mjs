import {chromium,expect} from '@playwright/test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';
const folder=mkdtempSync(join(tmpdir(),'fg-map-menus-')),store=new Store(join(folder,'db.sqlite'));
const vless=store.importProfile({name:'Map VLESS',value:'vless://00000000-0000-4000-8000-000000000001@192.0.2.8:443?security=none#Map'});
const outline=store.importProfile({name:'Map Outline',value:'ss://'+Buffer.from('chacha20-ietf-poly1305:fixture-secret').toString('base64url')+'@192.0.2.9:443'});
const rule=store.addRouteGroup({name:'Map rule',entries:['example.test'],routeId:vless.id});
const deviceRule=store.addDeviceRoute({name:'Map device rule',identifier:'192.0.2.10',routeId:vless.id});
const group=store.saveConnectionGroup(null,{name:'Map group',members:[vless.id,outline.id]});
store.updateProfile(store.profiles().find(p=>p.engine==='tor').id,{enabled:true});
const local={hostname:'Map client',mac:'02:00:00:00:00:02',ip:'192.0.2.10',online:true},remote={id:'remote-client',hostname:'Map remote',remote:true,accessPointId:'fixture-point',accessPointName:'Fixture cloud',online:true};
const currentClients=()=>[{...local,...(store.staticLease(local.mac)?{staticIp:store.staticLease(local.mac).ip}:{})},remote];
const writes=[];let updateState='current',updates=0;
const supervisor={setRoutes:()=>{},reapply:async()=>({ok:true}),status:()=>({state:'running',xray:{state:'running'},ssRelay:{state:'running'},torInstalled:true,tor:{fixture:{state:'ready'}},lanternInstalled:true,lantern:{fixture:{state:'running'}}}),telemetry:async profiles=>({available:true,profiles:Object.fromEntries(profiles.map(p=>[p.id,{httpStatus:'ok',available:true}])),groups:{}}),architecturePaths:()=>({available:true,paths:[]}),routeTraffic:()=>({available:false}),controller:async()=>({connections:[]})};
const server=createServer(store,{supervisor,interfaces:()=>[{name:'eth-fixture',type:'ethernet',carrier:true,addresses:['192.0.2.2/24']}],modulesHelper:async(op,id,version)=>{
 if(op==='check'){writes.push({op,id});updateState='checking';setTimeout(()=>{updateState='available';},100);return {ok:true};}
 if(op==='update'){writes.push({op,id,version});updates++;updateState='current';return {ok:true};}
 return {ok:true,modules:['mihomo','xray','adguard','zapret','frp'].map(id=>({id,current:'v1.0.0',supported:id!=='frp',state:id==='xray'?updateState:'current',candidate:{version:'v99.0.0'},checkedAt:id==='xray'&&updateState==='available'?123:0}))};
}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/clients',route=>route.fulfill({json:{clients:currentClients()}}));
 await page.route('**/api/clients/static',async route=>{const body=route.request().postDataJSON();store.pinStaticLease(body);await route.fulfill({json:body});});
 await page.route('**/api/clients/static/**',async route=>{store.unpinStaticLease(decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop()));await route.fulfill({json:{ok:true}});});
 await page.route('**/api/dashboard/architecture',async route=>{const response=await route.fetch(),body=await response.json();body.clients=currentClients();await route.fulfill({json:body});});
 await page.goto(base);await page.getByLabel('Username').fill('admin');await page.getByLabel('Password',{exact:true}).fill('test password 12345');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByTestId('overview-dashboard').waitFor();
 async function overview(){await page.goto(base+'/overview',{waitUntil:'networkidle'});await page.locator('.architecture-node').first().waitFor();await page.getByRole('button',{name:'Fit graph',exact:true}).click();}
 async function menu(id){const ready=page.getByTestId('architecture-create-rule');if(await ready.isVisible())await expect(ready).toBeEnabled();await page.locator(`[data-architecture-node="${id}"]`).click();await page.getByRole('menuitem').first().waitFor({timeout:6000});assert.equal(await page.locator('.row-menu').evaluate(node=>node.matches(':popover-open')),true);assert.deepEqual(errors,[]);return page.getByRole('menuitem').allTextContents();}
 async function closeDialog(){await page.keyboard.press('Escape');if(await page.getByRole('dialog',{name:'Exit without saving',exact:true}).isVisible())await page.getByRole('dialog',{name:'Exit without saving',exact:true}).getByRole('button',{name:'Exit',exact:true}).click();await expect(page.locator('dialog[open]')).toHaveCount(0);}
 await overview();const initialView=await page.getByTestId('architecture-world').getAttribute('style');
 const direct=store.profiles().find(p=>p.engine==='direct');assert.ok(!(await menu('gateway:'+direct.id)).some(x=>['Enable','Disable'].includes(x)));await page.keyboard.press('Escape');
 for(const id of [vless.id,store.profiles().find(p=>p.engine==='tor').id]){
  await menu('gateway:'+id);await page.getByRole('menuitem',{name:'Disable',exact:true}).click();await expect.poll(()=>store.profiles().find(p=>p.id===id).enabled).toBe(false);await expect(page.locator(`[data-architecture-node="gateway:${id}"]`)).toHaveClass(/disabled/);assert.equal(new URL(page.url()).pathname,'/overview');assert.equal(await page.getByTestId('architecture-world').getAttribute('style'),initialView);
  await menu('gateway:'+id);await page.getByRole('menuitem',{name:'Enable',exact:true}).click();await expect.poll(()=>store.profiles().find(p=>p.id===id).enabled).toBe(true);
 }
 for(const [kind,id] of [['groups',rule.id],['devices',deviceRule.id]]){
  const node=page.locator(`[data-architecture-node="rule:${kind}:${id}"]`);await menu(`rule:${kind}:${id}`);await page.getByRole('menuitem',{name:'Disable',exact:true}).click();await expect(node).toHaveClass(/disabled/);assert.equal(new URL(page.url()).pathname,'/overview');
  await menu(`rule:${kind}:${id}`);await page.getByRole('menuitem',{name:'Enable',exact:true}).click();await expect.poll(()=>kind==='groups'?store.routeGroups().find(r=>r.id===id).enabled:store.deviceRoutes().find(r=>r.id===id).enabled).toBe(true);
 }
 await page.route('**/api/profiles/'+vless.id,route=>route.request().method()==='PUT'?route.fulfill({status:400,json:{error:'Fixture: toggle rejected'}}):route.continue());await menu('gateway:'+vless.id);await page.getByRole('menuitem',{name:'Disable',exact:true}).click();await expect(page.locator('.toast.is-error').filter({hasText:'Fixture: toggle rejected'})).toBeVisible();assert.equal(store.profiles().find(p=>p.id===vless.id).enabled,true);await menu('gateway:'+vless.id);assert.ok((await page.getByRole('menuitem').allTextContents()).includes('Disable'));await page.keyboard.press('Escape');
 await page.route('**/api/routes/groups/'+rule.id+'/enabled',route=>route.fulfill({status:400,json:{error:'Fixture: rule toggle rejected'}}));await menu('rule:groups:'+rule.id);await page.getByRole('menuitem',{name:'Disable',exact:true}).click();await expect(page.locator('.toast').filter({hasText:'Fixture: rule toggle rejected'})).toBeVisible();assert.equal(store.routeGroups().find(r=>r.id===rule.id).enabled,true);
 const session=await (await page.request.get(base+'/api/auth/session')).json();await page.route('**/api/auth/session',route=>route.fulfill({json:{...session,user:{...session.user,role:'viewer'},permissions:[]}}));await overview();for(const id of ['gateway:'+vless.id,'rule:groups:'+rule.id]){assert.ok(!(await menu(id)).some(x=>['Enable','Disable'].includes(x)));await page.keyboard.press('Escape');}
 assert.deepEqual(errors,[]);console.log('Map toggles: gateway/Tor and group/device rules both directions, refreshed graph without navigation/view reset, Direct/viewer exclusions and rejected gateway/rule changes passed.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(folder,{recursive:true,force:true});}
