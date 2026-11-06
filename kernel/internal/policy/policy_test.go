// SPDX-License-Identifier: MIT

package policy

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"

	"github.com/rburns629/vennir/kernel/internal/dbtest"
	catalogv1 "github.com/rburns629/vennir/kernel/internal/gen/vennir/catalog/v1"
)

var testPool *pgxpool.Pool

func TestMain(m *testing.M) { dbtest.Main(m, &testPool) }

// fakeSource is a catalog whose reference names one release now.
type fakeSource struct {
	digest   string
	json     []byte
	verified bool
	fetches  int
	// Who's trusted now, and the earlier digests they signed too.
	fingerprint string
	alsoSigned  map[string]bool
}

func (f *fakeSource) Follow(context.Context) (string, error) {
	return "catalog.example/catalog-release:latest", nil
}
func (f *fakeSource) Digest(context.Context, string) (string, error) {
	return f.digest, nil
}
func (f *fakeSource) Fetch(_ context.Context, ref string) (Fetched, error) {
	f.fetches++
	if !strings.HasSuffix(ref, "@"+f.digest) {
		return Fetched{}, errors.New("not read by its digest: " + ref)
	}
	return Fetched{Digest: f.digest, JSON: f.json}, nil
}
func (f *fakeSource) Verify(_ context.Context, _, digest string) error {
	if !f.verified || (digest != f.digest && !f.alsoSigned[digest]) {
		return errors.New("no trusted signer signed it")
	}
	return nil
}
func (f *fakeSource) Fingerprint() string {
	if f.fingerprint == "" {
		return "signers-1"
	}
	return f.fingerprint
}

func (f *fakeSource) release(t *testing.T, d string, release *catalogv1.Release) {
	t.Helper()
	data, err := protojson.Marshal(release)
	if err != nil {
		t.Fatal(err)
	}
	f.digest, f.json, f.verified = d, data, true
}

// fakeWriter is the cluster's policies, by name.
type fakeWriter struct {
	policies map[string]map[string]string
	writes   int
}

func (w *fakeWriter) Write(_ context.Context, policy string, variables, _ map[string]string) (bool, error) {
	if w.policies[policy] == nil {
		return false, ErrNoPolicy{Name: policy}
	}
	changed := false
	for k, v := range variables {
		if w.policies[policy][k] != v {
			w.policies[policy][k] = v
			changed = true
		}
	}
	if changed {
		w.writes++
	}
	return changed, nil
}

func (w *fakeWriter) listed(t *testing.T, d string) []Entry {
	t.Helper()
	var shard map[string][]Entry
	if err := json.Unmarshal([]byte(w.policies["identity"]["releases"+d[7:8]]), &shard); err != nil {
		t.Fatal(err)
	}
	return shard[d]
}

func newController(t *testing.T, source Source) (*Controller, *fakeWriter, *Store) {
	t.Helper()
	tx := dbtest.Tx(t, testPool)
	store := &Store{DB: tx}
	writer := &fakeWriter{policies: map[string]map[string]string{"identity": {"seeded": "yes"}, "tokens": {"seeded": "yes"}}}
	return &Controller{Source: source, Store: store, Writer: writer, IdentityPolicy: "identity", GatewayPolicy: "tokens",
		Reserved: ReservedAudiences(), ReleaseGrace: time.Hour, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}, writer, store
}

func releaseAt(at time.Time, products ...*catalogv1.ProductAction) *catalogv1.Release {
	return &catalogv1.Release{Commit: "c1", CreatedAt: timestamppb.New(at), Teams: []*catalogv1.Team{{Name: "local"}}, Products: products,
		Apis: []*catalogv1.Api{{Name: "orders", Team: "local", ServiceAccount: "orders-api",
			BackendAuth: &catalogv1.BackendAuth{Kind: &catalogv1.BackendAuth_AwsSigV4{AwsSigV4: &catalogv1.AwsSigV4Auth{}}}}}}
}

func db(c string) *catalogv1.ProductAction {
	return &catalogv1.ProductAction{Name: "local-db-create", Team: "local", Action: "create",
		Image: "registry.example/local/db:1@" + digest(c), ServiceAccount: "db-sa", TokenAudiences: []string{"sts.amazonaws.com"}}
}

func TestNothingIsWrittenBeforeAVerifiedReleaseIsApplied(t *testing.T) {
	source := &fakeSource{}
	c, writer, _ := newController(t, source)
	source.release(t, digest("a"), releaseAt(time.Now(), db("1")))
	source.verified = false
	if err := c.Pass(context.Background()); err == nil || !strings.Contains(err.Error(), "nothing was applied") {
		t.Fatalf("an unverified release: %v", err)
	}
	if writer.writes != 0 || source.fetches != 0 {
		t.Fatalf("written %d times, read %d: the chart's seed must stand", writer.writes, source.fetches)
	}
}

func TestAVerifiedReleaseIsWrittenIntoBothPolicies(t *testing.T) {
	source := &fakeSource{}
	c, writer, _ := newController(t, source)
	source.release(t, digest("a"), releaseAt(time.Now(), db("1")))
	if err := c.Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []Entry{{Team: "local", Repository: "registry.example/local/db", Action: "create", ServiceAccount: "db-sa", Audiences: "sts.amazonaws.com"}}
	if got := writer.listed(t, digest("1")); len(got) != 1 || got[0] != want[0] {
		t.Fatalf("listed: %+v", got)
	}
	if writer.policies["tokens"]["apiAudiencesWritten"] != "true" || writer.policies["tokens"]["apiAudiences0"] != `{"local/orders-api":["sts.amazonaws.com"]}` {
		t.Fatalf("tokens: %v", writer.policies["tokens"])
	}
	// The same release again: read no further than its digest, nothing rewritten.
	writes := writer.writes
	if err := c.Pass(context.Background()); err != nil || source.fetches != 1 || writer.writes != writes {
		t.Fatalf("again: %v, %d fetches, %d writes", err, source.fetches, writer.writes)
	}
}

func TestAnEarlierReleaseStaysListedWhileInUseThenGoes(t *testing.T) {
	ctx := context.Background()
	source := &fakeSource{}
	c, writer, store := newController(t, source)
	start := time.Now().Add(-time.Minute)
	source.release(t, digest("a"), releaseAt(start, db("1")))
	if err := c.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	// The next release has the product at another digest.
	source.release(t, digest("b"), releaseAt(start.Add(time.Second), db("2")))
	if err := c.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	if len(writer.listed(t, digest("1"))) != 1 || len(writer.listed(t, digest("2"))) != 1 {
		t.Fatal("within the hour, both releases are listed")
	}
	// Over an hour since the release dropped it.
	if _, err := store.DB.Exec(ctx, `UPDATE catalog_policy_releases SET released_until = now() - interval '2 hours'
		WHERE released_until IS NOT NULL`); err != nil {
		t.Fatal(err)
	}
	// ...but an unfinished task runs it (as that product): still listed.
	if _, err := store.DB.Exec(ctx, `INSERT INTO executions (id, external_reference, idempotency_key, state)
		VALUES ('00000000-0000-0000-0000-0000000000e1', 'policy-test', 'policy-test-e1', 'RUNNING')`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.DB.Exec(ctx, `INSERT INTO execution_tasks (id, execution_id, task_key, image, action, team, service_account,
		state, original_inputs, timeout_seconds, max_attempts, attempt_count)
		VALUES ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', 'db', $1, 'create', 'local', 'db-sa',
		'READY', '{}', 60, 1, 0)`, "registry.example/local/db:1@"+digest("1")); err != nil {
		t.Fatal(err)
	}
	if err := c.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	if len(writer.listed(t, digest("1"))) != 1 {
		t.Fatal("a release an unfinished task runs was dropped")
	}
	// Finished: pruned, and no longer listed.
	if _, err := store.DB.Exec(ctx, `UPDATE execution_tasks SET state = 'SUCCEEDED' WHERE id = '00000000-0000-0000-0000-0000000000f1'`); err != nil {
		t.Fatal(err)
	}
	if err := c.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	if writer.listed(t, digest("1")) != nil || len(writer.listed(t, digest("2"))) != 1 {
		t.Fatal("the earlier release, finished and over an hour gone, is still listed")
	}
	var left int
	if err := store.DB.QueryRow(ctx, `SELECT count(*) FROM catalog_policy_releases WHERE digest = $1`, digest("1")).Scan(&left); err != nil || left != 0 {
		t.Fatalf("not pruned: %d, %v", left, err)
	}
}

func TestAnOlderReleaseIsNeverApplied(t *testing.T) {
	ctx := context.Background()
	source := &fakeSource{}
	c, writer, store := newController(t, source)
	now := time.Now()
	source.release(t, digest("a"), releaseAt(now, db("1")))
	if err := c.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	// Signed too, but made before the one applied: a replay.
	source.release(t, digest("b"), releaseAt(now.Add(-time.Hour), db("2")))
	if err := c.Pass(ctx); err == nil || !strings.Contains(err.Error(), "before the one applied") {
		t.Fatalf("an older release: %v", err)
	}
	if writer.listed(t, digest("2")) != nil {
		t.Fatal("an older release was listed")
	}
	state, err := store.State(ctx)
	if err != nil || state.Digest != digest("a") {
		t.Fatalf("state: %+v %v", state, err)
	}
	// One that says nowhere when it was made, likewise.
	undated := releaseAt(now, db("3"))
	undated.CreatedAt = nil
	source.release(t, digest("c"), undated)
	if err := c.Pass(ctx); err == nil {
		t.Fatal("an undated release was applied")
	}
}

func TestAReleaseDatedInTheFutureIsRefused(t *testing.T) {
	source := &fakeSource{}
	c, writer, _ := newController(t, source)
	// It would lock out every release after it.
	source.release(t, digest("a"), releaseAt(time.Now().Add(24*time.Hour), db("1")))
	if err := c.Pass(context.Background()); err == nil || !strings.Contains(err.Error(), "in the future") {
		t.Fatalf("%v", err)
	}
	if writer.writes != 0 {
		t.Fatal("written")
	}
}

func TestTheReleaseAppliedIsVerifiedAgainWhenOthersAreTrusted(t *testing.T) {
	ctx := context.Background()
	source := &fakeSource{}
	c, writer, store := newController(t, source)
	source.release(t, digest("a"), releaseAt(time.Now(), db("1")))
	if err := c.Pass(ctx); err != nil {
		t.Fatal(err)
	}
	// The chart now trusts other signers, who didn't sign it (its key was
	// removed): until a release they signed is applied, nothing is listed.
	source.fingerprint, source.verified = "signers-2", false
	if err := c.Pass(ctx); err == nil || !strings.Contains(err.Error(), "doesn't verify against the signers trusted now") {
		t.Fatalf("%v", err)
	}
	if writer.listed(t, digest("1")) != nil || writer.policies["tokens"]["apiAudiences0"] != "{}" {
		t.Fatal("still listed under signers that didn't sign it")
	}
	// A new process (no memory of it) still lists nothing.
	c2 := *c
	c2.untrusted = false
	if err := c2.Pass(ctx); err == nil || writer.listed(t, digest("1")) != nil {
		t.Fatalf("a restart listed it again: %v", err)
	}
	// They did sign it after all (a rotation listing both keys): listed
	// again, and not verified again after that.
	source.verified = true
	if err := c.Pass(ctx); err != nil || len(writer.listed(t, digest("1"))) != 1 {
		t.Fatalf("%v", err)
	}
	state, err := store.State(ctx)
	if err != nil || state.Signers != "signers-2" {
		t.Fatalf("%+v %v", state, err)
	}
}

func TestAPolicyThatIsntInstalledFailsThePass(t *testing.T) {
	source := &fakeSource{}
	c, writer, _ := newController(t, source)
	delete(writer.policies, "tokens")
	source.release(t, digest("a"), releaseAt(time.Now(), db("1")))
	var missing ErrNoPolicy
	if err := c.Pass(context.Background()); !errors.As(err, &missing) {
		t.Fatalf("%v", err)
	}
	if len(writer.listed(t, digest("1"))) != 1 {
		t.Fatal("the identity policy, installed, wasn't written")
	}
}
