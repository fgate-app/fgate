import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:6006/iframe.html?id=foundations-overlay-motion--unsaved-changes&viewMode=story');
 const form=page.getByRole('dialog',{name:'Editable form',exact:true});
 const confirmation=page.getByRole('dialog',{name:'Exit without saving',exact:true});
 const outside=()=>page.mouse.click(8,8);
 const show=async()=>{await page.getByRole('button',{name:'Edit form',exact:true}).click();await form.waitFor();};
 await show();await outside();await expect(form).toBeHidden();await expect(confirmation).toHaveCount(0);
 await show();await form.getByLabel('Name',{exact:true}).fill('Changed');await outside();await confirmation.waitFor();await confirmation.screenshot({path:'/tmp/fg-unsaved-confirmation.png'});await expect(form).toBeVisible();
 await confirmation.getByRole('button',{name:'Stay',exact:true}).click();await expect(confirmation).toBeHidden();await expect(page.locator('dialog[open]')).toHaveCount(1);await expect(form.getByLabel('Name',{exact:true})).toHaveValue('Changed');
 await form.getByLabel('Name',{exact:true}).fill('Original');await outside();await expect(form).toBeHidden();
 await show();await form.getByRole('combobox',{name:'Form route',exact:true}).click();await page.getByRole('option',{name:'Second item',exact:true}).click();await outside();await confirmation.waitFor();
 await confirmation.locator('.app-dialog-actions').getByRole('button',{name:'Exit',exact:true}).click();await expect(form).toBeHidden();await expect(confirmation).toBeHidden();
 await show();await form.getByLabel('Name',{exact:true}).fill('Saved');await form.getByRole('button',{name:'Save',exact:true}).click();await expect(form).toBeHidden();await expect(confirmation).toHaveCount(0);
 // Keyboard-only editing captures the original model before typing.
 await show();await form.getByLabel('Name',{exact:true}).press('End');await page.keyboard.type(' keyboard');await outside();await confirmation.waitFor();await page.keyboard.press('Escape');await expect(confirmation).toBeHidden();await expect(page.locator('dialog[open]')).toHaveCount(1);await expect(form).toBeVisible();
 await form.getByRole('button',{name:'Close',exact:true}).click();await expect(form).toBeHidden();
 await show();await outside();await expect(form).toBeHidden();assert.deepEqual(errors,[]);
 console.log('Unchanged and reverted forms, input/select/keyboard edits, discard confirmation, cancel, save and reopening passed.');
}finally{await browser.close();}
