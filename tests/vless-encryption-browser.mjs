import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';
const folder=mkdtempSync(join(tmpdir(),'fg-vless-matrix-')),store=new Store(join(folder,'db.sqlite'));
const server=createServer(store);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base,{waitUntil:'networkidle'});await page.getByLabel('Username').fill('admin');await page.getByLabel('Password',{exact:true}).fill('fixture password 12345');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByTestId('overview-dashboard').waitFor();await page.goto(base+'/connections',{waitUntil:'networkidle'});
 const enc='mlkem768x25519plus.native.0rtt.'+Buffer.alloc(32,1).toString('base64url');
 await page.getByTestId('add-exit').click();await page.getByRole('menuitem',{name:'Add config',exact:true}).click();let dialog=page.locator('dialog[open]');await dialog.getByRole('tab',{name:'Manual',exact:true}).click();await dialog.getByLabel('Name',{exact:true}).fill('Encryption fixture');await dialog.getByLabel('Server',{exact:true}).fill('fixture.test');await dialog.getByLabel('UUID',{exact:true}).fill('00000000-0000-4000-8000-000000000001');
 const field=()=>dialog.getByLabel('VLESS Encryption',{exact:true});await expect(field()).toHaveValue('none');await expect(field()).toHaveAttribute('type','password');await field().fill(enc);await dialog.getByRole('combobox',{name:'Security',exact:true}).click();await page.getByRole('option',{name:'tls',exact:true}).click();await page.getByTestId('dialog-add-exit').click();await dialog.waitFor({state:'hidden'});
 const row=page.getByTestId('exit-row').filter({hasText:'Encryption fixture'});await row.locator('.name-cell').click();dialog=page.locator('dialog[open]');await expect(field()).toHaveValue(enc);const revised=enc.replace('native.0rtt','xorpub.1rtt');await field().fill(revised);await page.getByTestId('dialog-add-exit').click();await dialog.waitFor({state:'hidden'});await row.locator('.name-cell').click();dialog=page.locator('dialog[open]');await expect(field()).toHaveValue(revised);
 const profile=store.profiles().find(p=>p.name==='Encryption fixture'),before=store.profileSnapshot(profile.id);await field().fill('invalid-secret-authentication-material');await page.getByTestId('dialog-add-exit').click();const alert=page.getByRole('alert').filter({hasText:'Invalid VLESS Encryption settings.'});await expect(alert).toBeVisible();assert.ok(!(await alert.textContent()).includes('invalid-secret'));assert.deepEqual(store.profileSnapshot(profile.id),before);await field().fill(revised);await alert.waitFor({state:'hidden',timeout:10000});
 await page.setViewportSize({width:390,height:844});await field().scrollIntoViewIfNeeded();assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth));await page.screenshot({path:'/tmp/fg-vless-encryption-mobile.png',animations:'disabled'});await page.getByTestId('dialog-add-exit').click();await dialog.waitFor({state:'hidden'});
 assert.deepEqual(errors,[]);console.log('VLESS Encryption: default none, password field, create/edit/reopen, invalid atomic save, privacy and mobile passed.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(folder,{recursive:true,force:true});}
