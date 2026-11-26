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
 async function menu(id){await page.locator(`[data-architecture-node="${id}"]`).click();await page.getByRole('menuitem').first().waitFor({timeout:6000});assert.equal(await page.locator('.row-menu').evaluate(node=>node.matches(':popover-open')),true);assert.deepEqual(errors,[]);return page.getByRole('menuitem').allTextContents();}
 async function closeDialog(){await page.keyboard.press('Escape');if(await page.getByRole('dialog',{name:'Exit without saving',exact:true}).isVisible())await page.getByRole('dialog',{name:'Exit without saving',exact:true}).getByRole('button',{name:'Exit',exact:true}).click();await expect(page.locator('dialog[open]')).toHaveCount(0);}
 await overview();await page.getByTestId('architecture-create-gateway').click();let dialog=page.getByRole('dialog');await dialog.getByLabel('Name',{exact:true}).fill('Created from map');await dialog.getByLabel('Link or configuration').fill('vless://00000000-0000-4000-8000-000000000002@192.0.2.30:443?security=none#Created');await page.getByTestId('dialog-add-exit').click();await expect(page.locator('dialog[open]')).toHaveCount(0);assert.ok(store.profiles().some(p=>p.name==='Created from map'));
 await overview();await page.getByTestId('architecture-create-group').click();dialog=page.getByRole('dialog');await dialog.getByLabel('Group name',{exact:true}).fill('Created map group');await dialog.getByRole('combobox').click();await page.getByRole('option',{name:'Map VLESS',exact:true}).click();await page.getByTestId('save-connection-group').click();await expect(page.locator('dialog[open]')).toHaveCount(0);assert.ok(store.connectionGroups().some(g=>g.name==='Created map group'&&g.members.includes(vless.id)));
 await overview();await page.getByTestId('architecture-create-rule').click();dialog=page.getByRole('dialog');await dialog.getByLabel('Group name',{exact:true}).fill('Created map rule');const input=dialog.getByTestId('route-entry-tags').locator('input.tag-input');await input.fill('created.example');await input.press('Enter');await dialog.getByLabel('Route',{exact:true}).click();await page.getByRole('option',{name:'Map VLESS',exact:true}).click();await page.getByTestId('dialog-save-group').click();await expect(page.locator('dialog[open]')).toHaveCount(0);assert.ok(store.routeGroups().some(g=>g.name==='Created map rule'&&g.entries.includes('created.example')&&g.routeId===vless.id));
 await overview();await page.setViewportSize({width:390,height:844});const title=await page.locator('.architecture-card .data-card-title').boundingBox(),search=await page.locator('.architecture-search').boundingBox();assert.ok(search.y>=title.y+title.height);await page.getByRole('button',{name:'Fit graph',exact:true}).click();await page.getByTestId('architecture-create-rule').click();await expect(page.getByRole('dialog').getByLabel('Group name',{exact:true})).toHaveValue('');await closeDialog();
 assert.deepEqual(errors,[]);console.log('Created gateway, group and rule from map and verified persisted data; mobile search on second row and create form passed.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(folder,{recursive:true,force:true});}
