import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{window.overlayAnimations=[];const original=Element.prototype.animate;Element.prototype.animate=function(frames,options){window.overlayAnimations.push({className:this.className,pseudo:options?.pseudoElement,duration:options?.duration,frames});const animation=original.call(this,frames,options);if(window.pauseOverlayExit && frames.at(-1).opacity===0)animation.pause();return animation;};});
 await page.goto('http://127.0.0.1:6006/iframe.html?id=foundations-overlay-motion--playground&viewMode=story');await page.getByTestId('motion-dialog').waitFor();
 const last=(className,pseudo)=>page.evaluate(({className,pseudo})=>window.overlayAnimations.filter(a=>String(a.className).includes(className) && a.pseudo===pseudo).at(-1),{className,pseudo});
 async function fading(locator,duration,className){
  await locator.waitFor();await page.waitForFunction(selector=>document.querySelector(selector)?.dataset.overlayState==='leaving',await locator.evaluate(element=>element.classList.contains('app-dialog')?'dialog[open]':element.classList.contains('user-popup')?'.user-popup':'.popup-list'));
  const timing=await last(className);assert.equal(timing.duration,duration);assert.equal(timing.frames.at(-1).opacity,0);assert.equal(timing.frames[0].transform,timing.frames.at(-1).transform,'closing only dissolves');
  const state=await locator.evaluate(element=>{for(const animation of element.getAnimations())if(!animation.effect.pseudoElement){animation.pause();animation.currentTime=animation.effect.getTiming().duration/2;}return {opacity:Number(getComputedStyle(element).opacity),inert:element.inert,topLayer:element.matches(':popover-open') || element.matches(':modal')};});assert.ok(state.opacity>0 && state.opacity<1);assert.equal(state.inert,true);if(className!=='user-popup')assert.equal(state.topLayer,true);
  await locator.evaluate(element=>element.getAnimations().forEach(animation=>animation.finish()));
 }
 await page.evaluate(()=>window.pauseOverlayExit=true);
 const input=page.getByRole('combobox',{name:'Motion select',exact:true});
 await input.click();assert.equal((await last('popup-list')).duration,110);await page.locator('.popup-list[data-overlay-state="open"]').waitFor();await input.press('Escape');await fading(page.locator('.popup-list'),120,'popup-list');await page.locator('.popup-list').waitFor({state:'detached'});assert.equal(await input.evaluate(element=>element===document.activeElement),true);
 await page.getByRole('button',{name:'Motion menu',exact:true}).click();assert.equal((await last('popup-list')).duration,110);await page.locator('.popup-list[data-overlay-state="open"]').waitFor();await page.keyboard.press('Escape');await fading(page.locator('.popup-list'),120,'popup-list');await page.locator('.popup-list').waitFor({state:'detached'});
 await page.getByTestId('user-menu').click();assert.equal((await last('user-popup')).duration,110);await page.locator('.user-popup[data-overlay-state="open"]').waitFor();await page.keyboard.press('Escape');await fading(page.locator('.user-popup'),120,'user-popup');await page.locator('.user-popup').waitFor({state:'detached'});
 await page.getByTestId('motion-dialog').click();const dialog=page.locator('dialog[open]');assert.equal((await last('app-dialog')).duration,180);await page.locator('dialog[data-overlay-state="open"]').waitFor();await dialog.getByRole('button',{name:'Close',exact:true}).click();await fading(dialog,160,'app-dialog');assert.equal((await last('app-dialog','::backdrop')).duration,160);await page.locator('dialog[open]').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
 await page.getByTestId('motion-drawer').click();assert.equal((await last('app-dialog')).duration,240);await page.locator('dialog[data-overlay-state="open"][open]').waitFor();await page.keyboard.press('Escape');await fading(page.locator('dialog[open]'),280,'app-dialog');await page.locator('dialog[open]').waitFor({state:'hidden'});
 await page.evaluate(()=>window.pauseOverlayExit=false);
 // Reopen a select while its leaving surface is still in the top layer.
 await input.click();await page.locator('.popup-list[data-overlay-state="open"]').waitFor();await input.press('Escape');await input.click();await page.locator('.popup-list[data-overlay-state="open"]').waitFor();assert.equal(await page.locator('.popup-list').count(),1);assert.equal(await page.locator('.popup-list').evaluate(element=>element.inert),false);await input.press('Escape');await page.locator('.popup-list').waitFor({state:'detached'});
 // Cancel a modal entry and then reopen it before the fade finishes.
 await page.getByTestId('motion-dialog').evaluate(element=>element.click());await page.waitForFunction(()=>document.querySelector('dialog[open]')?.dataset.overlayState==='entering');await page.locator('dialog[open] .dialog-close').evaluate(element=>element.click());await page.getByTestId('motion-dialog').evaluate(element=>element.click());await page.locator('dialog[open][data-overlay-state="open"]').waitFor();assert.equal(await page.locator('dialog[open]').evaluate(element=>element.inert),false);await page.keyboard.press('Escape');await page.locator('dialog[open]').waitFor({state:'hidden'});
 // A modal initially open on mount and the specialized resolver picker share the contract.
 await page.goto('http://127.0.0.1:6006/iframe.html?id=components-resolverdialog--default&viewMode=story');
 await page.getByRole('dialog',{name:'Add resolver',exact:true}).waitFor();
 await page.locator('.resolver-suggest[data-overlay-state="open"]').waitFor();assert.equal((await last('resolver-suggest')).duration,110);
 await page.evaluate(()=>window.pauseOverlayExit=true);
 const resolverInput=page.locator('.resolver-picker input');await resolverInput.press('Escape');
 const suggestion=page.locator('.resolver-suggest');await suggestion.waitFor();assert.equal((await last('resolver-suggest')).duration,120);
 assert.equal(await suggestion.evaluate(element=>element.inert),true);await suggestion.evaluate(element=>element.getAnimations().forEach(animation=>animation.finish()));await page.evaluate(()=>window.pauseOverlayExit=false);await suggestion.waitFor({state:'detached'});
 await resolverInput.fill('cloudflare');await page.getByRole('option').first().click();await page.locator('.resolver-chip').waitFor();
 await page.locator('.resolver-chip-clear').click();await resolverInput.fill('google');await page.waitForTimeout(200);
 await page.locator('.resolver-suggest[data-overlay-state="open"]').waitFor();await page.getByRole('option').filter({hasText:'Google Public DNS'}).click();await page.locator('.resolver-chip').waitFor();
 await page.locator('dialog[open] .dialog-close').click();await page.locator('dialog[open]').waitFor({state:'hidden'});
 await page.goto('http://127.0.0.1:6006/iframe.html?id=foundations-overlay-motion--playground&viewMode=story');await page.getByTestId('motion-dialog').waitFor();
 await page.emulateMedia({reducedMotion:'reduce'});const before=await page.evaluate(()=>window.overlayAnimations.length);await input.click();await input.press('Escape');await page.locator('.popup-list').waitFor({state:'detached'});await page.getByTestId('motion-dialog').click();await page.keyboard.press('Escape');await page.locator('dialog[open]').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>window.overlayAnimations.length),before);
 assert.deepEqual(errors,[]);console.log('Overlay entry/exit timings, opacity-only fade, backdrop, top layer, focus, interrupted reopening and reduced motion passed.');
}finally{await browser.close();}
