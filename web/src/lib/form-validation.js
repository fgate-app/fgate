import {createRouteValidation} from '../../../shared/route-validation.js';

export function ipVersion(value) {
 if(typeof value!=='string' || !value)return 0;
 if(/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(value)) {
  return value.split('.').every(part=>Number(part)<=255)?4:0;
 }
 if(!value.includes(':') || /[^a-f\d:.]/i.test(value))return 0;
 if(value.includes('.') && ipVersion(value.slice(value.lastIndexOf(':')+1))!==4)return 0;
 try{return new URL(`http://[${value}]/`).hostname?6:0;}catch{return 0;}
}
export const {normalizeRouteEntries,normalizeLocalRoute,validDeviceIdentifier}=createRouteValidation(ipVersion);
export const validPort=value=>Number.isInteger(Number(value)) && Number(value)>=1 && Number(value)<=65535;
export function validResolver(value) {
 try {
  const url=new URL(value);
  return ['https:','tls:','quic:','udp:','tcp:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
 }catch{return false;}
}
