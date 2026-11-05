// SPDX-License-Identifier: MIT

package auth

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// Against the console's real, migrated test database (TEST_DATABASE_URL,
// execution_console_test), in a transaction rolled back after: the same
// rules as console/src/auth/plugin.ts.

// The console's session key, as a test makes one; "other" signs as nobody
// the gateway trusts.
var (
	secret = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{1}, ed25519.SeedSize))
	other  = ed25519.NewKeyFromSeed(bytes.Repeat([]byte{2}, ed25519.SeedSize))
)

// staticKeys is the console's one key, as its JWKS would give it.
type staticKeys map[string]ed25519.PublicKey

func (k staticKeys) Key(_ context.Context, kid string) (ed25519.PublicKey, error) {
	if key, ok := k[kid]; ok {
		return key, nil
	}
	return nil, ErrUnauthenticated
}

var keys = staticKeys{"console": secret.Public().(ed25519.PublicKey)}

// jwt signs claims as the console does (EdDSA, kid "console"), or with
// another key or algorithm: "HS256" signs with an HMAC of key's seed.
func jwt(t *testing.T, key ed25519.PrivateKey, alg string, claims map[string]any) string {
	t.Helper()
	header, _ := json.Marshal(map[string]string{"alg": alg, "typ": "JWT", "kid": "console"})
	payload, _ := json.Marshal(claims)
	signing := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(payload)
	var signature []byte
	if alg == "HS256" {
		mac := hmac.New(sha256.New, key.Seed())
		mac.Write([]byte(signing))
		signature = mac.Sum(nil)
	} else {
		signature = ed25519.Sign(key, []byte(signing))
	}
	return signing + "." + base64.RawURLEncoding.EncodeToString(signature)
}

func tx(t *testing.T) pgx.Tx {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = "postgresql://postgres@localhost/execution_console_test"
	}
	conn, err := pgx.Connect(context.Background(), url)
	if err != nil {
		t.Fatalf("the console's test database (TEST_DATABASE_URL): %v", err)
	}
	tx, err := conn.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = tx.Rollback(context.Background())
		_ = conn.Close(context.Background())
	})
	return tx
}

func TestCallersSignInAsTheyDoAtTheConsole(t *testing.T) {
	db := tx(t)
	ctx := context.Background()
	var userID, botID, teamID string
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(db.QueryRow(ctx, `INSERT INTO users (email, is_admin) VALUES ('gw-person@example.com', false) RETURNING id::text`).Scan(&userID))
	must(db.QueryRow(ctx, `INSERT INTO users (email, is_bot) VALUES ('gw-bot@bots.vennir.local', true) RETURNING id::text`).Scan(&botID))
	must(db.QueryRow(ctx, `INSERT INTO teams (name) VALUES ('gw-test-web') RETURNING id::text`).Scan(&teamID))
	for _, id := range []string{userID, botID} {
		_, err := db.Exec(ctx, `INSERT INTO team_memberships (user_id, team_id, role) VALUES ($1, $2, 'member')`, id, teamID)
		must(err)
	}
	token := APITokenPrefix + "abc123"
	sum := sha256.Sum256([]byte(token))
	_, err := db.Exec(ctx, `INSERT INTO api_tokens (user_id, label, token_hash) VALUES ($1, 'ci', $2)`, botID, hex.EncodeToString(sum[:]))
	must(err)

	now := time.Now()
	r := &Resolver{DB: db, Keys: keys, Now: func() time.Time { return now }}
	session := jwt(t, secret, "EdDSA", map[string]any{"userId": userID, "iat": now.Unix() - 60, "exp": now.Unix() + 3600})
	who, err := r.Resolve(ctx, "Bearer "+session)
	if err != nil || who.UserID != userID || who.Email != "gw-person@example.com" || len(who.Teams) != 1 || who.Teams[0] != "gw-test-web" {
		t.Fatalf("a session: %+v, %v", who, err)
	}
	bot, err := r.Resolve(ctx, "Bearer "+token)
	if err != nil || bot.UserID != botID || !bot.IsBot || bot.Teams[0] != "gw-test-web" {
		t.Fatalf("a bot token: %+v, %v", bot, err)
	}

	// Its use is kept, as the console keeps it: at most every few minutes.
	var used time.Time
	must(db.QueryRow(ctx, `SELECT last_used_at FROM api_tokens WHERE user_id = $1`, botID).Scan(&used))
	if time.Since(used) > time.Minute {
		t.Fatalf("a token's use: last used %v", used)
	}
	_, err = db.Exec(ctx, `UPDATE api_tokens SET last_used_at = now() - interval '1 minute' WHERE user_id = $1`, botID)
	must(err)
	_, err = r.Resolve(ctx, "Bearer "+token)
	must(err)
	var again time.Time
	must(db.QueryRow(ctx, `SELECT last_used_at FROM api_tokens WHERE user_id = $1`, botID).Scan(&again))
	if time.Since(again) < 50*time.Second {
		t.Fatalf("a token used a minute ago isn't written again: last used %v", again)
	}

	for name, header := range map[string]string{
		"nothing":            "",
		"not a bearer":       "Basic " + session,
		"another key":        "Bearer " + jwt(t, other, "EdDSA", map[string]any{"userId": userID, "iat": now.Unix(), "exp": now.Unix() + 60}),
		"HS256":              "Bearer " + jwt(t, secret, "HS256", map[string]any{"userId": userID, "iat": now.Unix(), "exp": now.Unix() + 60}),
		"expired":            "Bearer " + jwt(t, secret, "EdDSA", map[string]any{"userId": userID, "iat": now.Unix() - 7200, "exp": now.Unix() - 1}),
		"no expiry":          "Bearer " + jwt(t, secret, "EdDSA", map[string]any{"userId": userID, "iat": now.Unix()}),
		"alg none":           "Bearer " + jwt(t, secret, "none", map[string]any{"userId": userID, "iat": now.Unix(), "exp": now.Unix() + 60}),
		"an unknown token":   "Bearer " + APITokenPrefix + "nope",
		"an unknown account": "Bearer " + jwt(t, secret, "EdDSA", map[string]any{"userId": "00000000-0000-0000-0000-000000000000", "iat": now.Unix(), "exp": now.Unix() + 60}),
		"not a user id":      "Bearer " + jwt(t, secret, "EdDSA", map[string]any{"userId": "' OR true --", "iat": now.Unix(), "exp": now.Unix() + 60}),
	} {
		if _, err := r.Resolve(ctx, header); err != ErrUnauthenticated {
			t.Errorf("%s: %v", name, err)
		}
	}

	// A password change revokes sessions issued before it (in whole seconds).
	_, err = db.Exec(ctx, `UPDATE users SET password_changed_at = $2 WHERE id = $1`, userID, now)
	must(err)
	if _, err := r.Resolve(ctx, "Bearer "+session); err != ErrUnauthenticated {
		t.Errorf("a session from before the password change: %v", err)
	}
	same := jwt(t, secret, "EdDSA", map[string]any{"userId": userID, "iat": now.Unix(), "exp": now.Unix() + 60})
	if _, err := r.Resolve(ctx, "Bearer "+same); err != nil {
		t.Errorf("the session the change issued, in the same second: %v", err)
	}
	// A password an admin set: refused until its owner changes it.
	_, err = db.Exec(ctx, `UPDATE users SET must_change_password = true WHERE id = $1`, userID)
	must(err)
	if _, err := r.Resolve(ctx, "Bearer "+same); err != ErrUnauthenticated {
		t.Errorf("a session whose password must be changed: %v", err)
	}
	ssoSession := jwt(t, secret, "EdDSA", map[string]any{"userId": userID, "sso": true, "iat": now.Unix(), "exp": now.Unix() + 60})
	if _, err := r.Resolve(ctx, "Bearer "+ssoSession); err != nil {
		t.Errorf("a single sign-on session, whatever the password: %v", err)
	}
	// A session signed out at the console, and not another of the same person's.
	signedOut := jwt(t, secret, "EdDSA", map[string]any{"userId": userID, "sso": true, "sid": "gw-signed-out", "iat": now.Unix(), "exp": now.Unix() + 60})
	other := jwt(t, secret, "EdDSA", map[string]any{"userId": userID, "sso": true, "sid": "gw-still-in", "iat": now.Unix(), "exp": now.Unix() + 60})
	_, err = db.Exec(ctx, `INSERT INTO revoked_sessions (sid, expires_at) VALUES ('gw-signed-out', now() + interval '1 minute')`)
	must(err)
	if _, err := r.Resolve(ctx, "Bearer "+signedOut); err != ErrUnauthenticated {
		t.Errorf("a signed-out session: %v", err)
	}
	if _, err := r.Resolve(ctx, "Bearer "+other); err != nil {
		t.Errorf("another session of the same person: %v", err)
	}
	// An expired token.
	_, err = db.Exec(ctx, `UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE user_id = $1`, botID)
	must(err)
	if _, err := r.Resolve(ctx, "Bearer "+token); err != ErrUnauthenticated {
		t.Errorf("an expired token: %v", err)
	}
	_, err = db.Exec(ctx, `UPDATE api_tokens SET expires_at = now() + interval '1 day' WHERE user_id = $1`, botID)
	must(err)
	if _, err := r.Resolve(ctx, "Bearer "+token); err != nil {
		t.Errorf("a token not yet expired: %v", err)
	}
	// A revoked token.
	_, err = db.Exec(ctx, `UPDATE api_tokens SET revoked_at = now() WHERE user_id = $1`, botID)
	must(err)
	if _, err := r.Resolve(ctx, "Bearer "+token); err != ErrUnauthenticated {
		t.Errorf("a revoked token: %v", err)
	}
}

// A team that requires single sign-on refuses its members' password
// sessions, as the console does: not a single sign-on's, not an admin's,
// not a bot's token, and nothing while the console has single sign-on off.
func TestATeamRequiringSingleSignOnRefusesPasswordSessions(t *testing.T) {
	db := tx(t)
	ctx := context.Background()
	var personID, adminID, teamID string
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(db.QueryRow(ctx, `INSERT INTO users (email) VALUES ('gw-sso-person@example.com') RETURNING id::text`).Scan(&personID))
	must(db.QueryRow(ctx, `INSERT INTO users (email, is_admin) VALUES ('gw-sso-admin@example.com', true) RETURNING id::text`).Scan(&adminID))
	must(db.QueryRow(ctx, `INSERT INTO teams (name, require_sso) VALUES ('gw-sso-team', true) RETURNING id::text`).Scan(&teamID))
	for _, id := range []string{personID, adminID} {
		_, err := db.Exec(ctx, `INSERT INTO team_memberships (user_id, team_id, role) VALUES ($1, $2, 'member')`, id, teamID)
		must(err)
	}
	now := time.Now()
	session := func(userID string, sso bool) string {
		claims := map[string]any{"userId": userID, "iat": now.Unix(), "exp": now.Unix() + 60}
		if sso {
			claims["sso"] = true
		}
		return "Bearer " + jwt(t, secret, "EdDSA", claims)
	}
	on := &Resolver{DB: db, Keys: keys, SSO: true, Now: func() time.Time { return now }}
	off := &Resolver{DB: db, Keys: keys, Now: func() time.Time { return now }}

	if _, err := on.Resolve(ctx, session(personID, false)); err != ErrUnauthenticated {
		t.Errorf("a member's password session: %v", err)
	}
	if _, err := on.Resolve(ctx, session(personID, true)); err != nil {
		t.Errorf("a member's single sign-on: %v", err)
	}
	if _, err := on.Resolve(ctx, session(adminID, false)); err != nil {
		t.Errorf("an admin's password session: %v", err)
	}
	// Off in the install's settings, on as an admin saved it in the console:
	// refused the same (and allowed again once it's off there too).
	// (In this test's transaction, rolled back after it.)
	_, err := db.Exec(ctx, `INSERT INTO sso_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`)
	must(err)
	_, err = db.Exec(ctx, `UPDATE sso_settings SET enabled = false WHERE id = 1`)
	must(err)
	if _, err := off.Resolve(ctx, session(personID, false)); err != nil {
		t.Errorf("a password session with single sign-on off: %v", err)
	}
	_, err = db.Exec(ctx, `UPDATE sso_settings SET enabled = true, issuer = 'https://accounts.example', client_id = 'c', redirect_url = 'https://console.example/cb' WHERE id = 1`)
	must(err)
	if _, err := off.Resolve(ctx, session(personID, false)); err != ErrUnauthenticated {
		t.Errorf("a member's password session with single sign-on an admin turned on: %v", err)
	}
	if _, err := off.Resolve(ctx, session(personID, true)); err != nil {
		t.Errorf("a member's single sign-on, an admin's on: %v", err)
	}
}

// An ordering bot may only order its listed templates in the console, so
// the gateway serves it nothing, by token or keyless session.
func TestAnOrderingBotCallsNoAPI(t *testing.T) {
	db := tx(t)
	ctx := context.Background()
	var botID string
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(db.QueryRow(ctx, `INSERT INTO users (email, is_bot, order_templates) VALUES ('gw-orderer@bots.vennir.local', true, '{shop/order}') RETURNING id::text`).Scan(&botID))
	token := APITokenPrefix + "orderer-" + botID
	sum := sha256.Sum256([]byte(token))
	_, err := db.Exec(ctx, `INSERT INTO api_tokens (user_id, label, token_hash) VALUES ($1::uuid, 'orders', $2)`, botID, hex.EncodeToString(sum[:]))
	must(err)
	now := time.Now()
	r := &Resolver{DB: db, Keys: keys, Now: func() time.Time { return now }}
	if _, err := r.Resolve(ctx, "Bearer "+token); err != ErrOrdersOnly {
		t.Errorf("its token: %v", err)
	}
	session := "Bearer " + jwt(t, secret, "EdDSA", map[string]any{"userId": botID, "iat": now.Unix(), "exp": now.Unix() + 60, "sso": true})
	if _, err := r.Resolve(ctx, session); err != ErrOrdersOnly {
		t.Errorf("its keyless session: %v", err)
	}
}

// A retired team is read-only in the console, so its members and bots call
// as their other teams, never as it; the teams come back in byte order, as
// the console's teamRolesForUser gives them.
func TestARetiredTeamCallsAsNobody(t *testing.T) {
	db := tx(t)
	ctx := context.Background()
	var userID string
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(db.QueryRow(ctx, `INSERT INTO users (email) VALUES ('gw-retired@example.com') RETURNING id::text`).Scan(&userID))
	for _, team := range []string{"gw-z", "gw-retired", "gw-a-b", "gw-ab"} {
		var teamID string
		must(db.QueryRow(ctx, `INSERT INTO teams (name) VALUES ($1) RETURNING id::text`, team).Scan(&teamID))
		_, err := db.Exec(ctx, `INSERT INTO team_memberships (user_id, team_id, role) VALUES ($1, $2, 'member')`, userID, teamID)
		must(err)
	}
	_, err := db.Exec(ctx, `UPDATE teams SET retired_at = now() WHERE name = 'gw-retired'`)
	must(err)
	now := time.Now()
	r := &Resolver{DB: db, Keys: keys, Now: func() time.Time { return now }}
	who, err := r.Resolve(ctx, "Bearer "+jwt(t, secret, "EdDSA", map[string]any{"userId": userID, "iat": now.Unix(), "exp": now.Unix() + 60}))
	must(err)
	if got := strings.Join(who.Teams, ","); got != "gw-a-b,gw-ab,gw-z" {
		t.Fatalf("the calling teams: %s", got)
	}
}

// A bot never calls as an admin, even if its row says it is one: as the
// console's resolveCaller has it.
func TestABotIsNeverAnAdmin(t *testing.T) {
	db := tx(t)
	ctx := context.Background()
	var botID string
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(db.QueryRow(ctx, `INSERT INTO users (email, is_bot, is_admin) VALUES ('gw-admin-bot@bots.vennir.local', true, true) RETURNING id::text`).Scan(&botID))
	token := APITokenPrefix + "admin-bot-" + botID
	sum := sha256.Sum256([]byte(token))
	_, err := db.Exec(ctx, `INSERT INTO api_tokens (user_id, label, token_hash) VALUES ($1::uuid, 'ci', $2)`, botID, hex.EncodeToString(sum[:]))
	must(err)
	now := time.Now()
	r := &Resolver{DB: db, Keys: keys, Now: func() time.Time { return now }}
	who, err := r.Resolve(ctx, "Bearer "+token)
	must(err)
	if who.IsAdmin || !who.IsBot {
		t.Errorf("its token: %+v", who)
	}
	who, err = r.Resolve(ctx, "Bearer "+jwt(t, secret, "EdDSA", map[string]any{"userId": botID, "iat": now.Unix(), "exp": now.Unix() + 60, "sso": true}))
	must(err)
	if who.IsAdmin || !who.IsBot {
		t.Errorf("its keyless session: %+v", who)
	}
}
