// In-memory history: only connections actually observed by mihomo are recorded.
export function createConnectionJournal(controller,{now=Date.now,retention=5*60*1000,maxClosed=1000}={}){
 const rows=new Map();let available=false,pending=null;
 const snapshot=()=>({available,retention,connections:[...rows.values()].sort((a,b)=>Number(b.active)-Number(a.active) || b.lastSeen-a.lastSeen)});
 return {
  snapshot,
  async poll(){
   if(pending)return pending;
   pending=(async()=>{
    try{
     const data=await controller('/connections');if(data?.connections===null)data.connections=[];if(!Array.isArray(data?.connections))throw Error('Invalid connections');
     const seen=new Set(),time=now();
     for(const connection of data.connections){
      if(typeof connection.id!=='string' || connection.chains?.some(chain=>['REJECT','REJECT-DROP'].includes(chain)))continue;
      const m=connection.metadata || {},old=rows.get(connection.id);seen.add(connection.id);
      const upload=Math.max(0,Number(connection.upload)||0),download=Math.max(0,Number(connection.download)||0);
      const elapsed=old?.active?(time-old.lastSeen)/1000:0;
      rows.set(connection.id,{id:connection.id,active:true,startedAt:connection.start || old?.startedAt || new Date(time).toISOString(),lastSeen:time,closedAt:null,
       host:m.host || m.destinationIP || '',destinationIP:m.destinationIP || '',destinationPort:String(m.destinationPort || ''),
       sourceIP:m.sourceIP || '',sourcePort:String(m.sourcePort || ''),process:m.process || m.processPath || '',network:m.network || '',type:m.type || '',
       rule:connection.rule || '',rulePayload:connection.rulePayload || '',chains:Array.isArray(connection.chains)?connection.chains.filter(v=>typeof v==='string'):[],
       upload,download,
       uploadSpeed:elapsed>0?Math.max(0,upload-old.upload)/elapsed:0,downloadSpeed:elapsed>0?Math.max(0,download-old.download)/elapsed:0,
       sniffHost:m.sniffHost || '',dnsMode:m.dnsMode || '',remoteDestination:m.remoteDestination || '',
       inboundName:m.inboundName || '',inboundIP:m.inboundIP || '',inboundPort:String(m.inboundPort || ''),inboundUser:m.inboundUser || '',
       processName:m.process || '',processPath:m.processPath || '',uid:m.uid ?? ''});
     }
     for(const row of rows.values())if(row.active && !seen.has(row.id)){row.active=false;row.uploadSpeed=0;row.downloadSpeed=0;row.closedAt=new Date(time).toISOString();row.lastSeen=time;}
     const closed=[...rows.values()].filter(row=>!row.active).sort((a,b)=>b.lastSeen-a.lastSeen);
     for(let i=0;i<closed.length;i++)if(i>=maxClosed || time-closed[i].lastSeen>retention)rows.delete(closed[i].id);
     available=true;
    }catch{available=false;} // A controller outage is not proof that connections closed.
    return snapshot();
   })().finally(()=>pending=null);
   return pending;
  },
  async close(id){
   const row=rows.get(id);if(!row?.active)return false;
   await controller('/connections/'+encodeURIComponent(id),{method:'DELETE'});
   row.active=false;row.uploadSpeed=0;row.downloadSpeed=0;row.closedAt=new Date(now()).toISOString();row.lastSeen=now();return true;
  }
 };
}
