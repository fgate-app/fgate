import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';
const folder=mkdtempSync(join(tmpdir(),'fg-mihomo-ui-')),store=new Store(join(folder,'db.sqlite'));
const server=createServer(store);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const base='http://127.0.0.1:'+server.address().port;
 await page.goto(base,{waitUntil:'networkidle'});await page.getByLabel('Username').fill('admin');await page.getByLabel('Password',{exact:true}).fill('fixture password 12345');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByTestId('overview-dashboard').waitFor();
 await page.goto(base+'/connections',{waitUntil:'networkidle'});
 async function open(){await page.getByTestId('add-exit').click();await page.getByRole('menuitem',{name:'Add config',exact:true}).click();return page.locator('dialog[open]:not([inert])');}
 let dialog=await open();await dialog.getByRole('tab',{name:'Upload file',exact:true}).click();
 await dialog.locator('input[type=file]').setInputFiles({name:'proxies.yaml',mimeType:'application/yaml',buffer:Buffer.from('proxies:\n - name: Trojan fixture\n   type: trojan\n   server: 192.0.2.1\n   port: 443\n   password: fixture-secret\n   alpn: [h2]\n   ws-opts: {path: /proxy, headers: {Host: cdn.example.com}}\n - name: HTTP fixture\n   type: http\n   server: 192.0.2.2\n   port: 8080\n')});
 await page.getByTestId('dialog-add-exit').click();await expect(page.getByRole('dialog',{name:'Select connections',exact:true})).toBeVisible();await page.getByTestId('gateway-add-selected').click();await page.locator('dialog[open]:not([inert])').waitFor({state:'hidden'});
 assert.ok(store.profiles().some(p=>p.name==='Trojan fixture'));assert.ok(store.profiles().some(p=>p.name==='HTTP fixture'));
 const row=page.getByTestId('exit-row').filter({hasText:'Trojan fixture'});await row.locator('.name-cell').click();dialog=page.locator('dialog[open]:not([inert])');
 await expect(dialog.getByLabel('Server',{exact:true})).toHaveValue('192.0.2.1');await expect(dialog.getByLabel('Password',{exact:true})).toHaveAttribute('type','password');
 await expect(dialog.getByLabel('Advanced proxy options (JSON)',{exact:true})).toHaveValue(/cdn\.example\.com/);await dialog.getByLabel('Port',{exact:true}).fill('8443');await page.getByTestId('dialog-add-exit').click();await dialog.waitFor({state:'hidden'});
 let node=JSON.parse(store.profileSnapshot(store.profiles().find(p=>p.name==='Trojan fixture').id).config.config).mihomo;assert.equal(node.port,8443);assert.equal(node['ws-opts'].headers.Host,'cdn.example.com');assert.deepEqual(node.alpn,['h2']);
 dialog=await open();await dialog.getByRole('tab',{name:'Manual',exact:true}).click();await dialog.getByRole('combobox',{name:'Proxy type',exact:true}).click();await page.getByRole('option',{name:'AnyTLS',exact:true}).click();await dialog.getByLabel('Name',{exact:true}).fill('AnyTLS fixture');await dialog.getByLabel('Server',{exact:true}).fill('192.0.2.3');await dialog.getByLabel('Password',{exact:true}).fill('fixture');await dialog.getByRole('switch',{name:'Skip certificate verification',exact:true}).check();await page.getByTestId('dialog-add-exit').click();await dialog.waitFor({state:'hidden'});
 for(const [locale,label] of [['en','Advanced proxy options (JSON)'],['ru','Дополнительные параметры прокси (JSON)'],['zh-CN','高级代理选项（JSON）']]){
  await page.setViewportSize({width:locale==='en'?1280:390,height:900});await page.evaluate(locale=>localStorage.setItem('fg.locale',locale),locale);await page.reload({waitUntil:'networkidle'});await page.getByTestId('exit-row').filter({hasText:'AnyTLS fixture'}).locator('.name-cell').click();dialog=page.locator('dialog[open]:not([inert])');await expect(dialog.getByLabel(label,{exact:true})).toBeVisible();await dialog.getByLabel(label,{exact:true}).scrollIntoViewIfNeeded();assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth));await page.screenshot({path:'/tmp/fg-mihomo-'+locale+'.png',animations:'disabled'});await dialog.locator('.dialog-close').click();
 }
 assert.deepEqual(errors,[]);console.log('Mihomo UI: YAML multi-selection, native settings round-trip, manual AnyTLS, password protection, EN/RU/ZH desktop/mobile passed.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(folder,{recursive:true,force:true});}
