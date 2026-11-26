import {ref} from 'vue';
export const canInstall=ref(false);
let prompt;
window.addEventListener('beforeinstallprompt',event=>{
 event.preventDefault();prompt=event;canInstall.value=true;
});
window.addEventListener('appinstalled',()=>{prompt=null;canInstall.value=false;});
export async function installApp(){
 const event=prompt;if(!event)return;
 prompt=null;canInstall.value=false;
 try{await event.prompt();await event.userChoice;}catch{/* The browser may withdraw installation eligibility. */}
}
export function registerPwa(){
 if(!import.meta.env.PROD || !window.isSecureContext || !('serviceWorker' in navigator))return;
 window.addEventListener('load',async()=>{
  try{
   const registration=await navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'});
   let checked=Date.now();
   const check=()=>{if(document.visibilityState==='visible' && Date.now()-checked>60000){checked=Date.now();registration.update().catch(()=>{});}};
   window.addEventListener('online',check);document.addEventListener('visibilitychange',check);
  }catch(error){console.warn('FreedomGate: PWA registration failed',error);}
 });
}
