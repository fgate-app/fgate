// Compiled into the Linux-only derived Lantern module by build-lantern.py.
package main

import (
 "context"
 "errors"
 "net"
 "os"
 "syscall"
 "time"

 "github.com/getlantern/netx"
 "golang.org/x/sys/unix"
)

// Relay dialing must observe the kernel's remote TCP handshake, not a TUN accept.
// This controls SDK relay sockets; ForceProxying still forbids direct user traffic.
func freedomgateConfigureUpstream() error {
 name:=os.Getenv("FG_LANTERN_INTERFACE")
 if len(name)==0 || len(name)>15 {return errors.New("Lantern requires a physical uplink interface")}
 if _,err:=net.InterfaceByName(name);err!=nil {return errors.New("Lantern uplink interface is unavailable")}
 dialer:=&net.Dialer{Timeout:10*time.Second,Control:func(network,address string,raw syscall.RawConn) error {
  var socketErr error
  err:=raw.Control(func(fd uintptr){socketErr=unix.SetsockoptString(int(fd),unix.SOL_SOCKET,unix.SO_BINDTODEVICE,name)})
  if err!=nil {return err};return socketErr
 }}
 netx.OverrideDial(func(ctx context.Context,network,address string)(net.Conn,error){
  if network!="tcp" && network!="tcp4" && network!="tcp6" {return nil,errors.New("Lantern relay transport supports TCP only")}
  return dialer.DialContext(ctx,network,address)
 })
 return nil
}
