import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {materialNavigation} from '../web/src/icons/material-navigation.js';
async function checkCounterCenters(page){
 const result=await page.locator('.architecture-world').evaluate(world=>{
  const edges=new Map([...world.querySelectorAll('[data-edge]')].map(node=>[node.dataset.edge,node]));
  const errors=[];let checked=0,dns=0;
  for(const card of world.querySelectorAll('[data-counter-edge]')){
   if(card.querySelector('.architecture-link-label')?.textContent==='DNS')dns++;
   const path=edges.get(card.dataset.counterEdge)?.querySelector('.architecture-wire');if(!path)continue;
   const point=path.getPointAtLength(path.getTotalLength()/2),screen=new DOMPoint(point.x,point.y).matrixTransform(path.getScreenCTM()),rect=card.getBoundingClientRect();
   const delta=Math.hypot(screen.x-rect.x-rect.width/2,screen.y-rect.y-rect.height/2);
   if(delta>1)errors.push({edge:card.dataset.counterEdge,delta});checked++;
  }
  return {checked,dns,errors};
 });
 assert.equal(result.dns,2,'all DNS cards are included in midpoint checks');
 assert.ok(result.checked>0);assert.deepEqual(result.errors,[],'counter centers match SVG curve midpoints');
}
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1600,height:1050}}),unexpected=[],errors=[];
 await page.addInitScript(()=>{try{localStorage.removeItem('freedomgate.network-map.view');}catch{}});
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{const url=new URL(request.url());if(url.hostname==='192.168.1.86'||url.pathname.startsWith('/api/'))unexpected.push(url.pathname);});
 for(const theme of ['light','dark']){
  await page.goto(`http://127.0.0.1:6006/iframe.html?id=overview-network-architecture--current-map&viewMode=story&globals=theme:${theme};locale:ru`);
  await page.locator('.architecture-node').first().waitFor();assert.equal(await page.locator('.architecture-column').count(),0);assert.equal(await page.locator('.architecture-node').count(),41);
  assert.equal(await page.locator('[data-architecture-node^="gateway:"]').count(),8);
  assert.equal(await page.locator('[data-wrapped-gateway]').count(),3);
  for(const wrap of await page.locator('[data-wrapped-gateway]').all()){
   const id=await wrap.getAttribute('data-wrapped-gateway'),outer=await wrap.boundingBox(),inner=await page.locator(`[data-architecture-node="${id}"]`).boundingBox();
   assert.ok(inner.x>outer.x&&inner.y>outer.y&&inner.x+inner.width<outer.x+outer.width&&inner.y+inner.height<outer.y+outer.height);
   assert.equal(await wrap.locator('.protocol-icon').count(),1);
   const layers=await page.evaluate(()=>({wire:+getComputedStyle(document.querySelector('.architecture-edges')).zIndex,outer:+getComputedStyle(document.querySelector('.architecture-gateway-wrap')).zIndex,inner:+getComputedStyle(document.querySelector('.architecture-node')).zIndex}));
   assert.ok(layers.wire>layers.outer&&layers.inner>layers.wire,'wires above outer backgrounds and below inner cards');
   const anchor=await wrap.getAttribute('data-architecture-anchor');
   const wire=page.locator(`[data-edge$="→${anchor}"] .architecture-wire`).first();assert.equal(await wire.count(),1);
   const endpoint=await wire.evaluate(path=>{const p=path.getPointAtLength(path.getTotalLength()),s=new DOMPoint(p.x,p.y).matrixTransform(path.getScreenCTM());return {x:s.x,y:s.y};});
   const status=await wrap.locator('.architecture-status').boundingBox();
   assert.ok(Math.abs(endpoint.x-outer.x)<1&&Math.abs(endpoint.y-status.y-status.height/2)<1,'outer input reaches left border at header indicator');
   assert.equal(await page.locator(`[data-edge^="${anchor}→"]`).count(),0,'outer header has no visible output');
  }
  assert.equal(await page.locator('[data-architecture-node^="group:"]').count(),2);
  const ruleX=await page.locator('[data-architecture-node^="rule:"]').first().evaluate(node=>parseFloat(node.style.left));
  const gatewayX=await page.locator('[data-architecture-node^="gateway:"]').first().evaluate(node=>parseFloat(node.style.left));
  for(const group of await page.locator('[data-architecture-node^="group:"]').all()){
   const id=await group.getAttribute('data-architecture-node');
   assert.equal(await page.locator(`[data-edge^="module:"][data-edge$="→${id}"]`).count(),0);
   assert.ok(await page.locator(`[data-edge^="gateway:"][data-edge$="→${id}"] .architecture-wire`).count()>0);
   const x=await group.evaluate(node=>parseFloat(node.style.left));assert.ok(gatewayX<x&&x<ruleX);
   assert.equal(await group.locator('.architecture-node-icon path').getAttribute('d'),materialNavigation.public.path);
  }

  assert.equal(await page.locator('[data-architecture-node="port:Meta"]').count(),0);
  assert.equal(await page.locator('[data-architecture-node="module:frp"]').count(),1);
  assert.equal(await page.locator('[data-edge*="module:frp"]').count(),0);
  assert.equal(await page.locator('[data-architecture-node="router"]').count(),0);
  const inactive=page.locator('.architecture-edge.is-inactive');assert.ok(await inactive.count()>0);
  assert.ok(await page.locator('.architecture-wire').evaluateAll(nodes=>nodes.every(node=>getComputedStyle(node).strokeDasharray==='none')),'all connection lines are solid');
  for(const wire of await inactive.locator('.architecture-wire').all()){
   assert.equal(await wire.getAttribute('marker-end'),null);assert.equal(await wire.getAttribute('marker-start'),null);
  }
  for(const label of await page.locator('.architecture-rate.is-dns').all()){
   const width=await label.evaluate(node=>node.offsetWidth);assert.ok(width<50,'DNS label shrinks to its text');
  }
  const moduleCard=page.locator('[data-architecture-group="modules"]');assert.equal(await moduleCard.count(),1);
  const rows=moduleCard.locator('.architecture-node');assert.equal(await rows.count(),6);
  assert.equal(await moduleCard.locator('.architecture-node-icon').count(),0);
  assert.equal(await page.locator('[data-architecture-node^="gateway:"] .architecture-node-icon').count(),8);
  const logos=page.locator('[data-architecture-node^="gateway:"] .protocol-icon');assert.equal(await logos.count(),8);
  const types=await logos.evaluateAll(nodes=>nodes.map(node=>node.dataset.protocol).sort());assert.deepEqual(types,['direct','lantern','ss','ss','tor','vless','vless','zapret']);
  for(const logo of await logos.all()){
   const geometry=await logo.evaluate(node=>{const svg=node.querySelector('svg'),box=svg.getBoundingClientRect();return {width:box.width,height:box.height,viewBox:svg.getAttribute('viewBox')};});
   assert.ok(Math.abs(geometry.width-geometry.height)<.1);assert.equal(geometry.viewBox,'0 0 24 24');
  }

  assert.equal(await moduleCard.locator('.architecture-group-surface').count(),1);
  for(let i=1;i<6;i++)assert.equal(await rows.nth(i).evaluate(node=>getComputedStyle(node).borderTopWidth),'1px');
  for(let i=0;i<6;i++)assert.equal(await rows.nth(i).evaluate(node=>getComputedStyle(node).boxShadow),'none');
  for(const name of ['Tor','Lantern'])assert.equal(await page.locator('.architecture-node .architecture-node-name').filter({hasText:new RegExp('^'+name+'$')}).count(),2);
  await rows.nth(2).click();assert.equal(await rows.nth(2).getAttribute('aria-pressed'),'true');await page.locator('.architecture-viewport').press('Escape');
  for(const name of ['eth0','wlan0']){
   const wires=page.locator(`[data-edge="port:${name}→modules"] .architecture-wire`);assert.ok(await wires.count()>0);
   for(const wire of await wires.all())assert.equal(await wire.evaluate(node=>getComputedStyle(node).strokeDasharray),'none');
  }
  assert.equal(await page.locator('[data-architecture-node="filter:adguard"]').count(),1);
  const adguard=await page.locator('[data-architecture-node="filter:adguard"]').boundingBox(),modules=await page.locator('.architecture-group-surface').boundingBox();
  assert.ok(Math.abs(adguard.x-modules.x)<1&&adguard.y+adguard.height<modules.y);
  const frp=await page.locator('[data-architecture-node="module:frp"]').boundingBox();
  assert.ok(Math.abs(frp.x-modules.x)<1&&frp.y>=adguard.y+adguard.height);
  const worldScale=await page.getByTestId('architecture-world').evaluate(node=>new DOMMatrix(getComputedStyle(node).transform).a);
  assert.ok(Math.abs((modules.y-adguard.y-adguard.height)/worldScale-16)<1);
  assert.ok(Math.abs((frp.y-modules.y-modules.height)/worldScale-16)<1);
  const frame=await page.locator('[data-architecture-frame="system-modules"]').boundingBox();
  for(const card of [adguard,modules,frp])assert.ok(card.x>frame.x&&card.y>frame.y&&card.x+card.width<frame.x+frame.width&&card.y+card.height<frame.y+frame.height,'outer card encloses all three cards');
  const columns=[await page.locator('[data-architecture-node^="port:"]').first().boundingBox(),frame];
  for(const prefix of ['gateway:','group:','rule:','client:'])columns.push(await page.locator(`[data-architecture-node^="${prefix}"]`).first().boundingBox());
  for(let i=1;i<columns.length;i++)assert.ok(Math.abs((columns[i].x-columns[i-1].x-columns[i-1].width)/worldScale-160)<1,'all visible column gaps equal 160');
  assert.equal(await page.locator('[data-architecture-group="modules"] [data-architecture-node="module:frp"]').count(),0);
  assert.equal(await page.locator('[data-architecture-node="module:frp"] .architecture-node-icon,[data-architecture-node="filter:adguard"] .architecture-node-icon').count(),0);
  assert.equal(await page.locator('[data-edge^="filter:adguard→"]').count(),0);
  assert.equal(await page.locator('[data-edge$="→filter:adguard"]').count(),2);
  const dnsColors=await page.evaluate(()=>{
   const probe=document.createElement('span');probe.style.color='var(--color-success)';document.body.append(probe);const success=getComputedStyle(probe).color;probe.remove();
   return {success,strokes:[...document.querySelectorAll('.architecture-edge.is-dns .architecture-wire,.architecture-arrow.dns,.architecture-mini-wire.is-dns')].map(node=>getComputedStyle(node).stroke)};
  });
  assert.ok(dnsColors.strokes.length>=7);assert.ok(dnsColors.strokes.every(stroke=>stroke===dnsColors.success),'DNS lines and arrows use the success token');
  await page.locator('.architecture-viewport').focus();
  assert.deepEqual(await page.locator('.architecture-viewport').evaluate(node=>{const style=getComputedStyle(node);return {outline:style.outlineStyle,shadow:style.boxShadow};}),{outline:'none',shadow:'none'});
  assert.equal(await page.locator('.architecture-card > .data-card-body').evaluate(node=>getComputedStyle(node).paddingBottom),'0px');


  const alignment=await page.locator('.architecture-world').evaluate(world=>{
   const nodes=new Map([...world.querySelectorAll('[data-architecture-node]')].map(node=>[node.dataset.architectureNode,node]));
   const errors=[];let checked=0;
   for(const edge of world.querySelectorAll('.architecture-edge')){
    const [source,target]=edge.dataset.edge.split('→'),path=edge.querySelector('.architecture-wire');
    if(!path)continue;
    for(const [id,distance] of [[source,0],[target,path.getTotalLength()]]){
     const status=nodes.get(id)?.querySelector('.architecture-status');if(!status)continue;
     const rect=status.getBoundingClientRect(),point=path.getPointAtLength(distance),screen=new DOMPoint(point.x,point.y).matrixTransform(path.getScreenCTM());
     const card=nodes.get(id).getBoundingClientRect(),expectedX=distance===0?card.right:card.left;
     if(Math.abs(screen.y-(rect.top+rect.height/2))>1||Math.abs(screen.x-expectedX)>1)errors.push({id,deltaY:screen.y-(rect.top+rect.height/2),deltaX:screen.x-expectedX});checked++;
    }
   }
   return {checked,errors};
  });
  assert.ok(alignment.checked>20);assert.deepEqual(alignment.errors,[],'connections align with status indicator centers');
  for(const node of await page.locator('.architecture-node.disabled').all()){
   const id=await node.getAttribute('data-architecture-node');
   assert.equal(await page.locator(`[data-counter-edge^="${id}→"] .app-icon,[data-counter-edge$="→${id}"] .app-icon`).count(),0,'disabled endpoints have no counters');
  }
  await checkCounterCenters(page);
  await page.screenshot({path:`/tmp/fg-architecture-router-${theme}.png`});

  assert.ok(await page.locator('.architecture-rate').filter({has:page.locator('.app-icon')}).count()>0);
  const motion=await page.locator('.architecture-rate').first().evaluate(node=>{const style=getComputedStyle(node);return {property:style.transitionProperty,duration:style.transitionDuration};});
  assert.ok(!motion.property.includes('transform')&&motion.property.includes('opacity'),'persistent counters must not animate geometry during zoom');
  assert.ok(motion.duration.includes('0.16s'));
  for(let i=0;i<3;i++)await page.getByRole('button',{name:'Отдалить',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.architecture-rate .app-icon'));
  assert.equal(await page.locator('.architecture-counter-leave-active').count(),0);
  assert.equal(await page.locator('.architecture-rate .app-icon').count(),0,'traffic counters hidden at small scale');
  assert.ok(await page.locator('.architecture-link-label').count()>0,'DNS labels remain visible');
  await checkCounterCenters(page);
  assert.ok(await page.locator('.architecture-wire').count()>0,'connections remain visible');
  for(let i=0;i<3;i++)await page.getByRole('button',{name:'Приблизить',exact:true}).click();
  assert.ok(await page.locator('.architecture-rate .app-icon').count()>0,'traffic counters return on zoom in');
  await page.getByRole('button',{name:'Показать всю схему',exact:true}).click();
  await page.screenshot({path:`/tmp/fg-architecture-current-${theme}.png`,fullPage:true});
 }
 await page.goto('http://127.0.0.1:6006/iframe.html?id=overview-network-architecture--current-map&viewMode=story&globals=theme:dark;locale:zh-CN');
 await page.locator('[data-architecture-group="modules"]').waitFor({state:"attached"});assert.equal(await page.locator('[data-architecture-group="modules"]').getAttribute("aria-label"),"模块");
 await page.goto('http://127.0.0.1:6006/iframe.html?id=overview-network-architecture--current-map&viewMode=story&globals=theme:dark;locale:ru');await page.locator('[data-architecture-group="modules"] .architecture-node').first().waitFor();
 assert.equal(await page.getByTestId('architecture-zoom-debug').count(),0);
 const before=await page.getByTestId('architecture-world').getAttribute('style');await page.getByRole('button',{name:'Приблизить',exact:true}).click();assert.notEqual(await page.getByTestId('architecture-world').getAttribute('style'),before);
 await page.getByRole('button',{name:'Приблизить',exact:true}).click();
 const counter=page.locator('.architecture-rate').filter({has:page.locator('.app-icon')}).first();
 const sizeAt100=await counter.boundingBox();
 for(let i=0;i<3;i++)await page.getByRole('button',{name:'Приблизить',exact:true}).click();
 assert.equal(await page.locator('.architecture-counter-move').count(),0,'zoom must not trigger TransitionGroup FLIP movement');
 const frames=await counter.evaluate(async node=>{
  const frames=[];for(let i=0;i<12;i++){await new Promise(requestAnimationFrame);const r=node.getBoundingClientRect();frames.push({x:r.x,y:r.y,width:r.width,height:r.height});}return frames;
 });
 for(const frame of frames){assert.ok(Math.abs(frame.x-frames[0].x)<.1&&Math.abs(frame.y-frames[0].y)<.1,'counter must not drift after zoom');}
 await checkCounterCenters(page);
 const sizeAbove100=await counter.boundingBox();
 assert.ok(Math.abs(sizeAt100.width-sizeAbove100.width)<.1,'counter width stays fixed above 100%');
 assert.ok(Math.abs(sizeAt100.height-sizeAbove100.height)<.1,'counter height stays fixed above 100%');
 await page.goto('http://127.0.0.1:6006/iframe.html?id=overview-network-architecture--in-overview&viewMode=story');
 await page.locator('.architecture-node').first().waitFor();assert.equal(await page.locator('.architecture-node').count(),41);assert.equal(await page.locator('.overview-dashboard > :first-child').evaluate(el=>el.classList.contains('architecture-card')),true);
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.goto('http://127.0.0.1:6006/iframe.html?id=overview-network-architecture--current-map&viewMode=story');
 await page.locator('.architecture-node').first().waitFor();
 await page.screenshot({path:'/tmp/fg-architecture-current-mobile.png'});
 assert.deepEqual(unexpected,[],'snapshot stories must never request live API');assert.deepEqual(errors,[]);
 console.log('Current map: 41 displayed nodes, both themes, overview row, zoom, mobile and no live API requests passed.');
}finally{await browser.close();}
