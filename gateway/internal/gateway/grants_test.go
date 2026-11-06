// SPDX-License-Identifier: MIT

package gateway

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rburns629/vennir/gateway/internal/auth"
	"github.com/rburns629/vennir/gateway/internal/caller"
	"github.com/rburns629/vennir/gateway/internal/store"
)

// grantFixture is setup's API with grants (decision 26), and callers for
// them: a person named by a grant, people in granted groups (with groups
// that count, and stale ones), bots, and an admin with none.
func grantFixture(t *testing.T) (*fixture, *recorder) {
	t.Helper()
	f := setup(t, "")
	f.api.ID = "orders-id"
	f.api.PerMinute = map[string]int{"default": 100, "web": 50}
	f.gw.Store.PutGrants("orders-id", []store.Grant{
		{ID: "g-ada", UserID: "ada", PerMinute: 2},
		{ID: "g-eng", Group: "eng@example.com", PerMinute: 3},
		{ID: "g-ops", Group: "ops@example.com"},
		{ID: "g-bot", UserID: "bot-1"},
		{ID: "g-lonely-bot", UserID: "bot-2"},
	})
	c := f.gw.Callers.(callers)
	c["ada"] = &auth.Caller{UserID: "ada", Email: "ada@example.com", Teams: []string{"data"}, GroupsCurrent: true}
	c["eng-1"] = &auth.Caller{UserID: "e1", Groups: []string{"eng@example.com"}, GroupsCurrent: true, SSOSession: true}
	c["eng-2"] = &auth.Caller{UserID: "e2", Groups: []string{"eng@example.com"}, GroupsCurrent: true, SSOSession: true}
	c["eng-and-ops"] = &auth.Caller{UserID: "e3", Groups: []string{"eng@example.com", "ops@example.com"}, GroupsCurrent: true}
	c["eng-stale-sso"] = &auth.Caller{UserID: "e4", Groups: []string{"eng@example.com"}, SSOSession: true}
	c["eng-stale-password"] = &auth.Caller{UserID: "e5", Groups: []string{"eng@example.com"}}
	c["eng-stale-web"] = &auth.Caller{UserID: "e6", Groups: []string{"eng@example.com"}, Teams: []string{"web"}, SSOSession: true}
	c["bot"] = &auth.Caller{UserID: "bot-1", IsBot: true, Teams: []string{"tools"}}
	// A bot whose teams are all retired calls as none of them: its grant doesn't count.
	c["lonely-bot"] = &auth.Caller{UserID: "bot-2", IsBot: true}
	c["group-bot"] = &auth.Caller{UserID: "bot-3", IsBot: true, Teams: []string{"tools"}, Groups: []string{"eng@example.com"}, GroupsCurrent: true}
	var got recorder
	f.gw.Traffic = &got
	return f, &got
}

func TestGrants(t *testing.T) {
	f, traffic := grantFixture(t)
	path := "/payments/orders/orders/ord_abcdefgh"
	for who, want := range map[string]int{
		"ada": 201, "eng-1": 201, "eng-and-ops": 201, "bot": 201, "payments-person": 201, "web-person": 201,
		// Admins only if granted; a bot in a granted group is no member of it;
		// a bot of retired teams only has no grant.
		"admin": 403, "outsider": 403, "group-bot": 403, "lonely-bot": 403,
		// Groups that don't count: an older single sign-on session signs in
		// again (401); a password's session or an API token is refused (403).
		"eng-stale-sso": 401, "eng-stale-password": 403,
		// Stale groups, but a shareWith team lets them in anyway.
		"eng-stale-web": 201,
	} {
		w := f.do("GET", path, who, "", nil)
		if w.Code != want {
			t.Errorf("%s: %d %s", who, w.Code, w.Body)
			continue
		}
		if want == 403 && (errorCode(t, w) != "NOT_GRANTED" || !strings.Contains(w.Body.String(), "payments/orders")) {
			t.Errorf("%s: %s", who, w.Body)
		}
		if want == 401 && (errorCode(t, w) != "UNAUTHENTICATED" || !strings.Contains(w.Body.String(), "sign in again") || w.Header().Get("WWW-Authenticate") == "") {
			t.Errorf("%s: %s %v", who, w.Body, w.Header())
		}
	}
	// Vennir-Team gives no access: a granted person calling as a team that
	// may not call it is refused.
	if w := f.do("GET", path, "ada", "", map[string]string{TeamHeader: "data"}); w.Code != 403 || !strings.Contains(w.Body.String(), TeamHeader) {
		t.Errorf("a grant, calling as a team: %d %s", w.Code, w.Body)
	}

	// The backend learns how: by grant, through a group, by team.
	claimsOf := func(who string) caller.Claims {
		n := len(f.backend.got)
		if w := f.do("GET", path, who, "", nil); w.Code != 201 {
			t.Fatalf("%s: %d", who, w.Code)
		}
		return verify(t, f.backend.got[n].Header.Get(caller.Header), f.public)
	}
	if c := claimsOf("ada"); c.Via != "user" || c.Team != "" || c.Group != "" || c.Subject != "user:ada" {
		t.Errorf("by grant: %+v", c)
	}
	if c := claimsOf("eng-and-ops"); c.Via != "group" || c.Group != "ops@example.com" || c.Team != "" {
		t.Errorf("through a group: %+v", c)
	}
	if c := claimsOf("payments-person"); c.Via != "team" || c.Team != "payments" {
		t.Errorf("by team: %+v", c)
	}
	// Traffic counts a grant's calls by grant or group, never by person.
	teams := map[string]bool{}
	for _, r := range *traffic {
		teams[r.team] = true
	}
	for _, want := range []string{"grant:user", "grant:group:eng@example.com", "payments", "web"} {
		if !teams[want] {
			t.Errorf("traffic has no %q: %v", want, *traffic)
		}
	}
	for team := range teams {
		if strings.Contains(team, "ada") || strings.Contains(team, "e1") {
			t.Errorf("traffic names a person: %q", team)
		}
	}
}

// Rates: a user grant's own; a group grant's for each of its members; the
// best of a person's groups; a grant without one, the API's default; and a
// revoked grant stops calls at the store's next refresh.
func TestGrantRatesAndRevoking(t *testing.T) {
	f, _ := grantFixture(t)
	path := "/payments/orders/orders/ord_abcdefgh"
	calls := func(who string, n int) (ok int, last *httptest.ResponseRecorder) {
		for range n {
			last = f.do("GET", path, who, "", nil)
			if last.Code == 201 {
				ok++
			}
		}
		return ok, last
	}
	if ok, last := calls("ada", 4); ok != 2 || last.Code != 429 || !strings.Contains(last.Body.String(), "You have used this API's 2 requests") {
		t.Errorf("a user grant at 2/min: %d through, then %d %s", ok, last.Code, last.Body)
	}
	// Each member of a group at 3/min, apart.
	if ok, _ := calls("eng-1", 5); ok != 3 {
		t.Errorf("eng-1: %d through, want 3", ok)
	}
	if ok, _ := calls("eng-2", 5); ok != 3 {
		t.Errorf("eng-2, apart from eng-1: %d through, want 3", ok)
	}
	// In eng (3/min) and ops (no rate: the API's default, 100): ops'.
	if ok, _ := calls("eng-and-ops", 10); ok != 10 {
		t.Errorf("the better of two groups: %d through, want 10", ok)
	}
	// A shareWith team at its named limit, as before.
	if ok, _ := calls("web-person", 55); ok != 50 {
		t.Errorf("a shareWith team at 50/min: %d", ok)
	}

	// Revoked: the store's next refresh has it gone.
	if w := f.do("GET", path, "bot", "", nil); w.Code != 201 {
		t.Fatalf("bot, granted: %d", w.Code)
	}
	f.gw.Store.PutGrants("orders-id", []store.Grant{{ID: "g-eng", Group: "eng@example.com", PerMinute: 3}})
	if w := f.do("GET", path, "bot", "", nil); w.Code != 403 || errorCode(t, w) != "NOT_GRANTED" {
		t.Errorf("bot, revoked: %d %s", w.Code, w.Body)
	}
}

// A hidden API is heard of by whoever a grant lets in, as by its own team
// (the console's sees()); not by a shareWith team, nor by an admin without
// one (who hears of it, but may not call).
func TestAHiddenAPIsGrantees(t *testing.T) {
	f, _ := grantFixture(t)
	f.api.Hidden = true
	path := "/payments/orders/orders/ord_abcdefgh"
	missing := f.do("GET", "/payments/ledger/orders", "", "", nil)
	for who, want := range map[string]int{"ada": 201, "eng-1": 201, "payments-person": 201, "admin": 403, "web-person": 404, "outsider": 404} {
		w := f.do("GET", path, who, "", nil)
		if w.Code != want || want == 404 && w.Body.String() != missing.Body.String() {
			t.Errorf("hidden, %s: %d %s", who, w.Code, w.Body)
		}
	}
}
