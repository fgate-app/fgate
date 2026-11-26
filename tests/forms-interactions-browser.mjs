import {chromium,expect} from '@playwright/test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {Store} from '../server/store.js';
import {createServer} from '../server/index.js';

const folder=mkdtempSync(join(tmpdir(),'fg-forms-')),store=new Store(join(folder,'db.sqlite'));
const server=createServer(store);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let browser;
try {
 browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{
  window.modalMotions=[];
  const animate=Element.prototype.animate;
  Element.prototype.animate=function(frames,options){if(this.matches('dialog.app-dialog'))window.modalMotions.push({frames,options});return animate.call(this,frames,options);};
 });
 await page.goto(base,{waitUntil:'networkidle'});
 const password=page.getByLabel('Password',{exact:true});
 await page.getByLabel('Username',{exact:true}).fill('admin');await password.fill('test password 12345');
 await page.getByRole('button',{name:'Show password',exact:true}).click();assert.equal(await password.getAttribute('type'),'text');
 await page.getByRole('button',{name:'Hide password',exact:true}).click();assert.equal(await password.getAttribute('type'),'password');
 await page.getByRole('button',{name:'Create administrator',exact:true}).click();await page.getByTestId('overview-dashboard').waitFor();
 await page.goto(base+'/routes',{waitUntil:'networkidle'});
 // Browser route lookup may select the default subsection: select Local routes explicitly.
 await page.getByRole('tab',{name:'Local routes',exact:true}).click();
 for(const selector of ['[role=tabpanel]','.data-card']){
  const container=page.locator(selector).filter({visible:true}).first();
  assert.equal(await container.evaluate(node=>{const previous=node.getAttribute('tabindex');node.setAttribute('tabindex','-1');node.focus();const style=getComputedStyle(node).outlineStyle;previous===null?node.removeAttribute('tabindex'):node.setAttribute('tabindex',previous);return style;}),'none','layout containers have no focus outline');
 }
 await page.getByTestId('add-local-route').click();
 const dialog=page.locator('dialog[open]');
 await expect(dialog.getByLabel('Alias',{exact:true})).toBeFocused();
 assert.ok(await page.evaluate(()=>window.modalMotions.some(({frames})=>frames[0].opacity===0)),'modal appearance animates');
 await dialog.getByLabel('Alias',{exact:true}).fill('bad name');await dialog.getByLabel('Address',{exact:true}).fill('example.com');
 await dialog.getByTestId('dialog-save-local-route').click();
 await page.locator('.toast.is-error').last().waitFor();
 assert.equal(await dialog.locator('.alert.error').count(),0);
 assert.equal(await dialog.getByLabel('Alias',{exact:true}).inputValue(),'bad name');
 assert.equal(store.localRoutes().length,0);
 assert.ok(await page.locator('.toast-stack').evaluate(node=>node.matches(':popover-open')),'error is visible above the modal');
 assert.ok((await page.locator('.toast-stack').boundingBox()).y<60,'notification stays at the top of the screen');
 await page.screenshot({path:'/tmp/fg-form-validation-toast.png',animations:'disabled'});
 assert.equal(await page.locator('.toast-text').last().evaluate(node=>{const b=node.getBoundingClientRect();return !!document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.closest('.toast');}),true,'toast is above the modal backdrop');
 await dialog.getByLabel('Alias',{exact:true}).fill('router.home');await dialog.getByTestId('dialog-save-local-route').click();await dialog.waitFor({state:'hidden'});
 const row=page.getByRole('row').filter({hasText:'router.home'});await row.waitFor();
 await row.locator('.name-cell').click({button:'right'});
 const menu=page.getByRole('menu');await menu.waitFor();
 assert.ok(await page.locator('.row-menu').evaluate(node=>{const s=getComputedStyle(node);return ['paddingTop','paddingRight','paddingBottom','paddingLeft'].every(key=>s[key]==='0px');}),'context menu has no padding');
 assert.equal(await menu.evaluate(node=>node.contains(document.activeElement)),false,'opening a context menu does not focus an item');
 assert.equal(await page.locator('dialog[open]').count(),0,'right click does not activate the row edit action');
 assert.equal(await page.locator('.row-menu:popover-open').count(),1);
 assert.equal(await page.locator('.row-menu').evaluate(node=>node.scrollHeight>node.clientHeight),false,'short row menu has no scrollbar');
 for(const theme of ['dark','light']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  const nav=page.locator('aside nav .app-button:not(.active)').first();
  await nav.hover();
  const color=await nav.evaluate(node=>getComputedStyle(node).backgroundColor);
  await menu.getByRole('menuitem').first().hover();
  await expect(menu.getByRole('menuitem').first()).toHaveCSS('background-color',color);
 }
 await page.evaluate(()=>document.documentElement.dataset.theme='dark');
 await page.keyboard.press('End');await expect(menu.getByRole('menuitem').last()).toBeFocused();
 await page.keyboard.press('Home');await expect(menu.getByRole('menuitem').first()).toBeFocused();
 await page.keyboard.press('Escape');await menu.waitFor({state:'hidden'});
 // Positioning near the bottom-right edge stays within the viewport.
 await row.evaluate(node=>node.dispatchEvent(new MouseEvent('contextmenu',{clientX:1275,clientY:895,bubbles:true,cancelable:true}))); await menu.waitFor();
 const bounds=await page.locator('.row-menu').boundingBox();
 assert.ok(bounds.x>=0 && bounds.x+bounds.width<=1280 && bounds.y>=0 && bounds.y+bounds.height<=900);
 assert.ok(bounds.x>1000 && bounds.y>700,'context menu uses the pointer position');
 assert.equal(await page.locator('.row-menu').evaluate(node=>node.scrollHeight>node.clientHeight),false,'short flipped menu has no scrollbar');
 await page.screenshot({path:'/tmp/fg-row-context-menu.png'});
 await menu.getByRole('menuitem').first().click();await dialog.waitFor();
 await expect(dialog.getByLabel('Alias',{exact:true})).toBeFocused();
 // Server-side rejection keeps the populated draft open as well.
 await page.route('**/api/routes/locals/*',route=>route.fulfill({status:400,json:{error:'Server rejected this edit'}}));
 await dialog.getByTestId('dialog-save-local-route').click();
 await page.locator('.toast.is-error').filter({hasText:'Server rejected this edit'}).waitFor();
 assert.equal(await dialog.getByLabel('Alias',{exact:true}).inputValue(),'router.home');
 assert.equal(await dialog.locator('.alert.error').count(),0);
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 assert.equal(await page.locator('.toast-stack').evaluate(node=>node.parentElement===document.body),true,'toast survives closing the modal');
 // Respect reduced motion and preserve field focus on a narrow viewport.
 await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:390,height:844});
 const before=await page.evaluate(()=>window.modalMotions.length);
 for(const selector of ['[role=tabpanel]','.data-card']){
  const container=page.locator(selector).filter({visible:true}).first();
  assert.equal(await container.evaluate(node=>{const previous=node.getAttribute('tabindex');node.setAttribute('tabindex','-1');node.focus();const style=getComputedStyle(node).outlineStyle;previous===null?node.removeAttribute('tabindex'):node.setAttribute('tabindex',previous);return style;}),'none','layout containers have no focus outline');
 }
 await page.getByTestId('add-local-route').click();await dialog.waitFor();
 await expect(dialog.getByLabel('Alias',{exact:true})).toBeFocused();
 assert.equal(await page.evaluate(()=>window.modalMotions.length),before);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:'/tmp/fg-modal-mobile.png'});
 assert.deepEqual(errors,[]);
 console.log('Forms: password visibility, local/server validation toasts, preserved drafts, modal animation/focus, reduced motion, row context menus and viewport bounds passed.');
}finally{
 await browser?.close();await new Promise(resolve=>server.close(resolve));store.close();rmSync(folder,{recursive:true,force:true});
}
