import {chromium,expect} from '@playwright/test';
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
 const session=await(await page.request.get(base+'/api/auth/session')).json(),profiles=await(await page.request.get(base+'/api/profiles')).json(),direct=profiles.find(profile=>profile.engine==='direct');
 const response=await page.request.post(base+'/api/routes/groups',{headers:{'X-CSRF-Token':session.csrf},data:{name:'Example domains with a long name',entries:['example.com','long-subdomain.example.org'],routeId:direct.id}});assert.ok(response.ok());
 async function fit(){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no page horizontal scrolling');}
 async function navigate(name){await page.getByTestId('mobile-navigation-toggle').click();const drawer=page.getByRole('dialog',{name:'Navigation',exact:true});await drawer.waitFor();assert.equal(await drawer.locator('nav .nav-label').filter({visible:true}).count(),6);await drawer.getByRole('button',{name,exact:true}).click();await drawer.waitFor({state:'hidden'});await fit();}
 async function card(table){const row=table.locator('tbody tr').first();await row.waitFor();assert.equal(await row.evaluate(el=>getComputedStyle(el).display),'grid');const details=await row.locator('td:not(:first-child):not(.actions-cell)').evaluateAll(cells=>cells.map(cell=>cell.dataset.label));assert.ok(details.every(Boolean),JSON.stringify(details));const rect=await row.boundingBox();assert.ok(rect.x>=0 && rect.x+rect.width<=390);await fit();return row;}
 const menuButton=page.getByTestId('mobile-navigation-toggle'),profileButton=page.getByTestId('mobile-profile'),brand=page.locator('.mobile-brand');
 const [menuRect,profileRect,brandRect]=await Promise.all([menuButton.boundingBox(),profileButton.boundingBox(),brand.boundingBox()]);
 assert.ok(menuRect.x<brandRect.x && profileRect.x>brandRect.x+brandRect.width);assert.ok(Math.abs(brandRect.x+brandRect.width/2-195)<1,'brand is centered');assert.equal(profileRect.width,profileRect.height);
 await profileButton.click();await page.getByRole('dialog',{name:'User menu',exact:true}).waitFor();await page.keyboard.press('Escape');await expect(profileButton).toBeFocused();
 await menuButton.click();const animatedDrawer=page.getByRole('dialog',{name:'Navigation',exact:true});await animatedDrawer.waitFor();
 assert.ok(await animatedDrawer.evaluate(el=>el.getAnimations().some(a=>a.effect.getKeyframes().some(f=>String(f.transform).includes('-100%')))),'drawer slides in from the left');
 await animatedDrawer.evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished.catch(()=>{}))));
 await page.screenshot({path:'/tmp/fg-mobile-drawer-slide.png',animations:'disabled'});
 await page.keyboard.press('Escape');assert.ok(await animatedDrawer.evaluate(el=>el.open && el.getAnimations().length>0),'drawer stays modal during slide-out');await animatedDrawer.waitFor({state:'hidden'});
 await page.screenshot({path:'/tmp/fg-mobile-header.png',animations:'disabled'});
 assert.equal(await page.locator('.shell>aside').isVisible(),false);assert.ok((await page.locator('.mobile-topbar').boundingBox()).height<=64);
 await page.getByTestId('mobile-navigation-toggle').click();const testDrawer=page.getByRole('dialog',{name:'Navigation',exact:true});await testDrawer.waitFor();await testDrawer.evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished.catch(()=>{}))));await page.mouse.move(100,300);await page.mouse.down();await page.mouse.move(365,300);await page.mouse.up();assert.ok(await testDrawer.isVisible());await page.mouse.click(365,300);await testDrawer.waitFor({state:'hidden'});assert.ok(await page.getByTestId('mobile-navigation-toggle').evaluate(el=>el===document.activeElement));
 await navigate('Gateways');const table=page.getByTestId('exit-list');await card(table);await page.screenshot({path:'/tmp/fg-mobile-gateways.png',fullPage:true});
 const editable=page.locator('[data-testid="exit-row"][data-engine="zapret"]');await editable.locator('.name-cell').click();await page.getByRole('dialog',{name:'Configure',exact:true}).waitFor();await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await editable.locator('.row-menu-trigger').click();await page.getByRole('menuitem',{name:'Configure',exact:true}).waitFor();await page.keyboard.press('Escape');
 await navigate('Clients');await card(page.getByTestId('client-list'));await page.screenshot({path:'/tmp/fg-mobile-clients.png',fullPage:true});
 await navigate('Rules');const rule=await card(page.getByTestId('route-group-list'));await page.screenshot({path:'/tmp/fg-mobile-rules.png',fullPage:true});assert.match(await rule.locator('[data-testid="route-label"]').locator('..').getAttribute('data-label'),/Route/);
 await navigate('Settings');await page.getByRole('tab',{name:'Modules & integrations',exact:true}).click();await card(page.getByTestId('module-list'));await page.screenshot({path:'/tmp/fg-mobile-modules.png',fullPage:true});
 await page.getByTestId('mobile-navigation-toggle').click();const drawer=page.getByRole('dialog',{name:'Navigation',exact:true});await drawer.getByTestId('user-menu').click();const user=page.getByRole('dialog',{name:'User menu',exact:true});await user.waitFor();await user.getByRole('combobox',{name:'Language',exact:true}).click();await page.getByRole('option',{name:'Русский',exact:true}).click();await page.getByRole('dialog',{name:'Навигация',exact:true}).waitFor();await page.screenshot({path:'/tmp/fg-mobile-navigation.png',fullPage:true});
 await page.keyboard.press('Escape');await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'Навигация',exact:true}).waitFor({state:'hidden'});
 await page.reload({waitUntil:'networkidle'});const label=await page.getByTestId('module-list').locator('tbody tr').first().locator('td').nth(1).getAttribute('data-label');assert.equal(label,'Версия');
 for(const width of [320,375,600,767,820,900]){await page.setViewportSize({width,height:844});await fit();}
 await page.setViewportSize({width:1440,height:1000});assert.equal(await page.getByTestId('module-list').evaluate(el=>getComputedStyle(el).display),'table');assert.ok(await page.locator('.shell>aside').isVisible());assert.equal(await page.getByTestId('mobile-navigation-toggle').isVisible(),false);
 const sidebar=page.locator('.shell>aside'),main=page.locator('.shell>main');const beforeWidth=(await sidebar.boundingBox()).width;
 await page.getByTestId('sidebar-toggle').click();
 await page.waitForFunction(()=>document.querySelector('.shell>aside').getAnimations().some(a=>a.transitionProperty==='width'));
 const middleWidth=await sidebar.evaluate(el=>{const animation=el.getAnimations().find(a=>a.transitionProperty==='width');animation.pause();animation.currentTime=120;return el.getBoundingClientRect().width;});assert.ok(middleWidth>80 && middleWidth<beforeWidth,'sidebar width animates between sizes');
 await sidebar.evaluate(el=>{for(const a of el.getAnimations())a.play();});await sidebar.evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished.catch(()=>{}))));await main.evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished.catch(()=>{}))));assert.equal(Math.round((await sidebar.boundingBox()).width),80);
 await page.screenshot({path:'/tmp/fg-sidebar-collapsed.png',animations:'disabled'});
 await page.getByTestId('sidebar-toggle').click();await sidebar.evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished.catch(()=>{}))));
 await page.emulateMedia({reducedMotion:'reduce'});await page.getByTestId('sidebar-toggle').click();assert.equal(await sidebar.evaluate(el=>el.getAnimations().length),0);
 await page.setViewportSize({width:390,height:844});await expect(page.getByTestId('mobile-profile').locator('.app-icon')).toBeVisible();await page.getByTestId('mobile-navigation-toggle').click();const reducedDrawer=page.getByRole('dialog',{name:'Навигация',exact:true});await reducedDrawer.waitFor();assert.equal(await reducedDrawer.evaluate(el=>el.getAnimations().length),0);await page.keyboard.press('Escape');await reducedDrawer.waitFor({state:'hidden'});
 assert.deepEqual(errors,[]);console.log('Mobile drawer, profile/language, gateway/client/rule/module cards, editing, menus, labels, 320–900 widths and desktop table restoration passed.');
}finally{await browser?.close();child.kill();await new Promise(resolve=>child.once('exit',resolve));rmSync(folder,{recursive:true,force:true});}
