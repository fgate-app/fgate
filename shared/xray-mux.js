export const xrayMuxFields=['muxEnabled','muxConcurrency','muxXudpConcurrency','muxUdp443'];
export const tcpMuxUnsupported=fields=>!!fields.flow || ['xhttp','splithttp'].includes(fields.network);
const invalid=()=>{throw Error('Invalid Xray Mux settings.');};
export function validateXrayMux(outbound){
 const mux=outbound.mux;if(mux===undefined)return;
 if(!mux || typeof mux!=='object' || Array.isArray(mux))invalid();
 if(mux.enabled!==undefined && typeof mux.enabled!=='boolean')invalid();
 for(const field of ['concurrency','xudpConcurrency'])if(mux[field]!==undefined && (!Number.isInteger(mux[field]) || mux[field]<-32768 || mux[field]>32767))invalid();
 if(mux.xudpProxyUDP443!==undefined && !['','reject','allow','skip'].includes(mux.xudpProxyUDP443))invalid();
 if(mux.enabled && (mux.concurrency ?? 0)>=0 && tcpMuxUnsupported({network:outbound.streamSettings?.network,flow:outbound.settings?.vnext?.[0]?.users?.[0]?.flow}))throw Error('TCP Mux is incompatible with Vision and XHTTP. Set TCP concurrency to -1 for XUDP only.');
}
export function xrayMuxDraft(outbound){
 const mux=outbound.mux;
 return {muxEnabled:String(mux?.enabled ?? false),muxConcurrency:String(mux?.concurrency ?? (mux?0:128)),muxXudpConcurrency:String(mux?.xudpConcurrency ?? (mux?0:16)),muxUdp443:mux?.xudpProxyUDP443 || 'reject'};
}
export function xrayMuxFromDraft(fields){
 if(!['true','false',undefined,''].includes(fields.muxEnabled))invalid();
 const enabled=fields.muxEnabled==='true';if(!enabled)return {enabled:false};
 const integer=(value,fallback)=>{if(value===undefined || value==='')return fallback;if(!/^-?\d+$/.test(value))invalid();return Number(value);};
 const mux={enabled:true,concurrency:integer(fields.muxConcurrency,128),xudpConcurrency:integer(fields.muxXudpConcurrency,16),xudpProxyUDP443:fields.muxUdp443 || 'reject'};
 validateXrayMux({mux,streamSettings:{network:fields.network || 'tcp'},settings:{vnext:[{users:[{flow:fields.flow || ''}]}]}});return mux;
}
