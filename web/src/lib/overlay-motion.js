// Shared entry and fade-out timings for every transient surface.
export const overlayDurations=Object.freeze({popup:110,dialog:180,drawer:240});
export const overlayExitDurations=Object.freeze({popup:120,dialog:160,drawer:280});
const running=new WeakMap();
export function cancelOverlay(element){
 const previous=running.get(element);
 previous?.surface.cancel();previous?.backdrop?.cancel();running.delete(element);
}
function animate(element,opening,done,{kind='popup',upward=false,backdrop=false}={}){
 const previous=running.get(element),style=getComputedStyle(element);
 const start={opacity:style.opacity,transform:style.transform};
 const backdropOpacity=backdrop?getComputedStyle(element,'::backdrop').opacity:1;
 cancelOverlay(element);
 element.inert=!opening;
 if(opening)element.removeAttribute('aria-hidden');else element.setAttribute('aria-hidden','true');
 element.dataset.overlayState=opening?'entering':'leaving';
 const complete=()=>{element.dataset.overlayState=opening?'open':'closed';done?.();};
 if(matchMedia('(prefers-reduced-motion: reduce)').matches){complete();return;}
 const duration=(opening?overlayDurations:overlayExitDurations)[kind];
 const easing=opening?'cubic-bezier(.2,.8,.2,1)':'ease-out';
 const initial=kind==='drawer'?{opacity:1,transform:'translateX(-100%)'}:kind==='dialog'?{opacity:0,transform:'translateY(12px) scale(.98)'}:{opacity:0,transform:`translateY(${upward?4:-4}px)`};
 const frames=opening?[previous?start:initial,{opacity:1,transform:'none'}]:[start,{opacity:0,transform:start.transform}];
 const surface=element.animate(frames,{duration,easing,fill:'forwards'});
 let shade;
 if(backdrop){
  // Firefox versions without pseudo-element animation still fade the surface.
  try{shade=element.animate([{opacity:previous?backdropOpacity:opening?0:1},{opacity:opening?1:0}],{duration,easing,fill:'forwards',pseudoElement:'::backdrop'});}catch{}
 }
 const animation={surface,backdrop:shade};running.set(element,animation);
 surface.onfinish=()=>{
  if(running.get(element)!==animation)return;
  running.delete(element);complete();surface.cancel();shade?.cancel();
 };
}
export function enterOverlay(element,done,options){animate(element,true,done,options);}
export function leaveOverlay(element,done,options){animate(element,false,done,options);}
