import {chromium} from '@playwright/test';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const supplied=process.env.FREEDOMGATE_STORYBOOK_URL;
const server=supplied?null:spawn('python3',['-u','-m','http.server','18896','--bind','127.0.0.1','--directory','storybook-static'],{stdio:['ignore','pipe','pipe']});
const base=supplied || 'http://127.0.0.1:18896';
let browser;
function luminance(color){const channels=color.match(/[\d.]+/g).slice(0,3).map(Number).map(value=>value/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;}
function contrast(a,b){a=luminance(a);b=luminance(b);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);}
try{
 if(server)await new Promise((resolve,reject)=>{server.stdout.once('data',resolve);server.once('exit',()=>reject(Error('Static Storybook server failed')));});
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 for(const theme of ['light','dark']){
  await page.goto(`${base}/iframe.html?id=foundations-visualization-colors--${theme}-theme&viewMode=story&globals=locale:ru`,{waitUntil:'networkidle'});
  await page.locator(`[data-chart-theme="${theme}"] .viz-shade code`).first().getByText(/^#/).waitFor();
  assert.equal(await page.locator('[data-color-family]').count(),6);
  const colors=await page.locator('.viz-swatch').evaluateAll(elements=>elements.map(element=>({token:element.dataset.colorToken,color:getComputedStyle(element).backgroundColor,opacity:getComputedStyle(element).opacity,background:getComputedStyle(element.closest('.viz-surface')).backgroundColor})));
  assert.equal(colors.length,24);
  for(const swatch of colors){assert.equal(swatch.opacity,'1');assert.ok(!swatch.color.includes('rgba'),'palette uses opaque colors');if(!/-strong|-soft|-subtle/.test(swatch.token))assert.ok(contrast(swatch.color,swatch.background)>=3,`${theme} ${swatch.token} has sufficient graphic-to-card contrast`);}
  const ping=await page.locator('.proxy-latency svg').evaluateAll(elements=>elements.map(element=>getComputedStyle(element).fill));
  assert.equal(await page.locator('[data-latency-chart=http] rect[data-sample=true]').count(),24,'real ping component displays the synthetic history');
  assert.equal(await page.locator('[data-latency-chart=udp] rect[data-sample=true]').count(),1);
  assert.equal(ping.length,2);assert.equal(ping[0],colors.find(color=>color.token==='--chart-teal').color);assert.equal(ping[1],colors.find(color=>color.token==='--chart-violet').color);
  await page.screenshot({path:`/tmp/fg-visualization-colors-${theme}.png`,fullPage:true});
  await page.setViewportSize({width:320,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'chart examples fit narrow screens');
  await page.setViewportSize({width:1440,height:1100});
 }
 await page.goto(`${base}/iframe.html?id=foundations-visualization-colors--compare-themes&viewMode=story&globals=locale:ru`,{waitUntil:'networkidle'});
 await page.locator('[data-chart-theme=dark] .viz-shade code').first().getByText(/^#/).waitFor();
 assert.equal(await page.locator('.viz-swatch').count(),48);
 await page.screenshot({path:'/tmp/fg-visualization-colors-compare.png',fullPage:true});
 for(const width of [320,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'palette comparison has no horizontal overflow');}
 assert.deepEqual(errors,[]);console.log('Visualization palette: both themes, 48 opaque swatches, base contrast, actual ping tokens and narrow layouts passed.');
}finally{await browser?.close();server?.kill();if(server)await new Promise(resolve=>server.once('exit',resolve));}
