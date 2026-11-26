// A repeated apply may retain the live LAN only after checking both its
// configuration and its actual state. A stale current.json alone is insufficient.
export async function canReuseNetwork({current,parsed,apConfig,savedApConfig,daemonRunning,run}) {
  if(!current || Object.keys(parsed).some(key=>JSON.stringify(parsed[key])!==JSON.stringify(current[key])))return false;
  if(parsed.clientType==='ap' && apConfig!==savedApConfig)return false;
  try {
    if(!await daemonRunning('dnsmasq'))return false;
    if(parsed.clientType==='ap' && !await daemonRunning('hostapd'))return false;
    for (const network of parsed.networks || []) {
      const address=await run('ip',['-4','-o','addr','show','dev',network.interface]);
      if(!address.includes(`inet ${network.address}/${network.prefix} `))return false;
    }
    const [client,uplink,forward]=await Promise.all([
      run('ip',['-4','-o','addr','show','dev',parsed.client]),
      run('ip',['-4','-o','addr','show','dev',parsed.uplink]),
      run('sysctl',['-n','net.ipv4.ip_forward']),
      run('nft',['list','table','inet','freedomgate_nat']),
    ]);
    if(!client.includes(`inet ${parsed.address}/${parsed.prefix} `) || !client.includes('scope global'))return false;
    if((/inet (\d+\.\d+\.\d+\.\d+\/\d+)/.exec(uplink)?.[1] || '')!==current.uplinkSubnet)return false;
    return forward.trim()==='1';
  }catch{return false;}
}
