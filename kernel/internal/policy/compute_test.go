// SPDX-License-Identifier: MIT

package policy

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	catalogv1 "github.com/rburns629/vennir/kernel/internal/gen/vennir/catalog/v1"
)

func digest(c string) string { return "sha256:" + strings.Repeat(c, 64) }

var noneReserved = ReservedAudiences()

// fixtureRelease is a release as the local sample's catalog makes one, with
// what the console would refuse beside what it registers.
func fixtureRelease() *catalogv1.Release {
	return &catalogv1.Release{
		Teams: []*catalogv1.Team{{Name: "local"}, {Name: "payments"}},
		Products: []*catalogv1.ProductAction{
			// Registered: two actions of one product, its ServiceAccount and
			// audiences; another product, with no ServiceAccount (default).
			{Name: "local-db-create", Team: "local", Action: "create", Image: "registry.example/local/db:1@" + digest("a"),
				ServiceAccount: "db-sa", TokenAudiences: []string{"sts.amazonaws.com", "https://example.com"}},
			{Name: "local-db-delete", Team: "local", Action: "delete", Image: "registry.example/local/db:1@" + digest("a"),
				ServiceAccount: "db-sa", TokenAudiences: []string{"sts.amazonaws.com", "https://example.com"}},
			{Name: "local-hello-run", Team: "local", Action: "run", Image: "registry.example/local/hello@" + digest("b")},
			// Not: unpinned, a team the release doesn't name, an API's or
			// ESO's ServiceAccount, the cluster's own audience.
			{Name: "local-tag-run", Team: "local", Action: "run", Image: "registry.example/local/tag:1"},
			{Name: "ghost-x-run", Team: "ghost", Action: "run", Image: "registry.example/ghost/x@" + digest("c")},
			{Name: "local-api-run", Team: "local", Action: "run", Image: "registry.example/local/api@" + digest("c"), ServiceAccount: "orders-api"},
			{Name: "local-vault-run", Team: "local", Action: "run", Image: "registry.example/local/vault@" + digest("c"), ServiceAccount: "eso-gcp"},
			{Name: "local-kube-run", Team: "local", Action: "run", Image: "registry.example/local/kube@" + digest("c"),
				ServiceAccount: "kube-sa", TokenAudiences: []string{"https://kubernetes.default.svc"}},
			// Two teams' products claiming one repository: neither.
			{Name: "local-shared-run", Team: "local", Action: "run", Image: "registry.example/shared@" + digest("d")},
			{Name: "payments-shared-run", Team: "payments", Action: "run", Image: "registry.example/shared@" + digest("d")},
			// Two of a team's products running as one ServiceAccount: neither.
			{Name: "payments-a-run", Team: "payments", Action: "run", Image: "registry.example/payments/a@" + digest("e"), ServiceAccount: "pay-sa"},
			{Name: "payments-b-run", Team: "payments", Action: "run", Image: "registry.example/payments/b@" + digest("f"), ServiceAccount: "pay-sa"},
		},
		Apis: []*catalogv1.Api{
			{Name: "orders", Team: "local", ServiceAccount: "orders-api",
				BackendAuth: &catalogv1.BackendAuth{Kind: &catalogv1.BackendAuth_ServiceAccountToken{ServiceAccountToken: &catalogv1.ServiceAccountTokenAuth{Audience: "https://orders.local"}}}},
			{Name: "ledger", Team: "local", ServiceAccount: "ledger-api",
				BackendAuth: &catalogv1.BackendAuth{Kind: &catalogv1.BackendAuth_AwsSigV4{AwsSigV4: &catalogv1.AwsSigV4Auth{RoleArn: "arn:aws:iam::1:role/r"}}}},
			{Name: "site", Team: "payments", ServiceAccount: "site-api",
				BackendAuth: &catalogv1.BackendAuth{Kind: &catalogv1.BackendAuth_GoogleIdToken{GoogleIdToken: &catalogv1.GoogleIdTokenAuth{ServiceAccount: "s@p.iam", Audience: "x"}}}},
			// One a cloud federates, the cluster's own: none.
			{Name: "sneaky", Team: "local", ServiceAccount: "sneaky-api",
				BackendAuth: &catalogv1.BackendAuth{Kind: &catalogv1.BackendAuth_ServiceAccountToken{ServiceAccountToken: &catalogv1.ServiceAccountTokenAuth{Audience: "sts.amazonaws.com"}}}},
			{Name: "kube", Team: "local", ServiceAccount: "kube-api",
				BackendAuth: &catalogv1.BackendAuth{Kind: &catalogv1.BackendAuth_ServiceAccountToken{ServiceAccountToken: &catalogv1.ServiceAccountTokenAuth{Audience: "https://kubernetes.default.svc"}}}},
			// Not an API's ServiceAccount; no team the release names.
			{Name: "bad", Team: "local", ServiceAccount: "db-sa"},
			{Name: "lost", Team: "ghost", ServiceAccount: "lost-api"},
			// No backend sign-in: nothing to mint.
			{Name: "open", Team: "local", ServiceAccount: "open-api"},
		},
	}
}

func TestReleasesAreWhatTheConsoleWouldRegister(t *testing.T) {
	releases, problems := Releases(fixtureRelease(), ReservedAudiences())
	want := []Release{
		{Digest: digest("a"), Entry: Entry{Team: "local", Repository: "registry.example/local/db", Action: "create", ServiceAccount: "db-sa", Audiences: "sts.amazonaws.com,https://example.com"}},
		{Digest: digest("a"), Entry: Entry{Team: "local", Repository: "registry.example/local/db", Action: "delete", ServiceAccount: "db-sa", Audiences: "sts.amazonaws.com,https://example.com"}},
		{Digest: digest("b"), Entry: Entry{Team: "local", Repository: "registry.example/local/hello", Action: "run", ServiceAccount: "default", Audiences: ""}},
	}
	if !reflect.DeepEqual(releases, want) {
		t.Fatalf("releases:\n got %+v\nwant %+v", releases, want)
	}
	left := map[string]bool{}
	for _, p := range problems {
		left[p.Item] = true
	}
	for _, name := range []string{"local-tag-run", "ghost-x-run", "local-api-run", "local-vault-run", "local-kube-run",
		"local-shared-run", "payments-shared-run", "payments-a-run", "payments-b-run"} {
		if !left["product "+name] {
			t.Errorf("%s was listed", name)
		}
	}
	if len(problems) != 9 {
		t.Errorf("%d problems: %+v", len(problems), problems)
	}
}

func TestAudiencesAreWhatEachAPIsBackendSignInNeeds(t *testing.T) {
	apis, problems := APIs(fixtureRelease())
	if len(problems) != 2 {
		t.Errorf("problems: %+v", problems)
	}
	got := Audiences(apis, "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/v", ReservedAudiences())
	want := map[string][]string{
		"local/orders-api":  {"https://orders.local"},
		"local/ledger-api":  {AWSAudience},
		"payments/site-api": {"//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/v"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("audiences: %v", got)
	}
	// Without the install's Google pool, a googleIdToken API needs nothing.
	if got := Audiences(apis, "", noneReserved); got["payments/site-api"] != nil {
		t.Errorf("no pool: %v", got)
	}
	// Two APIs on one ServiceAccount: both's.
	shared := Audiences([]API{{Team: "a", ServiceAccount: "x-api", Kind: "awsSigV4"},
		{Team: "a", ServiceAccount: "x-api", Kind: "serviceAccountToken", Audience: "https://b"}}, "", noneReserved)
	if !reflect.DeepEqual(shared["a/x-api"], []string{"https://b", AWSAudience}) {
		t.Errorf("shared: %v", shared)
	}
	// The cluster's own issuer's audience, read from this process's token.
	if got := Audiences([]API{{Team: "a", ServiceAccount: "x-api", Kind: "serviceAccountToken", Audience: "https://issuer"}},
		"", ReservedAudiences("https://issuer")); len(got) != 0 {
		t.Errorf("the issuer's: %v", got)
	}
}

func TestAnEarlierReleaseIsListedWhileInUseOrForAnHour(t *testing.T) {
	now := time.Now()
	ago := func(d time.Duration) *time.Time { at := now.Add(-d); return &at }
	entry := func(repository, action string) Entry {
		return Entry{Team: "local", Repository: repository, Action: action, ServiceAccount: "db-sa"}
	}
	releases := []Release{
		{Digest: digest("1"), Entry: entry("r.example/db", "create")},                                       // current
		{Digest: digest("2"), Entry: entry("r.example/db", "create"), ReleasedUntil: ago(10 * time.Minute)}, // dropped recently
		{Digest: digest("3"), Entry: entry("r.example/db", "create"), ReleasedUntil: ago(2 * time.Hour)},    // long ago, unused
		{Digest: digest("4"), Entry: entry("r.example/db", "create"), ReleasedUntil: ago(2 * time.Hour)},    // long ago, running
		// Long ago, and a task runs its digest as another product: not its.
		{Digest: digest("5"), Entry: entry("r.example/db", "create"), ReleasedUntil: ago(2 * time.Hour)},
	}
	inUse := map[Use]bool{
		{Digest: digest("4"), Team: "local", Repository: "r.example/db", Action: "create", ServiceAccount: "db-sa"}: true,
		{Digest: digest("5"), Team: "local", Repository: "r.example/db", Action: "delete", ServiceAccount: "db-sa"}: true,
		{Digest: digest("5"), Team: "other", Repository: "r.example/db", Action: "create", ServiceAccount: "db-sa"}: true,
	}
	listed := Listed(releases, inUse, now, time.Hour)
	for _, c := range []struct {
		digest string
		listed bool
	}{{"1", true}, {"2", true}, {"3", false}, {"4", true}, {"5", false}} {
		if _, ok := listed[digest(c.digest)]; ok != c.listed {
			t.Errorf("release %s listed: %v", c.digest, ok)
		}
	}
}

func TestAnUnfinishedTaskIsMatchedAsItsJobWouldBe(t *testing.T) {
	use, ok := UseOf("registry.example/local/db:1@"+digest("a"), "local", "create", "")
	want := Use{Digest: digest("a"), Team: "local", Repository: "registry.example/local/db", Action: "create", ServiceAccount: "default"}
	if !ok || use != want {
		t.Fatalf("%+v", use)
	}
	if use, _ := UseOf("library/busybox@"+digest("b"), "t", "run", "sa"); use.Repository != "docker.io/library/busybox" {
		t.Errorf("Docker Hub: %+v", use)
	}
	if _, ok := UseOf("registry.example/db:1", "t", "run", "sa"); ok {
		t.Error("an unpinned image is no release")
	}
	for image, repository := range map[string]string{
		"busybox":                           "docker.io/library/busybox",
		"me/app:1":                          "docker.io/me/app",
		"localhost:5001/local/db:latest":    "localhost:5001/local/db",
		"Registry/app":                      "Registry/app",
		"host.example/a/b:1@" + digest("a"): "host.example/a/b",
	} {
		if got := Repository(image); got != repository {
			t.Errorf("%s: %s", image, got)
		}
	}
}

func TestTheMapsAreShardedAndSizedAsThePolicyHoldsThem(t *testing.T) {
	listed := map[string][]Entry{
		digest("a"): {{Team: "t", Repository: "r", Action: "run", ServiceAccount: "default", Audiences: ""}},
		digest("0"): {{Team: "t", Repository: "r", Action: "run", ServiceAccount: "sa", Audiences: "x,y"}},
	}
	variables, err := IdentityVariables(listed)
	if err != nil {
		t.Fatal(err)
	}
	if len(variables) != 16 || variables["releases1"] != "{}" {
		t.Fatalf("%v", variables)
	}
	// As the chart's lookup seed re-encodes it (Helm's toJson: keys in
	// byte order), so an upgrade leaves it as written.
	wantA := `{"` + digest("a") + `":[{"action":"run","audiences":"","repository":"r","serviceAccount":"default","team":"t"}]}`
	if variables["releasesa"] != wantA {
		t.Errorf("releasesa: %s", variables["releasesa"])
	}
	var parsed map[string][]map[string]string
	if err := json.Unmarshal([]byte(variables["releases0"]), &parsed); err != nil || parsed[digest("0")][0]["audiences"] != "x,y" {
		t.Errorf("releases0: %s", variables["releases0"])
	}
	// One map over what it holds is refused, nothing written.
	big := map[string][]Entry{}
	for i := 0; i < 500; i++ {
		big["sha256:a"+fmt.Sprintf("%063x", i)] = []Entry{{Team: "team", Repository: strings.Repeat("r", 150), Action: "run", ServiceAccount: "sa"}}
	}
	if _, err := IdentityVariables(big); err == nil || !strings.Contains(err.Error(), "map a") {
		t.Errorf("an over-full map: %v", err)
	}
	audiences, err := AudienceVariables(map[string][]string{"a/b-api": {"x"}, "team/orders-api": {"y", "z"}})
	if err != nil {
		t.Fatal(err)
	}
	// By the key's length modulo 16, as the policy's CEL reads it.
	if audiences["apiAudiences7"] != `{"a/b-api":["x"]}` || audiences["apiAudiencesf"] != `{"team/orders-api":["y","z"]}` {
		t.Errorf("%v", audiences)
	}
}
