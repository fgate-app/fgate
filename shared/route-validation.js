import {uniqueRouteEntries} from './route-preset-entries.js';
// Use the same route validation on the server and in forms.
export function createRouteValidation(isIP){
const domain=/^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
function validRouteEntry(value){
 if(typeof value!=='string' || !value || value.length>1024)return false;
 if(value.startsWith('exclude:')){const inner=value.slice(8),name=inner.startsWith('full:')?inner.slice(5):inner;return name.length<=253 && domain.test(name) && !name.includes('*') && !isIP(name);}
 if(value.startsWith('full:'))return value.slice(5).length<=253 && domain.test(value.slice(5)) && !value.includes('*');
 if(value.startsWith('keyword:'))return /^[a-z0-9_.-]+$/i.test(value.slice(8));
 if(value.startsWith('regexp:')){
  const expression=value.slice(7);
  if(!expression || /[\s/\x00-\x1f]/.test(expression) || /\(\?[=!<]|\\[1-9]/.test(expression))return false;
  let inClass=false;
  for(let index=0;index<expression.length;index++){
   const char=expression[index];
   if(char==='\\'){
    const escaped=expression[++index];
    if(!escaped || /[a-zA-Z]/.test(escaped) && !/[abfnrtvABdDsSwWzpxPQE]/.test(escaped) || inClass && escaped==='b')return false;
    if(escaped==='x'){const hex=/^(?:[a-f0-9]{2}|\{[a-f0-9]{1,6}\})/i.exec(expression.slice(index+1));if(!hex || hex[0][0]==='{' && parseInt(hex[0].slice(1,-1),16)>0x10ffff)return false;index+=hex[0].length;}
    continue;
   }
   if(char==='[')inClass=true;else if(char===']')inClass=false;
   if(!inClass && char==='{'){
    const repeat=/^\{(\d+)(?:,(\d*))?\}/.exec(expression.slice(index));
    if(repeat && (Number(repeat[1])>1000 || repeat[2] && Number(repeat[2])>1000))return false;
   }
  }
  try{new RegExp(expression);return true;}catch{return false;}
 }
 if(isIP(value))return true;
 if(/^\d+(?:\.\d+){3}$/.test(value))return false;
 if(/^[0-9a-f:.]+\/\d{1,3}$/i.test(value)){
  const [address,prefix]=value.split('/'),version=isIP(address);
  return !!version && Number(prefix)>=0 && Number(prefix)<=(version===4?32:128);
 }
 return value.length<=253 && domain.test(value);
}
function normalizeRouteEntries(input,{max=50000}={}){
 const raw=Array.isArray(input)?input:String(input ?? '').split(/\r?\n/);
 const entries=uniqueRouteEntries(raw);
 if(!entries.length)throw new Error("Enter at least one domain, IP or CIDR.");
 if(entries.length>max)throw new Error(max===50000?"Specify no more than 50000 addresses.":"Specify no more than 500000 addresses.");
 for(const entry of entries)if(!validRouteEntry(entry))throw new Error("Invalid address: "+entry);
 return entries;
}
const DOMAIN_PATTERN = /^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const MAC_PATTERN = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const ALIAS_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
function normalizeLocalRoute(input) {
  const alias = String(input?.alias ?? '').trim().toLowerCase();
  const target = String(input?.target ?? '').trim().toLowerCase();
  if (!alias || alias.length > 253 || !ALIAS_PATTERN.test(alias)) throw new Error("Enter a valid alias, e.g. router.home.");
  if (!target || !(isIP(target) || (target.includes('/') && validRouteEntry(target) && !/^(full|regexp|keyword):/.test(target)) || DOMAIN_PATTERN.test(target))) throw new Error("Enter a valid address: IP, domain or CIDR.");
  return { alias, target };
}
function validDeviceIdentifier(value){return !!isIP(value) || MAC_PATTERN.test(value);}
return {validRouteEntry,normalizeRouteEntries,normalizeLocalRoute,validDeviceIdentifier};
}
