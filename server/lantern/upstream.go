// Compiled into the Linux-only derived Lantern module by build-lantern.py.
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"strconv"
	"syscall"
	"time"

	"github.com/getlantern/netx"
	"golang.org/x/sys/unix"
)

type freedomgateUpstream struct {
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// A wrapped connection never falls back to the bound physical interface. DNS for
// the destination is delegated to SOCKS, and TCP half-close is kept by netx.
func freedomgateUpstreamDialer() (func(context.Context, string, string) (net.Conn, error), error) {
	var dial func(context.Context, string, string) (net.Conn, error)
	if value := os.Getenv("FG_LANTERN_UPSTREAM"); value != "" {
		var upstream freedomgateUpstream
		if json.Unmarshal([]byte(value), &upstream) != nil || upstream.Port < 1 || upstream.Port > 65535 || len(upstream.Username) == 0 || len(upstream.Username) > 255 || len(upstream.Password) == 0 || len(upstream.Password) > 255 {
			return nil, errors.New("Invalid Lantern upstream configuration")
		}
		dial = func(ctx context.Context, network, address string) (net.Conn, error) {
			return freedomgateSocksDial(ctx, upstream, address)
		}
	} else {
		name := os.Getenv("FG_LANTERN_INTERFACE")
		if len(name) == 0 || len(name) > 15 {
			return nil, errors.New("Lantern requires a physical uplink interface")
		}
		if _, err := net.InterfaceByName(name); err != nil {
			return nil, errors.New("Lantern uplink interface is unavailable")
		}
		d := &net.Dialer{Timeout: 10 * time.Second, Control: func(network, address string, raw syscall.RawConn) error {
			var socketErr error
			err := raw.Control(func(fd uintptr) {
				socketErr = unix.SetsockoptString(int(fd), unix.SOL_SOCKET, unix.SO_BINDTODEVICE, name)
			})
			if err != nil {
				return err
			}
			return socketErr
		}}
		dial = d.DialContext
	}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" && network != "tcp4" && network != "tcp6" {
			return nil, errors.New("Lantern relay transport supports TCP only")
		}
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		return dial(ctx, network, address)
	}, nil
}

// Direct relays must observe the kernel handshake, not a TUN accept. Wrapped
// relays use only the authenticated loopback SOCKS endpoint supplied by runtime.
func freedomgateConfigureUpstream() error {
	dial, err := freedomgateUpstreamDialer()
	if err != nil {
		return err
	}
	netx.OverrideDial(dial)
	return nil
}

// Keep the original *net.TCPConn: SDK transports need CloseRead/CloseWrite.
func freedomgateSocksDial(ctx context.Context, upstream freedomgateUpstream, address string) (result net.Conn, err error) {
	host, portText, e := net.SplitHostPort(address)
	port, e2 := strconv.Atoi(portText)
	if e != nil || e2 != nil || port < 1 || port > 65535 || len(host) == 0 || len(host) > 255 {
		return nil, errors.New("Invalid Lantern relay address")
	}
	conn, e := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(upstream.Port)))
	if e != nil {
		return nil, e
	}
	defer func() {
		if err != nil {
			conn.Close()
		}
	}()
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	if deadline, ok := ctx.Deadline(); ok {
		conn.SetDeadline(deadline)
	}
	read := func(n int) ([]byte, error) { data := make([]byte, n); _, e := io.ReadFull(conn, data); return data, e }
	write := func(data []byte) error {
		for len(data) > 0 {
			n, e := conn.Write(data)
			if e != nil {
				return e
			}
			if n == 0 {
				return io.ErrShortWrite
			}
			data = data[n:]
		}
		return nil
	}
	if write([]byte{5, 1, 2}) != nil {
		return nil, errors.New("Lantern upstream greeting failed")
	}
	reply, e := read(2)
	if e != nil || reply[0] != 5 || reply[1] != 2 {
		return nil, errors.New("Lantern upstream authentication is unavailable")
	}
	auth := append([]byte{1, byte(len(upstream.Username))}, []byte(upstream.Username)...)
	auth = append(auth, byte(len(upstream.Password)))
	auth = append(auth, []byte(upstream.Password)...)
	if write(auth) != nil {
		return nil, errors.New("Lantern upstream authentication failed")
	}
	reply, e = read(2)
	if e != nil || reply[0] != 1 || reply[1] != 0 {
		return nil, errors.New("Lantern upstream authentication failed")
	}
	request := []byte{5, 1, 0}
	if ip := net.ParseIP(host); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			request = append(request, 1)
			request = append(request, v4...)
		} else {
			request = append(request, 4)
			request = append(request, ip.To16()...)
		}
	} else {
		request = append(request, 3, byte(len(host)))
		request = append(request, []byte(host)...)
	}
	request = binary.BigEndian.AppendUint16(request, uint16(port))
	if write(request) != nil {
		return nil, errors.New("Lantern upstream connection failed")
	}
	reply, e = read(4)
	if e != nil || reply[0] != 5 || reply[1] != 0 || reply[2] != 0 {
		return nil, errors.New("Lantern upstream connection failed")
	}
	size := 0
	switch reply[3] {
	case 1:
		size = 6
	case 4:
		size = 18
	case 3:
		part, e := read(1)
		if e != nil {
			return nil, errors.New("Invalid Lantern upstream reply")
		}
		size = int(part[0]) + 2
	default:
		return nil, errors.New("Invalid Lantern upstream reply")
	}
	if _, e = read(size); e != nil {
		return nil, errors.New("Invalid Lantern upstream reply")
	}
	if !stop() {
		return nil, ctx.Err()
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if e = conn.SetDeadline(time.Time{}); e != nil {
		return nil, e
	}
	return conn, nil
}
