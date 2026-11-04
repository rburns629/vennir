// SPDX-License-Identifier: MIT

package dbauth

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
)

func TestTheTokenIsKeptUntilAMinuteBeforeItExpires(t *testing.T) {
	asked := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Metadata-Flavor") != "Google" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		asked++
		fmt.Fprintf(w, `{"access_token":"token-%d","expires_in":3600,"token_type":"Bearer"}`, asked)
	}))
	defer server.Close()
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	tokens := &Tokens{URL: server.URL, Client: server.Client(), Now: func() time.Time { return now }}

	for range 3 {
		if got, err := tokens.Password(context.Background()); err != nil || got != "token-1" {
			t.Fatalf("Password = %q, %v; want token-1", got, err)
		}
	}
	now = now.Add(59*time.Minute + time.Second)
	if got, _ := tokens.Password(context.Background()); got != "token-2" {
		t.Fatalf("after 59 minutes Password = %q; want a new token", got)
	}
}

func TestNoTokenIsAnError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	tokens := &Tokens{URL: server.URL, Client: server.Client(), Now: time.Now}
	if _, err := tokens.Password(context.Background()); err == nil {
		t.Fatal("Password: no error for a 404")
	}
}

// A token is signed for its server and user, by the role's credentials,
// and kept ten minutes.
func TestRDSTokensAreSignedForTheirServerAndUserAndKept(t *testing.T) {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	signings := &counting{CredentialsProvider: credentials.NewStaticCredentialsProvider("AKIDEXAMPLE", "secret", "")}
	r := &RDS{Region: "us-east-2", Credentials: signings, Now: func() time.Time { return now }}
	first, err := r.Password(context.Background(), "db.example.us-east-2.rds.amazonaws.com", 5432, "vennir_kernel")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"db.example.us-east-2.rds.amazonaws.com:5432?Action=connect", "DBUser=vennir_kernel", "X-Amz-Credential=AKIDEXAMPLE%2F", "us-east-2%2Frds-db%2Faws4_request", "X-Amz-Signature="} {
		if !strings.Contains(first, want) {
			t.Errorf("token %q lacks %q", first, want)
		}
	}
	if again, _ := r.Password(context.Background(), "db.example.us-east-2.rds.amazonaws.com", 5432, "vennir_kernel"); again != first {
		t.Error("a token isn't kept")
	}
	other, _ := r.Password(context.Background(), "db.example.us-east-2.rds.amazonaws.com", 5432, "vennir_console")
	if !strings.Contains(other, "DBUser=vennir_console") {
		t.Errorf("another user's token: %q", other)
	}
	if signings.n != 2 {
		t.Errorf("signed %d times for two users, want 2", signings.n)
	}
	now = now.Add(11 * time.Minute)
	if _, err := r.Password(context.Background(), "db.example.us-east-2.rds.amazonaws.com", 5432, "vennir_kernel"); err != nil || signings.n != 3 {
		t.Errorf("past ten minutes, signed %d times (want 3): %v", signings.n, err)
	}
}

// counting counts how often a token is signed.
type counting struct {
	aws.CredentialsProvider
	n int
}

func (c *counting) Retrieve(ctx context.Context) (aws.Credentials, error) {
	c.n++
	return c.CredentialsProvider.Retrieve(ctx)
}
