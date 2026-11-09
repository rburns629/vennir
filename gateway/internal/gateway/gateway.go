// SPDX-License-Identifier: MIT

// Package gateway is the request path (decision 20, docs/assessment.md):
// a caller's request to /<team>/<api>/<path> is forwarded to that API's
// backend exactly as sent (method, path, query, headers, body), with the
// caller's credential swapped for the backend's and the caller named in a
// signed Vennir-Caller header, and the answer streamed back unchanged; but
// only if the API's OpenAPI document describes it. In order:
//
//  0. the client's address (clientAddress) hasn't failed to sign in more
//     than UnauthenticatedPerMinute times in the last minute; else 429,
//     before any database work
//  1. the API exists, and here (an internet-reachable one, on the public
//     listener); else 404
//  2. the caller signs in, as the console's callers do; else 401, or 404
//     for a hidden or paused API: before sign-in it's as one that isn't
//     there, and nothing of its state is told
//  3. the caller may see it: it isn't hidden, or it's their team's, or
//     they're an admin, or they may call it; else 404, as the console's sees()
//  4. it isn't closed, paused or held, and its spec could be read; else 503
//  5. the caller may call it (accessFor: their own team's, a grant to them
//     or to a group of theirs, or shared with one of their teams); else 403
//     NOT_GRANTED, or 401 for an older single sign-on session whose only way
//     in is a group's grant while groups come from a claim (it signs in
//     again, and its groups are read)
//  6. its body is within the API's size, and arrives within
//     BodyReadTimeout; else 413, or 408
//  7. its method and path are an operation in the spec; else 404, blocked:
//     never forwarded
//  8. its parameters, headers and body fit that operation's schemas, with
//     no query parameter or body it doesn't declare, and a body only with a
//     Content-Type; else 400
//  9. the caller is within their rate: their calling team's, or their
//     grant's (a group's, each member's); else 429 with Retry-After
//  10. forwarded, with the backend's credential minted for it, and
//     X-Forwarded-For the gateway's own peer, or on the public listener
//     behind a trusted proxy the address it saw (never what the caller said);
//     a cookie the backend sets is kept to the API's own path
//
// Every answer says who gave it: Vennir-Answered-By: gateway or backend;
// a backend's own Vennir-* headers aren't passed on. A request's traffic is
// counted against its API's endpoint only once it matched one of the spec's
// operations or the caller signed in: before that, against no endpoint.
// Logs and metrics name the API, team, caller and outcome; never a body, a
// header's value or a credential.
package gateway

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	verrors "github.com/pb33f/libopenapi-validator/errors"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/roburns/vennir/gateway/internal/auth"
	"github.com/roburns/vennir/gateway/internal/caller"
	"github.com/roburns/vennir/gateway/internal/limits"
	"github.com/roburns/vennir/gateway/internal/store"
)

// AnsweredBy says who answered: gateway or backend.
const AnsweredBy = "Vennir-Answered-By"

// TeamHeader names the team a caller calls as: only the API's own team
// counts. It never gives access a grant doesn't.
const TeamHeader = "Vennir-Team"

// RequestIDHeader is the gateway's id for a request, on both sides.
const RequestIDHeader = "Vennir-Request-Id"

// Gateway serves the published APIs.
type Gateway struct {
	Store   *store.Store
	Callers interface {
		Resolve(context.Context, string) (*auth.Caller, error)
	}
	Signer  *caller.Signer
	Limiter *limits.Limiter
	// Peers counts each client address's failed sign-ins
	// (Settings.UnauthenticatedPerMinute).
	Peers  *limits.Limiter
	Minter interface {
		Authorize(ctx context.Context, out *http.Request, body []byte, team, serviceAccount string, auth map[string]map[string]string) error
	}
	Settings Settings
	Log      *slog.Logger
	Metrics  *Metrics
	// Traffic counts what each API's requests came to (its page shows it),
	// and when each grant was last called through: a traffic.Recorder.
	Traffic interface {
		Record(apiID, team, endpoint, outcome string, at time.Time, took time.Duration)
		Used(grantID string, at time.Time)
	}
	// Public: this listener is the internet's, which serves only APIs that
	// are reachable from the internet and allowed to be.
	Public bool
	Now    func() time.Time

	transportsMu sync.Mutex
	transports   map[time.Duration]*http.Transport
}

// Settings are the install's (the chart's gateway values).
type Settings struct {
	BackendHosts  []string
	InternetTeams []string
	// ClusterDomain is the cluster's DNS domain: which backend hosts are
	// in the cluster, and in which namespace (store.BackendPlace).
	ClusterDomain string
	// TrustedProxies: the peers whose X-Forwarded-For names the caller
	// (clientAddress), on the public listener only.
	TrustedProxies []netip.Prefix
	// DefaultPerMinute applies to a team an API's limits don't name and
	// that has no default of its own.
	DefaultPerMinute int
	// Closed: every API answers 503, and nothing is forwarded.
	Closed bool
	// UnauthenticatedPerMinute: requests a minute one client address may
	// make that don't sign in, after which its requests are refused before
	// sign-in (and any database work) until it's under again. 0: no limit.
	UnauthenticatedPerMinute int
	// PublicPeersShared: the public listener's peer, with no TrustedProxies,
	// is a proxy every caller shares; no address is limited there.
	PublicPeersShared bool
	// BodyReadTimeout: the longest a request's body may take to arrive. 0:
	// no deadline.
	BodyReadTimeout time.Duration
}

// Metrics count what the gateway did.
type Metrics struct {
	Requests *prometheus.CounterVec
	Duration *prometheus.HistogramVec
}

// NewMetrics registers the gateway's metrics.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		Requests: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "vennir_gateway_requests_total",
			Help: "Requests, by API and outcome (forwarded, blocked, invalid, unauthenticated, forbidden, limited, peer_limited, paused, held, unavailable, backend_error)."},
			[]string{"api", "outcome"}),
		Duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "vennir_gateway_request_duration_seconds",
			Help: "How long requests took, by API and who answered.", Buckets: prometheus.DefBuckets}, []string{"api", "answered_by"}),
	}
	reg.MustRegister(m.Requests, m.Duration)
	return m
}

// hopByHop are headers for one connection, never forwarded.
// methodOverrides let a backend's framework run another method or path than
// the one the OpenAPI document was checked for: never forwarded.
var methodOverrides = []string{"X-Http-Method-Override", "X-Http-Method", "X-Method-Override", "X-Original-Url", "X-Rewrite-Url"}

var hopByHop = []string{"Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade"}

// outcome is how a request ended, for logs and metrics.
type outcome struct {
	name, team, subject string
	status              int
	// apiID and endpoint, once the API is known: for traffic.
	apiID, endpoint string
	// grantID: the grant that let the caller in, if one did (its last call).
	grantID string
	// served: the path named an API served here.
	served bool
}

func (o outcome) as(name string) outcome {
	o.name = name
	return o
}

func (g *Gateway) now() time.Time {
	if g.Now != nil {
		return g.Now()
	}
	return time.Now()
}

// ServeHTTP is the request path.
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := g.now()
	requestID := newID()
	w.Header().Set(RequestIDHeader, requestID)
	switch r.URL.Path {
	case "/.vennir/health":
		g.answer(w, http.StatusOK, "OK", "The gateway is up.")
		return
	case "/.vennir/jwks.json":
		keys, err := g.Signer.JWKS()
		if err != nil {
			g.answer(w, http.StatusInternalServerError, "INTERNAL", "")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set(AnsweredBy, "gateway")
		_, _ = w.Write(keys)
		return
	}
	team, name, rest, ok := split(r.URL.EscapedPath())
	var result outcome
	if ok {
		result = g.serve(w, r, team, name, rest, requestID)
	} else {
		result = g.refuse(w, outcome{name: "not_found"}, http.StatusNotFound, "NOT_FOUND", "No such API here: call /<team>/<api>/<path>, with no encoded slash or dot segment.")
	}
	// An API's own label only once it's one served here: any caller can
	// make up paths, and each label would be series kept forever.
	key := "-"
	if result.served {
		key = team + "/" + name
	}
	if g.Metrics != nil {
		answeredBy := "gateway"
		if result.name == "forwarded" {
			answeredBy = "backend"
		}
		g.Metrics.Requests.WithLabelValues(key, result.name).Inc()
		g.Metrics.Duration.WithLabelValues(key, answeredBy).Observe(g.now().Sub(start).Seconds())
	}
	if g.Traffic != nil && result.apiID != "" {
		outcomeName := result.name
		if outcomeName == "forwarded" {
			outcomeName = fmt.Sprintf("forwarded_%dxx", result.status/100)
		}
		g.Traffic.Record(result.apiID, result.team, result.endpoint, outcomeName, start, g.now().Sub(start))
		if result.grantID != "" {
			g.Traffic.Used(result.grantID, start)
		}
	}
	asked := "-"
	if ok {
		asked = team + "/" + name
	}
	g.Log.Info("request", "request_id", requestID, "api", asked, "team", result.team, "caller", result.subject,
		"method", r.Method, "outcome", result.name, "status", result.status, "duration_ms", g.now().Sub(start).Milliseconds())
}

func (g *Gateway) serve(w http.ResponseWriter, r *http.Request, team, name, rest, requestID string) outcome {
	// Only the public listener is behind a proxy: on the in-cluster one,
	// the peer is the caller (a Pod's X-Forwarded-For says nothing).
	var trusted []netip.Prefix
	if g.Public {
		trusted = g.Settings.TrustedProxies
	}
	client := clientAddress(r.Header, r.RemoteAddr, trusted)
	// First, whatever the API: a limited address hears nothing of which
	// APIs there are, and costs no database work.
	peer := peerKey(client)
	// Only where the address is the caller's: not on the public listener
	// behind a proxy every caller shares that isn't trusted to say who they
	// are (PublicPeersShared), where one caller's failures would shut out
	// the rest.
	limitPeers := g.Peers != nil && g.Settings.UnauthenticatedPerMinute > 0 &&
		!(g.Public && len(trusted) == 0 && g.Settings.PublicPeersShared)
	if limitPeers {
		if spent, wait := g.Peers.Spent(peer, g.Settings.UnauthenticatedPerMinute, g.now()); spent {
			w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds()+0.999)))
			return g.refuse(w, outcome{name: "peer_limited"}, http.StatusTooManyRequests, "RATE_LIMITED",
				"Too many requests from your address failed to sign in: nothing more is taken from it until Retry-After.")
		}
	}
	api := g.Store.Get(team, name)
	if api == nil || (g.Public && !(api.Internet && slices.Contains(g.Settings.InternetTeams, api.Team))) {
		return g.refuse(w, outcome{name: "not_found"}, http.StatusNotFound, "NOT_FOUND", "No such API here.")
	}
	// Before sign-in, an endpoint only if it's one of the spec's: anyone
	// could make up paths, each a row of traffic.
	o := outcome{apiID: api.ID, endpoint: api.Match(r.Method, rest), served: true}
	who, err := g.Callers.Resolve(r.Context(), r.Header.Get("Authorization"))
	if err != nil && errors.Is(err, auth.ErrUnauthenticated) && limitPeers {
		g.Peers.Allow(peer, g.Settings.UnauthenticatedPerMinute, g.now())
	}
	if err != nil {
		// Before sign-in, a hidden or paused API is as one that isn't
		// there: its state and pause message are for callers who see it.
		if api.Hidden || api.PausedMessage != nil {
			refused := "unauthenticated"
			if !errors.Is(err, auth.ErrUnauthenticated) && !errors.Is(err, auth.ErrOrdersOnly) {
				g.Log.Error("couldn't sign a caller in", "error", err)
				refused = "unavailable"
			}
			return g.refuse(w, o.as(refused), http.StatusNotFound, "NOT_FOUND", "No such API here.")
		}
		switch {
		case errors.Is(err, auth.ErrUnauthenticated):
			w.Header().Set("WWW-Authenticate", `Bearer realm="vennir"`)
			return g.refuse(w, o.as("unauthenticated"), http.StatusUnauthorized, "UNAUTHENTICATED", "Sign in: Authorization: Bearer <a session or bot token>.")
		case errors.Is(err, auth.ErrOrdersOnly):
			return g.refuse(w, o.as("forbidden"), http.StatusForbidden, "ORDERS_ONLY", "This bot places orders in the console: it calls no API.")
		}
		g.Log.Error("couldn't sign a caller in", "error", err)
		return g.refuse(w, o.as("unavailable"), http.StatusServiceUnavailable, "UNAVAILABLE", "The gateway can't check who you are right now.")
	}
	o.subject = "user:" + who.UserID
	if o.endpoint == "" {
		o.endpoint = r.Method + " " + rest
	}
	way, staleGroup := g.accessFor(who, api, r.Header.Get(TeamHeader))
	if way == nil && staleGroup && who.SSOSession {
		// As for a team a group gave: an older single sign-on session signs
		// in again, so its groups are read, rather than counting stale ones.
		// Before the hidden check: a group's grant lets them hear of it.
		w.Header().Set("WWW-Authenticate", `Bearer realm="vennir"`)
		return g.refuse(w, o.as("unauthenticated"), http.StatusUnauthorized, "UNAUTHENTICATED",
			"Your access to this API is through a single sign-on group, and your groups were read over an hour ago: sign in again.")
	}
	if api.Hidden && !who.IsAdmin && !slices.Contains(who.Teams, api.Team) && (way == nil || way.grant == nil) {
		// As the console's sees(): a hidden API is its own team's (and
		// admins', and whoever a grant lets in), whatever it's shared with,
		// and no one else hears of it.
		return g.refuse(w, o.as("not_found"), http.StatusNotFound, "NOT_FOUND", "No such API here.")
	}

	closed := g.Store.Closed()
	switch {
	case g.Settings.Closed || closed != "":
		message := "The gateway is closed: nothing is forwarded until it's reopened."
		if closed != "" {
			message = closed
		}
		return g.refuse(w, o.as("closed"), http.StatusServiceUnavailable, "GATEWAY_CLOSED", message)
	case api.PausedMessage != nil:
		return g.refuse(w, o.as("paused"), http.StatusServiceUnavailable, "API_PAUSED", *api.PausedMessage)
	case api.Validator == nil:
		// Before anything reads its backend URL, which may be what can't be read.
		return g.refuse(w, o.as("unavailable"), http.StatusServiceUnavailable, "API_UNAVAILABLE", "This API can't be served as it's set up (its team sees why on its page), so nothing is forwarded.")
	case !store.BackendAllowed(api.BackendURL, g.Settings.BackendHosts):
		return g.refuse(w, o.as("held"), http.StatusServiceUnavailable, "API_HELD", "This API's backend isn't one this install allows yet.")
	case store.BackendPlace(api.BackendURL, api.Team, api.APINamespaceTaken, g.Settings.ClusterDomain) == store.BackendElsewhere:
		return g.refuse(w, o.as("held"), http.StatusServiceUnavailable, "API_HELD", "This API's backend isn't in its team's API backends' namespace: an API may only use its own team's.")
	}

	result := o
	switch {
	case way == nil:
		result.name = "forbidden"
		message := "You may not call this API: ask its team for access on its page in the console (APIs → " + api.Key() + ")."
		if asked := r.Header.Get(TeamHeader); asked != "" {
			message = "You may not call this API as " + asked + " (" + TeamHeader + "): it isn't your team, or not one it's shared with."
		}
		return g.refuse(w, result, http.StatusForbidden, "NOT_GRANTED", message)
	}
	result.team = way.trafficTeam()
	if way.grant != nil {
		result.grantID = way.grant.ID
	}

	// The validator reads the query as Go parses it, which leaves out what it
	// can't read (a pair with a ";", a bad escape, and all of it past 10,000
	// parameters), and the backend gets the query as sent: only one that
	// reads in full is checked and forwarded.
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		result.name = "invalid"
		return g.refuse(w, result, http.StatusBadRequest, "INVALID_REQUEST", "The query can't be read (a \";\", a bad %-escape, or too many parameters): nothing was forwarded.")
	}
	// A ";" in a path is a matrix parameter to some backends' frameworks
	// (or ends the segment, or is dropped with what follows) and part of
	// the segment to the validator: only an API whose spec takes matrix
	// parameters gets one, raw or %3B (rest is unescaped).
	if strings.Contains(rest, ";") && !api.MatrixParameters {
		result.name = "invalid"
		return g.refuse(w, result, http.StatusBadRequest, "INVALID_REQUEST", "A \";\" in the path is taken only by an API whose OpenAPI document has matrix parameters: nothing was forwarded.")
	}
	// The validator reads the first, and a backend may read the last.
	if len(r.Header.Values("Content-Type")) > 1 {
		result.name = "invalid"
		return g.refuse(w, result, http.StatusBadRequest, "INVALID_REQUEST", "A request has one Content-Type: nothing was forwarded.")
	}

	if r.ContentLength > api.MaxRequest {
		result.name = "invalid"
		return g.refuse(w, result, http.StatusRequestEntityTooLarge, "TOO_LARGE", "The body is larger than this API takes: "+strconv.FormatInt(api.MaxRequest, 10)+" bytes.")
	}
	body, err := g.readBody(w, r, api.MaxRequest)
	if err != nil {
		result.name = "invalid"
		var tooLarge *http.MaxBytesError
		var netErr net.Error
		switch {
		case errors.As(err, &tooLarge):
			return g.refuse(w, result, http.StatusRequestEntityTooLarge, "TOO_LARGE", "The body is larger than this API takes: "+strconv.FormatInt(api.MaxRequest, 10)+" bytes.")
		case errors.As(err, &netErr) && netErr.Timeout():
			// The connection's read deadline has passed: it can't be reused.
			w.Header().Set("Connection", "close")
			return g.refuse(w, result, http.StatusRequestTimeout, "REQUEST_TIMEOUT", "The body didn't arrive in time: nothing was forwarded.")
		}
		return g.refuse(w, result, http.StatusBadRequest, "BAD_REQUEST", "The body couldn't be read: nothing was forwarded.")
	}

	// The validator checks a body only by its Content-Type, and would let
	// one without it through unchecked.
	if len(body) > 0 && r.Header.Get("Content-Type") == "" {
		result.name = "invalid"
		return g.refuse(w, result, http.StatusBadRequest, "INVALID_REQUEST", "A body needs a Content-Type: nothing was forwarded.")
	}
	// Frameworks read a _method field as the method to run instead.
	if query.Has("_method") || formHas(r.Header.Get("Content-Type"), body, "_method") {
		result.name = "invalid"
		return g.refuse(w, result, http.StatusBadRequest, "INVALID_REQUEST", "A _method field asks the backend for another method than the request's: nothing was forwarded.")
	}

	target := *api.BackendURL
	target.Path = strings.TrimSuffix(api.BackendURL.Path, "/") + rest
	target.RawPath = ""
	target.RawQuery = r.URL.RawQuery
	// The request as the backend would get it, checked against the spec.
	check, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), bytes.NewReader(body))
	if err != nil {
		result.name = "invalid"
		return g.refuse(w, result, http.StatusBadRequest, "BAD_REQUEST", "The request can't be read.")
	}
	// Its headers as the backend gets them: none for this hop only.
	check.Header = beyondThisHop(r.Header)
	if valid, problems := api.Validator.ValidateHttpRequest(check); !valid && !onlyStyledKeys(api, o.endpoint, problems) {
		if notInSpec(problems) {
			result.name = "blocked"
			return g.refuse(w, result, http.StatusNotFound, "NOT_IN_SPEC", "This API's OpenAPI document has no "+r.Method+" "+rest+": nothing was forwarded.")
		}
		result.name = "invalid"
		return g.refuseWith(w, result, http.StatusBadRequest, "INVALID_REQUEST", "The request doesn't fit this API's OpenAPI document; nothing was forwarded.", describe(problems))
	}

	perMinute := g.rate(api, way)
	if allowed, wait := g.Limiter.Allow(api.Key()+"|"+way.bucket(who), perMinute, g.now()); !allowed {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds()+0.999)))
		result.name = "limited"
		whose := "Your team has"
		if way.grant != nil {
			whose = "You have"
		}
		return g.refuse(w, result, http.StatusTooManyRequests, "RATE_LIMITED", whose+" used this API's "+strconv.Itoa(perMinute)+" requests a minute.")
	}

	signed, err := g.Signer.Sign(caller.Claims{Subject: "user:" + who.UserID, Email: who.Email, Bot: who.IsBot, Team: way.team,
		Via: way.via, Group: way.group(), API: api.Key(), Audience: api.BackendURL.Scheme + "://" + api.BackendURL.Host, RequestID: requestID}, g.now())
	if err != nil {
		result.name = "backend_error"
		return g.refuse(w, result, http.StatusInternalServerError, "INTERNAL", "")
	}

	out, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), bytes.NewReader(body))
	if err != nil {
		result.name = "invalid"
		return g.refuse(w, result, http.StatusBadRequest, "BAD_REQUEST", "The request can't be read.")
	}
	out.Header = forwardHeaders(r.Header, client, api.BackendAuth["awsSigV4"] != nil)
	out.Header.Set(caller.Header, signed)
	out.Header.Set(RequestIDHeader, requestID)
	out.ContentLength = int64(len(body))
	// Last: SigV4 signs the request as it will go.
	if err := g.Minter.Authorize(r.Context(), out, body, api.Team, api.ServiceAccount, api.BackendAuth); err != nil {
		g.Log.Error("couldn't sign in to a backend", "api", api.Key(), "error", err)
		result.name = "backend_error"
		return g.refuse(w, result, http.StatusBadGateway, "BACKEND_CREDENTIAL", "The gateway couldn't get this API's backend credential.")
	}

	res, err := g.transport(api.Timeout).RoundTrip(out)
	if err != nil {
		result.name = "backend_error"
		var netErr net.Error
		if errors.As(err, &netErr) && netErr.Timeout() {
			return g.refuse(w, result, http.StatusGatewayTimeout, "BACKEND_TIMEOUT", "The backend didn't answer in time.")
		}
		return g.refuse(w, result, http.StatusBadGateway, "BACKEND_UNREACHABLE", "The backend couldn't be reached.")
	}
	defer res.Body.Close()
	for k, values := range res.Header {
		k = http.CanonicalHeaderKey(k)
		// Vennir-* are the gateway's (its request id, who answered): a
		// backend's own never sit beside them.
		if slices.Contains(hopByHop, k) || strings.HasPrefix(strings.ToLower(k), "vennir-") {
			continue
		}
		for _, v := range values {
			if k == "Set-Cookie" {
				if v = scopeCookie(v, "/"+api.Team+"/"+api.Name, api.BackendURL.Path); v == "" {
					continue
				}
			}
			w.Header().Add(k, v)
		}
	}
	w.Header().Set(AnsweredBy, "backend")
	w.WriteHeader(res.StatusCode)
	flushCopy(w, res.Body)
	result.name, result.status = "forwarded", res.StatusCode
	return result
}

// readBody reads a request's body, at most limit bytes, within the
// gateway's BodyReadTimeout: a body sent slowly holds no connection open.
// The deadline is lifted once it's read, so the answer may stream for as
// long as the backend sends.
func (g *Gateway) readBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, error) {
	rc := http.NewResponseController(w)
	if g.Settings.BodyReadTimeout > 0 {
		// Not every ResponseWriter has a connection (a test's recorder).
		if err := rc.SetReadDeadline(time.Now().Add(g.Settings.BodyReadTimeout)); err == nil {
			defer func() { _ = rc.SetReadDeadline(time.Time{}) }()
		}
	}
	return io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
}

// peerKey is the key a client address's failed sign-ins are counted under:
// the address, or an IPv6 one's /64 (one host may hold all of it).
func peerKey(client string) string {
	a, err := netip.ParseAddr(client)
	if err != nil {
		return client
	}
	// An IPv4 address written as IPv6 (::ffff:a.b.c.d) is its IPv4 one.
	if a = a.Unmap(); a.Is4() {
		return a.String()
	}
	return netip.PrefixFrom(a, 64).Masked().String()
}

// access is how a caller may call an API (accessFor), as Vennir-Caller's
// via says it: "team" (its own team's), "user" (a grant names them),
// "group" (a grant names a group of theirs).
type access struct {
	via string
	// team: the calling team, for "team".
	team string
	// grant: the grant, for "user" and "group".
	grant *store.Grant
}

func (a *access) group() string {
	if a.grant == nil {
		return ""
	}
	return a.grant.Group
}

// trafficTeam is what the API's traffic counts it under: the calling team,
// or for a grant "grant:user" (a user's) or "grant:group:<group>", never a
// person: never a team's name either (a team's has no ":").
func (a *access) trafficTeam() string {
	switch {
	case a.grant == nil:
		return a.team
	case a.grant.Group != "":
		return "grant:group:" + a.grant.Group
	}
	return "grant:user"
}

// bucket is the rate limit's key within the API: a calling team's, a user
// grant's, or a group grant's for each of its members.
func (a *access) bucket(who *auth.Caller) string {
	switch {
	case a.grant == nil:
		return a.team
	case a.grant.Group != "":
		return "grant:" + a.grant.ID + "|" + who.UserID
	}
	return "grant:" + a.grant.ID
}

// rate is a way's requests a minute: a calling team's limit (api.yaml's for
// it, else its default), or a grant's own (else the API's default); the
// gateway's default when neither says.
func (g *Gateway) rate(api *store.API, a *access) int {
	n := 0
	if a.grant != nil {
		n = a.grant.PerMinute
	} else {
		n = api.PerMinute[a.team]
	}
	if n == 0 {
		n = api.PerMinute["default"]
	}
	if n == 0 {
		n = g.Settings.DefaultPerMinute
	}
	return n
}

// accessFor is how the caller may call the API, or nil (decision 26; the
// console's core/apiAccess.ts accessFor, kept in step), in this order:
// their own team's; a grant to them (a bot's, while it's in a team that
// isn't retired); a grant to a single sign-on group of theirs (a person's,
// while their groups count: the best rate of them). Admins are no
// exception. Vennir-Team (asked) calls as the API's own team, if it's
// theirs, else nil; it gives no access by itself. staleGroup: a group
// grant would let them in, but their groups don't count now.
func (g *Gateway) accessFor(who *auth.Caller, api *store.API, asked string) (way *access, staleGroup bool) {
	if asked != "" {
		if asked == api.Team && slices.Contains(who.Teams, asked) {
			return &access{via: "team", team: asked}, false
		}
		return nil, false
	}
	if slices.Contains(who.Teams, api.Team) {
		return &access{via: "team", team: api.Team}, false
	}
	grants := g.Store.Grants(api.ID)
	for i := range grants {
		if grants[i].UserID != "" && grants[i].UserID == who.UserID && (!who.IsBot || len(who.Teams) > 0) {
			return &access{via: "user", grant: &grants[i]}, false
		}
	}
	if !who.IsBot {
		var best *store.Grant
		for i := range grants {
			gr := &grants[i]
			if gr.Group == "" || !slices.Contains(who.Groups, gr.Group) {
				continue
			}
			if best == nil || g.rate(api, &access{grant: gr}) > g.rate(api, &access{grant: best}) ||
				g.rate(api, &access{grant: gr}) == g.rate(api, &access{grant: best}) && gr.Group < best.Group {
				best = gr
			}
		}
		if best != nil {
			if who.GroupsCurrent {
				return &access{via: "group", grant: best}, false
			}
			staleGroup = true
		}
	}
	return nil, staleGroup
}

// notInSpec: the method and path match no operation, as against a request
// that matched one and didn't fit it.
func notInSpec(problems []*verrors.ValidationError) bool {
	for _, p := range problems {
		if p.ValidationType == "path" {
			return true
		}
	}
	return false
}

// forwardHeaders are the caller's headers, less what's only for the
// gateway: hop-by-hop ones, their Authorization (the gateway's sign-in,
// never the backend's), any Vennir-* (which only the gateway sets), and
// what a caller could claim about where it's from (Forwarded,
// X-Forwarded-*, X-Real-Ip): X-Forwarded-For is set to client, the caller's
// address as clientAddress worked it out.
func forwardHeaders(in http.Header, client string, sigV4 bool) http.Header {
	out := beyondThisHop(in)
	for _, h := range methodOverrides {
		out.Del(h)
	}
	out.Del("Authorization")
	out.Del("Forwarded")
	out.Del("X-Real-Ip")
	for k := range out {
		lower := strings.ToLower(k)
		// A SigV4 backend's operation can be chosen by its headers
		// (X-Amz-Target), which would be signed as the API's role: only
		// the signing's own are sent.
		if strings.HasPrefix(lower, "vennir-") || strings.HasPrefix(lower, "x-forwarded-") || (sigV4 && strings.HasPrefix(lower, "x-amz-")) {
			out.Del(k)
		}
	}
	if client != "" {
		out.Set("X-Forwarded-For", client)
	}
	return out
}

// beyondThisHop is in without its hop-by-hop headers, those every Connection
// header names included: what the backend gets, and so what's validated.
func beyondThisHop(in http.Header) http.Header {
	out := in.Clone()
	for _, h := range hopByHop {
		out.Del(h)
	}
	for _, value := range in.Values("Connection") {
		for _, h := range strings.Split(value, ",") {
			if h = strings.TrimSpace(h); h != "" {
				out.Del(h)
			}
		}
	}
	return out
}

// formHas says whether a form body (urlencoded or multipart) has a field.
func formHas(contentType string, body []byte, field string) bool {
	media, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return false
	}
	switch media {
	case "application/x-www-form-urlencoded":
		values, _ := url.ParseQuery(string(body))
		return values.Has(field)
	case "multipart/form-data":
		reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
		for {
			part, err := reader.NextPart()
			if err != nil {
				return false
			}
			if part.FormName() == field {
				return true
			}
		}
	}
	return false
}

// clientAddress is the caller's address: the request's peer, unless the
// peer is one of trusted (an ingress, a load balancer); then the peer's
// X-Forwarded-For is read from its end back, past every trusted address,
// to the first that isn't one: the address the trusted proxies saw. What
// a caller wrote before that is never taken. An entry that isn't an
// address ends the walk at the last one that was.
func clientAddress(header http.Header, remoteAddr string, trusted []netip.Prefix) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return ""
	}
	peer, err := netip.ParseAddr(host)
	if err != nil || !trustedAddress(peer, trusted) {
		return host
	}
	var hops []string
	for _, value := range header.Values("X-Forwarded-For") {
		hops = append(hops, strings.Split(value, ",")...)
	}
	client := peer.Unmap()
	for i := len(hops) - 1; i >= 0; i-- {
		hop, ok := address(strings.TrimSpace(hops[i]))
		if !ok {
			break
		}
		client = hop
		if !trustedAddress(hop, trusted) {
			break
		}
	}
	return client.String()
}

// address reads one X-Forwarded-For entry: an address, with or without a
// port (some proxies add it).
func address(entry string) (netip.Addr, bool) {
	if a, err := netip.ParseAddr(entry); err == nil {
		return a.Unmap(), true
	}
	if ap, err := netip.ParseAddrPort(entry); err == nil {
		return ap.Addr().Unmap(), true
	}
	return netip.Addr{}, false
}

func trustedAddress(a netip.Addr, trusted []netip.Prefix) bool {
	a = a.Unmap()
	for _, p := range trusted {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// scopeCookie is a backend's Set-Cookie kept to its API's own path (every
// API shares the gateway's origin), and to the gateway's host: its Path, as
// the caller sees it (less the backend's own base path, backendPath), under
// base (/<team>/<api>), the API's root when it's outside the backend's
// base; no Domain; its other attributes kept. "" when it can't be read, or
// it's a __Host- cookie (which must be Path=/, so can't be kept to one
// API): it isn't passed on.
func scopeCookie(setCookie, base, backendPath string) string {
	c, err := http.ParseSetCookie(setCookie)
	if err != nil || strings.HasPrefix(c.Name, "__Host-") {
		return ""
	}
	path, prefix := c.Path, strings.TrimSuffix(backendPath, "/")
	switch {
	case !strings.HasPrefix(path, "/"):
		path = "/"
	case prefix == "":
	case path == prefix || strings.HasPrefix(path, prefix+"/"):
		path = "/" + strings.TrimPrefix(strings.TrimPrefix(path, prefix), "/")
	default:
		path = "/"
	}
	c.Path, c.Domain = base+path, ""
	// String drops the attributes it doesn't know (Unparsed): kept as sent.
	out := c.String()
	for _, attr := range c.Unparsed {
		out += "; " + attr
	}
	return out
}

// transport is a client whose wait for the backend's answer to begin is
// timeout (the API's), one per distinct timeout.
func (g *Gateway) transport(timeout time.Duration) *http.Transport {
	g.transportsMu.Lock()
	defer g.transportsMu.Unlock()
	if g.transports == nil {
		g.transports = map[time.Duration]*http.Transport{}
	}
	t, ok := g.transports[timeout]
	if !ok {
		t = http.DefaultTransport.(*http.Transport).Clone()
		t.ResponseHeaderTimeout = timeout
		// A backend's redirect goes back to the caller, never followed here.
		t.Proxy = nil
		// The host as store.BackendPlace read it: never one the Pod's DNS
		// search path finds somewhere else (store.DialHost).
		dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
		domain := g.Settings.ClusterDomain
		t.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(store.DialHost(host, domain), port))
		}
		g.transports[timeout] = t
	}
	return t
}

func flushCopy(w http.ResponseWriter, body io.Reader) {
	flusher, _ := w.(http.Flusher)
	buf := make([]byte, 32<<10)
	for {
		n, err := body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if err != nil {
			return
		}
	}
}

func (g *Gateway) refuse(w http.ResponseWriter, o outcome, status int, code, message string) outcome {
	return g.refuseWith(w, o, status, code, message, nil)
}

func (g *Gateway) refuseWith(w http.ResponseWriter, o outcome, status int, code, message string, problems []string) outcome {
	g.answerWith(w, status, code, message, problems)
	o.status = status
	return o
}

func (g *Gateway) answer(w http.ResponseWriter, status int, code, message string) {
	g.answerWith(w, status, code, message, nil)
}

func (g *Gateway) answerWith(w http.ResponseWriter, status int, code, message string, problems []string) {
	w.Header().Set(AnsweredBy, "gateway")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body := map[string]any{"error": code, "message": message}
	if len(problems) > 0 {
		body["problems"] = problems
	}
	_ = json.NewEncoder(w).Encode(body)
}

// split reads /<team>/<api>/<rest>, rest beginning with /.
func split(escaped string) (team, name, rest string, ok bool) {
	parts := strings.SplitN(strings.TrimPrefix(escaped, "/"), "/", 3)
	if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
		return "", "", "", false
	}
	team, err1 := url.PathUnescape(parts[0])
	name, err2 := url.PathUnescape(parts[1])
	if err1 != nil || err2 != nil {
		return "", "", "", false
	}
	rest = "/"
	if len(parts) == 3 {
		// An encoded slash would change which segments the backend sees
		// from those checked; a dot segment, which path it resolves to.
		if strings.Contains(strings.ToLower(parts[2]), "%2f") {
			return "", "", "", false
		}
		if rest, err1 = url.PathUnescape("/" + parts[2]); err1 != nil {
			return "", "", "", false
		}
		// A backslash, and a dot segment with a ;parameter (..;), are
		// slashes and dot segments to some backends' frameworks.
		if strings.Contains(rest, "\\") {
			return "", "", "", false
		}
		for _, segment := range strings.Split(rest, "/") {
			if segment == "." || segment == ".." || strings.HasPrefix(segment, ".;") || strings.HasPrefix(segment, "..;") {
				return "", "", "", false
			}
		}
	}
	return team, name, rest, true
}

func newID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// onlyStyledKeys: every problem is a query key strict mode didn't know is
// one of a declared parameter's (a deepObject's filter[x], an exploded
// object's properties), so the request does fit.
func onlyStyledKeys(api *store.API, endpoint string, problems []*verrors.ValidationError) bool {
	for _, p := range problems {
		if p.ValidationType != verrors.StrictValidationType || p.ValidationSubType != verrors.StrictSubTypeQuery || !api.TakesQueryKey(endpoint, p.ParameterName) {
			return false
		}
	}
	return true
}
