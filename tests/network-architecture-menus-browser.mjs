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
const group=store.saveConnectionGroup(null,{name:'Map group',members:[vless.id,outline.id]});
const local={hostname:'Map client',mac:'02:00:00:00:00:02',ip:'192.0.2.10',online:true},remote={id:'remote-client',hostname:'Map remote',remote:true,accessPointId:'fixture-point',accessPointName:'Fixture cloud',online:true};
const currentClients=()=>[{...local,...(store.staticLease(local.mac)?{staticIp:store.staticLease(local.mac).ip}:{})},remote];
const writes=[];let updateState='current',updates=0;
const supervisor={status:()=>({state:'running',xray:{state:'running'},ssRelay:{state:'running'},torInstalled:true,tor:{fixture:{state:'ready'}},lanternInstalled:true,lantern:{fixture:{state:'running'}}}),telemetry:async profiles=>({available:true,profiles:Object.fromEntries(profiles.map(p=>[p.id,{httpStatus:'ok',available:true}])),groups:{}}),architecturePaths:()=>({available:true,paths:[]}),routeTraffic:()=>({available:false}),controller:async()=>({connections:[]})};
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
 await overview();assert.equal(await page.locator('[data-testid^="architecture-create-"]').count(),3);
 await page.getByTestId('architecture-create-gateway').click();await expect(page.getByRole('dialog').getByLabel('Name',{exact:true})).toHaveValue('');await closeDialog();
 await overview();await page.getByTestId('architecture-create-group').click();await expect(page.getByRole('dialog')).toContainText('New connection group');await expect(page.getByRole('dialog').getByLabel('Group name',{exact:true})).toHaveValue('');await closeDialog();
 await overview();await page.getByTestId('architecture-create-rule').focus();await page.keyboard.press('Enter');await expect(page.getByRole('dialog').getByLabel('Group name',{exact:true})).toHaveValue('');await closeDialog();
 await overview();await menu('port:eth-fixture');await page.getByRole('menuitem',{name:'Configure',exact:true}).click();await page.locator('.network-settings').waitFor();assert.equal(new URL(page.url()).pathname,'/settings/network');
 await overview();const mapItems=await menu('gateway:'+vless.id);await page.keyboard.press('Escape');await page.goto(base+'/connections',{waitUntil:'networkidle'});await page.getByTestId('exit-row').filter({hasText:'Map VLESS'}).getByRole('button',{name:'Actions',exact:true}).click();assert.deepEqual(await page.getByRole('menuitem').allTextContents(),mapItems.filter(item=>!['Enable','Disable'].includes(item)));await page.keyboard.press('Escape');
 await overview();await menu('gateway:'+vless.id);await page.getByRole('menuitem',{name:'Configure',exact:true}).click();await expect(page.getByRole('dialog').getByLabel('Name',{exact:true})).toHaveValue('Map VLESS');await closeDialog();
 await overview();await menu('gateway:'+vless.id);await page.getByRole('menuitem',{name:'Remove',exact:true}).click();await page.getByRole('dialog').waitFor();assert.ok(store.profiles().some(p=>p.id===vless.id));await page.getByRole('button',{name:'Cancel',exact:true}).click();
 for(const engine of ['direct','lantern','tor','zapret']){
  await overview();const profile=store.profiles().find(p=>p.engine===engine),items=await menu('gateway:'+profile.id);assert.ok(!items.includes('Remove'));assert.equal(items.includes('Configure'),['tor','zapret'].includes(engine));await page.keyboard.press('Escape');
 }
 await overview();await menu('rule:groups:'+rule.id);await page.getByRole('menuitem',{name:'Edit',exact:true}).click();await expect(page.getByRole('dialog').getByLabel('Group name',{exact:true})).toHaveValue('Map rule');await closeDialog();
 await overview();await menu('rule:groups:'+rule.id);await page.getByRole('menuitem',{name:'Remove',exact:true}).click();await page.getByRole('dialog').waitFor();assert.ok(store.routeGroups().some(r=>r.id===rule.id));await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await overview();await menu('group:'+group.id);await page.getByRole('menuitem',{name:'Edit',exact:true}).click();await page.getByRole('dialog').waitFor();await closeDialog();
 await overview();await menu('client:'+local.mac);await page.getByRole('menuitem',{name:'Pin address',exact:true}).click();await expect(page.getByRole('dialog').getByLabel('MAC address',{exact:true})).toHaveValue(local.mac);await page.getByTestId('dialog-save-static').click();await expect(page.locator('dialog[open]')).toHaveCount(0);assert.equal(store.staticLease(local.mac).ip,local.ip);
 await overview();const pinned=await menu('client:'+local.mac);assert.ok(pinned.includes('Change address')&&pinned.includes('Unpin address'));await page.getByRole('menuitem',{name:'Unpin address',exact:true}).click();await expect(page.getByTestId('client-list')).toBeVisible();await expect.poll(()=>Boolean(store.staticLease(local.mac))).toBe(false);
 await overview();const remoteItems=await menu('client:remote:'+remote.accessPointId+':'+remote.id);assert.deepEqual(remoteItems,['Show connections']);await page.getByRole('menuitem',{name:'Show connections',exact:true}).click();await expect(page).toHaveURL(/accessClient=remote-client/);
 for(const [id,type] of [['xray','VLESS'],['outline','Shadowsocks / Outline'],['mihomo','SOCKS5']]){
  await overview();const items=await menu('module:'+id);assert.equal(items.includes('Update'),id!=='outline');assert.equal(writes.length,0,'opening module menus must not check/update');await page.getByRole('menuitem',{name:'Add config',exact:true}).click();await expect(page.getByRole('dialog').getByRole('combobox',{name:'Proxy type',exact:true})).toHaveValue(type);await closeDialog();
 }
 for(const id of ['tor','lantern','frp']){await overview();assert.deepEqual(await menu('module:'+id),['Modules']);await page.keyboard.press('Escape');}
 await overview();await menu('module:xray');await page.getByRole('menuitem',{name:'Update',exact:true}).click();await page.getByRole('dialog',{name:'Update module',exact:true}).waitFor({timeout:10000});assert.deepEqual(writes,[{op:'check',id:'xray'}]);await page.getByTestId('install-module').click();await expect.poll(()=>updates).toBe(1);assert.deepEqual(writes.at(-1),{op:'update',id:'xray',version:'v99.0.0'});
 await overview();const viewport=page.locator('.architecture-viewport'),bounds=await viewport.boundingBox();await page.mouse.move(bounds.x+40,bounds.y+40);await page.mouse.down();await page.mouse.move(bounds.x+90,bounds.y+80,{steps:4});await page.mouse.up();assert.equal(await page.getByRole('menuitem').count(),0,'drag must not open a menu');
 await page.locator('[data-architecture-node="port:eth-fixture"]').focus();await page.keyboard.press('Enter');await expect(page.getByRole('menuitem',{name:'Configure',exact:true})).toBeFocused();await page.keyboard.press('Escape');
 const session=await (await page.request.get(base+'/api/auth/session')).json();await page.route('**/api/auth/session',route=>route.fulfill({json:{...session,user:{...session.user,role:'viewer'},permissions:[]}}));await overview();
 assert.equal(await page.locator('[data-testid^="architecture-create-"]').count(),0);assert.deepEqual(await menu('gateway:'+vless.id),['Go to rules','Show connections']);await page.keyboard.press('Escape');
 await overview();assert.deepEqual(await menu('module:xray'),['Modules']);await page.keyboard.press('Escape');
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Fit graph',exact:true}).click();await menu('port:eth-fixture');const popup=await page.locator('.row-menu').boundingBox();assert.ok(popup.x>=0&&popup.x+popup.width<=390&&popup.y>=0&&popup.y+popup.height<=844);await page.keyboard.press('Escape');
 assert.deepEqual(errors,[]);console.log('Map menus: table parity, engine/builtin differences, network/module links, route/group dialogs and delete confirmation, client pin/unpin/remote journal, module-specific config and safe check→confirm→update fixture, drag and mobile top-layer passed.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(folder,{recursive:true,force:true});}
