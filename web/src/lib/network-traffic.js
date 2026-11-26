export function formatNetworkRate(value,t) {
  if(!Number.isFinite(value) || value<0)return '—';
  const units=['Б/с','КБ/с','МБ/с','ГБ/с'];let index=0;
  while(value>=1024 && index<units.length-1){value/=1024;index++;}
  return `${Number(value.toFixed(index?1:0))} ${t(units[index])}`;
}
export function interfaceRates(traffic,name,uplink=false) {
  const counters=traffic?.[name];
  return {upload:uplink?counters?.transmitRate:counters?.receiveRate,download:uplink?counters?.receiveRate:counters?.transmitRate};
}
