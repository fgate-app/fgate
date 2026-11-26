import {readFile,readdir} from 'node:fs/promises';

export async function readInterfaceCounters() {
  const names=await readdir('/sys/class/net');
  return Promise.all(names.filter(name=>name!=='lo').map(async name=>{
    try {
      const base=`/sys/class/net/${name}`;
      const [index,receive,transmit]=await Promise.all([
        readFile(`${base}/ifindex`,'utf8'),readFile(`${base}/statistics/rx_bytes`,'utf8'),readFile(`${base}/statistics/tx_bytes`,'utf8')
      ]);
      return {name,index:index.trim(),receive:BigInt(receive.trim()),transmit:BigInt(transmit.trim())};
    }catch{return {name};}
  }));
}

// Kernel interface counters include all traffic, even flows bypassing mihomo.
// Use monotonic time and reset the baseline after a counter/interface reset.
export function createInterfaceTraffic({read=readInterfaceCounters,now=()=>performance.now(),cacheMs=1000}={}) {
  let previous=new Map(),cached=null,sampled=-Infinity,pending;
  return async()=>{
    if(cached && now()-sampled<cacheMs)return cached;
    if(pending)return pending;
    pending=(async()=>{
      try {
        const rows=await read(),time=now(),next=new Map(),interfaces={};
        for(const row of rows) {
          const old=previous.get(row.name);
          const valid=typeof row.receive==='bigint' && typeof row.transmit==='bigint' && row.receive>=0n && row.transmit>=0n;
          const seconds=old?(time-old.time)/1000:0;
          const comparable=valid && old && old.index===row.index && seconds>0 && row.receive>=old.receive && row.transmit>=old.transmit;
          interfaces[row.name]={receiveRate:comparable?Number(row.receive-old.receive)/seconds:null,transmitRate:comparable?Number(row.transmit-old.transmit)/seconds:null};
          if(valid)next.set(row.name,{...row,time});
        }
        previous=next;sampled=time;cached={interfaces};
      }catch {previous.clear();sampled=now();cached={interfaces:{}};}
      return cached;
    })().finally(()=>{pending=null;});
    return pending;
  };
}
