#!/usr/bin/env python3
"""Test actual generated firewall in three isolated netns, never the host firewall."""
import os,subprocess,uuid,pathlib
assert os.geteuid()==0
suffix=uuid.uuid4().hex[:6];names=['fgfc-'+suffix+x for x in ['c','r','s']]
c,r,s=names
root=pathlib.Path(__file__).resolve().parents[2]
def run(*args):return subprocess.run(args,check=True,capture_output=True,text=True).stdout
def ns(n,*args):return run('ip','netns','exec',n,*args)
def ping(n,target,ok):
 p=subprocess.run(['ip','netns','exec',n,'ping','-c','2','-W','2',target],capture_output=True)
 assert (p.returncode==0)==ok,(n,target,p.stdout,p.stderr)
try:
 for n in names:
  run('ip','netns','add',n);ns(n,'sysctl','-qw','net.ipv6.conf.all.disable_ipv6=0');ns(n,'sysctl','-qw','net.ipv6.conf.default.disable_ipv6=0');run('ip','-n',n,'link','set','lo','up')
 for left,li,right,ri in [(c,'client',r,'lan'),(r,'wan',s,'server')]:
  run('ip','link','add',li,'type','veth','peer','name',ri);run('ip','link','set',li,'netns',left);run('ip','link','set',ri,'netns',right)
 for n,iface,v4,v6 in [(c,'client','10.77.0.2/24','fd77:1::2/64'),(r,'lan','10.77.0.1/24','fd77:1::1/64'),(r,'wan','10.78.0.1/24','fd77:2::1/64'),(s,'server','10.78.0.2/24','fd77:2::2/64')]:
  run('ip','-n',n,'addr','add',v4,'dev',iface);run('ip','-n',n,'-6','addr','add',v6,'dev',iface,'nodad');run('ip','-n',n,'link','set',iface,'up')
 ns(r,'sysctl','-qw','net.ipv4.ip_forward=1');ns(r,'sysctl','-qw','net.ipv6.conf.all.forwarding=1')
 for n,via,via6 in [(c,'10.77.0.1','fd77:1::1'),(s,'10.78.0.1','fd77:2::1')]:
  run('ip','-n',n,'route','add','default','via',via);run('ip','-n',n,'-6','route','add','default','via',via6)
 ping(c,'10.78.0.2',True);ping(c,'fd77:2::2',True)
 for generator in ['single','multi']:
  js="import {nftConfig} from './server/network-config.js';import {multiNftConfig} from './server/network-runtime.js';console.log("+("nftConfig('lan','wan','10.77.0.0/24','')" if generator=='single' else "multiNftConfig([{interface:'lan',subnet:'10.77.0.0/24'}],'wan','')")+");"
  rules=subprocess.run([os.environ.get('NODE','node'),'--input-type=module','-e',js],cwd=root,check=True,capture_output=True,text=True).stdout
  subprocess.run(['ip','netns','exec',r,'nft','-f','-'],input=rules,check=True,text=True)
  ping(c,'10.78.0.2',False);ping(c,'fd77:2::2',False)
  ping(r,'10.78.0.2',True);ping(r,'fd77:2::2',True) # local proxy/DIRECT output remains usable
  ns(r,'ip','tuntap','add','dev','testtun','mode','tun');ns(r,'ip','link','set','testtun','up');ns(r,'ip','link','del','testtun')
  ping(c,'10.78.0.2',False);ping(c,'fd77:2::2',False)
  ns(r,'nft','delete','table','inet','freedomgate_nat')
 print('Single/multi LAN firewall: IPv4/IPv6 direct forwarding blocked before/after TUN removal; local output works.')
finally:
 for n in reversed(names):subprocess.run(['ip','netns','del',n],capture_output=True)
