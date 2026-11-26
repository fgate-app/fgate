package main

import (
	"bytes"
	"context"
	"golang.getoutline.org/sdk/transport"
	"golang.getoutline.org/sdk/transport/shadowsocks"
	"net"
	"testing"
	"time"
)

func TestAuthenticatedReplyReplayWindow(t *testing.T) {
	key, e := shadowsocks.NewEncryptionKey("chacha20-ietf-poly1305", "test-password")
	if e != nil {
		t.Fatal(e)
	}
	peer, e := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if e != nil {
		t.Fatal(e)
	}
	defer peer.Close()
	endpoint := replayEndpoint{base: &transport.UDPEndpoint{Address: peer.LocalAddr().String()}, key: key}
	conn, e := endpoint.ConnectPacket(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(time.Second))
	conn.Write([]byte("request"))
	buf := make([]byte, 2048)
	_, source, e := peer.ReadFromUDP(buf)
	if e != nil {
		t.Fatal(e)
	}
	pack := func(value string) []byte {
		packet, e := shadowsocks.Pack(make([]byte, 2048), []byte(value), key)
		if e != nil {
			t.Fatal(e)
		}
		return packet
	}
	first, second := pack("first"), pack("second")
	bad := append([]byte(nil), first...)
	bad[len(bad)-1] ^= 1
	peer.WriteToUDP(bad, source)
	peer.WriteToUDP(first, source)
	peer.WriteToUDP(first, source)
	peer.WriteToUDP(second, source)
	for _, expected := range []string{"first", "second"} {
		n, e := conn.Read(buf)
		if e != nil {
			t.Fatal(e)
		}
		plain, e := shadowsocks.Unpack(make([]byte, 2048), buf[:n], key)
		if e != nil || !bytes.Equal(plain, []byte(expected)) {
			t.Fatal("authentication or replay rejection failed")
		}
	}
}
