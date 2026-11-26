const intervals={hours:3600000,days:86400000};
const count=value=>Number.isSafeInteger(value) && value>=0?value:null;

// Keep AdGuard's native buckets; missing counters stay unknown rather than zero.
export function normalizeAdGuardStatistics(data,now=Date.now()) {
 const interval=intervals[data?.time_units];
 if(!interval || !Array.isArray(data.dns_queries) || !Array.isArray(data.blocked_filtering)) {
  throw new Error('Invalid AdGuard statistics');
 }
 const end=Math.floor(now/interval)*interval;
 const length=Math.max(data.dns_queries.length,data.blocked_filtering.length);
 return {
  available:true,
  interval,
  queries:count(data.num_dns_queries),
  blocked:count(data.num_blocked_filtering),
  samples:Array.from({length},(_,index)=>({
   time:end-(length-1-index)*interval,
   queries:count(data.dns_queries[index]),
   blocked:count(data.blocked_filtering[index])
  }))
 };
}
