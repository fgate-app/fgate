package main
import("context";"io";"net";"testing";"time";"github.com/getlantern/netx")
func TestFreedomgateUpstreamValidation(t *testing.T){
 for _,name:=range []string{"","missing-interface","this-interface-name-is-too-long"}{t.Setenv("FG_LANTERN_INTERFACE",name);if freedomgateConfigureUpstream()==nil{t.Fatal("invalid interface accepted")}}
}
func TestFreedomgateKernelConnectAndFailure(t *testing.T){
 t.Setenv("FG_LANTERN_INTERFACE","lo");if err:=freedomgateConfigureUpstream();err!=nil{t.Fatal(err)}
 listener,err:=net.Listen("tcp4","127.0.0.1:0");if err!=nil{t.Fatal(err)};address:=listener.Addr().String()
 done:=make(chan error,1);go func(){conn,err:=listener.Accept();if err!=nil{done<-err;return};defer conn.Close();conn.SetDeadline(time.Now().Add(time.Second));one:=make([]byte,1);_,err=io.ReadFull(conn,one);if err==nil{_,err=conn.Write(one)};done<-err}()
 ctx,cancel:=context.WithTimeout(context.Background(),time.Second);defer cancel();conn,err:=netx.DialContext(ctx,"tcp4",address);if err!=nil{t.Fatal(err)};conn.SetDeadline(time.Now().Add(time.Second));conn.Write([]byte{42});one:=make([]byte,1);_,err=io.ReadFull(conn,one);conn.Close();if err!=nil||one[0]!=42{t.Fatalf("transfer failed: %v",err)};if err=<-done;err!=nil{t.Fatal(err)};listener.Close()
 conn,err=netx.DialContext(ctx,"tcp4",address);if err==nil{conn.Close();t.Fatal("closed remote port incorrectly reported success")}
 if conn,err=netx.DialContext(ctx,"udp",address);err==nil{conn.Close();t.Fatal("UDP transport accepted")}
}
