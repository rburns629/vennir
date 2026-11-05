// SPDX-License-Identifier: MIT

// Package store holds the gateway's view of the published APIs: read from
// the console's apis table (which the catalog's releases fill) every few
// seconds, each with its OpenAPI validator, built again only when its row
// changes. An API whose team is retired or purged isn't there at all.
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/pb33f/libopenapi"
	validator "github.com/pb33f/libopenapi-validator"
	"github.com/pb33f/libopenapi-validator/config"
)

// API is one published API, as the gateway serves it.
type API struct {
	ID             string
	Team, Name     string
	BackendURL     *url.URL
	BackendAuth    map[string]map[string]string
	ServiceAccount string
	ShareWith      []string
	// Hidden: only its own team, and admins, hear of it, whatever it's
	// shared with (the console's sees()).
	Hidden        bool
	Internet      bool
	PerMinute     map[string]int
	Timeout       time.Duration
	MaxRequest    int64
	PausedMessage *string
	UpdatedAt     time.Time
	// APINamespaceTaken: a team is named APINamespace(Team) (one named
	// before such names were refused), so that namespace is its, not this
	// API's team's (BackendPlace).
	APINamespaceTaken bool
	// Validator checks a request against the spec; Problem says why there
	// isn't one (the API then answers 503: it can't be checked, so it isn't
	// forwarded).
	Validator validator.Validator
	Problem   string
	// recorded: Problem is in the console's api_problems table (or, with
	// none, the API's row isn't), for the API's page.
	recorded bool
	// Endpoints are its spec's operations, to name what a request matched.
	Endpoints []Endpoint
	// queryKeys are the query keys each operation ("METHOD /path") takes
	// beyond its parameters' names, which strict mode counts as undeclared.
	queryKeys map[string]queryKeys
}

// queryKeys: a deepObject parameter's `name[...]` keys (by prefix), and an
// exploded object parameter's properties, sent as keys of their own.
type queryKeys struct {
	prefixes   []string
	properties map[string]bool
}

// TakesQueryKey is whether an operation ("METHOD /path", Match's) takes a
// query key its parameters name only through their style.
func (a *API) TakesQueryKey(endpoint, key string) bool {
	k := a.queryKeys[endpoint]
	if k.properties[key] {
		return true
	}
	for _, p := range k.prefixes {
		if strings.HasPrefix(key, p) {
			return true
		}
	}
	return false
}

// Endpoint is one operation: its method and its path as the spec writes it.
type Endpoint struct {
	Method, Path string
	pattern      *regexp.Regexp
}

// Match is the operation a request's method and path (relative to the
// backend) matched, as "METHOD /path/{param}", or "".
func (a *API) Match(method, path string) string {
	for _, e := range a.Endpoints {
		if e.Method == method && e.pattern.MatchString(path) {
			return e.Method + " " + e.Path
		}
	}
	return ""
}

var parameter = regexp.MustCompile(`\{[^}/]*\}`)

// endpoints are a spec's operations.
func endpoints(spec []byte) []Endpoint {
	var doc struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if json.Unmarshal(spec, &doc) != nil {
		return nil
	}
	var out []Endpoint
	for path, item := range doc.Paths {
		quoted := regexp.QuoteMeta(parameter.ReplaceAllString(path, "\x00"))
		pattern := regexp.MustCompile("^" + strings.ReplaceAll(quoted, "\x00", "[^/]+") + "/?$")
		for method := range item {
			switch method {
			case "get", "put", "post", "delete", "options", "head", "patch", "trace":
				out = append(out, Endpoint{Method: strings.ToUpper(method), Path: path, pattern: pattern})
			}
		}
	}
	return out
}

// Key is <team>/<name>.
func (a *API) Key() string { return a.Team + "/" + a.Name }

// Store is the published APIs.
type Store struct {
	DB interface {
		Query(context.Context, string, ...any) (pgx.Rows, error)
		Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	}
	Log *slog.Logger

	mu   sync.RWMutex
	apis map[string]*API
	// closed is the message an admin closed the gateway with, or "".
	closed string
}

// Closed is why an admin closed the gateway, or "" when it's open.
func (s *Store) Closed() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.closed
}

// Get is an API by team and name.
func (s *Store) Get(team, name string) *API {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.apis[team+"/"+name]
}

// Len is how many APIs it holds.
func (s *Store) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.apis)
}

// Refresh reads the APIs again, building a validator for each that's new or changed.
func (s *Store) Refresh(ctx context.Context) error {
	var closed string
	states, err := s.DB.Query(ctx, `SELECT coalesce(closed_message, '') FROM gateway_state WHERE id = 1`)
	if err != nil {
		return err
	}
	for states.Next() {
		if err := states.Scan(&closed); err != nil {
			states.Close()
			return err
		}
	}
	states.Close()
	rows, err := s.DB.Query(ctx, `SELECT a.id::text, t.name, a.name, a.openapi::text, a.backend_url, coalesce(a.backend_auth::text, ''),
			a.service_account, a.share_with, a.hidden, a.internet, a.per_minute::text, a.timeout_seconds, a.max_request_bytes,
			a.paused_message, a.updated_at, EXISTS (SELECT 1 FROM teams o WHERE o.name = t.name || '-apis')
		FROM apis a JOIN teams t ON t.id = a.team_id WHERE t.retired_at IS NULL AND t.deleted_at IS NULL`)
	if err != nil {
		return err
	}
	defer rows.Close()
	s.mu.RLock()
	old := s.apis
	s.mu.RUnlock()
	next := map[string]*API{}
	for rows.Next() {
		var a API
		var spec, backendURL, auth, perMinute string
		var timeout int
		if err := rows.Scan(&a.ID, &a.Team, &a.Name, &spec, &backendURL, &auth, &a.ServiceAccount, &a.ShareWith, &a.Hidden, &a.Internet,
			&perMinute, &timeout, &a.MaxRequest, &a.PausedMessage, &a.UpdatedAt, &a.APINamespaceTaken); err != nil {
			return err
		}
		if prev := old[a.Key()]; prev != nil && prev.UpdatedAt.Equal(a.UpdatedAt) && prev.APINamespaceTaken == a.APINamespaceTaken {
			if !prev.recorded {
				s.record(ctx, prev)
			}
			s.warnTeamNamespace(prev)
			next[a.Key()] = prev
			continue
		}
		a.Timeout = time.Duration(timeout) * time.Second
		// What can't be read is a problem, never a default: settings that
		// didn't decode would forward without the backend's credential, or
		// without the API's limits.
		if a.BackendURL, err = url.Parse(backendURL); err != nil {
			a.Problem = "its backend URL can't be read"
		} else if json.Unmarshal([]byte(perMinute), &a.PerMinute) != nil {
			a.Problem = "its rate limits can't be read"
		} else if auth != "" && json.Unmarshal([]byte(auth), &a.BackendAuth) != nil {
			a.Problem = "its backend credential settings can't be read"
		} else if v, keys, problem := build([]byte(spec)); problem != "" {
			a.Problem = problem
		} else {
			a.Validator, a.queryKeys = v, keys
			a.Endpoints = endpoints([]byte(spec))
		}
		if a.Problem != "" {
			s.Log.Warn("an API can't be served", "api", a.Key(), "problem", a.Problem)
		}
		s.warnTeamNamespace(&a)
		s.record(ctx, &a)
		next[a.Key()] = &a
	}
	if err := rows.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	s.apis = next
	s.closed = closed
	s.mu.Unlock()
	return nil
}

// warnTeamNamespace logs, once a refresh, an API whose backend still runs
// in its team's own namespace: served for one release, until it moves to
// the team's API backends' namespace.
func (s *Store) warnTeamNamespace(a *API) {
	if a.BackendURL != nil && BackendPlace(a.BackendURL, a.Team, a.APINamespaceTaken) == BackendInTeam {
		s.Log.Warn("an API's backend runs in its team's namespace: move it to the team's API backends' namespace",
			"event", "api_backend_in_team_namespace", "api", a.Key(), "namespace", a.Team, "move_to", APINamespace(a.Team))
	}
}

// maxProblem is the most of a problem the console is told: a parser's
// message can quote much of the document.
const maxProblem = 1000

// record tells the console whether the API can be served (api_problems, a
// row while it can't), for its page. A failed write is logged and tried
// again on the next refresh; serving doesn't wait on it.
func (s *Store) record(ctx context.Context, a *API) {
	var err error
	if a.Problem == "" {
		_, err = s.DB.Exec(ctx, `DELETE FROM api_problems WHERE api_id = $1::uuid`, a.ID)
	} else {
		problem := a.Problem
		if len(problem) > maxProblem {
			problem = strings.ToValidUTF8(problem[:maxProblem], "") + "…"
		}
		// found_at stays when the same problem is found again (another
		// replica, a restart): it's when it began.
		_, err = s.DB.Exec(ctx, `INSERT INTO api_problems (api_id, problem) VALUES ($1::uuid, $2)
			ON CONFLICT (api_id) DO UPDATE SET problem = excluded.problem,
				found_at = CASE WHEN api_problems.problem = excluded.problem THEN api_problems.found_at ELSE now() END`, a.ID, problem)
	}
	if err != nil {
		s.Log.Error("couldn't record whether an API can be served", "api", a.Key(), "error", err)
		return
	}
	a.recorded = true
}

// Put adds an API whose spec is given, for tests.
func (s *Store) Put(a *API, spec []byte) {
	if a.Validator == nil {
		a.Validator, a.queryKeys, a.Problem = build(spec)
		a.Endpoints = endpoints(spec)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.apis == nil {
		s.apis = map[string]*API{}
	}
	s.apis[a.Key()] = a
}

func build(spec []byte) (validator.Validator, map[string]queryKeys, string) {
	doc, err := libopenapi.NewDocument(spec)
	if err != nil {
		return nil, nil, "its OpenAPI document can't be read: " + err.Error()
	}
	// Strict: what the document doesn't describe isn't forwarded. A body
	// on an operation that declares none, or of a media type with a schema
	// the validator can't decode (it reads JSON, YAML, XML, forms,
	// multipart, text, CSV and binary), is refused, and so is an undeclared
	// query parameter. Headers and cookies aren't held to it (clients and proxies
	// add their own), nor a body's properties beyond what its schema allows.
	// (No dot before the stars: names with one are written in brackets.)
	v, errs := validator.NewValidator(doc,
		config.WithStandardBodyDecoders(),
		config.WithRejectUndeclaredRequestBody(),
		config.WithRejectUnsupportedBodyContent(),
		config.WithStrictMode(),
		config.WithStrictIgnorePaths("$.headers**", "$.cookies**", "$.body**"))
	if len(errs) > 0 {
		return nil, nil, fmt.Sprintf("its OpenAPI document can't be used: %v", errs[0])
	}
	model, err := doc.BuildV3Model()
	if err != nil {
		return nil, nil, "its OpenAPI document can't be used: " + err.Error()
	}
	keys := map[string]queryKeys{}
	if model.Model.Paths != nil {
		for path, item := range model.Model.Paths.PathItems.FromOldest() {
			for method, op := range item.GetOperations().FromOldest() {
				var k queryKeys
				for _, p := range slices.Concat(item.Parameters, op.Parameters) {
					if p.In != "query" {
						continue
					}
					switch {
					case p.Style == "deepObject":
						k.prefixes = append(k.prefixes, p.Name+"[")
					case (p.Style == "" || p.Style == "form") && (p.Explode == nil || *p.Explode) && p.Schema != nil:
						if s := p.Schema.Schema(); s != nil && slices.Contains(s.Type, "object") && s.Properties != nil {
							for name := range s.Properties.KeysFromOldest() {
								if k.properties == nil {
									k.properties = map[string]bool{}
								}
								k.properties[name] = true
							}
						}
					}
				}
				if k.prefixes != nil || k.properties != nil {
					keys[strings.ToUpper(method)+" "+path] = k
				}
			}
		}
	}
	return v, keys, ""
}

// Run refreshes every interval until ctx ends; a failed refresh keeps
// what it had, and is logged.
func (s *Store) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.Refresh(ctx); err != nil {
				s.Log.Error("couldn't read the published APIs", "error", err)
			}
		}
	}
}

// BackendNamespace is the namespace an in-cluster backend host names
// (<service>.<namespace>.svc, with or without .cluster.local), or "" for any
// other host. The gateway may reach every team's API backends, so an API
// may only use one in its own team's API backends' namespace (BackendPlace;
// the console's core/apis.ts backendNamespace, kept in step).
func BackendNamespace(u *url.URL) string {
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	host = strings.TrimSuffix(host, ".cluster.local")
	rest, ok := strings.CutSuffix(host, ".svc")
	if !ok {
		return ""
	}
	labels := strings.Split(rest, ".")
	if len(labels) < 2 {
		return ""
	}
	return labels[len(labels)-1]
}

// APINamespace is the namespace a team's API backends run in, apart from
// its steps and their Secrets (the console's k8s.ts apiNamespace, which
// makes it).
func APINamespace(team string) string { return team + "-apis" }

// Where an API's backend runs, for its team (BackendPlace).
const (
	// BackendOutside: not in the cluster (any host BackendAllowed allows).
	BackendOutside = "outside"
	// BackendInAPIs: in the team's API backends' namespace.
	BackendInAPIs = "apis"
	// BackendInTeam: in the team's own namespace, where its steps run.
	// Served for one release, until backends have moved, and logged.
	BackendInTeam = "team"
	// BackendElsewhere: in any other namespace: held.
	BackendElsewhere = "other"
)

// BackendPlace says where an API's backend runs for the team it is.
// APINamespace(team) is the team's only when no team has that name
// (apiNamespaceTaken). The console's core/apis.ts backendPlace, kept in
// step.
func BackendPlace(u *url.URL, team string, apiNamespaceTaken bool) string {
	switch ns := BackendNamespace(u); {
	case ns == "":
		return BackendOutside
	case ns == APINamespace(team) && !apiNamespaceTaken:
		return BackendInAPIs
	case ns == team:
		return BackendInTeam
	default:
		return BackendElsewhere
	}
}

// BackendAllowed: the URL's host is one of hosts, exactly or below a "*."
// pattern (the console's rule, console/src/core/apis.ts).
func BackendAllowed(u *url.URL, hosts []string) bool {
	host := strings.ToLower(u.Hostname())
	for _, pattern := range hosts {
		p := strings.ToLower(pattern)
		if suffix, ok := strings.CutPrefix(p, "*"); ok && strings.HasPrefix(suffix, ".") {
			if strings.HasSuffix(host, suffix) && len(host) > len(suffix) {
				return true
			}
		} else if host == p {
			return true
		}
	}
	return false
}
