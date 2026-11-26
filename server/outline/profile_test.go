package main

import (
	"encoding/base64"
	"testing"
)

func TestExistingSSLinkFormats(t *testing.T) {
	user := base64.RawURLEncoding.EncodeToString([]byte("chacha20-ietf-poly1305:test-password"))
	for _, value := range []string{"ss://" + user + "@EXAMPLE.com:443/?outline=1&prefix=%16%03%01%00%C2%A8%01%01#Example", "ss://" + base64.RawStdEncoding.EncodeToString([]byte("chacha20-ietf-poly1305:test-password@example.com:443")) + "?prefix=%2516%2503%2501%2500%25C2%25A8%2501%2501"} {
		n, e := parseSS(value)
		if e != nil {
			t.Fatal(e)
		}
		if n.Server != "example.com" || n.Password != "test-password" || n.Prefix != "16030100a80101" {
			t.Fatal("legacy profile changed")
		}
	}
	for _, suffix := range []string{"?plugin=secret", "?prefix=%E2%82%AC", "?prefix=a&prefix=b", "?prefix=12345678901234567"} {
		if _, e := parseSS("ss://" + user + "@example.com:443/" + suffix); e == nil {
			t.Fatal("unsupported input accepted")
		}
	}
}
