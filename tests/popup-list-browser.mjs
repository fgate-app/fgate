import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({reducedMotion:'reduce'}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:6006/iframe.html?id=components-popup-lists--shared-appearance&viewMode=story',{waitUntil:'networkidle'});
 const styles=()=>page.locator('.popup-list').evaluate(el=>{const surface=getComputedStyle(el),item=getComputedStyle(el.querySelectorAll('li')[1]);return {surface:[surface.backgroundColor,surface.boxShadow,surface.borderRadius,surface.padding,surface.fontSize],item:[item.minHeight,item.padding,item.borderRadius,item.fontSize],topLayer:el.matches(':popover-open')};});
 for(const theme of ['dark','light']){
  await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
  await page.getByRole('combobox',{name:'Select m',exact:true}).click();await page.getByRole('listbox').waitFor();const expected=await styles();assert.equal(expected.topLayer,true);assert.equal(expected.item[0],'44px');await page.keyboard.press('Escape');
  await page.getByRole('combobox',{name:'Select s',exact:true}).click();await page.getByRole('listbox').waitFor();assert.deepEqual(await styles(),expected);await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Context menu',exact:true}).click();await page.getByRole('menu').waitFor();assert.deepEqual(await styles(),expected);
  await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.textContent.trim()),'Remove');await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button',{name:'Context menu',exact:true}).evaluate(el=>el===document.activeElement),true);
  assert.ok((await page.locator('.app-count').evaluate(el=>getComputedStyle(el).backgroundColor)).includes('0.14'));
 }
 await page.setViewportSize({width:390,height:844});await page.goto('http://127.0.0.1:6006/iframe.html?id=components-select--long-list&viewMode=story',{waitUntil:'networkidle'});
 const input=page.getByRole('combobox');await input.click();assert.equal(await page.getByRole('option').count(),40,'long lists start with one chunk');await input.press('End');await input.press('Enter');assert.equal(await input.inputValue(),'Connection 100');
 await page.locator('.custom-select').evaluate(el=>{el.style.position='fixed';el.style.bottom='8px';el.style.width='320px';});await input.click();const bounds=await page.locator('.popup-list').boundingBox();assert.ok(bounds.y>=0 && bounds.y+bounds.height<=844,'upward popup stays within viewport');
 assert.deepEqual(errors,[]);console.log('Shared popup: identical select/menu styles, top layer, keyboard, progressive list, upward placement and count tint passed.');
}finally{await browser.close();}
