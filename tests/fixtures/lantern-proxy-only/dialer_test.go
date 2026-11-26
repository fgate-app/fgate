package dialer
import("context";"errors";"net";"testing")
type fgCounter struct{calls int}
func(d *fgCounter)DialContext(context.Context,string,string)(net.Conn,error){d.calls++;return nil,errors.New("fixture relay unavailable")}
func(d *fgCounter)Close(){}
func(d *fgCounter)OnOptions(*Options)Dialer{return d}
func(d *fgCounter)status(string)int{return SUCCEEDED}
func(d *fgCounter)reset(string){}
func TestFreedomGateProxyOnly(t *testing.T){
 if c,e:=NewProxylessDialer().DialContext(context.Background(),"tcp","example.com:443");e==nil||c!=nil{t.Fatal("bootstrap dialer must fail closed")}
 direct,relay:=&fgCounter{},&fgCounter{}
 d:=newParallelPreferProxyless(direct,relay,&Options{ProxyAll:func()bool{return true}})
 if c,e:=d.DialContext(context.Background(),"tcp","example.com:443");e==nil||c!=nil{t.Fatal("unavailable relay must fail closed")}
 if direct.calls!=0||relay.calls!=1{t.Fatalf("direct=%d relay=%d",direct.calls,relay.calls)}
}
