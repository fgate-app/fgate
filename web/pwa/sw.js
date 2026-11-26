// Only the public offline page and installation artwork are stored. API requests
// and authenticated pages always go to the network.
const CACHE='freedomgate-offline-__BUILD_ID__';
const OFFLINE='/offline.html';
const PUBLIC_FILES=[OFFLINE,'/typography.css','/colors.css','/icons/icon-192.png','/icons/icon-512.png','/icons/icon-maskable-512.png','/icons/apple-touch-icon.png'];
self.addEventListener('install',event=>{
 event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(PUBLIC_FILES)));
});
self.addEventListener('activate',event=>{
 event.waitUntil((async()=>{
  for(const name of await caches.keys())if(name.startsWith('freedomgate-offline-') && name!==CACHE)await caches.delete(name);
  await self.clients.claim();
 })());
});
self.addEventListener('fetch',event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=='GET' || url.origin!==self.location.origin || url.pathname.startsWith('/api/'))return;
 if(PUBLIC_FILES.includes(url.pathname)){
  event.respondWith(caches.open(CACHE).then(async cache=>await cache.match(url.pathname) || fetch(request)));
  return;
 }
 if(request.mode==='navigate'){
  event.respondWith(fetch(request).catch(async()=>{
   const cache=await caches.open(CACHE);
   return await cache.match(OFFLINE) || Response.error();
  }));
 }
});
