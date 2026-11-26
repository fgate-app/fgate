import {chromium,expect} from '@playwright/test';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const store=new Store(':memory:'),server=createServer(store);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const base='http://127.0.0.1:'+server.address().port;
 await page.route('**/api/network',route=>route.fulfill({json:{interfaces:[],setup:store.networkSettings(),plan:[],warnings:['Ingress eth0 has no link. Internet access requires an active connection.']}}));
 assert.equal((await page.request.post(base+'/api/auth/setup',{data:{username:'admin',password:'fixture password 12345'}})).status(),200);
 for(const language of ['en','ru','zh-CN']){
  const dictionary=JSON.parse(readFileSync(new URL('../web/src/locales/'+language+'.json',import.meta.url),'utf8'));
  await page.goto(base);await page.evaluate(value=>localStorage.setItem('fg.locale',value),language);
  await page.goto(base+'/settings/users',{waitUntil:'networkidle'});
  const row=page.getByTestId('user-row').filter({hasText:'admin'});await row.locator('.row-menu-trigger').click();
  await page.getByRole('menuitem',{name:dictionary['Отключить'],exact:true}).click();
  await expect(page.locator('.toast.is-error').last()).toContainText(dictionary['You cannot disable or demote the last administrator.']);
  await page.screenshot({path:'/tmp/fg-refactor-error-'+language+'.png',animations:'disabled'});
  // Old saved errors use Russian values; they must also have an English fallback.
  await page.route('**/api/users/*',route=>route.request().method()==='PUT'?route.fulfill({status:400,json:{error:'Неподдерживаемый тип подключения.'}}):route.continue());
  await row.locator('.row-menu-trigger').click();await page.getByRole('menuitem',{name:dictionary['Отключить'],exact:true}).click();
  await expect(page.locator('.toast.is-error').filter({hasText:dictionary['Неподдерживаемый тип подключения.'] || dictionary['Unsupported connection type.']})).toBeVisible();
  await page.unroute('**/api/users/*');

  await page.goto(base+'/settings/network',{waitUntil:'networkidle'});
  const warning=dictionary['Ingress {value0} has no link. Internet access requires an active connection.'].replace('{value0}','eth0');
  await expect(page.locator('.alert').filter({hasText:warning})).toBeVisible();
  await page.screenshot({path:'/tmp/fg-refactor-warning-'+language+'.png',animations:'disabled'});
 }
 assert.deepEqual(errors,[]);console.log('English backend errors render correctly in en/ru/zh-CN without changing the administrator.');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));store.close();}
