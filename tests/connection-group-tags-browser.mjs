import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:6006/iframe.html?id=components-connection-group-dialog--edit&viewMode=story');
 await page.getByRole('button',{name:'Edit group',exact:true}).click();
 const dialog=page.getByRole('dialog'),input=dialog.getByRole('combobox',{name:'Add connection to group',exact:true}),tags=dialog.locator('.app-tag-input .app-tag');
 await dialog.waitFor();await expect(tags).toHaveCount(1);await input.hover();assert.equal(await dialog.locator('.tag-remove:hover').count(),0);await tags.first().locator('.tag-text').hover();assert.equal(await dialog.locator('.tag-remove:hover').count(),0);await tags.first().getByRole('button').hover();assert.equal(await dialog.locator('.tag-remove:hover').count(),1);assert.equal(await input.evaluate(element=>element.closest('label').control===element),true,'outer label associates with the actual input');await expect(dialog.locator('.select-chevron')).toHaveCount(0);for(let i=0;i<2;i++){await input.click();await expect(tags).toHaveCount(1);await input.press('Escape');}await input.press('Escape');await expect(page.locator('.popup-list')).toHaveCount(0);await input.click();await expect(page.getByRole('option',{name:'Direct',exact:true})).toHaveCount(0);
 await input.fill('Amsterdam');await page.getByRole('option',{name:'Proxy Amsterdam',exact:true}).click();await expect(tags).toHaveCount(2);
 await input.click();await input.fill('DPI');await input.press('ArrowDown');await input.press('Enter');await expect(tags).toHaveCount(3);await input.click();await expect(tags).toHaveCount(3);await input.press('Escape');
 await tags.filter({hasText:'Proxy Amsterdam'}).getByRole('button').click();await expect(tags).toHaveCount(2);
 await input.focus();await input.press('Backspace');await expect(tags).toHaveCount(1);
 await input.click();await input.fill('unknown gateway');await input.press('Enter');await expect(tags).toHaveCount(1);await input.press('Escape');
 await input.click();await page.getByRole('option',{name:'DPI bypass',exact:true}).click();await expect(tags).toHaveCount(2);
 await expect(page.locator('.popup-list')).toHaveCount(0);await page.screenshot({path:'/tmp/fg-connection-group-tags.png'});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await dialog.getByTestId('save-connection-group').click();await expect(page.getByTestId('saved-group')).toHaveText(JSON.stringify({name:'Automatic',members:['direct','dpi']}));
 await expect(page.locator('dialog[open]')).toHaveCount(0);await page.getByRole('button',{name:'Edit group',exact:true}).click();await expect(tags).toHaveCount(1);
 await input.click();await page.getByRole('option',{name:'DPI bypass',exact:true}).click();await page.mouse.click(2,2);await page.getByRole('dialog',{name:'Exit without saving',exact:true}).waitFor();
 await page.goto('http://127.0.0.1:6006/iframe.html?id=components-tag-input--empty&viewMode=story');const freeInput=page.locator('.tag-input');await freeInput.fill('example.org');await freeInput.press('Enter');await expect(page.locator('.app-tag')).toHaveCount(1);await freeInput.fill('one.org,two.org');await expect(page.locator('.app-tag')).toHaveCount(3);await freeInput.press('Backspace');await expect(page.locator('.app-tag')).toHaveCount(2);
 await page.goto('http://127.0.0.1:6006/iframe.html?id=components-tag-input--disabled&viewMode=story');await expect(page.locator('.tag-input')).toBeDisabled();await expect(page.locator('.tag-remove').first()).toBeDisabled();
 assert.deepEqual(errors,[]);console.log('Group Tag Input: existing IDs, search, keyboard selection/removal, no duplicates or unknown gateways, save, reopen, dirty confirmation and mobile passed.');
}finally{await browser.close();}
