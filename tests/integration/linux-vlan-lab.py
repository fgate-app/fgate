#!/usr/bin/env python3
"""Exercise VLAN + independent LANs entirely inside disposable namespaces.
Usage: sudo python3 linux-vlan-lab.py <generated-runtime.json>
The fixture contains the actual JS-generated dnsmasq/nftables configuration.
"""
import json, os, subprocess, sys, tempfile, time, uuid

def run(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout.strip()

def main():
    if os.geteuid() != 0:
        raise SystemExit('Run as root on a Linux test host')
    fixture=json.load(open(sys.argv[1]))
    suffix=uuid.uuid4().hex[:6]
    router,wan,lan,ap=[f'fgv-{suffix}-{role}' for role in ['r','w','l','a']]
    namespaces=[]; processes=[]
    with tempfile.TemporaryDirectory(prefix='fg-vlan-') as folder:
        try:
            for namespace in [router,wan,lan,ap]:
                run('ip','netns','add',namespace);namespaces.append(namespace)
                run('ip','-n',namespace,'link','set','lo','up')
            def pair(left,right,left_name,right_name):
                first,second='fva'+uuid.uuid4().hex[:6],'fvb'+uuid.uuid4().hex[:6]
                run('ip','link','add',first,'type','veth','peer','name',second)
                for ns,name,target in [(left,first,left_name),(right,second,right_name)]:
                    run('ip','link','set',name,'netns',ns)
                    run('ip','-n',ns,'link','set',name,'name',target)
                    run('ip','-n',ns,'link','set',target,'up')
            pair(router,wan,'eth0','trunk')
            pair(wan,lan,'client','eth0')
            pair(router,ap,'wlan0','eth0')
            for ns,parent,name in [(router,'eth0','eth0.20'),(wan,'trunk','trunk.20')]:
                run('ip','-n',ns,'link','add','link',parent,'name',name,'type','vlan','id','20')
                run('ip','-n',ns,'link','set',name,'up')
            run('ip','-n',wan,'link','add','br20','type','bridge')
            for iface in ['trunk.20','client']:
                run('ip','-n',wan,'link','set',iface,'master','br20')
            run('ip','-n',wan,'link','set','br20','up')
            for ns,iface,address in [(router,'eth0','198.19.0.2/30'),(wan,'trunk','198.19.0.1/30'),(wan,'lo','203.0.113.1/32'),(router,'eth0.20','10.30.0.1/24'),(router,'wlan0','10.20.0.1/24'),(lan,'eth0','10.30.0.100/24'),(ap,'eth0','10.20.0.100/24')]:
                run('ip','-n',ns,'addr','add',address,'dev',iface)
            run('ip','-n',router,'route','add','default','via','198.19.0.1')
            for ns,gateway in [(lan,'10.30.0.1'),(ap,'10.20.0.1')]:
                run('ip','-n',ns,'route','add','default','via',gateway)
            run('ip','netns','exec',router,'sysctl','-w','net.ipv4.ip_forward=1')
            nft=folder+'/rules.nft';open(nft,'w').write(fixture['nft'])
            run('ip','netns','exec',router,'nft','-f',nft)
            dns=fixture['dns'].replace('/run/freedomgate/dnsmasq.pid',folder+'/dnsmasq.pid').replace('/run/freedomgate/dnsmasq.leases',folder+'/leases')
            dnsfile=folder+'/dnsmasq.conf';open(dnsfile,'w').write(dns)
            run('ip','netns','exec',router,'dnsmasq','--test','-C',dnsfile)
            processes.append(subprocess.Popen(['ip','netns','exec',router,'dnsmasq','--keep-in-foreground','--user=root','-C',dnsfile],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
            # Stand-in for AdGuard: responds on the real DNS interception port.
            processes.append(subprocess.Popen(['ip','netns','exec',router,'dnsmasq','--keep-in-foreground','--user=root','--port=53053','--no-resolv','--no-hosts','--address=/fg.test/203.0.113.1','--pid-file='+folder+'/dns.pid'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
            time.sleep(1)
            assert all(process.poll() is None for process in processes),'dnsmasq failed to start'
            query="import socket,struct; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(3);s.sendto(struct.pack('!HHHHHH',42,256,1,0,0,0)+b'\\x02fg\\x04test\\0'+struct.pack('!HH',1,1),('8.8.8.8',53));r=s.recv(4096);assert r[-4:]==bytes([203,0,113,1]),r"
            discover = "import socket,struct,sys; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.setsockopt(socket.SOL_SOCKET,socket.SO_BROADCAST,1);s.setsockopt(socket.SOL_SOCKET,socket.SO_BINDTODEVICE,b'eth0\\0');s.bind(('0.0.0.0',68));s.settimeout(4);p=bytearray(240);p[0:3]=bytes([1,1,6]);p[4:8]=struct.pack('!I',42);p[10:12]=bytes([128,0]);p[28:34]=bytes([2,0,0,0,0,int(sys.argv[1])]);p[236:240]=bytes([99,130,83,99]);s.sendto(bytes(p)+bytes([53,1,1,255]),('255.255.255.255',67));r=s.recv(4096);assert r[16:19]==bytes([10,int(sys.argv[1]),0]),r[16:20]"
            for namespace,subnet in [(lan,'30'),(ap,'20')]:
                run('ip','netns','exec',namespace,'python3','-c',discover,subnet)
            for namespace in [lan,ap]:
                run('ip','netns','exec',namespace,'ping','-c','1','-W','2','203.0.113.1')
                run('ip','netns','exec',namespace,'python3','-c',query)
            for namespace,target in [(lan,'10.20.0.100'),(ap,'10.30.0.100'),(lan,'198.19.0.1')]:
                result=subprocess.run(['ip','netns','exec',namespace,'ping','-c','1','-W','1',target],capture_output=True)
                assert result.returncode!=0,'LAN isolation failed'
            print(json.dumps({'vlan_trunk':'passed','two_subnets_nat':'passed','dns_interception_both_lans':'passed','lan_isolation':'passed','dnsmasq_config':'passed','dhcp_both_subnets':'passed','host_network_changes':False}))
        finally:
            for process in processes:
                process.terminate()
                try:process.wait(timeout=3)
                except subprocess.TimeoutExpired:process.kill();process.wait()
            for namespace in reversed(namespaces):
                subprocess.run(['ip','netns','del',namespace],capture_output=True)
if __name__=='__main__':main()
