// FreedomGate SOCKS integration; SS encryption and prefix come from Outline SDK.
package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"golang.getoutline.org/sdk/transport"
	"golang.getoutline.org/sdk/transport/shadowsocks"
	"io"
	"net"
	"os"
	"strconv"
	"sync"
	"time"
)

const sdkVersion = "v0.1.0"

type Config struct {
	Node Node `json:"node"`
	Port int  `json:"port"`
}
type Bridge struct {
	tcp   *shadowsocks.StreamDialer
	udp   shadowsocks.PacketListener
	limit chan struct{}
}

// Authenticate using SDK before adding a reply salt to the bounded replay window.
type replayEndpoint struct {
	base transport.PacketEndpoint
	key  *shadowsocks.EncryptionKey
}

func (e replayEndpoint) ConnectPacket(ctx context.Context) (net.Conn, error) {
	c, err := e.base.ConnectPacket(ctx)
	if err != nil {
		return nil, err
	}
	return &replayConn{Conn: c, key: e.key, seen: map[string]bool{}, scratch: make([]byte, 65535)}, nil
}

type replayConn struct {
	net.Conn
	key     *shadowsocks.EncryptionKey
	seen    map[string]bool
	order   []string
	scratch []byte
}

func (c *replayConn) Read(b []byte) (int, error) {
	for {
		n, e := c.Conn.Read(b)
		if e != nil {
			return n, e
		}
		if _, e = shadowsocks.Unpack(c.scratch, b[:n], c.key); e != nil {
			continue
		}
		salt := string(b[:c.key.SaltSize()])
		if c.seen[salt] {
			continue
		}
		c.seen[salt] = true
		c.order = append(c.order, salt)
		if len(c.order) > 4096 {
			delete(c.seen, c.order[0])
			c.order = c.order[1:]
		}
		return n, nil
	}
}
func newBridge(n Node) (*Bridge, error) {
	key, e := n.key()
	if e != nil || net.ParseIP(n.Server) == nil {
		return nil, invalid
	}
	address := net.JoinHostPort(n.Server, strconv.Itoa(n.Port))
	dialer, e := dpiDialer(n.DpiBypass)
	if e != nil {
		return nil, e
	}
	tcp, e := shadowsocks.NewStreamDialer(&transport.TCPEndpoint{Address: address, Dialer: dialer}, key)
	if e != nil {
		return nil, e
	}
	prefix, _ := hex.DecodeString(n.Prefix)
	tcp.SaltGenerator = shadowsocks.NewPrefixSaltGenerator(prefix)
	udp, e := shadowsocks.NewPacketListener(replayEndpoint{base: &transport.UDPEndpoint{Address: address}, key: key}, key)
	if e != nil {
		return nil, e
	}
	return &Bridge{tcp: tcp, udp: udp, limit: make(chan struct{}, 256)}, nil
}
func reply(conn net.Conn, status byte, port int) error {
	_, e := conn.Write([]byte{5, status, 0, 1, 127, 0, 0, 1, byte(port >> 8), byte(port)})
	return e
}
func (b *Bridge) handle(conn net.Conn) {
	select {
	case b.limit <- struct{}{}:
		defer func() { <-b.limit }()
	default:
		conn.Close()
		return
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(12 * time.Second))
	var greeting [2]byte
	if _, e := io.ReadFull(conn, greeting[:]); e != nil || greeting[0] != 5 || greeting[1] == 0 {
		return
	}
	methods := make([]byte, int(greeting[1]))
	if _, e := io.ReadFull(conn, methods); e != nil {
		return
	}
	if !bytes.Contains(methods, []byte{0}) {
		conn.Write([]byte{5, 255})
		return
	}
	if _, e := conn.Write([]byte{5, 0}); e != nil {
		return
	}
	var request [3]byte
	if _, e := io.ReadFull(conn, request[:]); e != nil || request[0] != 5 || request[2] != 0 {
		return
	}
	host, port, kind, e := readAddress(conn)
	if e != nil {
		reply(conn, 8, 0)
		return
	}
	switch request[1] {
	case 1:
		if port == 0 {
			reply(conn, 1, 0)
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		up, e := b.tcp.DialStream(ctx, net.JoinHostPort(host, strconv.Itoa(port)))
		cancel()
		if e != nil {
			reply(conn, 1, 0)
			return
		}
		defer up.Close()
		if reply(conn, 0, 0) != nil {
			return
		}
		conn.SetDeadline(time.Time{})
		upload, download := make(chan struct{}, 1), make(chan struct{}, 1)
		go func() { io.Copy(up, conn); up.CloseWrite(); upload <- struct{}{} }()
		go func() {
			io.Copy(conn, up)
			if tcp, ok := conn.(*net.TCPConn); ok {
				tcp.CloseWrite()
			}
			download <- struct{}{}
		}()
		select {
		case <-download:
			return
		case <-upload:
			select {
			case <-download:
			case <-time.After(60 * time.Second):
			}
		}
	case 3:
		ip := net.ParseIP(host)
		if kind == 3 || ip == nil || !(ip.IsUnspecified() || host == "127.0.0.1") {
			reply(conn, 8, 0)
			return
		}
		b.associate(conn, port)
	default:
		reply(conn, 7, 0)
	}
}

type udpAddress string

func (a udpAddress) Network() string { return "udp" }
func (a udpAddress) String() string  { return string(a) }
func (b *Bridge) associate(control net.Conn, clientPort int) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	up, e := b.udp.ListenPacket(ctx)
	cancel()
	if e != nil {
		reply(control, 1, 0)
		return
	}
	defer up.Close()
	local, e := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if e != nil {
		reply(control, 1, 0)
		return
	}
	defer local.Close()
	if reply(control, 0, local.LocalAddr().(*net.UDPAddr).Port) != nil {
		return
	}
	control.SetDeadline(time.Time{})
	var lock sync.Mutex
	var client *net.UDPAddr
	go func() {
		data := make([]byte, 65535)
		for {
			n, source, e := local.ReadFromUDP(data)
			if e != nil {
				return
			}
			if !source.IP.Equal(net.ParseIP("127.0.0.1")) || (clientPort != 0 && source.Port != clientPort) || n < 4 || n > 16000 || !bytes.Equal(data[:3], []byte{0, 0, 0}) {
				continue
			}
			r := bytes.NewReader(data[3:n])
			host, port, _, e := readAddress(r)
			if e != nil || port == 0 {
				continue
			}
			payload := data[n-r.Len() : n]
			lock.Lock()
			if client != nil && client.Port != source.Port {
				lock.Unlock()
				continue
			}
			if client == nil {
				client = source
			}
			lock.Unlock()
			up.WriteTo(payload, udpAddress(net.JoinHostPort(host, strconv.Itoa(port))))
		}
	}()
	go func() {
		data := make([]byte, 65535)
		for {
			n, source, e := up.ReadFrom(data)
			if e != nil {
				if errors.Is(e, net.ErrClosed) || errors.Is(e, io.EOF) {
					return
				}
				continue
			}
			host, portText, e := net.SplitHostPort(source.String())
			if e != nil {
				continue
			}
			port, e := strconv.Atoi(portText)
			if e != nil {
				continue
			}
			addr, e := addressBytes(host, port)
			if e != nil {
				continue
			}
			lock.Lock()
			destination := client
			lock.Unlock()
			if destination != nil {
				packet := append(append([]byte{0, 0, 0}, addr...), data[:n]...)
				local.WriteToUDP(packet, destination)
			}
		}
	}()
	io.Copy(io.Discard, control)
}
func run() error {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		return json.NewEncoder(os.Stdout).Encode(map[string]string{"sdk": sdkVersion, "bridge": "0.2.0"})
	}
	if len(os.Args) == 2 && os.Args[1] == "--parse" {
		data, e := io.ReadAll(io.LimitReader(os.Stdin, 16385))
		if e != nil {
			return invalid
		}
		n, e := parseSS(string(data))
		if e != nil {
			return invalid
		}
		return json.NewEncoder(os.Stdout).Encode(n)
	}
	if len(os.Args) != 2 {
		return invalid
	}
	file, e := os.Open(os.Args[1])
	if e != nil {
		return invalid
	}
	defer file.Close()
	var cfg Config
	if json.NewDecoder(io.LimitReader(file, 65536)).Decode(&cfg) != nil || cfg.Port < 1 || cfg.Port > 65535 {
		return invalid
	}
	bridge, e := newBridge(cfg.Node)
	if e != nil {
		return e
	}
	listener, e := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.Port)))
	if e != nil {
		return e
	}
	defer listener.Close()
	for {
		conn, e := listener.Accept()
		if e != nil {
			return e
		}
		go bridge.handle(conn)
	}
}
func main() {
	if run() != nil {
		os.Stderr.WriteString("Outline SDK: invalid configuration or unavailable transport.\n")
		os.Exit(1)
	}
}
