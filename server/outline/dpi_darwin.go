package main

import (
	"errors"
	"net"
)

func dpiDialer(enabled bool) (net.Dialer, error) {
	if enabled {
		return net.Dialer{}, errors.New("DPI bypass requires Linux")
	}
	return net.Dialer{}, nil
}
