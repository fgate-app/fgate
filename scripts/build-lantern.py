#!/usr/bin/env python3
"""Build a pinned Lantern module; upstream's direct/proxyless paths are disabled."""
import argparse,hashlib,json,os,pathlib,shutil,subprocess,tarfile,tempfile
from install_support import elf_architecture,public_tree,module_stage
ROOT=pathlib.Path(__file__).resolve().parents[1]

def replace_once(path,old,new):
    source=path.read_text()
    if source.count(old)!=1:raise ValueError('Lantern routing patch does not match the pinned source')
    path.chmod(0o644);path.write_text(source.replace(old,new))

def patch_sources(headless,flashlight):
    replace_once(headless/'serve.go','func serve(cmd *ServeCmd) {','func serve(cmd *ServeCmd) {\n\t// FreedomGate routes every client connection through an external proxy.\n\tclient.ForceProxying()\n\tif err := freedomgateConfigureUpstream(); err != nil { pterm.Error.Println(err.Error()); return }')
    shutil.copy2(ROOT/'server/lantern/upstream.go',headless/'freedomgate_upstream.go')
    replace_once(flashlight/'client/client.go','if routingRuleForDomain == domainrouting.MustDirect {','if routingRuleForDomain == domainrouting.MustDirect && !shouldForceProxying() {')
    replace_once(flashlight/'client/client.go','ProxyAll: client.proxyAll,','ProxyAll: func() bool { return shouldForceProxying() || client.proxyAll() },')
    replace_once(flashlight/'dialer/parallel_dialer.go','if !common.SupportsProxyless() {','if (d.opts.ProxyAll != nil && d.opts.ProxyAll()) || !common.SupportsProxyless() {')
    replace_once(flashlight/'chained/shadowsocks_impl.go','"github.com/getlantern/common/config"','"github.com/getlantern/common/config"\n "github.com/getlantern/netx"')
    replace_once(flashlight/'chained/shadowsocks_impl.go','&transport.TCPEndpoint{Address: addr}', '''transport.FuncStreamEndpoint(func(ctx context.Context) (transport.StreamConn, error) {
 conn, err := netx.DialContext(ctx, "tcp", addr)
 if err != nil { return nil, err }
 stream, ok := conn.(transport.StreamConn)
 if !ok { conn.Close(); return nil, fmt.Errorf("upstream does not support TCP half-close") }
 return stream, nil
})''')
    replace_once(flashlight/'chained/vmess_impl.go','(&net.Dialer{}).DialContext(ctx, N.NetworkTCP, impl.addr)','netx.DialContext(ctx, N.NetworkTCP, impl.addr)')
    replace_once(flashlight/'chained/vmess_impl.go','"net"','"net"\n "github.com/getlantern/netx"')
    replace_once(flashlight/'chained/proxy.go','reportDialCore reportDialCoreFn) (proxyImpl, error) {','''reportDialCore reportDialCoreFn) (proxyImpl, error) {
 switch transport {
 case "quic_ietf", "broflake", "water": return nil, fmt.Errorf("relay transport does not support the bound TCP uplink")
 }
''')
    path=flashlight/'dialer/proxyless.go';source=path.read_text();start=source.index('func (d *proxylessDialer) DialContext(');end=source.index('// getOrCreateDialer',start)
    if source[start:end].count('func ')!=1:raise ValueError('Lantern proxyless patch does not match the pinned source')
    path.chmod(0o644);path.write_text(source[:start]+'''// FreedomGate must fail closed even before external proxy configuration is available.
func (d *proxylessDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
 return nil, fmt.Errorf("proxyless transport is disabled by FreedomGate")
}

'''+source[end:])

def prepare_sources(lock,work,source_archive=None):
    archive=pathlib.Path(source_archive) if source_archive else ROOT/lock['modifiedSource']['path']
    data=archive.read_bytes()
    if len(data)>16*1024*1024 or hashlib.sha256(data).hexdigest()!=lock['modifiedSource']['sha256']:raise ValueError('Modified Lantern source checksum mismatch')
    with tarfile.open(archive) as source:source.extractall(work/'source',filter='data')
    roots=list((work/'source/source').iterdir());flashlight=work/'source/flashlight-fg'
    if len(roots)!=1 or not (roots[0]/'go.mod').is_file() or not (flashlight/'go.mod').is_file():raise ValueError('Invalid modified Lantern source layout')
    headless=roots[0]
    if (headless/'freedomgate_upstream.go').read_bytes()!=(ROOT/'server/lantern/upstream.go').read_bytes():raise ValueError('Modified Lantern source snapshot does not match the current adapter')
    return headless,flashlight,archive

def build(platform,output,source_archive=None):
    if platform not in ['linux-arm64','linux-amd64']:raise ValueError('Unsupported Lantern platform')
    lock=json.loads((ROOT/'packaging/lantern.lock.json').read_text());arch=platform.split('-')[1]
    env={**os.environ,'CGO_ENABLED':'1','GOOS':'linux','GOARCH':arch}
    target=pathlib.Path(output).resolve()/lock['version']
    if target.exists():raise ValueError('Lantern build destination already exists')
    with tempfile.TemporaryDirectory(prefix='fg-lantern-build-') as temporary:
        work=pathlib.Path(temporary)
        module_stage('lantern','checking',10)
        headless,flashlight,archive=prepare_sources(lock,work,source_archive)
        target.parent.mkdir(parents=True,exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='.lantern-',dir=target.parent) as stage:
            stage=pathlib.Path(stage);binary=stage/'lantern-headless'
            module_stage('lantern','building',35)
            subprocess.run(['go','build','-mod=readonly','-trimpath','-buildvcs=false','-ldflags','-s -w -X github.com/getlantern/lantern-headless-client/shared.ApplicationVersion='+lock['version'],'-o',str(binary),'.'],cwd=headless,env=env,check=True)
            module_stage('lantern','verifying',85)
            if elf_architecture(binary)!=platform:raise ValueError('Lantern binary has an unexpected architecture')
            shutil.copy2(headless/'LICENSE',stage/'COPYING.txt')
            (stage/'manifest.json').write_text(json.dumps({**lock,'platform':platform,'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest()},indent=2)+'\n')
            module_stage('lantern','packaging',95)
            # Keep the modified sources and build recipe with this derived module.
            with tarfile.open(stage/'corresponding-source.tar.gz','w:gz') as source:
                source.add(headless,arcname='source/'+headless.name);source.add(flashlight,arcname='flashlight-fg');source.add(ROOT/'scripts/build-lantern.py',arcname='scripts/build-lantern.py');source.add(ROOT/'server/lantern/upstream.go',arcname='server/lantern/upstream.go');source.add(ROOT/'scripts/install_support.py',arcname='scripts/install_support.py');source.add(ROOT/'packaging/lantern.lock.json',arcname='packaging/lantern.lock.json');source.add(archive,arcname='modified-source.tar.gz')
            public_tree(stage);stage.rename(target)
    return target
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--platform',required=True);parser.add_argument('--output',required=True);parser.add_argument('--source-archive');args=parser.parse_args();print(build(args.platform,args.output,args.source_archive))
