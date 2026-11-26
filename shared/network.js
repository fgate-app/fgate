// Shared by the editor, API and privileged helper. Existing AP records retain
// their original interface and addressing; the second LAN is opt-in.
export function logicalInterface(parent, vlanId) {
  if (vlanId === '' || vlanId === null || vlanId === undefined) return parent;
  if (!/^\d+$/.test(String(vlanId)) || Number(vlanId)<1 || Number(vlanId)>4094) throw new Error('VLAN ID: 1–4094.');
  const name=`${parent}.${Number(vlanId)}`;
  if (name.length<=15) return name;
  let hash=2166136261;
  for (const char of parent) hash=Math.imul(hash^char.charCodeAt(0),16777619)>>>0;
  return `fg${Number(vlanId)}-${hash.toString(36)}`;
}
export function normalizeNetworkSetup(input) {
  const value=input && typeof input==='object' && !Array.isArray(input)?input:{};
  return {...value,
    uplink:{...value.uplink,interface:value.uplink?.interface??''},
    client:{...value.client,interface:value.client?.interface??'',type:value.client?.type==='ethernet'?'ethernet':'ap',ssid:value.client?.ssid??'',password:value.client?.password??'',subnet:value.client?.subnet??'10.10.0.1/24',vlanId:value.client?.vlanId??''},
    dhcp:{start:'10.10.0.100',end:'10.10.0.200',...value.dhcp},
    wired:{interface:'',vlanId:'',subnet:'10.30.0.1/24',...value.wired,enabled:value.wired?.enabled===true,dhcp:{start:'10.30.0.100',end:'10.30.0.200',...value.wired?.dhcp}}
  };
}
export function clientNetworks(setup) {
  return [{...setup.client,dhcp:setup.dhcp},...(setup.wired?.enabled?[setup.wired]:[])];
}
