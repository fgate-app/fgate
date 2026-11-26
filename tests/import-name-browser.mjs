import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const folder=mkdtempSync(join(tmpdir(),'fg-mobile-')),child=spawn(process.execPath,['server/index.js'],{env:{...process.env,PORT:'18884',FREEDOMGATE_DB:join(folder,'db.sqlite')},stdio:['ignore','pipe','pipe']});let browser;
try{
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('Server failed')));});
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:390,height:844}}),base='http://127.0.0.1:18884',errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/clients',route=>route.fulfill({json:{clients:[{mac:'aa:bb:cc:dd:ee:ff',ip:'10.20.0.115',hostname:'Pixel 7',online:true,traffic:{upload:1024,download:4096},expiresAt:Date.now()+600000}]}}));
 await page.goto(base,{waitUntil:'networkidle'});await page.getByLabel('Username').fill('admin');await page.getByLabel('Password',{exact:true}).fill('test password 12345');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByTestId('overview-dashboard').waitFor();
 await page.goto(base+'/connections',{waitUntil:'networkidle'});
 await page.getByTestId('add-exit').click();await page.getByRole('menuitem',{name:/^(Add config|Добавить конфиг|添加配置)$/}).click();const dialog=page.getByRole('dialog'),name=dialog.getByLabel('Name',{exact:true}),link=dialog.getByLabel('Link or configuration');
 await link.fill('ss://fixture#'+encodeURIComponent('Москва SS'));assert.equal(await name.inputValue(),'Москва SS');
 await link.fill('socks5://127.0.0.1:1080#'+encodeURIComponent('Gateway + Test'));assert.equal(await name.inputValue(),'Gateway + Test');
 await name.fill('Manual import name');await link.fill('socks5://127.0.0.1:1080#Other');assert.equal(await name.inputValue(),'Manual import name');
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByTestId('add-exit').click();await page.getByRole('menuitem',{name:/^(Add config|Добавить конфиг|添加配置)$/}).click();await link.fill('socks5://127.0.0.1:1080#'+encodeURIComponent('Авто Gateway'));assert.equal(await name.inputValue(),'Авто Gateway');
 await dialog.getByTestId('dialog-add-exit').click();await dialog.waitFor({state:'hidden'});
 const row=page.getByTestId('exit-row').filter({hasText:'Авто Gateway'});await row.waitFor();await row.locator('.name-cell').click();
 assert.equal(await name.inputValue(),'Авто Gateway');await dialog.getByRole('tab',{name:'Reload config',exact:true}).click();await dialog.getByLabel('Link or configuration',{exact:true}).fill('socks5://127.0.0.1:1081#Replacement');assert.equal(await name.inputValue(),'Авто Gateway');
 await name.fill('Renamed Gateway');await dialog.getByTestId('dialog-add-exit').click();await dialog.waitFor({state:'hidden'});await page.getByTestId('exit-row').filter({hasText:'Renamed Gateway'}).waitFor();
 await page.reload({waitUntil:'networkidle'});await page.getByTestId('exit-row').filter({hasText:'Renamed Gateway'}).waitFor();
 assert.deepEqual(errors,[]);console.log('Import auto-fills link names, preserves manual input, resets dialogs and allows persistent gateway renaming.');
}finally{await browser?.close();child.kill();await new Promise(resolve=>child.once('exit',resolve));rmSync(folder,{recursive:true,force:true});}
