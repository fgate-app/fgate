const fail=()=>{throw Object.assign(Error('Invalid VLESS Encryption settings. Use none or a supported mlkem768x25519plus client string with matching server keys.'),{code:'VLESS_ENCRYPTION_INVALID'});};
// Xray 26.11.9 client syntax. Never include authentication material in errors.
export function vlessEncryption(value='none'){
 if(value==='none')return value;
 if(typeof value!=='string' || value.length>256*1024)fail();
 const [method,appearance,rtt,...parts]=value.split('.');
 if(method!=='mlkem768x25519plus' || !['native','xorpub','random'].includes(appearance) || !['0rtt','1rtt'].includes(rtt) || !parts.length)fail();
 let keys=false,padding=0,total=0;
 for(const part of parts){
  if(part.length>=20){
   if(!/^[A-Za-z0-9_-]+$/.test(part) || ![43,1579].includes(part.length))fail();
   let decoded;try{decoded=atob(part.replace(/-/g,'+').replace(/_/g,'/'));}catch{fail();}
   if(![32,1184].includes(decoded.length) || btoa(decoded).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')!==part)fail();
   keys=true;continue;
  }
  if(keys || !/^\d+-\d+-\d+$/.test(part))fail();
  const [probability,min,max]=part.split('-').map(Number);
  if(![probability,min,max].every(Number.isSafeInteger) || probability>100 || min>max || (!padding && (probability!==100 || min<35)))fail();
  if(padding%2===0)total+=max;
  if(total>65553)fail();padding++;
 }
 if(!keys)fail();
 return value;
}
