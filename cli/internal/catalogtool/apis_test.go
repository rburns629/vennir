// SPDX-License-Identifier: MIT

package catalogtool

import (
	"encoding/json"
	"strings"
	"testing"
)

const apiYAML = `apiVersion: vennir.dev/v2
kind: Api
name: orders
displayName: Orders API
description: The order service.
spec: openapi.yaml
backend:
  url: https://orders.example.com
  auth:
    googleIdToken:
      serviceAccount: orders-gateway@payments-prod.iam.gserviceaccount.com
access: {requests: open}
limits:
  default: 600/min
  web: 2/s
timeout: 20s
maxRequest: 512KiB
`

const openapiYAML = `openapi: 3.1.0
info: {title: Orders, version: 2.3.0}
servers: [{url: https://orders.example.com}]
paths:
  /orders/{orderId}:
    parameters:
      - {name: orderId, in: path, required: true, schema: {type: string, pattern: "^ord_[a-z0-9]{8}$"}}
    get:
      responses: {"200": {description: ok}}
  /orders:
    post:
      requestBody:
        content:
          application/json:
            schema: {$ref: "#/components/schemas/Order"}
      responses: {"201": {description: created}}
components:
  schemas:
    Order: {type: object, required: [amount], properties: {amount: {type: integer}}}
`

func apiCatalog(t *testing.T, api, spec string) *Catalog {
	return catalogWith(t, map[string]string{
		"teams/payments/apis/orders/api.yaml":     api,
		"teams/payments/apis/orders/openapi.yaml": spec,
	})
}

// An API's api.yaml and OpenAPI file, checked: the spec is the allowlist,
// so it must be OpenAPI 3.0 or 3.1, all in one file, aimed at the backend,
// with a schema for everything the gateway is to check.
func TestAPIs(t *testing.T) {
	c := apiCatalog(t, apiYAML, openapiYAML)
	if out := errorsOf(t, (*Catalog).ValidateAPIs, c); out != "" {
		t.Fatalf("a good API was refused:\n%s", out)
	}
	apis, err := c.releaseAPIs()
	if err != nil || len(apis) != 1 {
		t.Fatalf("apis = %v, %v", apis, err)
	}
	a := apis[0]
	if a.GetTeam() != "payments" || a.GetName() != "orders" || a.GetServiceAccount() != "orders-api" ||
		a.GetPerMinute()["default"] != 600 || a.GetPerMinute()["web"] != 120 || a.GetTimeoutSeconds() != 20 ||
		a.GetMaxRequestBytes() != 512<<10 || a.GetBackendAuth().GetGoogleIdToken().GetAudience() != "https://orders.example.com" ||
		a.GetPath() != "teams/payments/apis/orders/api.yaml" || a.GetAccessRequests() != "open" {
		t.Errorf("api = %v", a)
	}
	var doc map[string]any
	if err := json.Unmarshal([]byte(a.GetOpenapi()), &doc); err != nil || doc["openapi"] != "3.1.0" {
		t.Errorf("openapi = %.80s, %v", a.GetOpenapi(), err)
	}

	for name, tc := range map[string]struct{ api, spec, want string }{
		"another backend":                {apiYAML, strings.Replace(openapiYAML, "https://orders.example.com", "https://elsewhere.example.com", 1), "servers don't include backend.url"},
		"a reference outside the file":   {apiYAML, strings.Replace(openapiYAML, "#/components/schemas/Order", "orders.yaml#/Order", 1), "refers outside itself"},
		"a parameter with no schema":     {apiYAML, strings.Replace(openapiYAML, `schema: {type: string, pattern: "^ord_[a-z0-9]{8}$"}`, "description: x", 1), "parameter 'orderId' has no schema"},
		"the gateway's own path":         {apiYAML, strings.Replace(openapiYAML, "/orders:", "/.vennir/health:", 1), "the gateway's own"},
		"two paths alike":                {apiYAML, strings.Replace(openapiYAML, "/orders:", "/orders/{id}:", 1), "match the same requests"},
		"a shell in a path":              {apiYAML, strings.Replace(openapiYAML, "/orders:", "/orders'$(id)':", 1), "a character a path doesn't need"},
		"a reference to nothing":         {apiYAML, strings.Replace(openapiYAML, "#/components/schemas/Order", "#/components/schemas/Missing", 1), "isn't valid OpenAPI"},
		"Swagger 2":                      {apiYAML, "swagger: \"2.0\"\ninfo: {title: x, version: \"1\"}\npaths: {}\n", "OpenAPI"},
		"no spec file":                   {strings.Replace(apiYAML, "spec: openapi.yaml", "spec: missing.yaml", 1), openapiYAML, "no such file"},
		"another name":                   {strings.Replace(apiYAML, "name: orders", "name: billing", 1), openapiYAML, "isn't its folder's"},
		"plain http outside the cluster": {strings.Replace(apiYAML, "https://orders.example.com", "http://orders.example.com", 1), strings.Replace(openapiYAML, "https://", "http://", 1), "http only to a Service"},
		"shareWith, removed":             {apiYAML + "shareWith: [web]\n", openapiYAML, "shareWith was removed"},
		"requests nobody can answer":     {strings.Replace(apiYAML, "requests: open", "requests: sometimes", 1), openapiYAML, "api.yaml"},
		"a limit it can't read":          {strings.Replace(apiYAML, "600/min", "lots", 1), openapiYAML, "api.yaml"},
		"too long a timeout":             {strings.Replace(apiYAML, "timeout: 20s", "timeout: 900s", 1), openapiYAML, "api.yaml"},
		"AWS's audience":                 {tokenFor("sts.amazonaws.com"), openapiYAML, "one a cloud federates"},
		"Azure's audience":               {tokenFor("api://AzureADTokenExchange"), openapiYAML, "one a cloud federates"},
		"a GKE pool":                     {tokenFor("acme.svc.id.goog"), openapiYAML, "one a cloud federates"},
		"a GKE pool's STS audience":      {tokenFor("identitynamespace:acme.svc.id.goog:https://container.googleapis.com/x"), openapiYAML, "one a cloud federates"},
		"a GCP provider":                 {tokenFor("//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/k"), openapiYAML, "one a cloud federates"},
		"the Kubernetes API's":           {tokenFor("https://kubernetes.default.svc"), openapiYAML, "one a cloud federates"},
	} {
		if out := errorsOf(t, (*Catalog).ValidateAPIs, apiCatalog(t, tc.api, tc.spec)); !strings.Contains(out, tc.want) {
			t.Errorf("%s: want %q in:\n%s", name, tc.want, out)
		}
	}
	if out := errorsOf(t, (*Catalog).ValidateAPIs, apiCatalog(t, tokenFor("https://orders.example.com"), openapiYAML)); out != "" {
		t.Errorf("a backend's own audience was refused:\n%s", out)
	}
}

// shareWith is refused, plainly (decision 26: each install's grants replaced
// it). Without access, requests wait for approval.
func TestShareWithRemoved(t *testing.T) {
	shared := strings.Replace(apiYAML, "access: {requests: open}", "shareWith: [web]", 1)
	if out := errorsOf(t, (*Catalog).ValidateAPIs, apiCatalog(t, shared, openapiYAML)); !strings.Contains(out, "teams/payments/apis/orders/api.yaml: "+ShareWithRemoved) {
		t.Errorf("shareWith wasn't refused as removed:\n%s", out)
	}
	c := apiCatalog(t, strings.Replace(apiYAML, "access: {requests: open}\n", "", 1), openapiYAML)
	if out := errorsOf(t, (*Catalog).ValidateAPIs, c); out != "" {
		t.Fatalf("refused without access:\n%s", out)
	}
	apis, err := c.releaseAPIs()
	if err != nil || len(apis) != 1 || apis[0].GetAccessRequests() != "approval" {
		t.Errorf("apis = %v, %v", apis, err)
	}
}

// tokenFor is apiYAML with a serviceAccountToken for audience.
func tokenFor(audience string) string {
	return strings.Replace(apiYAML, `    googleIdToken:
      serviceAccount: orders-gateway@payments-prod.iam.gserviceaccount.com`, `    serviceAccountToken:
      audience: "`+audience+`"`, 1)
}

// An AWS backend that takes IAM: signed as a role, carried in the
// release; a static secret isn't a backend credential at all.
func TestAPIBackendCredentials(t *testing.T) {
	aws := strings.Replace(apiYAML, `    googleIdToken:
      serviceAccount: orders-gateway@payments-prod.iam.gserviceaccount.com`, `    awsSigV4:
      roleArn: arn:aws:iam::123456789012:role/orders-gateway
      region: us-east-1
      service: lambda`, 1)
	c := apiCatalog(t, aws, openapiYAML)
	if out := errorsOf(t, (*Catalog).ValidateAPIs, c); out != "" {
		t.Fatalf("refused:\n%s", out)
	}
	apis, err := c.releaseAPIs()
	if err != nil || apis[0].GetBackendAuth().GetAwsSigV4().GetRoleArn() != "arn:aws:iam::123456789012:role/orders-gateway" ||
		apis[0].GetBackendAuth().GetAwsSigV4().GetService() != "lambda" {
		t.Errorf("apis = %v, %v", apis, err)
	}
	entra := strings.Replace(apiYAML, `    googleIdToken:
      serviceAccount: orders-gateway@payments-prod.iam.gserviceaccount.com`, `    entraToken:
      tenantId: 11111111-1111-1111-1111-111111111111
      clientId: 22222222-2222-2222-2222-222222222222
      scope: api://33333333-3333-3333-3333-333333333333/.default`, 1)
	c = apiCatalog(t, entra, openapiYAML)
	if out := errorsOf(t, (*Catalog).ValidateAPIs, c); out != "" {
		t.Fatalf("refused:\n%s", out)
	}
	apis, err = c.releaseAPIs()
	if got := apis[0].GetBackendAuth().GetEntraToken(); err != nil || got.GetClientId() != "22222222-2222-2222-2222-222222222222" ||
		got.GetTenantId() != "11111111-1111-1111-1111-111111111111" || got.GetScope() != "api://33333333-3333-3333-3333-333333333333/.default" {
		t.Errorf("apis = %v, %v", apis, err)
	}
	// The client credentials grant takes only a resource's /.default.
	noDefault := strings.Replace(entra, "/.default", "/orders.read", 1)
	if out := errorsOf(t, (*Catalog).ValidateAPIs, apiCatalog(t, noDefault, openapiYAML)); !strings.Contains(out, "scope") {
		t.Errorf("a scope that isn't a /.default was accepted:\n%s", out)
	}
	secret := strings.Replace(apiYAML, `    googleIdToken:
      serviceAccount: orders-gateway@payments-prod.iam.gserviceaccount.com`, `    secret: {name: key, key: value, header: X-Api-Key}`, 1)
	if out := errorsOf(t, (*Catalog).ValidateAPIs, apiCatalog(t, secret, openapiYAML)); !strings.Contains(out, "api.yaml") {
		t.Errorf("a static secret was accepted:\n%s", out)
	}
}

// An http backend is fine inside the cluster, where the gateway reaches a
// team's Service directly.
func TestAPIsInTheCluster(t *testing.T) {
	url := "http://orders.payments.svc.cluster.local:8080"
	c := apiCatalog(t, strings.Replace(apiYAML, "https://orders.example.com", url, 1), strings.Replace(openapiYAML, "https://orders.example.com", url, 1))
	if out := errorsOf(t, (*Catalog).ValidateAPIs, c); out != "" {
		t.Errorf("refused:\n%s", out)
	}
}

func TestHTTPOnlyToAServiceInTheCluster(t *testing.T) {
	for host, want := range map[string]bool{
		"orders.payments.svc.cluster.local": true,
		// Another domain can't be told from a name on the internet: the
		// short form is looked up with the install's own.
		"orders.payments.svc.corp.internal":    false,
		"orders.payments.svc.attacker.example": false,
		"orders.payments.svc":                  true,
		"ORDERS.Payments.SVC.cluster.local.":   true,
		"orders.svc.cluster.local":             false,
		"pod.orders.payments.svc":              false,
		"api.example.com":                      false,
		"svc.example.com":                      false,
	} {
		if got := inClusterService(host); got != want {
			t.Errorf("inClusterService(%s) = %v, want %v", host, got, want)
		}
	}
}
