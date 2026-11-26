import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),base='http://127.0.0.1:6006/iframe.html?id=foundations-typography--';
 const font=locator=>locator.evaluate(element=>getComputedStyle(element).fontSize);
 await page.goto(base+'scale&viewMode=story');await page.locator('[data-font-token="--font-size-13"]').waitFor();
 for(const element of await page.locator('[data-font-token]').all()){
  const token=await element.getAttribute('data-font-token');assert.equal(await font(element),token.split('-').at(-1)+'px');
 }
 await page.goto(base+'form-controls&viewMode=story');await page.locator('input.app-input.control-m').waitFor();
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:900});
  for(const selector of ['input.app-input.control-m','input.app-input.control-s','textarea.control-m','textarea.control-s','.select-input.control-m','.select-input.control-s'])assert.equal(await font(page.locator(selector)),'13px',selector);
  assert.equal(await font(page.locator('label').filter({has:page.locator('input.app-input.control-m')})),'13px');
  assert.equal(await font(page.locator('label').filter({has:page.locator('input.app-input.control-s')})),'12px');
  assert.equal(await font(page.getByRole('button',{name:'Button m',exact:true})),'14px');assert.equal(await font(page.getByRole('button',{name:'Button s',exact:true})),'12px');
 }
 await page.evaluate(()=>document.documentElement.style.setProperty('--font-size-control','15px'));
 for(const selector of ['input.app-input.control-m','input.app-input.control-s','textarea.control-m','textarea.control-s','.select-input.control-m','.select-input.control-s'])assert.equal(await font(page.locator(selector)),'15px',selector+' responds to the shared control token');
 assert.equal(await font(page.getByRole('button',{name:'Button m',exact:true})),'14px');
 await page.evaluate(()=>document.documentElement.style.removeProperty('--font-size-control'));
 await page.setViewportSize({width:1280,height:1000});await page.screenshot({path:'/tmp/fg-typography-controls.png',fullPage:true});
 await page.goto(base+'roles&viewMode=story');await page.locator('[data-font-token="--font-size-control"]').waitFor();
 const expected={body:13,caption:12,control:13,'button-m':14,'button-s':12,'label-m':13,'label-s':12,table:13,'table-heading':11,'heading-page':30,'heading-page-compact':26,'heading-dialog':18,'heading-section':16,brand:21,'brand-compact':17,'chart-label':10};
 for(const [role,size] of Object.entries(expected))assert.equal(await font(page.locator(`[data-font-token="--font-size-${role}"]`)),size+'px');
 assert.equal(await font(page.locator('[data-font-token="--font-size-metric"]')),'25.6px');
 await page.setViewportSize({width:390,height:900});assert.equal(await font(page.locator('[data-font-token="--font-size-metric"]')),'20px');assert.equal(await font(page.locator('[data-font-token="--font-size-metric-compact"]')),'18px');
 await page.screenshot({path:'/tmp/fg-typography-roles-mobile.png',fullPage:true});
 console.log('Typography scale, semantic roles, form controls, responsive metrics and live token overrides passed.');
}finally{await browser.close();}
