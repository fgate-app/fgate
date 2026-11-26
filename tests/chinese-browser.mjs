import {chromium,expect} from '@playwright/test';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const zh=JSON.parse(readFileSync(new URL('../web/src/locales/zh-CN.json',import.meta.url),'utf8'));
const store=new Store(':memory:');
const server=createServer(store);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base,{waitUntil:'networkidle'});await page.getByTestId('language').click();await page.getByRole('option',{name:'简体中文',exact:true}).click();
 await expect(page.getByRole('heading',{name:'首次设置',exact:true})).toBeVisible();await page.reload();await expect(page.locator('html')).toHaveAttribute('lang','zh-CN');
 await page.getByLabel('用户名',{exact:true}).fill('admin');await page.getByLabel('密码',{exact:true}).fill('test password 12345');await page.getByRole('button',{name:'创建管理员'}).click();await page.getByTestId('overview-dashboard').waitFor();
 for(const path of ['/overview','/connections','/routes','/settings/network','/settings/dns','/clients','/settings/modules','/settings/users','/settings/ssh','/settings/logs']){
  await page.goto(base+path,{waitUntil:'networkidle'});await expect(page.locator('html')).toHaveAttribute('lang','zh-CN');
  const text=await page.locator('body').innerText();assert.ok(!/[А-Яа-яЁё]/.test(text),`Russian text on ${path}: ${text}`);
 }
 await page.goto(base+'/connections',{waitUntil:'networkidle'});
 await page.getByTestId('add-exit').click();await page.getByRole('menuitem',{name:'添加配置',exact:true}).click();
 for(const key of ['Добавить конфиг','Загрузить файл','Вручную']){
  await page.getByRole('tab',{name:zh[key],exact:true}).click();
  const dialog=page.locator('dialog[open]');await expect(dialog).toBeVisible();assert.ok(!/[А-Яа-яЁё]/.test(await dialog.innerText()));
  if(key==='Загрузить файл')await expect(dialog.getByRole('button',{name:zh['Выбрать файл'],exact:true})).toBeVisible();
  if(key==='Вручную')await expect(dialog.getByRole('combobox').first()).toBeVisible();
 }
 await page.getByRole('button',{name:zh['Отмена'],exact:true}).click();await expect(page.locator('dialog[open]')).toHaveCount(0);
 for(const theme of ['light','dark']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  for(const width of [1440,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`/tmp/fg-chinese-${theme}-${width}.png`,animations:'disabled'});}
 }
 assert.deepEqual(errors,[]);console.log('Chinese language selection, persistence, all main pages and mobile/light/dark layout passed.');
}finally{await browser?.close();await new Promise(r=>server.close(r));store.close();}
