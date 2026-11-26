import {DiagnosticBlocklist} from '../server/diagnostic-blocklist.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';
import assert from 'node:assert/strict';
const store=new Store(':memory:');let state='current',updates=0,frpState='stopped',torState='stopped',torInstalled=true,torUpdateState='current',torUpdateError=null,systemState='current',systemSupported=true,systemProgress=50,systemStage='web',systemAction='build',systemComponents={};
const listDirectory=mkdtempSync(join(tmpdir(),'fg-blocklist-browser-'));const list=new DiagnosticBlocklist({directory:listDirectory,fetchImpl:async()=>new Response('example.com\n')});
const server=createServer(store,{diagnosticBlocklist:list,diagnosticListFetch:async()=>new Response(JSON.stringify({sha:'b'.repeat(40)})),modulesHelper:async(op,id,version)=>{
 if(id==='system' && op==='check'){systemState='available';return {ok:true};}
 if(id==='system' && op==='update'){assert.equal(version,'a'.repeat(40));systemState='installing';systemComponents={lantern:{stage:'building',progress:35,startedAt:Date.now()},tor:{stage:'reuse',progress:100,startedAt:Date.now()}};return {ok:true};}
 if(op==='check'){state='available';return {ok:true};}
 if(op==='update'){assert.equal(id,'mihomo');assert.equal(version,'v99.0.0');updates++;state='updated';return {ok:true};}
 return {ok:true,modules:[{id:'system',current:'1111111',supported:systemSupported,state:systemState,progress:systemProgress,stage:systemStage,action:systemAction,components:systemComponents,startedAt:Date.now()-65000,candidate:{version:'a'.repeat(40)}},...['mihomo','xray','adguard','zapret','frp','tor'].map(id=>({id,...(id==='tor'?{installed:torInstalled}:{}),current:id==='mihomo' && state==='updated'?'v99.0.0':'v1.0.0',state:id==='mihomo'?state:id==='tor'?torUpdateState:'current',...(id==='tor'?{error:torUpdateError}:{}),supported:true,candidate:{version:'v99.0.0'}}))]};
}});server.accessPoints.moduleState=async()=>frpState;await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/status',async route=>{const response=await route.fetch(),body=await response.json();await route.fulfill({json:{...body,moduleVersions:{...body.moduleVersions,tor:torInstalled?'16.0.1':'—',lantern:'1.2.8-fg5'}}});});
 await page.route('**/api/dns/engine',route=>route.fulfill({json:{engine:{state:'running',torInstalled,tor:torState===null?undefined:torState==='stopped'?{}:{fixture:{state:torState}}},filter:{state:'running'}}}));
 await page.goto(base);await page.getByLabel('Username').fill('admin');await page.getByLabel('Password',{exact:true}).fill('test password 12345');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByTestId('overview-dashboard').waitFor();
 await page.goto(base+'/settings/interface');await expect(page.getByTestId('interface-preferences')).toBeVisible();
 await page.getByTestId('interface-language').click();await page.getByRole('option',{name:'Русский',exact:true}).click();
 await expect(page.getByRole('tab',{name:'Интерфейс',exact:true})).toHaveAttribute('aria-selected','true');
 await page.getByTestId('interface-theme').click();await page.getByRole('option',{name:'Светлая',exact:true}).click();await expect(page.locator('html')).toHaveAttribute('data-theme','light');await page.reload();await expect(page.locator('html')).toHaveAttribute('lang','ru');await expect(page.locator('html')).toHaveAttribute('data-theme','light');
 await page.goto(base+'/settings/modules');
 const allRequest=page.waitForRequest(request=>request.url()===base+'/api/modules' && request.method()==='POST');
 const allResponse=page.waitForResponse(response=>response.url()===base+'/api/modules' && response.request().method()==='POST');
 await page.getByTestId('check-updates').click();assert.deepEqual((await allRequest).postDataJSON(),{op:'check'});assert.equal((await allResponse).status(),202);state='current';await page.reload({waitUntil:'networkidle'});
await expect(page.getByTestId('module-row').filter({hasText:'zapret2'}).locator('td').first()).toHaveText('zapret2');const row=page.getByTestId('module-row').filter({hasText:'mihomo'});await expect(row.getByTestId('module-version-note')).toHaveCount(0);await expect(row.getByTestId('module-status')).not.toContainText('Установлена актуальная версия');await row.locator('.row-menu-trigger').click();await page.getByRole('menuitem',{name:'Проверить обновление',exact:true}).click();await expect(row.getByTestId('module-version-note')).toContainText('Доступно обновление');await expect(row.getByTestId('module-status')).toHaveText('Работает');
 await row.locator('.row-menu-trigger').click();await page.getByRole('menuitem',{name:'Обновить',exact:true}).click();await expect(page.locator('dialog[open]')).toContainText('v1.0.0 → v99.0.0');await page.getByTestId('install-module').click();await expect(row.getByTestId('module-version-note')).toHaveCount(0);await expect(row.getByTestId('module-status')).toHaveText('Работает');assert.equal(updates,1);await expect(row).toContainText('v99.0.0');
 for(const stage of ['downloading','verifying','installing','restarting']){state=stage;await page.reload({waitUntil:'networkidle'});await expect(row.getByTestId('module-update-progress')).toBeVisible();await expect(row.locator('progress')).toHaveAttribute('value',String(['downloading','verifying','installing','restarting'].indexOf(stage)*25));await expect(row.getByTestId('module-status')).toHaveText('Работает');}
 await page.screenshot({path:'/tmp/fg-modules-update-progress.png',animations:'disabled'});
 state='error';await page.reload({waitUntil:'networkidle'});await expect(row.getByTestId('module-update-progress')).toHaveCount(0);
 state='unknown';await page.reload({waitUntil:'networkidle'});await expect(row.getByTestId('module-version-note')).toHaveCount(0);state='updated';await page.reload({waitUntil:'networkidle'});
 const listRow=page.getByTestId('module-row').filter({hasText:'Список доменов для диагностики'});await expect(listRow).toContainText('Не загружен');await listRow.locator('.row-menu-trigger').click();await page.getByRole('menuitem',{name:'Проверить обновление',exact:true}).click();await expect(listRow).toContainText('Доступно обновление');await listRow.locator('.row-menu-trigger').click();await page.getByRole('menuitem',{name:'Обновить',exact:true}).click();await expect(page.locator('dialog[open]')).not.toContainText('соединения могут');await page.getByTestId('install-module').click();await expect(listRow.getByTestId('module-status')).toContainText('Работает');await expect(listRow).toContainText('bbbbbbb');assert.equal(list.status().count,1);
 await page.route('**/api/domain-lists',route=>route.fulfill({json:{loaded:true,ref:'c'.repeat(40),presets:[{available:true}]}}));
 const torRow=page.getByTestId('module-row').filter({hasText:'Tor / Snowflake'}),frpRow=page.getByTestId('module-row').filter({hasText:'frp'});
 for(const [tor,frp,installed,torText,frpText] of [['stopped','stopped',true,'Остановлен','Остановлен'],['connecting','connecting',true,'Подключение','Подключение'],['ready','active',true,'Работает','Работает'],['waiting','connecting',true,'Ожидание повторного подключения к Tor.','Подключение'],['failed','error',true,'Ошибка','Ошибка'],['unavailable','unavailable',false,'Не установлен','Не установлен'],[null,'unknown',true,'Неизвестно','Неизвестно']]){
  torState=tor;frpState=frp;torInstalled=installed;await page.reload({waitUntil:'networkidle'});
  await expect(torRow.getByTestId('module-status')).toHaveText(torText);await expect(frpRow.getByTestId('module-status')).toHaveText(frpText);
  await expect(torRow.getByTestId('module-version-note')).toHaveCount(0);await expect(frpRow.getByTestId('module-version-note')).toHaveCount(0);
 }
 torState='ready';frpState='active';await page.reload({waitUntil:'networkidle'});await expect(page.getByTestId('module-row').filter({hasText:'Пресеты доменов'}).getByTestId('module-status')).toHaveText('Работает');
 for(const stage of ['checking','available','downloading','installing','error']){
  torUpdateState=stage;torUpdateError='Legacy update error';await page.reload({waitUntil:'networkidle'});
  await expect(torRow.getByTestId('module-version-note')).toHaveCount(0);await expect(torRow.getByTestId('module-update-error')).toHaveCount(0);await expect(torRow.locator('.row-menu-trigger')).toHaveCount(0);await expect(page.getByTestId('check-updates')).toBeEnabled();
 }
 await expect(torRow.getByTestId('module-version')).toHaveText('16.0.1');
 for(const name of ['Shadowsocks Outline SDK','Lantern','Tor / Snowflake']){
  const bundled=page.getByTestId('module-row').filter({hasText:name});await expect(bundled.locator('.row-menu-trigger')).toHaveCount(0);await expect(bundled.getByTestId('module-version-note')).toHaveCount(0);await bundled.click();await expect(page.locator('.toast')).toHaveCount(0);
 }
 const systemRow=page.getByTestId('module-row').filter({hasText:'Система'});
 await systemRow.locator('.row-menu-trigger').click();await page.getByRole('menuitem',{name:'Проверить обновление',exact:true}).click();await expect(systemRow.getByTestId('module-version-note')).toContainText('aaaaaaa');
 await systemRow.locator('.row-menu-trigger').click();await page.getByRole('menuitem',{name:'Обновить',exact:true}).click();await page.getByTestId('install-module').click();await expect(systemRow.getByTestId('module-update-progress')).toBeVisible();await expect(page.locator('dialog[open]')).toHaveCount(0);await expect(systemRow.getByTestId('system-update-detail')).toContainText('Сборка веб-интерфейса');await expect(systemRow.locator('progress')).toHaveAttribute('value','50');systemProgress=75;systemStage='modules';systemAction='reuse';await page.reload({waitUntil:'networkidle'});await expect(systemRow.locator('progress')).toHaveAttribute('value','75');await expect(systemRow.getByTestId('system-update-detail')).toContainText('Подготовка компонентов');const lanternProgress=page.getByTestId('module-row').filter({hasText:'Lantern'});await expect(lanternProgress.locator('progress')).toHaveAttribute('value','35');await expect(lanternProgress.getByTestId('system-update-detail')).toContainText('Сборка компонента');await expect(torRow.locator('progress')).toHaveAttribute('value','100');await expect(torRow.getByTestId('system-update-detail')).toContainText('Используются проверенные');await page.screenshot({path:'/tmp/fg-system-update-progress.png',animations:'disabled'});
 systemState='updated';await page.reload({waitUntil:'networkidle'});await expect(systemRow.getByTestId('module-update-progress')).toHaveCount(0);
 systemSupported=false;await page.reload({waitUntil:'networkidle'});await expect(systemRow.locator('.row-menu-trigger')).toHaveCount(0);await expect(systemRow).toContainText('Docker');systemSupported=true;
 for(const theme of ['light','dark']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.screenshot({path:'/tmp/fg-module-status-'+theme+'.png',animations:'disabled'});}
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'/tmp/fg-module-status-mobile.png',animations:'disabled'});await page.setViewportSize({width:1440,height:1000});

 await page.screenshot({path:'/tmp/fg-modules-desktop.png',animations:'disabled'});
 await page.goto(base+'/settings/interface');await page.setViewportSize({width:390,height:844});await expect(page.getByTestId('interface-language')).toBeVisible();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'/tmp/fg-interface-mobile.png',animations:'disabled'});
 assert.deepEqual(errors,[]);console.log('Module runtime states, current-version note in version column, loaded lists, update menus, both themes and mobile passed.');
}finally{await browser?.close();await new Promise(r=>server.close(r));store.close();rmSync(listDirectory,{recursive:true,force:true});}
