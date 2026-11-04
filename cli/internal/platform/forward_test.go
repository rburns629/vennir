// SPDX-License-Identifier: MIT

package platform

import (
	"bytes"
	"context"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestHelperForward stands in for kubectl's port-forward: it listens on the
// port for a while, then ends as a dropped stream does.
func TestHelperForward(t *testing.T) {
	if os.Getenv("VENNIR_HELPER_FORWARD") == "" {
		t.Skip("run by TestSuperviseRestarts")
	}
	l, err := net.Listen("tcp", "127.0.0.1:"+os.Getenv("VENNIR_HELPER_FORWARD"))
	if err != nil {
		os.Exit(2)
	}
	go func() {
		for {
			if c, err := l.Accept(); err == nil {
				c.Close()
			}
		}
	}()
	time.Sleep(time.Second)
	os.Exit(1)
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// A forward that ends is started again on the same port, and says so.
func TestSuperviseRestarts(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	starts := 0
	var mu sync.Mutex
	out := &syncBuffer{}
	f, err := supervise(context.Background(), out, port, func(ctx context.Context) *exec.Cmd {
		mu.Lock()
		starts++
		mu.Unlock()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestHelperForward$")
		cmd.Env = append(os.Environ(), "VENNIR_HELPER_FORWARD="+strconv.Itoa(port))
		return cmd
	})
	if err != nil {
		t.Fatal(err)
	}
	defer f.Stop()
	// The first ends after a second; within the next few it's back.
	deadline := time.Now().Add(15 * time.Second)
	for {
		mu.Lock()
		n := starts
		mu.Unlock()
		if n >= 2 {
			if conn, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), time.Second); err == nil {
				conn.Close()
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("not back after %d start(s); said %q", n, out.String())
		}
		time.Sleep(200 * time.Millisecond)
	}
	if !strings.Contains(out.String(), "port-forward ended") {
		t.Errorf("said %q", out.String())
	}
}
