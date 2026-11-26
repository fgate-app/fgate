#!/usr/bin/env python3
"""Real mihomo TUN forwarding across three fully isolated Linux namespaces."""
import argparse, json, os, pathlib, subprocess, tempfile, time, uuid

def run(*command):return subprocess.check_output(command,text=True,stderr=subprocess.STDOUT).strip()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--mihomo',required=True);args=parser.parse_args()
    if os.geteuid()!=0:raise SystemExit('Requires sudo on Linux')
    suffix=uuid.uuid4().hex[:5];client,gateway,server=['fg-'+name+'-'+suffix for name in ['c','g','s']]
    namespaces=[];processes=[];links=[]
    temp=tempfile.TemporaryDirectory(prefix='fg-tun-smoke-');base=pathlib.Path(temp.name)
    try:
        for ns in [client,gateway,server]:
            run('ip','netns','add',ns);namespaces.append(ns);run('ip','-n',ns,'link','set','lo','up')
        for left,right,ns1,ns2,addr1,addr2 in [('c'+suffix,'l'+suffix,client,gateway,'10.66.0.2/24','10.66.0.1/24'),('w'+suffix,'s'+suffix,gateway,server,'198.19.0.2/30','198.19.0.1/30')]:
            run('ip','link','add',left,'type','veth','peer','name',right);links.extend([left,right])
            for interface,ns,address in [(left,ns1,addr1),(right,ns2,addr2)]:
                run('ip','link','set',interface,'netns',ns);run('ip','-n',ns,'addr','add',address,'dev',interface);run('ip','-n',ns,'link','set',interface,'up')
        run('ip','-n',client,'route','add','default','via','10.66.0.1')
        run('ip','-n',gateway,'route','add','default','via','198.19.0.1')
        run('ip','-n',server,'addr','add','203.0.113.10/32','dev','lo')
        run('ip','-n',server,'route','add','default','via','198.19.0.2')
        run('ip','netns','exec',gateway,'sysctl','-w','net.ipv4.ip_forward=1')
        (base/'fixture.txt').write_text('freedomgate-real-tun')
        config={'mode':'rule','log-level':'info','ipv6':False,'interface-name':'w'+suffix,'dns':{'enable':False},'tun':{'enable':True,'device':'fgtun','stack':'mixed','auto-route':True,'auto-redirect':True,'strict-route':True},'rules':['MATCH,DIRECT']}
        (base/'mihomo.json').write_text(json.dumps(config))
        with (base/'modules.log').open('w') as log:
            http=subprocess.Popen(['ip','netns','exec',server,'python3','-m','http.server','18080','--bind','203.0.113.10','--directory',temp.name],stdout=log,stderr=log);processes.append(http)
            core=subprocess.Popen(['ip','netns','exec',gateway,args.mihomo,'-d',temp.name,'-f',str(base/'mihomo.json')],stdout=log,stderr=log);processes.append(core)
            for _ in range(100):
                if core.poll() is not None:raise RuntimeError('mihomo TUN exited: '+(base/'modules.log').read_text()[-2000:])
                link=subprocess.run(['ip','-n',gateway,'link','show','fgtun'],capture_output=True)
                if link.returncode==0:break
                time.sleep(.1)
            time.sleep(.5)
            response=run('ip','netns','exec',client,'curl','--noproxy','*','--fail','--silent','--show-error','--max-time','10','http://203.0.113.10:18080/fixture.txt')
            assert response=='freedomgate-real-tun','Unexpected tunneled response'
            stats=json.loads(run('ip','-j','-s','-n',gateway,'link','show','fgtun'))[0]
            counters=stats.get('stats64') or stats.get('stats')
            assert counters['rx']['packets']>0 and counters['tx']['packets']>0,'Traffic bypassed TUN'
            print(json.dumps({'forwarded_http_through_mihomo_tun':'passed','tun_rx_packets':counters['rx']['packets'],'tun_tx_packets':counters['tx']['packets'],'host_routes_modified':False,'external_vpn_tested':False}))
    finally:
        for process in reversed(processes):
            process.terminate()
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        for ns in reversed(namespaces):subprocess.run(['ip','netns','del',ns],capture_output=True)
        for link in links:subprocess.run(['ip','link','del',link],capture_output=True)
        temp.cleanup()

if __name__=='__main__':main()
