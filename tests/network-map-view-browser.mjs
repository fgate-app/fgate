import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1600,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const url='http://127.0.0.1:6006/iframe.html?id=overview-network-architecture--current-map&viewMode=story&globals=locale:en';
 await page.goto(url);await page.evaluate(()=>localStorage.removeItem('freedomgate.network-map.view'));await page.reload();await page.locator('.architecture-node').first().waitFor();
 const world=page.getByTestId('architecture-world'),viewport=page.locator('.architecture-viewport');
 await expect(page.locator('.architecture-controls output')).toHaveText('100%');
 await page.getByRole('button',{name:'Zoom in',exact:true}).click();
 const area=await viewport.boundingBox();await page.mouse.move(area.x+20,area.y+20);await page.mouse.down();await page.mouse.move(area.x+85,area.y+65,{steps:5});await page.mouse.up();
 const before=await world.getAttribute('style');await page.reload();await page.locator('.architecture-node').first().waitFor();await expect(world).toHaveAttribute('style',before);await expect(page.locator('.architecture-controls output')).toHaveText('120%');
 await page.goto('http://127.0.0.1:6006/iframe.html?id=components-tabs--medium&viewMode=story');await page.goto(url);await expect(world).toHaveAttribute('style',before);
 const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('freedomgate.network-map.view')));assert.equal(stored.scale,1.2);assert.deepEqual(Object.keys(stored).sort(),['offset','scale','version']);
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Fit graph',exact:true}).click();const fitted=await world.getAttribute('style');await page.reload();await expect(world).toHaveAttribute('style',fitted);
 await page.addInitScript(()=>localStorage.setItem('freedomgate.network-map.view','corrupt'));await page.setViewportSize({width:390,height:844});await page.reload();await expect(page.locator('.architecture-controls output')).toHaveText('100%');await expect.poll(()=>world.evaluate(node=>{const m=new DOMMatrix(getComputedStyle(node).transform);return [m.a,m.e,m.f];})).toEqual([1,16,16]);
 await page.evaluate(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Denied','SecurityError');}}));await page.getByRole('button',{name:'Zoom in',exact:true}).click();await expect(page.locator('.architecture-controls output')).toHaveText('120%');await page.waitForTimeout(200);
 assert.deepEqual(errors,[]);console.log('Map view: default 100%, pan/zoom restored on reload and return, minimal stored data, corrupt/denied storage and mobile default passed.');
}finally{await browser.close();}
