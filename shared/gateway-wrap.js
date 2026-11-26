const engines=new Set(['tor','lantern','outline','xray','socks5','mihomo']);
export const canWrapGateway=profile=>!!profile && (['tor','lantern'].includes(profile.engine) || !profile.builtin && engines.has(profile.engine));
export function gatewayWrapCandidates(profiles,id){
 return profiles.filter(profile=>{
  if(profile.id===id || !canWrapGateway(profile))return false;
  const seen=new Set([id]);let current=profile;
  while(current){if(seen.has(current.id))return false;seen.add(current.id);current=profiles.find(p=>p.id===current.gatewayId);}
  return true;
 });
}
export function gatewayChainAvailable(profiles,id){
 const seen=new Set();let current=profiles.find(p=>p.id===id);
 while(current){
  if(current.enabled===false || seen.has(current.id))return false;
  seen.add(current.id);
  if(!current.gatewayId)return true;
  current=profiles.find(p=>p.id===current.gatewayId);
 }
 return false;
}
export function validateGatewayWrap(profiles,id,gatewayId){
 if(gatewayId!==null && (typeof gatewayId!=='string' || !gatewayId))throw Error("Select an outer gateway.");
 if(gatewayId===null)return;
 if(profiles.find(p=>p.id===id)?.engine==='lantern')throw Error('Lantern cannot be wrapped in another gateway.');
 if(profiles.find(p=>p.id===id)?.engine==='tor' || !canWrapGateway(profiles.find(p=>p.id===id)))throw Error("This connection cannot be wrapped in a gateway.");
 if(gatewayUsesLantern(profiles,gatewayId) && ['wireguard','hysteria2','hysteria','tuic','shadowquic','masque','tailscale','zerotier','easytier'].includes(profiles.find(row=>row.id===id)?.protocol))throw Error('This UDP-only proxy cannot use a TCP-only gateway.');
 if(gatewayUsesTor(profiles,gatewayId) && ['wireguard','hysteria2','hysteria','tuic','shadowquic','masque','tailscale','zerotier','easytier'].includes(profiles.find(row=>row.id===id)?.protocol))throw Error('This UDP-only proxy cannot use a Tor gateway.');
 if(!gatewayWrapCandidates(profiles,id).some(p=>p.id===gatewayId))throw Error("Select another gateway: the connection is missing or creates a cycle.");
}

export function gatewayInChain(profiles,id,engine){
 const seen=new Set();let current=profiles.find(row=>row.id===id);
 while(current && !seen.has(current.id)){if(current.engine===engine)return current;seen.add(current.id);current=profiles.find(row=>row.id===current.gatewayId);}
 return null;
}
export const gatewayUsesTor=(profiles,id)=>!!gatewayInChain(profiles,id,'tor');
export const gatewayUsesLantern=(profiles,id)=>!!gatewayInChain(profiles,id,'lantern');
export const gatewayUsesTcpOnly=(profiles,id)=>gatewayUsesTor(profiles,id)||gatewayUsesLantern(profiles,id);
