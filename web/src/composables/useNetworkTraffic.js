import {onMounted,onUnmounted,ref} from 'vue';

export function useNetworkTraffic(api) {
  const traffic=ref({});
  let timer,controller,active=true;
  async function poll() {
    controller=new AbortController();
    try {
      const data=await api('network/traffic',{signal:controller.signal});
      if(active)traffic.value=data.interfaces || {};
    } catch {if(active)traffic.value={};}
    finally {if(active)timer=setTimeout(poll,2000);}
  }
  onMounted(poll);
  onUnmounted(()=>{active=false;clearTimeout(timer);controller?.abort();});
  return traffic;
}
