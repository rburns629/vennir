// SPDX-License-Identifier: MIT

// Package gateway is the request path (decision 20, docs/assessment.md):
// a caller's request to /<team>/<api>/<path> is forwarded to that API's
// backend exactly as sent (method, path, query, headers, body), with the
// caller's credential swapped for the backend's and the caller named in a
// signed Vertra-Caller header, and the answer streamed back unchanged; but
// only if the API's OpenAPI document describes it. In order:
//
//  1. the API exists, and here (an internet-reachable one, on the public
//     listener); else 404
//  2. the caller signs in, as the console's callers do; else 401, or 404
//     for a hidden or paused API: before sign-in it's as one that isn't
//     there, and nothing of its state is told
//  3. the caller may see it: it isn't hidden, or it's their team's, or
//     they're an admin; else 404, as the console's sees()
//  4. it isn't closed, paused or held, and its spec could be read; else 503
//  5. it's shared with one of the caller's teams; else 403
//  6. its body is within the API's size; else 413
//  7. its method and path are an operation in the spec; else 404, blocked:
//     never forwarded
//  8. its parameters, headers and body fit that operation's schemas, with
//     no query parameter or body it doesn't declare, and a body only with a
//     Content-Type; else 400
//  9. the calling team is within the API's rate; else 429 with Retry-After
//  10. forwarded, with the backend's credential minted for it, and
//     X-Forwarded-For the gateway's own peer, or on the public listener
//     behind a trusted proxy the address it saw (never what the caller said);
//     a cookie the backend sets is kept to the API's own path
//
// Every answer says who gave it: Vertra-Answered-By: gateway or backend.
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

	"github.com/rburns629/vertra/gateway/internal/auth"
	"github.com/rburns629/vertra/gateway/internal/caller"
	"github.com/rburns629/vertra/gateway/internal/limits"
	"github.com/rburns629/vertra/gateway/internal/store"
	"github.com/rburns629/vertra/gateway/internal/traffic"
)

// AnsweredBy says who answered: gateway or backend.
const AnsweredBy = "Vertra-Answered-By"

// TeamHeader picks the team a caller in several calls as.
const TeamHeader = "Vertra-Team"

// RequestIDHeader is the gateway's id for a request, on both sides.
const RequestIDHeader = "Vertra-Request-Id"

// Gateway serves the published APIs.
type Gateway struct {
	Store   *store.Store
	Callers interface {
		Resolve(context.Context, string) (*auth.Caller, error)
	}
	Signer  *caller.Signer
	Limiter *limits.Limiter
	Minter  interface {
		Authorize(ctx context.Context, out *http.Request, body []byte, team, serviceAccount string, auth map[string]map[string]string) error
	}
	Settings Settings
	Log      *slog.Logger
	Metrics  *Metrics
	// Traffic counts what each API's requests came to (its page shows it).
	Traffic *traffic.Recorder
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
	// TrustedProxies: the peers whose X-Forwarded-For names the caller
	// (clientAddress), on the public listener only.
	TrustedProxies []netip.Prefix
	// DefaultPerMinute applies to a team an API's limits don't name and
	// that has no default of its own.
	DefaultPerMinute int
	// Closed: every API answers 503, and nothing is forwarded.
	Closed bool
}

// Metrics count what the gateway did.
type Metrics struct {
	Requests *prometheus.CounterVec
	Duration *prometheus.HistogramVec
}

// NewMetrics registers the gateway's metrics.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		Requests: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "vertra_gateway_requests_total",
			Help: "Requests, by API and outcome (forwarded, blocked, invalid, unauthenticated, forbidden, limited, paused, held, unavailable, backend_error)."},
			[]string{"api", "outcome"}),
		Duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "vertra_gateway_request_duration_seconds",
			Help: "How long requests took, by API and who answered.", Buckets: prometheus.DefBuckets}, []string{"api", "answered_by"}),
	}
	reg.MustRegister(m.Requests, m.Duration)
	return m
}

// hopByHop are headers for one connection, never forwarded.
var hopByHop = []string{"Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade"}

// outcome is how a request ended, for logs and metrics.
type outcome struct {
	name, team, subject string
	status              int
	// apiID and endpoint, once the API is known: for traffic.
	apiID, endpoint string
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
	case "/.vertra/health":
		g.answer(w, http.StatusOK, "OK", "The gateway is up.")
		return
	case "/.vertra/jwks.json":
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
	}
	asked := "-"
	if ok {
		asked = team + "/" + name
	}
	g.Log.Info("request", "request_id", requestID, "api", asked, "team", result.team, "caller", result.subject,
		"method", r.Method, "outcome", result.name, "status", result.status, "duration_ms", g.now().Sub(start).Milliseconds())
}

func (g *Gateway) serve(w http.ResponseWriter, r *http.Request, team, name, rest, requestID string) outcome {
	api := g.Store.Get(team, name)
	if api == nil || (g.Public && !(api.Internet && slices.Contains(g.Settings.InternetTeams, api.Team))) {
		return g.refuse(w, outcome{name: "not_found"}, http.StatusNotFound, "NOT_FOUND", "No such API here.")
	}
	o := outcome{apiID: api.ID, endpoint: api.Match(r.Method, rest), served: true}
	if o.endpoint == "" {
		o.endpoint = r.Method + " " + rest
	}
	who, err := g.Callers.Resolve(r.Context(), r.Header.Get("Authorization"))
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
			w.Header().Set("WWW-Authenticate", `Bearer realm="vertra"`)
			return g.refuse(w, o.as("unauthenticated"), http.StatusUnauthorized, "UNAUTHENTICATED", "Sign in: Authorization: Bearer <a session or bot token>.")
		case errors.Is(err, auth.ErrOrdersOnly):
			return g.refuse(w, o.as("forbidden"), http.StatusForbidden, "ORDERS_ONLY", "This bot places orders in the console: it calls no API.")
		}
		g.Log.Error("couldn't sign a caller in", "error", err)
		return g.refuse(w, o.as("unavailable"), http.StatusServiceUnavailable, "UNAVAILABLE", "The gateway can't check who you are right now.")
	}
	o.subject = "user:" + who.UserID
	if api.Hidden && !who.IsAdmin && !slices.Contains(who.Teams, api.Team) {
		// As the console's sees(): a hidden API is its own team's (and
		// admins'), whatever it's shared with, and no one else hears of it.
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
	case !store.BackendAllowed(api.BackendURL, g.Settings.BackendHosts):
		return g.refuse(w, o.as("held"), http.StatusServiceUnavailable, "API_HELD", "This API's backend isn't one this install allows yet.")
	case store.BackendNamespace(api.BackendURL) != "" && store.BackendNamespace(api.BackendURL) != api.Team:
		return g.refuse(w, o.as("held"), http.StatusServiceUnavailable, "API_HELD", "This API's backend is another team's: an API may only use its own team's.")
	case api.Validator == nil:
		return g.refuse(w, o.as("unavailable"), http.StatusServiceUnavailable, "API_UNAVAILABLE", "This API's OpenAPI document can't be used, so nothing is forwarded.")
	}

	result := o
	callingTeam, ok := g.callingTeam(who, api, r.Header.Get(TeamHeader))
	if !ok {
		result.name = "forbidden"
		return g.refuse(w, result, http.StatusForbidden, "NOT_SHARED", "This API isn't shared with your team (or not with the team in "+TeamHeader+").")
	}
	result.team = callingTeam

	if r.ContentLength > api.MaxRequest {
		result.name = "invalid"
		return g.refuse(w, result, http.StatusRequestEntityTooLarge, "TOO_LARGE", "The body is larger than this API takes: "+strconv.FormatInt(api.MaxRequest, 10)+" bytes.")
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, api.MaxRequest))
	if err != nil {
		result.name = "invalid"
		return g.refuse(w, result, http.StatusRequestEntityTooLarge, "TOO_LARGE", "The body is larger than this API takes: "+strconv.FormatInt(api.MaxRequest, 10)+" bytes.")
	}

	// The validator checks a body only by its Content-Type, and would let
	// one without it through unchecked.
	if len(body) > 0 && r.Header.Get("Content-Type") == "" {
		result.name = "invalid"
		return g.refuse(w, result, http.StatusBadRequest, "INVALID_REQUEST", "A body needs a Content-Type: nothing was forwarded.")
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
	check.Header = r.Header.Clone()
	if valid, problems := api.Validator.ValidateHttpRequest(check); !valid && !onlyStyledKeys(api, o.endpoint, problems) {
		if notInSpec(problems) {
			result.name = "blocked"
			return g.refuse(w, result, http.StatusNotFound, "NOT_IN_SPEC", "This API's OpenAPI document has no "+r.Method+" "+rest+": nothing was forwarded.")
		}
		result.name = "invalid"
		return g.refuseWith(w, result, http.StatusBadRequest, "INVALID_REQUEST", "The request doesn't fit this API's OpenAPI document; nothing was forwarded.", describe(problems))
	}

	perMinute := api.PerMinute[callingTeam]
	if perMinute == 0 {
		perMinute = api.PerMinute["default"]
	}
	if perMinute == 0 {
		perMinute = g.Settings.DefaultPerMinute
	}
	if allowed, wait := g.Limiter.Allow(api.Key()+"|"+callingTeam, perMinute, g.now()); !allowed {
		w.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds()+0.999)))
		result.name = "limited"
		return g.refuse(w, result, http.StatusTooManyRequests, "RATE_LIMITED", "Your team has used this API's "+strconv.Itoa(perMinute)+" requests a minute.")
	}

	signed, err := g.Signer.Sign(caller.Claims{Subject: "user:" + who.UserID, Email: who.Email, Bot: who.IsBot, Team: callingTeam,
		API: api.Key(), Audience: api.BackendURL.Scheme + "://" + api.BackendURL.Host, RequestID: requestID}, g.now())
	if err != nil {
		result.name = "backend_error"
		return g.refuse(w, result, http.StatusInternalServerError, "INTERNAL", "")
	}

	out, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), bytes.NewReader(body))
	if err != nil {
		result.name = "invalid"
		return g.refuse(w, result, http.StatusBadRequest, "BAD_REQUEST", "The request can't be read.")
	}
	// Only the public listener is behind a proxy: on the in-cluster one,
	// the peer is the caller (a Pod's X-Forwarded-For says nothing).
	var trusted []netip.Prefix
	if g.Public {
		trusted = g.Settings.TrustedProxies
	}
	out.Header = forwardHeaders(r.Header, clientAddress(r.Header, r.RemoteAddr, trusted))
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
		if slices.Contains(hopByHop, k) {
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

// callingTeam is the team the caller calls as: the one in Vertra-Team if
// they're in it and it may call; else their own team that owns the API;
// else the first of theirs it's shared with.
func (g *Gateway) callingTeam(who *auth.Caller, api *store.API, asked string) (string, bool) {
	may := func(team string) bool {
		return team == api.Team || slices.Contains(api.ShareWith, "*") || slices.Contains(api.ShareWith, team)
	}
	if asked != "" {
		return asked, slices.Contains(who.Teams, asked) && may(asked)
	}
	if slices.Contains(who.Teams, api.Team) {
		return api.Team, true
	}
	for _, team := range who.Teams {
		if may(team) {
			return team, true
		}
	}
	return "", false
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
// never the backend's), any Vertra-* (which only the gateway sets), and
// what a caller could claim about where it's from (Forwarded,
// X-Forwarded-*, X-Real-Ip): X-Forwarded-For is set to client, the caller's
// address as clientAddress worked it out.
func forwardHeaders(in http.Header, client string) http.Header {
	out := in.Clone()
	for _, h := range hopByHop {
		out.Del(h)
	}
	for _, h := range strings.Split(in.Get("Connection"), ",") {
		if h = strings.TrimSpace(h); h != "" {
			out.Del(h)
		}
	}
	out.Del("Authorization")
	out.Del("Forwarded")
	out.Del("X-Real-Ip")
	for k := range out {
		if lower := strings.ToLower(k); strings.HasPrefix(lower, "vertra-") || strings.HasPrefix(lower, "x-forwarded-") {
			out.Del(k)
		}
	}
	if client != "" {
		out.Set("X-Forwarded-For", client)
	}
	return out
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
