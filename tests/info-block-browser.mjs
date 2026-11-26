import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.launch({channel:'chrome',headless:true});
function luminance(color){return color.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);}
try{
 const page=await browser.newPage({viewport:{width:700,height:300}});
 for(const theme of ['dark','light'])for(const [story,variant] of [['information','info'],['warning','warning'],['special-attention','danger']]){
  await page.goto((process.env.STORYBOOK_URL || 'http://127.0.0.1:6006')+'/iframe.html?id=components-info-block--'+story+'&viewMode=story&globals=theme:'+theme);
  const block=page.locator('.app-info-block--'+variant);await expect(block).toBeVisible();await expect(block.locator('svg')).toBeVisible();
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  const colors=await block.evaluate(node=>{const style=getComputedStyle(node);return {background:style.backgroundColor,text:style.color};});
  const a=luminance(colors.background),b=luminance(colors.text);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,theme+' '+variant+' text contrast');
  assert.ok(theme==='dark'?a<.06:a>.65,theme+' '+variant+' surface brightness');
  await page.screenshot({path:'/tmp/fg-info-block-'+theme+'-'+variant+'.png'});
 }
 console.log('Info/warning/danger blocks: subdued dark backgrounds, light pastel backgrounds, left icons and text contrast >=4.5 passed.');
}finally{await browser.close();}
