package main

import (
	"net"
	"syscall"
)

// Only the upstream TCP socket carries this mark. UDP and other profiles do not.
const outlineDPIMark = 0x10000007

func dpiDialer(enabled bool) (net.Dialer, error) {
	d := net.Dialer{}
	if !enabled {
		return d, nil
	}
	control := func(network, address string, c syscall.RawConn) error {
		var optionErr error
		err := c.Control(func(fd uintptr) {
			optionErr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_MARK, outlineDPIMark)
		})
		if err != nil {
			return err
		}
		return optionErr
	}
	// Fail readiness rather than silently opening unmarked connections.
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0)
	if err != nil {
		return d, err
	}
	err = syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_MARK, outlineDPIMark)
	syscall.Close(fd)
	if err != nil {
		return d, err
	}
	d.Control = control
	return d, nil
}
