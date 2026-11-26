import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:6006/iframe.html?id=components-select--default&viewMode=story');
const input=page.getByRole('combobox');await input.waitFor();await input.click();assert.equal(await input.getAttribute('aria-expanded'),'true');await input.fill('wire');assert.equal(await page.getByRole('option').count(),1);await input.press('Enter');assert.equal(await input.inputValue(),'WireGuard');assert.equal(await input.getAttribute('aria-expanded'),'false');
await input.click();await input.fill('not a protocol');await page.getByRole('status').filter({hasText:'No results'}).waitFor();await input.press('Escape');assert.equal(await input.inputValue(),'WireGuard');
await input.press('s');assert.equal(await input.inputValue(),'s');assert.equal(await page.getByRole('option').count(),3);await input.press('ArrowDown');await input.press('Enter');assert.equal(await input.getAttribute('aria-expanded'),'false');
await input.press('ArrowDown');await input.press('End');await input.press('Enter');assert.equal(await input.inputValue(),'OpenVPN');
await input.click();await page.locator('body').click({position:{x:380,y:600}});assert.equal(await input.getAttribute('aria-expanded'),'false');
await input.click();await page.screenshot({path:'/tmp/freedomgate-select.png'});const rect=await page.locator('.select-popup').boundingBox();assert.ok(rect.x>=0 && rect.x+rect.width<=390);await input.press('Tab');assert.equal(await input.getAttribute('aria-expanded'),'false');
await page.goto('http://127.0.0.1:6006/iframe.html?id=components-select--disabled&viewMode=story');await page.getByRole('combobox').waitFor();assert.equal(await page.getByRole('combobox').isDisabled(),true);
assert.deepEqual(errors,[]);console.log('Custom select: search, empty results, keyboard, escape, outside click, tab, mobile bounds, disabled passed.');
}finally{await browser.close();}
