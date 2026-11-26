// Proxy-only diagnostic: does NOT verify the client TUN/gateway path. Outside npm test. The HTTP proxy must be an SSH forward
// to the mihomo mixed port. No mock responses and no TLS verification bypass.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
const proxy=process.env.FREEDOMGATE_TEST_PROXY;
if(!proxy)throw new Error('Set FREEDOMGATE_TEST_PROXY explicitly. This diagnostic is not a gateway acceptance test.');
const videoId=process.env.FREEDOMGATE_TEST_VIDEO || 'aqz-KE-bpKQ'; // Blender Foundation: Big Buck Bunny.
const browser=await chromium.launch({channel:'chrome',headless:process.env.FREEDOMGATE_TEST_HEADED!=='1',proxy:{server:proxy},args:['--disable-quic','--autoplay-policy=no-user-gesture-required']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const media=[];let progress;
const playback=()=>page.evaluate(()=>{const v=document.querySelector('video');return {time:v?.currentTime,paused:v?.paused,readyState:v?.readyState,rate:v?.playbackRate,frames:v?.getVideoPlaybackQuality?.().totalVideoFrames,buffered:v?[...Array(v.buffered.length)].map((_,i)=>[v.buffered.start(i),v.buffered.end(i)]):[]};});
page.on('response',response=>{
 const url=new URL(response.url());
 if(url.hostname.endsWith('.googlevideo.com') && url.pathname.includes('videoplayback'))media.push({host:url.hostname,status:response.status(),server:response.headers()['server'],type:response.headers()['content-type']});
});
try{
 console.log('Opening YouTube through the selected proxy');
 await page.goto(`https://www.youtube.com/watch?v=${videoId}`,{waitUntil:'domcontentloaded',timeout:60000});
 console.log('Page loaded');
 for(const name of [/Reject all/i,/Отклонить все/i]) {
  const button=page.getByRole('button',{name}).first();
  if(await button.isVisible().catch(()=>false))await button.click();
 }
 await page.waitForFunction(()=>Boolean(document.querySelector('video')),{},{timeout:45000});
 await page.locator('video').first().evaluate(video=>{video.muted=true;void video.play().catch(()=>{});});
 const state=()=>page.evaluate(()=>{
  const v=document.querySelector('video'),p=document.querySelector('#movie_player');
  return {time:v?.currentTime,paused:v?.paused,readyState:v?.readyState,width:v?.videoWidth,height:v?.videoHeight,
   frames:v?.getVideoPlaybackQuality?.().totalVideoFrames,videoId:p?.getVideoData?.().video_id,
   error:v?.error?.message || document.querySelector('.ytp-error-content-wrap-reason')?.textContent || null};
 });
 await page.waitForFunction(id=>{const v=document.querySelector('video'),p=document.querySelector('#movie_player');return p?.getVideoData?.().video_id===id && v?.currentTime>2 && !v.paused;},videoId,{timeout:60000});
 progress=setInterval(()=>playback().then(data=>console.log('Progress:',JSON.stringify(data))).catch(()=>{}),5000);
 const first=await state();
 console.log('Playback started:',JSON.stringify(first));
 await page.waitForFunction(start=>{const v=document.querySelector('video');return v && v.currentTime-start>=30;},first.time,{timeout:60000});
 const last=await state();
 assert.equal(last.videoId,videoId);
 assert.ok(last.frames>first.frames,'decoded frames advance');
 assert.ok(media.some(r=>r.status===200 || r.status===206),'real media fragments received');
 console.log('Playback verified:',JSON.stringify({first,last,mediaResponses:media.length,successfulMediaResponses:media.filter(r=>r.status===200||r.status===206).length,mediaHosts:[...new Set(media.map(r=>r.host))],transport:'TCP through the selected mihomo proxy; QUIC disabled in test browser'}));
 await page.screenshot({path:'/tmp/freedomgate-youtube-live.png'});
}catch(error){
 console.log('Live check failed:',error.message);
 console.log('Last playback state:',JSON.stringify(await playback().catch(()=>null)));
 console.log('Media responses:',JSON.stringify(media));
 console.log('Page:',await page.title().catch(()=>''));
 console.log('Visible player error:',await page.locator('.ytp-error-content-wrap-reason').allTextContents().catch(()=>[]));
 await page.screenshot({path:'/tmp/freedomgate-youtube-live-failed.png'}).catch(()=>{});
 process.exitCode=1;
}finally{clearInterval(progress);await browser.close();}
