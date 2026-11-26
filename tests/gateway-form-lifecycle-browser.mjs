import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';
const folder=mkdtempSync(join(tmpdir(),'fg-gateway-lifecycle-')),store=new Store(join(folder,'db.sqlite'));
const server=createServer(store);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',message=>{if(/TypeError|ReferenceError|Unhandled error/.test(message.text()))errors.push(message.text());});
 await page.goto(base,{waitUntil:'networkidle'});await page.getByLabel('Username').fill('admin');await page.getByLabel('Password',{exact:true}).fill('fixture password 12345');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByTestId('overview-dashboard').waitFor();
 await page.goto(base+'/connections',{waitUntil:'networkidle'});
 store.importProfile({name:'VLESS fixture',value:'vless://00000000-0000-4000-8000-000000000001@example.com:443?security=none'});
 await page.reload({waitUntil:'networkidle'});
 await page.getByTestId('add-exit').click();await page.getByRole('menuitem',{name:/^(Add config|Добавить конфиг|添加配置)$/}).click();let dialog=page.locator('dialog[open]');await dialog.getByRole('tab',{name:'Manual',exact:true}).click();await dialog.getByLabel('Server',{exact:true}).fill('manual.example');await dialog.getByLabel('UUID',{exact:true}).fill('00000000-0000-4000-8000-000000000001');
 await dialog.getByRole('combobox',{name:'Security',exact:true}).click();await page.getByRole('option',{name:'none',exact:true}).click();await dialog.getByRole('combobox',{name:'Transport',exact:true}).click();await page.getByRole('option',{name:'ws',exact:true}).click();await dialog.getByLabel('Path',{exact:true}).fill('/tunnel');
 await page.getByTestId('dialog-add-exit').click();await dialog.waitFor({state:'hidden'});await expect(page.getByTestId('add-exit')).toBeEnabled();
 await page.getByTestId('exit-row').filter({hasText:'VLESS fixture'}).locator('.name-cell').click();
 await expect(dialog.getByRole('tab',{name:'Parameters',exact:true})).toBeVisible({timeout:3000});assert.deepEqual(errors,[]);console.log('Gateway lifecycle: manual VLESS transport selection, close and immediate reopen without Vue renderer errors passed');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(folder,{recursive:true,force:true});}
