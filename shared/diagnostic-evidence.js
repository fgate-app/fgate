const verified=row=>row?.routeVerified===true || row?.pathObservation?.state==='verified';
const aggregate=rows=>rows.every(row=>row.state==='ok')?'ok':rows.every(row=>row.state==='failed')?'failed':rows.every(row=>row.state==='unavailable')?'unavailable':'partial';
const providerName=(matrix,id,providers)=>[...(matrix.providers || []),...providers].find(row=>row.id===id)?.name || id || 'DNS';
export function probeMessage(row,changed=false){
 if(changed || row.observation==='configuration-changed' || row.reason==='configuration-changed')return 'The settings changed during this request.';
 const reason=row.reason || row.observation;
 if(row.pathObservation?.state==='mismatch' || reason==='path-mismatch')return 'The request used a different gateway.';
 const messages={'http3-tool-unavailable':'The installed curl does not support HTTP/3.','http3-unconfirmed':'No HTTP/3 response was received within the time limit.','http3-probe-unavailable':'The HTTP/3 request could not be completed.','tls-version-unavailable':'This TLS version is not supported by the test tool.','tls-probe-unavailable':'The TLS comparison could not be completed.','transport-error':'The connection could not be established.','path-unverified':'The response arrived, but its route could not be confirmed.','resolver-ipv6-unavailable':'This resolver has no IPv6 endpoint in the catalog.','gateway-ipv6-unavailable':'The gateway could not connect to the IPv6 resolver.','route-unavailable':'No usable route to this resolver was found.',timeout:'No response within the time limit.','budget-exhausted':'The diagnostic time budget was reached.','gateway-udp-unavailable':'This gateway could not carry the UDP request.','permission-denied':'The test process lacked permission to send the request.','dns-address-unavailable':'The website IP address could not be obtained.','dns-unavailable':'The DNS request could not be completed.','baseline-unavailable':'The initial control connection failed, so this comparison could not run.','certificate-error':'The server certificate could not be verified.','tls-alert':'The server interrupted the secure connection.','tls-error':'The secure connection could not be established.','unexpected-eof':'The server closed the connection before the response was complete.','connection-reset':'The connection was reset.','connect-error':'The connection could not be established.','connection-refused':'The connection was refused.','refused':'The connection was refused.','transport-unavailable':'The test transport was unavailable.','gateway-probe-unavailable':'The gateway request could not be performed.','invalid-response':'The server returned an invalid response.'};
 if(messages[reason])return messages[reason];
 if((row.state==='ok' || row.responseState==='ok') && !verified(row))return 'The response arrived, but its route could not be confirmed.';
 return row.state==='ok'?'The secure connection succeeded.':row.state==='failed'?'The request failed.':'The request could not be completed.';
}
export function dnsEvidence(matrix,providers=[]){
 const groups=new Map(),flat=(matrix.attempts || []).map(row=>({...row,responseState:row.state,state:matrix.path?.configChanged?'unavailable':row.state==='ok' && row.rcode===0 && verified(row)?'ok':row.state==='failed' || (row.rcode!=null && row.rcode!==0)?'failed':'unavailable'}));
 for(const row of flat){const key=[row.provider,row.family || matrix.family || 4,row.transport,row.qtype].join(':');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);}
 const rows=[...groups.values()].map(group=>{
  const first=group[0],details=[];
  for(const row of group){
   let message,params;
   if(matrix.path?.configChanged){message=probeMessage(row,true);}
   else if(row.state==='ok'){
    const addresses=[...new Set((row.answers || []).filter(answer=>['A','AAAA'].includes(answer.type)).map(answer=>answer.value))];
    message=addresses.length?'DNS returned: {addresses}.':'DNS replied with no addresses of this type.';params={addresses:addresses.join(', ')};
   }else if(row.rcode===3){message='DNS reports that this domain does not exist.';}
   else if(row.rcode!=null && row.rcode!==0){message='DNS returned error code {code}.';params={code:row.rcode};}
   else message=probeMessage(row,matrix.path?.configChanged);
   if(!details.some(detail=>detail.message===message && JSON.stringify(detail.params)===JSON.stringify(params)))details.push({message,params});
  }
  return {target:[providerName(matrix,first.provider,providers),String(first.transport || 'DNS').toUpperCase(),`IPv${first.family || matrix.family || 4}`,first.qtype].filter(Boolean).join(' · '),state:aggregate(group),message:'Successful DNS replies: {ok} of {total}.',params:{ok:group.filter(row=>row.state==='ok').length,total:group.length},details};
 });
 return {rows,params:{ok:flat.filter(row=>row.state==='ok').length,failed:flat.filter(row=>row.state==='failed').length,unavailable:flat.filter(row=>row.state==='unavailable').length,total:flat.length}};
}
const operations={'baseline-before':'Control connection before changing the site name','foreign-sni':'Control server with the tested site name','baseline-after':'Control connection after changing the site name','target-own-ip':'Website connection with its own site name','control-on-target-ip':'Website server with the control site name'};
export function sniEvidence(matrix,providers=[]){
 return (matrix.attempts || []).map(row=>({target:[providerName(matrix,row.provider,providers),row.address].filter(Boolean).join(' · '),operation:operations[row.kind] || 'Secure connection',state:matrix.path?.configChanged?'unavailable':row.state==='failed'?'failed':row.state==='ok' && verified(row)?'ok':'unavailable',message:probeMessage(row,matrix.path?.configChanged),details:[...(row.servername?[{message:'Site name sent: {name}.',params:{name:row.servername}}]:[]),...(row.resolution?.state==='unavailable'?[{message:probeMessage({state:'unavailable',reason:row.resolution.reason})}]:[])]}));
}
