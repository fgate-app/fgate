import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';
const store=new Store(':memory:');
store.db.prepare('INSERT INTO zapret_settings VALUES(1,?)').run(JSON.stringify({quic:true,udpPorts:'8443'}));
const applied=[];
const server=createServer(store,{zapretApply:async input=>{applied.push(input);return {ok:true};}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.getByLabel('Username').fill('admin');await page.getByLabel('Password',{exact:true}).fill('fixture password 12345');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByTestId('overview-dashboard').waitFor();
 async function open(advanced){await page.goto(base+'/connections');await page.getByTestId('exit-row').filter({hasText:'zapret'}).locator('.row-menu-trigger').click();const locale=await page.locator('html').getAttribute('lang');await page.getByRole('menuitem',{name:{en:'Settings',ru:'Настройки','zh-CN':'设置'}[locale],exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();await dialog.getByRole('button',{name:advanced,exact:true}).click();return dialog;}
 let dialog=await open('Advanced settings');
 const udp=dialog.getByRole('switch',{name:'Process UDP other than QUIC',exact:true});await expect(udp).not.toBeChecked();await expect(dialog.getByLabel('QUIC ports')).toHaveValue('8443');
 await udp.click();await expect(dialog.getByTestId('zapret-udp-ports')).toBeVisible();await dialog.getByTestId('zapret-udp-ports').fill('3478-3481,50000-50100');
 await dialog.getByTestId('zapret-udp-strategy').click();await page.getByRole('option',{name:'Fake QUIC packets',exact:true}).click();await dialog.getByTestId('zapret-udp-repeats').fill('8');
 await dialog.getByLabel('Bypass method',{exact:true}).click();await page.getByRole('option',{name:'YouTube (TLS + QUIC)',exact:true}).click();
 await dialog.getByRole('button',{name:'Save',exact:true}).click();await expect(dialog).not.toBeVisible();assert.equal(applied.at(-1).settings.strategy,'youtube');assert.equal(applied.at(-1).settings.udp,true);assert.equal(applied.at(-1).settings.udpRepeats,8);
 dialog=await open('Advanced settings');await expect(dialog.getByRole('switch',{name:'Process UDP other than QUIC',exact:true})).toBeChecked();await expect(dialog.getByTestId('zapret-udp-ports')).toHaveValue('3478-3481,50000-50100');
 const valid=store.zapretSettings();await dialog.getByTestId('zapret-udp-ports').fill('0');await dialog.getByRole('button',{name:'Save',exact:true}).click();await expect(page.locator('.toast.is-error .toast-text').last()).toHaveText('Invalid zapret port list.');assert.deepEqual(store.zapretSettings(),valid);
 await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
 for(const [locale,advanced,label,method] of [['ru','Дополнительные настройки','Обрабатывать UDP кроме QUIC','Способ обхода UDP'],['zh-CN','高级设置','处理 QUIC 以外的 UDP','UDP 绕过方式']]){
  await page.evaluate(value=>localStorage.setItem('fg.locale',value),locale);await page.setViewportSize({width:390,height:844});dialog=await open(advanced);
  await expect(dialog.getByRole('switch',{name:label,exact:true})).toBeChecked();await expect(dialog.getByLabel(method, {exact:true})).toBeVisible();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await dialog.getByTestId('zapret-udp-repeats').scrollIntoViewIfNeeded();
  await page.screenshot({path:`/tmp/fg-zapret-udp-${locale}.png`,animations:'disabled'});await page.keyboard.press('Escape');
 }
 assert.deepEqual(errors,[]);console.log('UDP controls, persisted legacy/new settings, validation, Russian/Chinese translations and mobile layout passed.');
}finally{await browser?.close();await new Promise(r=>server.close(r));store.close();}
