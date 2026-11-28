import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';
import {gatewayEditor} from '../server/gateway-editor.js';
import {normalizeXrayProfile} from '../server/xray-profile.js';
import {combinations,uri} from './fixtures/vless-matrix.js';
const folder=mkdtempSync(join(tmpdir(),'fg-vless-matrix-')),store=new Store(join(folder,'db.sqlite'));
const server=createServer(store);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base,{waitUntil:'networkidle'});await page.getByLabel('Username').fill('admin');await page.getByLabel('Password',{exact:true}).fill('fixture password 12345');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByTestId('overview-dashboard').waitFor();await page.goto(base+'/connections',{waitUntil:'networkidle'});
 for(const item of combinations){
  const name=`Matrix ${item.network} ${item.security}`;console.log('Checking '+name);
  await page.getByTestId('add-exit').click();await page.getByRole('menuitem',{name:/^Add config$/}).click();let dialog=page.locator('dialog[open]');
  await dialog.getByLabel('Link or configuration').fill(uri(item)+'#'+encodeURIComponent(name));await page.getByTestId('dialog-add-exit').click();await dialog.waitFor({state:'hidden'});
  const row=page.getByTestId('exit-row').filter({hasText:name});await row.locator('.name-cell').click();dialog=page.locator('dialog[open]');
  await expect(dialog.getByRole('combobox',{name:'Transport',exact:true})).toHaveValue(item.network);await expect(dialog.getByRole('combobox',{name:'Security',exact:true})).toHaveValue(item.security);
  const profile=store.profiles().find(p=>p.name===name),before=normalizeXrayProfile(store.profileSnapshot(profile.id).config.config);
  await dialog.getByLabel('Port',{exact:true}).fill('8443');await page.getByTestId('dialog-add-exit').click();await dialog.waitFor({state:'hidden'});
  before.outbounds[0].settings.vnext[0].port=8443;assert.deepEqual(normalizeXrayProfile(store.profileSnapshot(profile.id).config.config),before,name);
  await row.locator('.name-cell').click();dialog=page.locator('dialog[open]');await expect(dialog.getByLabel('Port',{exact:true})).toHaveValue('8443');
  if(['ws','httpupgrade','xhttp','splithttp'].includes(item.network)){await expect(dialog.getByLabel('Path',{exact:true})).toHaveValue('/путь?ed=2048');await expect(dialog.getByLabel('Host',{exact:true})).toHaveValue('edge.example');}
  if(item.network==='grpc')await expect(dialog.getByLabel('gRPC service name',{exact:true})).toHaveValue('grpc-service');
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 }
 const badName='Matrix ws tls',bad=page.getByTestId('exit-row').filter({hasText:badName});await bad.locator('.name-cell').click();let dialog=page.locator('dialog[open]');
 await dialog.getByRole('combobox',{name:'Security',exact:true}).click();await page.getByRole('option',{name:'reality',exact:true}).click();await dialog.getByLabel('Reality public key',{exact:true}).fill('fixture-key');await page.getByTestId('dialog-add-exit').click();
 await expect(page.getByRole('alert').filter({hasText:'REALITY requires TCP'})).toBeVisible();assert.equal(gatewayEditor(store.profileSnapshot(store.profiles().find(p=>p.name===badName).id)).fields.security,'tls');
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 // Changed invalid draft requires the existing discard confirmation.
 const discard=page.getByRole('dialog').filter({hasText:'Unsaved changes will be lost.'});if(await discard.isVisible())await discard.getByRole('button',{name:'Exit',exact:true}).click();
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>localStorage.setItem('fg.locale','ru'));await page.reload({waitUntil:'networkidle'});
 const mobile=page.getByTestId('exit-row').filter({hasText:'Matrix splithttp reality'});await mobile.locator('.name-cell').click();dialog=page.locator('dialog[open]');await expect(dialog.getByLabel('Путь',{exact:true})).toHaveValue('/путь?ed=2048');assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth));await page.screenshot({path:'/tmp/fg-vless-roundtrip-mobile.png',animations:'disabled'});
 assert.deepEqual(errors,[]);console.log(`VLESS: ${combinations.length} transport/security combinations imported, edited, saved and reopened; incompatible REALITY rejected; mobile localization passed.`);
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(folder,{recursive:true,force:true});}
