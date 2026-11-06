// SPDX-License-Identifier: MIT

// Package auth signs a gateway caller in exactly as the console does
// (console/src/auth/plugin.ts, kept in step): a person's session JWT
// (EdDSA, checked with the console's public key, keys.go: the gateway can
// verify a session but never make one; one issued before the account's
// last password change, or signed out, is revoked), or a bot's API token
// (mp_..., found by its SHA-256 in api_tokens, unless revoked or expired;
// its last_used_at kept as the console keeps it). The caller's teams are
// read from the console's database on every request, so a membership change
// counts at once; a retired team (read-only in the console) calls as
// nobody. While single sign-on groups come from an ID token's claim, a
// membership a group gave counts only for a single sign-on session signed in
// within the hour (claimGroupsSession), and so do a person's groups for an
// API's group grants (Caller.GroupsCurrent). A token is never logged or kept.
package auth

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// APITokenPrefix marks a bot's API token (console/src/auth/apiToken.ts).
const APITokenPrefix = "mp_"

// Caller is who's calling.
type Caller struct {
	UserID  string
	Email   string
	IsAdmin bool
	IsBot   bool
	// Teams are the teams the caller is in that may call: not retired ones.
	Teams []string
	// Groups are a person's single sign-on groups as the console last read
	// them (user_groups), for an API's group grants; none for a bot.
	Groups []string
	// GroupsCurrent: Groups count now. Not while they come from an ID
	// token's claim and this isn't a single sign-on session signed in within
	// claimGroupsSession (the console's plugin.ts groupsCurrent, the same).
	GroupsCurrent bool
	// SSOSession: signed in with single sign-on (so it can sign in again to
	// have its groups read), not a password or an API token.
	SSOSession bool
}

// ErrUnauthenticated is a missing, malformed, expired or revoked credential.
var ErrUnauthenticated = errors.New("missing, invalid, expired or revoked credential")

// ErrOrdersOnly is an ordering bot's credential: it may only order its
// listed templates in the console (auth/access.ts ensureMayOrder), so it
// calls no API.
var ErrOrdersOnly = errors.New("an ordering bot calls no API")

// tokenUseResolution is how stale an API token's last_used_at may get
// before a request updates it (console/src/auth/plugin.ts, the same).
const tokenUseResolution = 5 * time.Minute

// claimGroupsSession is how long after its sign-in a session counts the
// memberships single sign-on groups gave, while those groups come from an ID
// token's claim, which only a sign-in reads: the console's
// CLAIM_GROUPS_SESSION_SECONDS (console/src/sso.ts), the same.
const claimGroupsSession = time.Hour

// googleGroupsFresh is how long Google Workspace groups, read hourly
// between sign-ins, count for an API's group grant after they were read:
// the console's GOOGLE_GROUPS_FRESH_SECONDS (console/src/sso.ts), the same.
const googleGroupsFresh = 90 * time.Minute

// uuidPattern is a user id as the console makes them: anything else in a
// session names nobody.
var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// DB is what the lookups run on (a pool).
type DB interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Resolver signs callers in.
type Resolver struct {
	DB DB
	// The console's session keys (ConsoleKeys).
	Keys Keys
	// SSO: the install's settings turn single sign-on on, so a password's
	// session is refused for someone a team requires it of (as the
	// console's auth/plugin.ts does; admins are exempt). Single sign-on an
	// admin turns on in the console (sso_settings) counts too, read when
	// it matters.
	SSO bool
	Now func() time.Time
}

// Resolve turns an Authorization header into its caller.
func (r *Resolver) Resolve(ctx context.Context, authorization string) (*Caller, error) {
	bearer, ok := strings.CutPrefix(authorization, "Bearer ")
	if !ok || bearer == "" {
		return nil, ErrUnauthenticated
	}
	var c Caller
	var passwordChanged *time.Time
	var mustChangePassword, ordering bool
	passwordSession := false
	// A single sign-on session, and one signed in within claimGroupsSession.
	ssoSession, recentSSO := false, false
	if strings.HasPrefix(bearer, APITokenPrefix) {
		sum := sha256.Sum256([]byte(bearer))
		var tokenID string
		var lastUsed *time.Time
		err := r.DB.QueryRow(ctx, `SELECT u.id::text, u.email, u.is_admin, u.is_bot, u.order_templates IS NOT NULL, t.id::text, t.last_used_at
			FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 AND t.revoked_at IS NULL
			AND (t.expires_at IS NULL OR t.expires_at > now())`, hex.EncodeToString(sum[:])).
			Scan(&c.UserID, &c.Email, &c.IsAdmin, &c.IsBot, &ordering, &tokenID, &lastUsed)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUnauthenticated
		}
		if err != nil {
			return nil, err
		}
		// Used here counts as used: a bot that only calls APIs mustn't look
		// stale in the console's token list.
		if lastUsed == nil || r.now().Sub(*lastUsed) > tokenUseResolution {
			if _, err := r.DB.Exec(ctx, `UPDATE api_tokens SET last_used_at = now() WHERE id = $1::uuid`, tokenID); err != nil {
				return nil, err
			}
		}
	} else {
		claims, err := r.verifyJWT(ctx, bearer)
		if errors.Is(err, ErrUnauthenticated) {
			return nil, ErrUnauthenticated
		}
		if err != nil {
			// The console's keys couldn't be read: not the caller's fault.
			return nil, err
		}
		if !uuidPattern.MatchString(claims.UserID) {
			return nil, ErrUnauthenticated
		}
		err = r.DB.QueryRow(ctx, `SELECT id::text, email, is_admin, is_bot, password_changed_at, must_change_password, order_templates IS NOT NULL
			FROM users WHERE id = $1::uuid`, claims.UserID).
			Scan(&c.UserID, &c.Email, &c.IsAdmin, &c.IsBot, &passwordChanged, &mustChangePassword, &ordering)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrUnauthenticated
		}
		if err != nil {
			return nil, err
		}
		// Whole seconds, as the console compares: the token a password
		// change issues in the same second still counts.
		if passwordChanged != nil && claims.IssuedAt < passwordChanged.Unix() {
			return nil, ErrUnauthenticated
		}
		// Signed out before it expired (the console's AuthService.SignOut).
		if claims.SessionID != "" {
			var revoked bool
			if err := r.DB.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM revoked_sessions WHERE sid = $1)`, claims.SessionID).Scan(&revoked); err != nil {
				return nil, err
			}
			if revoked {
				return nil, ErrUnauthenticated
			}
		}
		passwordSession = !claims.SSO
		ssoSession = claims.SSO
		recentSSO = ssoSession && r.now().Unix()-claims.IssuedAt <= int64(claimGroupsSession/time.Second)
		// A password someone else set: the console allows nothing but
		// changing it, and neither does the gateway.
		if passwordSession && mustChangePassword {
			return nil, ErrUnauthenticated
		}
	}
	if ordering {
		return nil, ErrOrdersOnly
	}
	// A bot is never an admin, whatever its row says: the console refuses
	// making one an admin, and resolves a bot as no admin too.
	c.IsAdmin = c.IsAdmin && !c.IsBot
	// Ordered by name byte for byte, as the console's teamRolesForUser is,
	// so both pick the same calling team. A retired team's require_sso
	// still counts (as the console's does), but it calls as nobody. From
	// groups: a group gave it and the team is still mapped (the console's
	// fromGroups). With each row, the single sign-on settings an admin saved
	// (ssoOn): whether they're on, and whether groups come from a claim.
	rows, err := r.DB.Query(ctx, `SELECT t.name, t.require_sso, t.retired_at IS NOT NULL,
		m.from_groups AND EXISTS (SELECT 1 FROM sso_group_mappings g WHERE g.team_id = t.id),
		COALESCE((SELECT s.enabled AND s.issuer <> '' AND s.client_id <> '' AND s.redirect_url <> '' FROM sso_settings s WHERE s.id = 1), false),
		COALESCE((SELECT s.groups_claim <> '' FROM sso_settings s WHERE s.id = 1), false)
		FROM team_memberships m JOIN teams t ON t.id = m.team_id
		WHERE m.user_id = $1::uuid AND t.deleted_at IS NULL ORDER BY t.name COLLATE "C"`, c.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type membership struct {
		team       string
		fromGroups bool
	}
	var held []membership
	ssoRequired, anyFromGroups, savedOn, claimSet := false, false, false, false
	for rows.Next() {
		var team string
		var requireSSO, retired, fromGroups bool
		if err := rows.Scan(&team, &requireSSO, &retired, &fromGroups, &savedOn, &claimSet); err != nil {
			return nil, err
		}
		if !retired {
			held = append(held, membership{team, fromGroups})
		}
		anyFromGroups = anyFromGroups || fromGroups
		ssoRequired = ssoRequired || requireSSO
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	ssoOn := r.ssoOn(savedOn)
	// While single sign-on is on and groups come from an ID token's claim, a
	// membership a group gave counts only for a recent single sign-on: an
	// older one is refused (its person signs in again, and their groups are
	// read), and a password's session or an API token calls without those
	// teams. While it's off, nothing changes (the console's claimGroupsInUse
	// and resolveCaller, the same).
	stale := anyFromGroups && !recentSSO && ssoOn && claimSet
	if stale && ssoSession {
		return nil, ErrUnauthenticated
	}
	for _, m := range held {
		if !stale || !m.fromGroups {
			c.Teams = append(c.Teams, m.team)
		}
	}
	if passwordSession && ssoRequired && !c.IsAdmin && ssoOn {
		return nil, ErrUnauthenticated
	}
	c.SSOSession = ssoSession
	// A person's groups, for an API's group grants: counting, as group-given
	// teams do, only while they can't be stale (with groups from a claim,
	// for a recent single sign-on). Whether a group grant is the caller's
	// only way in is the API's question (the gateway's accessFor).
	if !c.IsBot {
		// The groups, with the settings that say whether they count: the
		// group rows read within googleGroupsFresh (only Google's are
		// read between sign-ins; a claim's count by the session instead).
		var ssoSaved, claimSet, googleSet bool
		var all, fresh []string
		if err := r.DB.QueryRow(ctx, `SELECT
			ARRAY(SELECT group_name FROM user_groups WHERE user_id = $1::uuid ORDER BY group_name COLLATE "C"),
			ARRAY(SELECT group_name FROM user_groups WHERE user_id = $1::uuid AND read_at > $2 ORDER BY group_name COLLATE "C"),
			COALESCE((SELECT s.enabled AND s.issuer <> '' AND s.client_id <> '' AND s.redirect_url <> '' FROM sso_settings s WHERE s.id = 1), false),
			COALESCE((SELECT s.groups_claim <> '' FROM sso_settings s WHERE s.id = 1), false),
			COALESCE((SELECT s.google_groups FROM sso_settings s WHERE s.id = 1), false)`, c.UserID, r.now().Add(-googleGroupsFresh)).
			Scan(&all, &fresh, &ssoSaved, &claimSet, &googleSet); err != nil {
			return nil, err
		}
		// Groups count only while single sign-on is on and a source is set:
		// with a claim, for a single sign-on from the last hour; with
		// Google's alone, the rows read within googleGroupsFresh, so a
		// resync that keeps failing fails closed (the console's plugin.ts
		// groupsCurrent and apiAccess.ts groupsOf, the same).
		sourceOn := r.ssoOn(ssoSaved) && (claimSet || googleSet)
		switch {
		case claimSet:
			c.Groups, c.GroupsCurrent = all, sourceOn && recentSSO
		default:
			c.Groups, c.GroupsCurrent = fresh, sourceOn
		}
	}
	return &c, nil
}

// ssoOn: single sign-on is on, by the install's settings or as an admin
// saved it in the console (saved: sso.ts refreshSso's on, and complete).
// One difference, on the side of refusing: the console also needs the saved
// client secret to unseal, which the gateway, granted no part of it, can't
// check; while it can't (JWT_SECRET changed), the console treats single
// sign-on as off and the gateway as on, until an admin saves it again. (A
// changed JWT_SECRET also changes the session key, so no session from
// before it is accepted anyway.) The same goes for the claim-groups rule:
// meanwhile, with a groups claim saved, the gateway drops group-given teams
// from API tokens and password sessions, and refuses older single sign-on
// sessions holding one, where the console counts them. It errs on the
// refusing side.
func (r *Resolver) ssoOn(saved bool) bool {
	return r.SSO || saved
}

type claims struct {
	UserID string `json:"userId"`
	// Made by single sign-on, not a password.
	SSO bool `json:"sso"`
	// The session's id, which signing out revokes; empty on older sessions.
	SessionID string `json:"sid"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

// verifyJWT checks an EdDSA JWT signed with the console's session key, and
// that it hasn't expired.
func (r *Resolver) verifyJWT(ctx context.Context, token string) (*claims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, ErrUnauthenticated
	}
	var header struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
	}
	if err := decodeSegment(parts[0], &header); err != nil || header.Alg != "EdDSA" || header.Kid == "" {
		return nil, ErrUnauthenticated
	}
	key, err := r.Keys.Key(ctx, header.Kid)
	if err != nil {
		return nil, err
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), signature) {
		return nil, ErrUnauthenticated
	}
	var c claims
	if err := decodeSegment(parts[1], &c); err != nil || c.UserID == "" {
		return nil, ErrUnauthenticated
	}
	if c.ExpiresAt == 0 || r.now().Unix() >= c.ExpiresAt {
		return nil, ErrUnauthenticated
	}
	return &c, nil
}

func (r *Resolver) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func decodeSegment(segment string, into any) error {
	data, err := base64.RawURLEncoding.DecodeString(segment)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, into)
}
