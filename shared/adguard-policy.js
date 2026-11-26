export function normalizeDnsPolicy(input={}){
 const urls=Array.isArray(input.dnsFilters)?input.dnsFilters:typeof input.dnsFilters==='string'?input.dnsFilters.split(/\r?\n/).filter(line=>line.trim()).map(url=>({url})):[];
 if(urls.length>20)throw Error("Enter up to 20 DNS subscriptions.");
 const dnsFilters=[...new Map(urls.map(item=>{
  let url;try{url=new URL(typeof item==='string'?item:item.url);}catch{throw Error("Enter a valid DNS subscription URL.");}
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.hash || url.href.length>2048)throw Error("Enter an HTTP(S) DNS subscription URL without credentials.");
  return [url.href,{url:url.href,name:String(item.name || '').trim().slice(0,100)}];
 })).values()];
 const raw=Array.isArray(input.dnsRules)?input.dnsRules:String(input.dnsRules || '').split(/\r?\n/);
 const dnsRules=[...new Set(raw.map(rule=>String(rule).trim()).filter(Boolean))];
 if(dnsRules.length>10000 || dnsRules.some(rule=>rule.length>2048 || /[\x00-\x1f]/.test(rule)))throw Error("Invalid custom DNS rules.");
 if((dnsFilters.length || dnsRules.length) && input.routeId!=='block')throw Error("DNS filters are available only for the Block action.");
 return {dnsFilters,dnsRules};
}
export const hasDnsPolicy=group=>Boolean(group?.dnsFilters?.length || group?.dnsRules?.length);
export function normalizeAdGuardSettings(input={}){
 const cacheSize=Number(input.cacheSize ?? 4194304),blockedTtl=Number(input.blockedTtl ?? 10),logInterval=Number(input.logInterval ?? 86400000);
 const logEnabled=input.logEnabled ?? true;
 if(!Number.isInteger(cacheSize) || cacheSize<0 || cacheSize>268435456)throw Error("DNS cache size must be between 0 and 256 MB.");
 if(!Number.isInteger(blockedTtl) || blockedTtl<0 || blockedTtl>86400)throw Error("Blocked response TTL must be between 0 and 86400 seconds.");
 if(typeof logEnabled!=='boolean' || ![21600000,86400000,604800000,2592000000,7776000000].includes(logInterval))throw Error("Check DNS log settings.");
 const subscriptions=normalizeDnsPolicy({routeId:'block',dnsFilters:input.subscriptions || []}).dnsFilters.map(source=>({...source,enabled:(input.subscriptions || []).find(item=>item.url===source.url)?.enabled!==false}));
 return {cacheSize,blockedTtl,logEnabled,logInterval,subscriptions};
}
