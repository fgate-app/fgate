import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../server/store.js';import {createServer} from '../server/index.js';
import {AccessPointService} from '../server/access-points/service.js';
const folder=mkdtempSync(join(tmpdir(),'fg-recursion-browser-')),store=new Store(join(folder,'db'));
const accessPoints=new AccessPointService(store,{stateDir:folder,runtime:{close:async()=>{}}});
accessPoints.repository.save({id:'fixture',host:'203.0.113.10',enabled:false,clients:[],secrets:{}});
const server=createServer(store,{accessPoints});await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));const base='http://127.0.0.1:'+server.address().port;
 await page.goto(base);await page.getByLabel('Username',{exact:true}).fill('admin');await page.getByLabel('Password',{exact:true}).fill('fixture password 12345');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByTestId('overview-dashboard').waitFor();await page.goto(base+'/connections');
 await page.getByTestId('add-exit').click();await page.getByRole('menuitem',{name:'Add config',exact:true}).click();const dialog=page.locator('dialog[open]');
 await dialog.getByLabel('Link or configuration').fill('vless://00000000-0000-4000-8000-000000000001@203.0.113.10:8443?security=none');await dialog.getByTestId('dialog-add-exit').click();await expect(dialog.getByText(/This server belongs to an access point/)).toBeVisible();assert.equal(store.profiles().filter(p=>!p.builtin).length,0);await expect(dialog).toBeVisible();
 await dialog.getByLabel('Link or configuration').fill('vless://00000000-0000-4000-8000-000000000001@198.51.100.8:443?security=none');await dialog.getByTestId('dialog-add-exit').click();await dialog.waitFor({state:'hidden'});assert.equal(store.profiles().filter(p=>!p.builtin).length,1);assert.deepEqual(errors,[]);console.log('Recursion error rendered; dialog preserved; external gateway imported successfully.');
}finally{await browser?.close();await new Promise(r=>server.close(r));await accessPoints.close();store.close();rmSync(folder,{recursive:true,force:true});}
