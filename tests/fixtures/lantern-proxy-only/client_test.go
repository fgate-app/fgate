package client
import("context";"errors";"net";"testing";"time";"github.com/getlantern/flashlight/v7/dialer";"github.com/getlantern/flashlight/v7/domainrouting";"github.com/getlantern/flashlight/v7/ops")
type fgUnavailableRelay struct{calls int}
var fgRelayError=errors.New("fixture relay unavailable")
func(d *fgUnavailableRelay)DialContext(context.Context,string,string)(net.Conn,error){d.calls++;return nil,fgRelayError}
func(d *fgUnavailableRelay)Close(){}
func(d *fgUnavailableRelay)OnOptions(*dialer.Options)dialer.Dialer{return d}
func TestFreedomGateMustDirectCannotBypass(t *testing.T){
 listener,e:=net.Listen("tcp","127.0.0.1:0");if e!=nil{t.Fatal(e)};defer listener.Close()
 domainrouting.Configure(domainrouting.RulesMap{"127.0.0.1":domainrouting.MustDirect},&domainrouting.ProxiedSitesConfig{})
 defer domainrouting.Configure(nil,&domainrouting.ProxiedSitesConfig{})
 ForceProxying();defer StopForcingProxying()
 relay:=&fgUnavailableRelay{};c:=&Client{dialer:&protectedDialer{dialer:relay}}
 op:=ops.Begin("fg-test");defer op.End();ctx,cancel:=context.WithTimeout(context.Background(),time.Second);defer cancel()
 connection,e:=c.doDial(op,ctx,true,listener.Addr().String(),nil);if connection!=nil{connection.Close()}
 if !errors.Is(e,fgRelayError)||relay.calls!=1{t.Fatalf("relay calls=%d error=%v",relay.calls,e)}
 listener.(*net.TCPListener).SetDeadline(time.Now().Add(20*time.Millisecond));connection,e=listener.Accept();if e==nil{connection.Close();t.Fatal("direct origin received a connection")}
}
