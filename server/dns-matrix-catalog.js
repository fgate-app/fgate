import {isIP} from 'node:net';
import {resolvers} from './dns-resolvers.js';

// Use one catalog entry (including its filtering policy) across all transports.
// Numeric peers come from that entry; DNS bootstrap is never implicit.
export function dnsMatrixProviders(ids,family=4) {
  if(![4,6].includes(family))throw Error('Invalid DNS transport family.');
  const eligible=resolvers.filter(row=>row.protocols?.udp && row.protocols?.dot && row.protocols?.doh && row.ips?.some(ip=>isIP(ip)===4));
  const selected=ids ?? eligible.filter(row=>row.filtering==='none').slice(0,2).map(row=>row.id);
  if(!Array.isArray(selected) || selected.length<1 || selected.length>2 || new Set(selected).size!==selected.length)throw Error('Invalid DNS matrix providers.');
  return selected.map(id=>{
    const entry=eligible.find(row=>row.id===id);
    if(!entry)throw Error('Unsupported DNS matrix provider.');
    const endpoints={};
    for(const transport of ['udp','tcp','dot','doh']){
      const url=new URL(entry.protocols[transport] || (transport==='tcp'?entry.protocols.udp.replace(/^udp:/,'tcp:'):''));
      const host=url.hostname.replace(/^\[|\]$/g,'');
      const address=isIP(host)===family?host:[...(entry.ips || []),...(entry.ipv6Ips || [])].find(ip=>isIP(ip)===family) || null;
      if(family===4 && !address)throw Error('Unsupported DNS matrix address family.');
      endpoints[transport]={address,family,servername:host,port:Number(url.port || ({udp:53,tcp:53,dot:853,doh:443}[transport])),path:url.pathname+url.search};
    }
    return {id:entry.id,name:entry.name,filtering:entry.filtering,family,endpoints};
  });
}

export function normalizeDnsMatrixName(value='example.com') {
  if(typeof value!=='string' || value.length>253)throw Error('Invalid DNS name.');
  const name=value.replace(/\.$/,'').toLowerCase();
  if(name.split('.').length<2 || name.split('.').some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))throw Error('Invalid DNS name.');
  return name;
}

export function dnsMatrixCatalog(){
  const providers=[];
  for(const entry of resolvers){try{dnsMatrixProviders([entry.id]);providers.push({id:entry.id,name:entry.name,filtering:entry.filtering});}catch{}}
  return {providers,defaults:dnsMatrixProviders().map(row=>row.id)};
}
