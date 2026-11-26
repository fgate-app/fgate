package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestFreedomgateWrappedDial(t *testing.T) {
	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	var received atomic.Int32
	go func() {
		for {
			c, e := target.Accept()
			if e != nil {
				return
			}
			go func() {
				defer c.Close()
				data, _ := io.ReadAll(c)
				if string(data) == "fixture" {
					received.Add(1)
					c.Write([]byte("reply"))
				}
			}()
		}
	}()
	upstream, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	requested := make(chan string, 1)
	go func() {
		c, e := upstream.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(3 * time.Second))
		header := make([]byte, 2)
		if _, e = io.ReadFull(c, header); e != nil {
			return
		}
		methods := make([]byte, int(header[1]))
		if _, e = io.ReadFull(c, methods); e != nil {
			return
		}
		c.Write([]byte{5, 2})
		if _, e = io.ReadFull(c, header); e != nil {
			return
		}
		user := make([]byte, int(header[1]))
		io.ReadFull(c, user)
		size := make([]byte, 1)
		io.ReadFull(c, size)
		password := make([]byte, int(size[0]))
		io.ReadFull(c, password)
		if string(user) != "fixture-user" || string(password) != "fixture-password" {
			c.Write([]byte{1, 1})
			return
		}
		c.Write([]byte{1, 0})
		connect := make([]byte, 5)
		if _, e = io.ReadFull(c, connect); e != nil {
			return
		}
		if connect[3] != 3 {
			return
		}
		host := make([]byte, int(connect[4]))
		io.ReadFull(c, host)
		port := make([]byte, 2)
		io.ReadFull(c, port)
		requested <- string(host)
		remote, e := net.Dial("tcp", target.Addr().String())
		if e != nil {
			return
		}
		defer remote.Close()
		c.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 0})
		go func() { io.Copy(remote, c); remote.(*net.TCPConn).CloseWrite() }()
		io.Copy(c, remote)
	}()
	port := upstream.Addr().(*net.TCPAddr).Port
	config, _ := json.Marshal(freedomgateUpstream{Port: port, Username: "fixture-user", Password: "fixture-password"})
	t.Setenv("FG_LANTERN_UPSTREAM", string(config))
	t.Setenv("FG_LANTERN_INTERFACE", "missing-iface")
	dial, err := freedomgateUpstreamDialer()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := dial(ctx, "tcp", net.JoinHostPort("unresolvable-control.invalid", strconv.Itoa(target.Addr().(*net.TCPAddr).Port)))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if <-requested != "unresolvable-control.invalid" {
		t.Fatal("Destination DNS was not delegated to SOCKS")
	}
	stream, ok := conn.(interface {
		CloseRead() error
		CloseWrite() error
	})
	if !ok {
		t.Fatal("TCP half-close was lost")
	}
	conn.Write([]byte("fixture"))
	stream.CloseWrite()
	reply, err := io.ReadAll(conn)
	if err != nil || string(reply) != "reply" {
		t.Fatal("Wrapped data transfer failed")
	}
	if received.Load() != 1 {
		t.Fatal("Target did not receive the wrapped payload")
	}
	upstream.Close()
	if c, e := dial(ctx, "tcp", target.Addr().String()); e == nil {
		c.Close()
		t.Fatal("Unavailable outer gateway fell back to DIRECT")
	}
	if received.Load() != 1 {
		t.Fatal("Failed wrapper reached target directly")
	}
	if _, e := dial(ctx, "udp", target.Addr().String()); e == nil {
		t.Fatal("UDP must be rejected")
	}
	canceled, stop := context.WithCancel(context.Background())
	stop()
	if _, e := dial(canceled, "tcp", target.Addr().String()); e == nil {
		t.Fatal("Canceled dial succeeded")
	}
}

func TestFreedomgateInvalidUpstreamFailsClosed(t *testing.T) {
	for _, value := range []string{"invalid", `{"port":0,"username":"user","password":"private"}`, `{"port":1080,"username":"","password":"private"}`} {
		t.Setenv("FG_LANTERN_UPSTREAM", value)
		t.Setenv("FG_LANTERN_INTERFACE", "lo")
		if _, err := freedomgateUpstreamDialer(); err == nil || strings.Contains(err.Error(), "private") {
			t.Fatal("Invalid upstream accepted or exposed credentials")
		}
	}
}

func TestFreedomgateDirectDial(t *testing.T) {
	t.Setenv("FG_LANTERN_UPSTREAM", "")
	t.Setenv("FG_LANTERN_INTERFACE", "lo")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		c, e := listener.Accept()
		if e == nil {
			c.Close()
		}
	}()
	dial, err := freedomgateUpstreamDialer()
	if err != nil {
		t.Fatal(err)
	}
	conn, err := dial(context.Background(), "tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	conn.Close()
	t.Setenv("FG_LANTERN_INTERFACE", "missing-iface")
	if _, e := freedomgateUpstreamDialer(); e == nil {
		t.Fatal("Missing physical interface accepted")
	}
}
