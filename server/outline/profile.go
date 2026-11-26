package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"golang.getoutline.org/sdk/transport/shadowsocks"
	"io"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

var invalid = errors.New("invalid Shadowsocks configuration")
var escaped = regexp.MustCompile(`^(%[0-9a-fA-F]{2})+$`)

type Node struct {
	DpiBypass bool   `json:"dpi_bypass,omitempty"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	Server    string `json:"server"`
	Port      int    `json:"port"`
	Cipher    string `json:"cipher"`
	Password  string `json:"password"`
	Prefix    string `json:"prefix_hex"`
	Enabled   bool   `json:"enabled"`
}

func decode64(value string) (string, error) {
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if raw, e := enc.DecodeString(value); e == nil && utf8.Valid(raw) {
			return string(raw), nil
		}
	}
	return "", invalid
}
func (n Node) key() (*shadowsocks.EncryptionKey, error) {
	if n.Password == "" || n.Port < 1 || n.Port > 65535 || n.Server == "" {
		return nil, invalid
	}
	if n.Cipher != "chacha20-ietf-poly1305" && n.Cipher != "aes-256-gcm" && n.Cipher != "aes-128-gcm" {
		return nil, invalid
	}
	key, e := shadowsocks.NewEncryptionKey(n.Cipher, n.Password)
	if e != nil {
		return nil, invalid
	}
	prefix, e := hex.DecodeString(n.Prefix)
	if e != nil || len(prefix) > 16 || len(prefix) > key.SaltSize()-16 {
		return nil, invalid
	}
	return key, nil
}
func parseSS(value string) (Node, error) {
	var n Node
	if !strings.HasPrefix(value, "ss://") || len(value) > 16384 {
		return n, invalid
	}
	body, fragment, _ := strings.Cut(value[5:], "#")
	if !strings.Contains(body, "@") {
		encoded, query, has := strings.Cut(body, "?")
		decoded, e := decode64(encoded)
		if e != nil {
			return n, e
		}
		body = decoded
		if has {
			body += "?" + query
		}
	}
	authority, query, _ := strings.Cut(body, "?")
	index := strings.LastIndex(authority, "@")
	if index < 0 {
		return n, invalid
	}
	user, endpoint := authority[:index], authority[index+1:]
	if !strings.Contains(user, ":") {
		var e error
		user, e = decode64(user)
		if e != nil {
			return n, e
		}
	}
	cipher, password, ok := strings.Cut(user, ":")
	if !ok {
		return n, invalid
	}
	var e error
	n.Cipher, e = url.PathUnescape(cipher)
	if e != nil {
		return n, invalid
	}
	n.Password, e = url.PathUnescape(password)
	if e != nil {
		return n, invalid
	}
	address, e := url.Parse("//" + strings.TrimRight(endpoint, "/"))
	if e != nil || address.Path != "" || address.User != nil {
		return n, invalid
	}
	n.Server = strings.ToLower(address.Hostname())
	n.Port, e = strconv.Atoi(address.Port())
	if e != nil {
		return n, invalid
	}
	options, e := url.ParseQuery(query)
	if e != nil {
		return n, invalid
	}
	for key, values := range options {
		if (key != "outline" && key != "prefix") || len(values) != 1 {
			return n, invalid
		}
	}
	prefix := options.Get("prefix")
	if escaped.MatchString(prefix) {
		prefix, e = url.PathUnescape(prefix)
		if e != nil {
			return n, invalid
		}
	}
	if !utf8.ValidString(prefix) {
		return n, invalid
	}
	raw := []byte{}
	for _, r := range prefix {
		if r > 255 {
			return n, invalid
		}
		raw = append(raw, byte(r))
	}
	n.Prefix = hex.EncodeToString(raw)
	n.Name, e = url.PathUnescape(fragment)
	if e != nil {
		return n, invalid
	}
	n.Name = strings.TrimSpace(n.Name)
	if n.Name == "" {
		n.Name = n.Server
	}
	if utf8.RuneCountInString(n.Name) > 150 {
		return n, invalid
	}
	for _, r := range n.Name {
		if r < 32 {
			return n, invalid
		}
	}
	id := make([]byte, 8)
	if _, e = rand.Read(id); e != nil {
		return n, e
	}
	n.ID = hex.EncodeToString(id)
	n.Enabled = true
	_, e = n.key()
	return n, e
}
func readAddress(r io.Reader) (string, int, int, error) {
	var kind [1]byte
	if _, e := io.ReadFull(r, kind[:]); e != nil {
		return "", 0, 0, e
	}
	size := 0
	switch kind[0] {
	case 1:
		size = 4
	case 4:
		size = 16
	case 3:
		var b [1]byte
		if _, e := io.ReadFull(r, b[:]); e != nil {
			return "", 0, 0, e
		}
		size = int(b[0])
		if size == 0 {
			return "", 0, 0, invalid
		}
	default:
		return "", 0, 0, invalid
	}
	data := make([]byte, size+2)
	if _, e := io.ReadFull(r, data); e != nil {
		return "", 0, 0, e
	}
	host := string(data[:size])
	if kind[0] != 3 {
		host = net.IP(data[:size]).String()
	}
	port := int(data[size])<<8 | int(data[size+1])
	return host, port, int(kind[0]), nil
}
func addressBytes(host string, port int) ([]byte, error) {
	if port < 1 || port > 65535 {
		return nil, invalid
	}
	var b []byte
	if ip := net.ParseIP(host); ip != nil {
		if v4 := ip.To4(); v4 != nil {
			b = append([]byte{1}, v4...)
		} else {
			b = append([]byte{4}, ip.To16()...)
		}
	} else {
		if len(host) < 1 || len(host) > 255 {
			return nil, invalid
		}
		b = append([]byte{3, byte(len(host))}, []byte(host)...)
	}
	return append(b, byte(port>>8), byte(port)), nil
}
