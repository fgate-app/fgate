// Root, isolated network namespace only. The fixture never changes host networking.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {probePathMtu} from '../server/path-mtu.js';
const ip=args=>execFileSync('ip',args,{stdio:['ignore','pipe','pipe']});
ip(['link','add','fgmtu0','type','veth','peer','name','fgmtu1']);
try{
 ip(['addr','add','10.38.0.1/24','dev','fgmtu0']);ip(['link','set','fgmtu0','up']);ip(['link','set','fgmtu1','up']);
 // Separate peer namespace prevents the local-address route from bypassing veth.
 execFileSync('ip',['netns','add','fg-mtu-peer']);ip(['link','set','fgmtu1','netns','fg-mtu-peer']);ip(['netns','exec','fg-mtu-peer','ip','link','set','lo','up']);ip(['netns','exec','fg-mtu-peer','ip','link','set','fgmtu1','up']);ip(['netns','exec','fg-mtu-peer','ip','addr','add','10.38.0.2/24','dev','fgmtu1']);
 const options={address:'10.38.0.2',interfaceName:'fgmtu0'};
 const full=await probePathMtu(options);assert.equal(full.outcome,'ok',JSON.stringify(full));assert.equal(full.lowerBound,1500);
 ip(['netns','add','fg-mtu-target']);
 const router=args=>ip(['netns','exec','fg-mtu-peer','ip',...args]),target=args=>ip(['netns','exec','fg-mtu-target','ip',...args]);
 router(['link','add','fgmtr0','type','veth','peer','name','fgmtr1']);router(['link','set','fgmtr1','netns','fg-mtu-target']);router(['addr','add','10.39.0.1/24','dev','fgmtr0']);router(['link','set','fgmtr0','mtu','1280']);router(['link','set','fgmtr0','up']);
 target(['link','set','lo','up']);target(['addr','add','10.39.0.2/24','dev','fgmtr1']);target(['link','set','fgmtr1','up']);target(['route','add','default','via','10.39.0.1']);
 ip(['netns','exec','fg-mtu-peer','sysctl','-qw','net.ipv4.ip_forward=1']);ip(['route','add','10.39.0.0/24','via','10.38.0.2']);
 const icmp=await probePathMtu({...options,address:'10.39.0.2'});assert.equal(icmp.lowerBound,1280,JSON.stringify(icmp));assert.ok(icmp.attempts.some(row=>row.reason==='icmp-size-limit' && row.mtu===1280),JSON.stringify(icmp));
 ip(['link','set','fgmtu0','mtu','1280']);
 const limited=await probePathMtu(options);assert.equal(limited.lowerBound,1280,JSON.stringify(limited));assert.ok(limited.attempts.some(row=>row.reason==='local-size-limit' && row.mtu===1280),JSON.stringify(limited));
 ip(['link','set','fgmtu0','mtu','1500']);
 ip(['-6','addr','add','fd42:38::1/64','dev','fgmtu0','nodad']);ip(['netns','exec','fg-mtu-peer','ip','-6','addr','add','fd42:38::2/64','dev','fgmtu1','nodad']);
 const ipv6=await probePathMtu({...options,address:'fd42:38::2'});assert.equal(ipv6.lowerBound,1500,JSON.stringify(ipv6));
 const silent=await probePathMtu({...options,address:'10.38.0.99'});assert.equal(silent.outcome,'unavailable',JSON.stringify(silent));assert.equal(silent.reportedMtu,null); // no ARP neighbour, silence proves nothing
 console.log(JSON.stringify({full:full.lowerBound,icmp:icmp.reportedMtu,ipv6:ipv6.lowerBound,limited:limited.lowerBound,reportedMtu:limited.reportedMtu,silent:silent.outcome,publicTraffic:false}));
}finally{try{ip(['netns','del','fg-mtu-target']);}catch{}try{ip(['netns','del','fg-mtu-peer']);}catch{}try{ip(['link','del','fgmtu0']);}catch{}}
