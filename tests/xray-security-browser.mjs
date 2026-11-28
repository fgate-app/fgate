import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';
import {uri} from './fixtures/vless-matrix.js';
const folder=mkdtempSync(join(tmpdir(),'fg-vless-matrix-')),store=new Store(join(folder,'db.sqlite'));
const server=createServer(store);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base,{waitUntil:'networkidle'});await page.getByLabel('Username').fill('admin');await page.getByLabel('Password',{exact:true}).fill('fixture password 12345');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByTestId('overview-dashboard').waitFor();await page.goto(base+'/connections',{waitUntil:'networkidle'});
 const pin='ab'.repeat(32),key=Buffer.alloc(1952,2).toString('base64url');
 const rows=[{network:'ws',security:'tls',name:'Advanced TLS'},{network:'tcp',security:'reality',name:'Advanced REALITY'}];
 for(const item of rows){
  const link=new URL(uri(item));link.hash=item.name;if(item.security==='tls')link.searchParams.set('pcs',pin);else {link.searchParams.set('pqv',key);link.searchParams.set('spiderX','/native');link.searchParams.delete('spx');}
  await page.getByTestId('add-exit').click();await page.getByRole('menuitem',{name:'Add config',exact:true}).click();let dialog=page.locator('dialog[open]');await dialog.getByLabel('Link or configuration').fill(link.href);await page.getByTestId('dialog-add-exit').click();await dialog.waitFor({state:'hidden'});
  const row=page.getByTestId('exit-row').filter({hasText:item.name});await row.locator('.name-cell').click();dialog=page.locator('dialog[open]');
  const accordion=dialog.getByRole('button',{name:'Advanced settings',exact:true});await expect(accordion).toHaveAttribute('aria-expanded','true');
  if(item.security==='tls'){
   await expect(dialog.getByLabel('Certificate SHA-256 pins',{exact:true})).toHaveValue(pin);await dialog.getByLabel('ALPN',{exact:true}).fill('h2');await expect(dialog.getByText('WebSocket needs HTTP/1.1. Check ALPN on both client and server.',{exact:true})).toBeVisible();await dialog.getByLabel('ALPN',{exact:true}).fill('http/1.1');await dialog.getByLabel('Certificate names',{exact:true}).fill('fixture.test');
  }else {await expect(dialog.getByLabel('ML-DSA-65 verification key',{exact:true})).toHaveValue(key);await dialog.getByLabel('SpiderX',{exact:true}).fill('/edited');}
  await page.getByTestId('dialog-add-exit').click();await dialog.waitFor({state:'hidden'});await row.locator('.name-cell').click();dialog=page.locator('dialog[open]');
  if(item.security==='tls')await expect(dialog.getByLabel('ALPN',{exact:true})).toHaveValue('http/1.1');else await expect(dialog.getByLabel('SpiderX',{exact:true})).toHaveValue('/edited');
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 }
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>localStorage.setItem('fg.locale','ru'));await page.reload({waitUntil:'networkidle'});await page.getByTestId('exit-row').filter({hasText:'Advanced TLS'}).locator('.name-cell').click();const dialog=page.locator('dialog[open]');await dialog.getByLabel('SHA-256 сертификатов',{exact:true}).scrollIntoViewIfNeeded();await expect(dialog.getByLabel('SHA-256 сертификатов',{exact:true})).toHaveValue(pin);assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth));await page.screenshot({path:'/tmp/fg-xray-security-mobile.png',animations:'disabled'});
 assert.deepEqual(errors,[]);console.log('Xray advanced TLS/REALITY: import, accordion, edits, reopen, ALPN hints and mobile localization passed.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(folder,{recursive:true,force:true});}
