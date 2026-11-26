import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';
const folder=mkdtempSync(join(tmpdir(),'fg-hy2-')),store=new Store(join(folder,'db.sqlite'));
const server=createServer(store);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`,pin='ab'.repeat(32);
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',message=>{if(/TypeError|ReferenceError|Unhandled error/.test(message.text()))errors.push(message.text());});
 await page.goto(base,{waitUntil:'networkidle'});await page.getByLabel('Username').fill('admin');await page.getByLabel('Password',{exact:true}).fill('fixture password 12345');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByTestId('overview-dashboard').waitFor();
 await page.goto(base+'/connections',{waitUntil:'networkidle'});await page.getByTestId('add-exit').click();await page.getByRole('menuitem',{name:/^(Add config|Добавить конфиг|添加配置)$/}).click();
 let dialog=page.locator('dialog[open]');
 await dialog.getByLabel('Link or configuration').fill(`hy2://user:fixture%40secret@vpn.example:8443?sni=tls.example&obfs=salamander&obfs-password=fixture-mask&pinSHA256=${pin}#HY2%20fixture`);
 await expect(dialog.getByLabel('Name',{exact:true})).toHaveValue('HY2 fixture');await expect(page.getByTestId('exit-detected')).toContainText('Hysteria 2');
 await page.getByTestId('dialog-add-exit').click();await dialog.waitFor({state:'hidden'});
 const row=page.getByTestId('exit-row').filter({hasText:'HY2 fixture'});await row.locator('.name-cell').click();
 dialog=page.locator('dialog[open]');await expect(dialog.getByLabel('Server',{exact:true})).toHaveValue('vpn.example');await expect(dialog.getByLabel('Port',{exact:true})).toHaveValue('8443');
 await expect(dialog.getByLabel('Password',{exact:true})).toHaveValue('user:fixture@secret');await expect(dialog.getByLabel('Obfuscation password',{exact:true})).toHaveValue('fixture-mask');await expect(dialog.getByLabel('Certificate SHA-256 fingerprint',{exact:true})).toHaveValue(pin);
 await expect(dialog.getByRole('switch',{name:'Skip certificate verification',exact:true})).not.toBeChecked();assert.equal(await dialog.getByLabel('Password',{exact:true}).getAttribute('type'),'password');
 await dialog.getByLabel('Port',{exact:true}).fill('9443');await dialog.getByRole('switch',{name:'Skip certificate verification',exact:true}).check();await page.screenshot({path:'/tmp/fg-hy2-desktop.png',animations:'disabled'});
 await page.getByTestId('dialog-add-exit').click();await dialog.waitFor({state:'hidden'});await row.locator('.name-cell').click();await expect(dialog.getByLabel('Port',{exact:true})).toHaveValue('9443');await expect(dialog.getByRole('switch',{name:'Skip certificate verification',exact:true})).toBeChecked();
 const profile=store.profiles().find(p=>p.name==='HY2 fixture'),saved=JSON.parse(store.profileSnapshot(profile.id).config.config);assert.equal(saved.fingerprint,pin);assert.equal(saved.password,'user:fixture@secret');assert.equal(saved['obfs-password'],'fixture-mask');
 await dialog.getByRole('combobox',{name:'Obfuscation',exact:true}).click();await page.getByRole('option',{name:'Optional',exact:true}).click();await expect(dialog.getByLabel('Obfuscation password',{exact:true})).toHaveCount(0);await page.getByTestId('dialog-add-exit').click();await dialog.waitFor({state:'hidden'});assert.equal(JSON.parse(store.profileSnapshot(profile.id).config.config)['obfs-password'],undefined);
 // Existing manual form, including validation and a switch in a normal form row.
 await page.getByTestId('add-exit').click();await page.getByRole('menuitem',{name:/^(Add config|Добавить конфиг|添加配置)$/}).click();await dialog.getByRole('tab',{name:'Manual',exact:true}).click();await dialog.getByRole('combobox',{name:'Proxy type',exact:true}).click();await page.getByRole('option',{name:'Hysteria 2',exact:true}).click();await dialog.getByLabel('Name',{exact:true}).fill('Manual HY2');await dialog.getByLabel('Server',{exact:true}).fill('manual.example');await dialog.getByLabel('Password',{exact:true}).fill('manual-fixture');
 await dialog.getByRole('combobox',{name:'Obfuscation',exact:true}).click();await page.getByRole('option',{name:'salamander',exact:true}).click();await page.getByTestId('dialog-add-exit').click();await expect(page.getByRole('alert').filter({hasText:'Specify Salamander'})).toBeVisible();assert.equal(store.profiles().filter(p=>p.protocol==='hysteria2').length,1);await dialog.getByLabel('Obfuscation password',{exact:true}).fill('manual-mask');await page.getByTestId('dialog-add-exit').click();await dialog.waitFor({state:'hidden'});assert.equal(store.profiles().filter(p=>p.protocol==='hysteria2').length,2);
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>localStorage.setItem('fg.locale','ru'));await page.reload({waitUntil:'networkidle'});await page.getByTestId('exit-row').filter({hasText:'HY2 fixture'}).locator('.name-cell').click();
 dialog=page.locator('dialog[open]');await expect(dialog.getByRole('switch',{name:'Не проверять сертификат',exact:true})).toBeChecked();await expect(dialog.getByLabel('SHA-256 отпечаток сертификата',{exact:true})).toHaveValue(pin);await dialog.getByLabel('SHA-256 отпечаток сертификата',{exact:true}).scrollIntoViewIfNeeded();assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth));await page.screenshot({path:'/tmp/fg-hy2-mobile.png',animations:'disabled'});await dialog.getByRole('button',{name:'Отмена',exact:true}).click();
 assert.deepEqual(errors,[]);console.log('Hysteria 2: URI import, standard/manual forms, protected credentials, certificate switch, validation, round-trip and mobile localization passed.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(folder,{recursive:true,force:true});}
