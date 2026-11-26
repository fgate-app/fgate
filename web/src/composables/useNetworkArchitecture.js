import {computed,ref} from 'vue';
import {usePolling} from './usePolling.js';
import {buildNetworkArchitectureLayout} from '../lib/network-architecture-layout.js';
export function useNetworkArchitecture(api,activeUserId){
 const snapshot=ref(null),loading=ref(true),unavailable=ref(false);
 const {refresh}=usePolling(activeUserId,{interval:5000,request:signal=>api('dashboard/architecture',{signal}),
  onReset:()=>{snapshot.value=null;loading.value=true;unavailable.value=false;},
  onData:data=>{snapshot.value=data;loading.value=false;unavailable.value=false;},
  onError:()=>{loading.value=false;unavailable.value=true;}
 });
 return {graph:computed(()=>buildNetworkArchitectureLayout(snapshot.value,{loading:loading.value,unavailable:unavailable.value})),refresh};
}
