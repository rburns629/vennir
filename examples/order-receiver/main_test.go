// SPDX-License-Identifier: MIT

package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"testing"
	"time"
)

// sign is the console's Vennir-Signature (console/src/callbacks.ts).
func sign(secret, body string, at time.Time) string {
	t := strconv.FormatInt(at.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(t + "." + body))
	return "t=" + t + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

func TestOnlyAFreshPostSignedWithTheSecretVerifies(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	body := `{"type":"order.finished","executionId":"e1","state":"SUCCEEDED"}`
	secret := "s3cr3t"
	for name, tc := range map[string]struct {
		header, body string
		ok           bool
	}{
		"as signed":              {sign(secret, body, now), body, true},
		"a minute old":           {sign(secret, body, now.Add(-time.Minute)), body, true},
		"replayed an hour later": {sign(secret, body, now.Add(-time.Hour)), body, false},
		"another secret":         {sign("other", body, now), body, false},
		"the body changed":       {sign(secret, body, now), `{"type":"order.finished","executionId":"e2","state":"SUCCEEDED"}`, false},
		"no signature":           {"", body, false},
		"not hex":                {"t=1800000000,v1=zz", body, false},
	} {
		err := verify([]byte(secret), tc.header, []byte(tc.body), now)
		if (err == nil) != tc.ok {
			t.Errorf("%s: %v", name, err)
		}
	}
}
