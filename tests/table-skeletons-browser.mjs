import {chromium,expect} from '@playwright/test';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';
import assert from 'node:assert/strict';
const store=new Store(':memory:');store.importProfile({name:'Fixture proxy',value:'socks5://127.0.0.1:9999'});
const server=createServer(store,{modulesHelper:async()=>({ok:true,modules:[]})});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.getByLabel('Username').fill('admin');await page.getByLabel('Password',{exact:true}).fill('test password 12345');await page.getByRole('button',{name:'Create administrator'}).click();await page.getByTestId('overview-dashboard').waitFor();
 async function check(path,endpoint,testId,{failure=false,mobile=false}={}){
  let release;const gate=new Promise(r=>release=r);await page.route('**/api/'+endpoint,async route=>{await gate;if(failure)await route.fulfill({status:502,json:{error:'Fixture error'}});else await route.continue();});
  await page.setViewportSize({width:mobile?390:1440,height:900});await page.goto(base+path,{waitUntil:'domcontentloaded'});
  const table=testId?page.getByTestId(testId):page.locator('table').first();await expect(table.locator('.table-skeleton')).toBeVisible();await expect(table).toHaveAttribute('aria-busy','true');
  assert.equal(await table.locator('.table-skeleton tr').count(),5);assert.ok(await table.locator('.table-skeleton tr').evaluateAll(rows=>rows.every(row=>row.getBoundingClientRect().height>=57)));assert.equal(await table.locator('.table-skeleton tr').first().locator('td').count(),await table.locator('thead th').count());
  for(const theme of ['dark','light']){await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);const color=await table.evaluate(el=>{const probe=document.createElement('span');probe.style.backgroundColor='var(--color-border-subtle)';el.parentElement.append(probe);const color=getComputedStyle(probe).backgroundColor;probe.remove();return color;});await expect(table.locator('.skeleton-bar').first()).toHaveCSS('background-color',color);}
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await expect(table.locator('tbody:not(.table-skeleton)')).toBeHidden();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`/tmp/fg-skeleton-${endpoint.replaceAll('/','-')}-${mobile?'mobile':'desktop'}.png`,animations:'disabled'});
  await page.emulateMedia({reducedMotion:'reduce'});await expect(table.locator('.skeleton-bar').first()).toHaveCSS('animation-name','none');await page.emulateMedia({reducedMotion:'no-preference'});
  release();await expect(table.locator('.table-skeleton')).toHaveCount(0);if(await table.count()){await expect(table).toHaveAttribute('aria-busy','false');assert.ok(await table.locator('tbody tr').evaluateAll(rows=>rows.filter(row=>row.getBoundingClientRect().height>0).every(row=>row.getBoundingClientRect().height>=57)));if(!mobile)assert.ok(await table.locator('thead tr').evaluateAll(rows=>rows.every(row=>row.getBoundingClientRect().height>=57)));}await page.unroute('**/api/'+endpoint);
 }
 await check('/connections','profiles','exit-list');await expect(page.getByTestId('exit-row').filter({hasText:'Fixture proxy'})).toBeVisible();
 await check('/clients','clients','client-list',{mobile:true});
 // Background refresh keeps the loaded empty state visible rather than flashing placeholders.
 await page.route('**/api/clients',route=>route.fulfill({json:{clients:[]}}));await page.waitForTimeout(5200);await expect(page.getByTestId('client-list').locator('.table-skeleton')).toHaveCount(0);await page.unroute('**/api/clients');
 await check('/routes/domains','routes','route-group-list',{failure:true});
 await check('/settings/users','users','user-list');
 await check('/settings/modules','modules','module-list');
 await check('/settings/logs','logs','log-list');
 await check('/settings/dns','dns',null);
 assert.deepEqual(errors,[]);console.log('Table skeletons: delayed requests, actual header columns, mobile layout, reduced motion, empty/error completion and quiet background polling passed.');
}finally{await browser?.close();await new Promise(r=>server.close(r));store.close();}
