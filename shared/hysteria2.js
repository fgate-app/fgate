const fail=()=>{throw Error('Invalid Hysteria 2 configuration.');};
export const hysteria2Fields=['server','port','password','sni','skip-cert-verify','fingerprint','obfs','obfs-password'];
export function normalizeHysteria2(input){
  if(!input || input.type!=='hysteria2' || Object.keys(input).some(key=>!['type','udp',...hysteria2Fields].includes(key)))fail();
  const p={...input};
  if(typeof p.server!=='string' || !p.server || /[\s/\\?#@%]/.test(p.server) || !Number.isInteger(p.port) || p.port<1 || p.port>65535)fail();
  try{const host=new URL('https://'+(p.server.includes(':')?'['+p.server+']':p.server)+':'+p.port);if(!host.hostname)fail();}catch{fail();}
  for(const field of ['password','sni','fingerprint','obfs','obfs-password'])if(p[field]!==undefined && typeof p[field]!=='string')fail();
  if(p.sni && /[\u0000-\u0020\u007f/\\?#@]/.test(p.sni))fail();
  if(p['skip-cert-verify']!==undefined && typeof p['skip-cert-verify']!=='boolean')fail();
  if(p.udp!==undefined && p.udp!==true)fail();
  if(p.obfs && p.obfs!=='salamander')throw Error('This Hysteria 2 obfuscation is not supported.');
  if((p.obfs && !p['obfs-password']) || (!p.obfs && p['obfs-password']))throw Error('Specify Salamander obfuscation and its password together.');
  if(p.fingerprint){
    if(!/^(?:[a-f\d]{64}|(?:[a-f\d]{2}:){31}[a-f\d]{2})$/i.test(p.fingerprint))throw Error('Specify a SHA-256 certificate fingerprint (64 hexadecimal digits).');
    p.fingerprint=p.fingerprint.replaceAll(':','').toLowerCase();
  }
  return {type:'hysteria2',server:p.server,port:p.port,password:p.password ?? '',udp:true,'skip-cert-verify':p['skip-cert-verify'] ?? false,
    ...Object.fromEntries(['sni','fingerprint','obfs','obfs-password'].filter(key=>p[key]).map(key=>[key,p[key]]))};
}

export function parseHysteria2(value){
  try{
    if(typeof value!=='string' || !/^(hy2|hysteria2):\/\//i.test(value) || /\s/.test(value))fail();
    decodeURIComponent(value); // Reject malformed escapes, including invalid UTF-8.
    const url=new URL(value),authority=value.split('://')[1].split(/[/?#]/)[0];
    if(!['','/'].includes(url.pathname) || (authority.match(/@/g) || []).length>1)fail();
    const allowed=new Set(['sni','insecure','pinSHA256','obfs','obfs-password']),seen=new Set();
    for(const [key] of url.searchParams){if(!allowed.has(key))throw Error('This Hysteria 2 link contains unsupported parameters.');if(seen.has(key))fail();seen.add(key);}
    const insecure=url.searchParams.get('insecure');if(insecure!==null && !['0','1'].includes(insecure))fail();
    return normalizeHysteria2({type:'hysteria2',server:url.hostname.replace(/^\[|\]$/g,''),port:Number(url.port || 443),
      password:authority.includes('@')?decodeURIComponent(authority.slice(0,authority.lastIndexOf('@'))):'',
      sni:url.searchParams.get('sni') || '',fingerprint:url.searchParams.get('pinSHA256') || '',
      'skip-cert-verify':insecure==='1',obfs:url.searchParams.get('obfs') || '', 'obfs-password':url.searchParams.get('obfs-password') || ''});
  }catch(error){if(error.message?.includes('Hysteria 2') || error.message?.startsWith('Specify '))throw error;fail();}
}
