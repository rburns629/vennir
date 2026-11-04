// SPDX-License-Identifier: MIT

package grant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// cloud answers the CLI calls a plan makes: the first key contained in
// the command line wins; nothing matching is an error, as is a value that
// is an error.
type cloud struct {
	answers [][2]any
	ran     []string
}

func (c *cloud) exec(_ context.Context, name string, args ...string) (string, error) {
	line := name + " " + strings.Join(args, " ")
	c.ran = append(c.ran, line)
	for _, a := range c.answers {
		if strings.Contains(line, a[0].(string)) {
			if err, ok := a[1].(error); ok {
				return "", err
			}
			return a[1].(string), nil
		}
	}
	return "", fmt.Errorf("unexpected: %s", line)
}

func labels(p *Plan) string {
	var s []string
	for _, a := range p.Actions {
		s = append(s, a.Label)
	}
	return strings.Join(s, ",")
}

func find(t *testing.T, p *Plan, verb string) Action {
	t.Helper()
	for _, a := range p.Actions {
		if a.Args != nil && strings.Contains(strings.Join(a.Args, " "), verb) {
			return a
		}
	}
	t.Fatalf("no %q in %+v", verb, p.Actions)
	return Action{}
}

var (
	eks = Reader{Name: "vennir-eks", Issuer: "https://oidc.eks.us-east-2.amazonaws.com/id/ABC",
		Subject: "system:serviceaccount:vennir-system:console-execution-console"}
	gke = Reader{Name: "vennir-gke", Issuer: "https://container.googleapis.com/v1/projects/reader/locations/us-central1/clusters/vennir-gke",
		Subject: "system:serviceaccount:vennir-system:console-execution-console"}
	owner   = GCPOwner{Project: "acyclix-dev", RegistryProject: "acyclix-dev", Region: "us-central1", Repository: "vennir-products"}
	pool    = "projects/42/locations/global/workloadIdentityPools/vennir-installs"
	member  = "principal://iam.googleapis.com/" + pool + "/subject/vennir-eks:system:serviceaccount:vennir-system:console-execution-console"
	missing = errors.New("ERROR: (gcloud) NOT_FOUND: Requested entity was not found.")
)

func TestReaderValidation(t *testing.T) {
	if err := eks.Validate("aws"); err != nil {
		t.Error(err)
	}
	if err := (Reader{Name: "r-gke", ServiceAccounts: []string{"c@p.iam.gserviceaccount.com"}}).Validate("gcp"); err != nil {
		t.Error(err)
	}
	for _, c := range []struct {
		r      Reader
		target string
		want   string
	}{
		{Reader{Name: "X"}, "gcp", "--reader"},
		{Reader{Name: "eks"}, "gcp", "say who reads"},
		{Reader{Name: "eks", Issuer: "http://x", Subject: "default"}, "aws", "--issuer"},
		{Reader{Name: "eks", Issuer: "https://x", Subject: "default"}, "aws", "--subject"},
		{Reader{Name: "eks", ServiceAccounts: []string{"c@p.iam.gserviceaccount.com"}}, "aws", "an aws owner"},
		{Reader{Name: "eks", ServiceAccounts: []string{"not-an-email"}}, "gcp", "service account's email"},
		{Reader{Name: "eks", Issuer: "https://x", Subject: eks.Subject, ServiceAccounts: []string{"c@p.iam.gserviceaccount.com"}}, "gcp", "not both"},
	} {
		if err := c.r.Validate(c.target); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%+v: %v, want %q", c.r, err, c.want)
		}
	}
}

// A first grant on gcp: the pool, a provider trusting the reader's issuer
// for its console alone, mapped to a subject of the reader's own, and read
// on the repository for exactly that principal.
func TestGCPGrantsAFederatedReader(t *testing.T) {
	c := &cloud{answers: [][2]any{
		{"auth list", "owner@example.com"},
		{"get-iam-policy", `{"bindings":[]}`},
		{"projects describe", "42"},
		{"providers describe", missing},
		{"workload-identity-pools describe", missing},
	}}
	p, err := PlanGCP(context.Background(), c.exec, owner, eks, false)
	if err != nil {
		t.Fatal(err)
	}
	if labels(p) != "Will create,Will create,Will grant" || !p.Changes() {
		t.Fatalf("actions: %s", labels(p))
	}
	create := strings.Join(find(t, p, "create-oidc").Args, " ")
	for _, want := range []string{
		"create-oidc vennir-eks", "--issuer-uri=https://oidc.eks.us-east-2.amazonaws.com/id/ABC",
		`--attribute-mapping=google.subject="vennir-eks:"+assertion.sub`,
		"--attribute-condition=assertion.sub=='system:serviceaccount:vennir-system:console-execution-console'",
		"--workload-identity-pool=vennir-installs", "--project=acyclix-dev",
	} {
		if !strings.Contains(create, want) {
			t.Errorf("create-oidc lacks %q: %s", want, create)
		}
	}
	bind := find(t, p, "add-iam-policy-binding")
	if !strings.Contains(strings.Join(bind.Args, " "), "vennir-products --role=roles/artifactregistry.reader --member="+member) {
		t.Errorf("binding: %v", bind.Args)
	}
	if p.ReaderSets != [2]string{"externalCatalog.gcpWorkloadIdentityProvider", pool + "/providers/vennir-eks"} {
		t.Errorf("reader sets %v", p.ReaderSets)
	}

	// Applying runs only the changes, in order.
	before := len(c.ran)
	c.answers = append([][2]any{{"workload-identity-pools create", ""}, {"create-oidc", ""}, {"add-iam-policy-binding", ""}}, c.answers...)
	if err := p.Apply(context.Background(), c.exec, nil); err != nil {
		t.Fatal(err)
	}
	if ran := c.ran[before:]; len(ran) != 3 || !strings.Contains(ran[0], "pools create") || !strings.Contains(ran[2], "add-iam-policy-binding") {
		t.Errorf("ran %q", ran)
	}
}

// Granted already: nothing to change. An earlier hand-made provider (the
// bare subject) is updated in place, and the binding to the bare subject
// noted for removal.
func TestGCPGrantIsIdempotent(t *testing.T) {
	provider := `{"state":"ACTIVE","attributeCondition":"assertion.sub=='system:serviceaccount:vennir-system:console-execution-console'",
		"attributeMapping":{"google.subject":"\"vennir-eks:\"+assertion.sub"},"oidc":{"issuerUri":"https://oidc.eks.us-east-2.amazonaws.com/id/ABC"}}`
	policy := fmt.Sprintf(`{"bindings":[{"role":"roles/artifactregistry.reader","members":[%q]}]}`, member)
	c := &cloud{answers: [][2]any{
		{"auth list", "owner@example.com"}, {"get-iam-policy", policy}, {"projects describe", "42"},
		{"providers describe", provider}, {"workload-identity-pools describe", "ACTIVE"},
	}}
	p, err := PlanGCP(context.Background(), c.exec, owner, eks, false)
	if err != nil {
		t.Fatal(err)
	}
	if p.Changes() || labels(p) != "Has,Has,Has" {
		t.Errorf("granted: %s", labels(p))
	}

	old := "principal://iam.googleapis.com/" + pool + "/subject/" + eks.Subject
	c.answers[1][1] = fmt.Sprintf(`{"bindings":[{"role":"roles/artifactregistry.reader","members":[%q]}]}`, old)
	c.answers[3][1] = strings.Replace(provider, `\"vennir-eks:\"+assertion.sub`, "assertion.sub", 1)
	p, err = PlanGCP(context.Background(), c.exec, owner, eks, false)
	if err != nil {
		t.Fatal(err)
	}
	if labels(p) != "Has,Will update,Will grant" || len(p.Notes) != 1 || !strings.Contains(p.Notes[0], "--member="+old) {
		t.Errorf("earlier setup: %s %q", labels(p), p.Notes)
	}
}

func TestGCPRevokesAFederatedReader(t *testing.T) {
	c := &cloud{answers: [][2]any{
		{"auth list", "owner@example.com"},
		{"get-iam-policy", fmt.Sprintf(`{"bindings":[{"role":"roles/artifactregistry.reader","members":[%q]}]}`, member)},
		{"projects describe", "42"}, {"providers describe", `{"state":"ACTIVE"}`}, {"workload-identity-pools describe", "ACTIVE"},
	}}
	p, err := PlanGCP(context.Background(), c.exec, owner, eks, true)
	if err != nil {
		t.Fatal(err)
	}
	if labels(p) != "Will remove,Will delete" || p.ReaderSets[0] != "" {
		t.Errorf("revoke: %s", labels(p))
	}
	find(t, p, "remove-iam-policy-binding")
	find(t, p, "providers delete vennir-eks")
}

// A reader on Google Cloud: its own service accounts, each read on the
// repository; nothing for it to set.
func TestGCPGrantsServiceAccounts(t *testing.T) {
	r := Reader{Name: "vennir-gke", ServiceAccounts: []string{"vennir-gke-console@reader.iam.gserviceaccount.com", "vennir-gke-nodes@reader.iam.gserviceaccount.com"}}
	c := &cloud{answers: [][2]any{
		{"auth list", "owner@example.com"},
		{"get-iam-policy", `{"bindings":[{"role":"roles/artifactregistry.reader","members":["serviceAccount:vennir-gke-console@reader.iam.gserviceaccount.com"]}]}`},
	}}
	p, err := PlanGCP(context.Background(), c.exec, owner, r, false)
	if err != nil {
		t.Fatal(err)
	}
	if labels(p) != "Has,Will grant" || p.ReaderSets[0] != "" {
		t.Errorf("service accounts: %s", labels(p))
	}
	if !strings.Contains(strings.Join(find(t, p, "add-iam-policy-binding").Args, " "), "--member=serviceAccount:vennir-gke-nodes@reader.iam.gserviceaccount.com") {
		t.Error("the nodes' account")
	}
	for _, line := range c.ran {
		if strings.Contains(line, "workload-identity-pools") {
			t.Errorf("no federation for service accounts: %s", line)
		}
	}
}

func awsOwner() AWSOwner {
	return AWSOwner{Region: "us-east-2", Prefix: "vennir-products", Args: func(a ...string) []string {
		return append(a, "--profile", "owner", "--region", "us-east-2", "--output", "json")
	}}
}

// A first grant on aws: an OIDC provider for the reader's issuer, and a
// role only its console may assume by web identity, which reads the
// catalog's repositories and nothing else.
func TestAWSGrantsAWebIdentity(t *testing.T) {
	noSuch := errors.New("An error occurred (NoSuchEntity) when calling the GetRole operation")
	c := &cloud{answers: [][2]any{
		{"get-caller-identity", `{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/owner"}`},
		{"get-role", noSuch},
		{"get-open-id-connect-provider", noSuch},
	}}
	p, err := PlanAWS(context.Background(), c.exec, awsOwner(), gke, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if labels(p) != "Will create,Will create,Will set" {
		t.Fatalf("actions: %s", labels(p))
	}
	if p.Registry != "123456789012.dkr.ecr.us-east-2.amazonaws.com/vennir-products" ||
		p.ReaderSets != [2]string{"externalCatalog.awsRoleArn", "arn:aws:iam::123456789012:role/vennir-reader-vennir-gke"} {
		t.Errorf("plan: %s %v", p.Registry, p.ReaderSets)
	}
	provider := strings.Join(find(t, p, "create-open-id-connect-provider").Args, " ")
	if !strings.Contains(provider, "--url "+gke.Issuer+" --client-id-list sts.amazonaws.com") || !strings.Contains(provider, "--profile owner") {
		t.Errorf("provider: %s", provider)
	}

	role := find(t, p, "create-role").Args
	var trust document
	if err := json.Unmarshal([]byte(role[indexOf(role, "--assume-role-policy-document")+1]), &trust); err != nil {
		t.Fatal(err)
	}
	host := "container.googleapis.com/v1/projects/reader/locations/us-central1/clusters/vennir-gke"
	st := trust.Statement[0]
	if len(trust.Statement) != 1 || st.Action != "sts:AssumeRoleWithWebIdentity" ||
		st.Principal["Federated"] != "arn:aws:iam::123456789012:oidc-provider/"+host ||
		st.Condition["StringEquals"][host+":sub"] != gke.Subject || st.Condition["StringEquals"][host+":aud"] != "sts.amazonaws.com" {
		t.Errorf("trust: %+v", trust)
	}

	put := find(t, p, "put-role-policy").Args
	var policy document
	if err := json.Unmarshal([]byte(put[indexOf(put, "--policy-document")+1]), &policy); err != nil {
		t.Fatal(err)
	}
	if len(policy.Statement) != 2 || policy.Statement[0].Action != "ecr:GetAuthorizationToken" ||
		policy.Statement[1].Resource != "arn:aws:ecr:us-east-2:123456789012:repository/vennir-products/*" ||
		fmt.Sprint(policy.Statement[1].Action) != fmt.Sprint(ReadActions) {
		t.Errorf("policy: %+v", policy)
	}
	for _, action := range ReadActions {
		if strings.Contains(action, "Put") || strings.Contains(action, "Delete") || strings.Contains(action, "Upload") {
			t.Errorf("a write: %s", action)
		}
	}
}

const eksHost = "oidc.eks.us-east-2.amazonaws.com/id/ABC"

// role is get-role's answer for a role with trust, spaced as the CLI
// prints it.
func role(t *testing.T, trust string) string {
	t.Helper()
	var b strings.Builder
	b.WriteString(`{"Role":{"RoleName":"vennir-reader-vennir-eks","AssumeRolePolicyDocument":`)
	var out bytes.Buffer
	if err := json.Indent(&out, []byte(trust), "    ", "  "); err != nil {
		t.Fatal(err)
	}
	b.WriteString(out.String() + `}}`)
	return b.String()
}

// policyAnswer is get-role-policy's answer.
func policyAnswer(policy string) string {
	return `{"RoleName":"vennir-reader-vennir-eks","PolicyName":"read-catalog","PolicyDocument":` + policy + `}`
}

// Again, with nothing different: nothing to change.
func TestAWSGrantAgainChangesNothing(t *testing.T) {
	c := &cloud{answers: [][2]any{
		{"get-caller-identity", `{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/owner"}`},
		{"get-role-policy", policyAnswer(ReadPolicy("aws", "us-east-2", "123456789012", "vennir-products"))},
		{"get-role", role(t, TrustPolicy("arn:aws:iam::123456789012:oidc-provider/"+eksHost, eks))},
		{"get-open-id-connect-provider", `{"ClientIDList":["sts.amazonaws.com"]}`},
	}}
	p, err := PlanAWS(context.Background(), c.exec, awsOwner(), eks, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if labels(p) != "Has,Has,Has" || p.Changes() {
		t.Errorf("again: %s", labels(p))
	}
}

// Again for the same reader, set differently (an older version's trust,
// a missing policy): set again; an existing provider without STS's
// audience gets it.
func TestAWSGrantAgain(t *testing.T) {
	provider := "arn:aws-us-gov:iam::123456789012:oidc-provider/" + eksHost
	c := &cloud{answers: [][2]any{
		{"get-caller-identity", `{"Account":"123456789012","Arn":"arn:aws-us-gov:iam::123456789012:user/owner"}`},
		{"get-role-policy", errors.New("An error occurred (NoSuchEntity) when calling the GetRolePolicy operation")},
		{"get-role", role(t, `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Federated":"`+provider+`"},
		  "Action":"sts:AssumeRoleWithWebIdentity","Condition":{"StringEquals":{"`+eksHost+`:sub":"`+eks.Subject+`"}}}]}`)},
		{"get-open-id-connect-provider", `{"ClientIDList":["other"]}`},
	}}
	p, err := PlanAWS(context.Background(), c.exec, awsOwner(), eks, false, false)
	if err != nil {
		t.Fatal(err)
	}
	if labels(p) != "Will add,Will set,Will set" || !strings.HasPrefix(p.ReaderSets[1], "arn:aws-us-gov:iam::") {
		t.Errorf("again: %s %v", labels(p), p.ReaderSets)
	}
	find(t, p, "update-assume-role-policy")
	find(t, p, "put-role-policy")
}

// The role is named by the reader alone: one trusting another reader's
// console (another cluster of the same name) is refused, on grant and on
// revoke, unless --replace.
func TestAWSRoleOfAnotherReader(t *testing.T) {
	other := Reader{Name: eks.Name, Issuer: "https://oidc.eks.eu-west-1.amazonaws.com/id/XYZ", Subject: eks.Subject}
	theirs := role(t, TrustPolicy("arn:aws:iam::123456789012:oidc-provider/oidc.eks.eu-west-1.amazonaws.com/id/XYZ", other))
	for _, tc := range []struct {
		name  string
		trust string
		says  string
	}{
		{"another issuer", theirs, "system:serviceaccount:vennir-system:console-execution-console from oidc.eks.eu-west-1.amazonaws.com/id/XYZ"},
		{"another subject", role(t, TrustPolicy("arn:aws:iam::123456789012:oidc-provider/"+eksHost,
			Reader{Issuer: eks.Issuer, Subject: "system:serviceaccount:vennir-system:other"})), "system:serviceaccount:vennir-system:other from " + eksHost},
		{"not vennir's", role(t, `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}`),
			"a trust policy vennir didn't write"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &cloud{answers: [][2]any{
				{"get-caller-identity", `{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/owner"}`},
				{"get-role-policy", policyAnswer(ReadPolicy("aws", "us-east-2", "123456789012", "vennir-products"))},
				{"get-role", tc.trust},
				{"get-open-id-connect-provider", `{"ClientIDList":["sts.amazonaws.com"]}`},
				{"list-role-policies", `{"PolicyNames":["read-catalog"]}`},
			}}
			for _, revoke := range []bool{false, true} {
				_, err := PlanAWS(context.Background(), c.exec, awsOwner(), eks, revoke, false)
				if err == nil || !strings.Contains(err.Error(), "lets "+tc.says+" assume it") || !strings.Contains(err.Error(), "--replace") {
					t.Errorf("revoke %v: %v", revoke, err)
				}
			}
			p, err := PlanAWS(context.Background(), c.exec, awsOwner(), eks, false, true)
			if err != nil {
				t.Fatal(err)
			}
			if labels(p) != "Has,Will replace,Has" {
				t.Errorf("replace: %s", labels(p))
			}
			find(t, p, "update-assume-role-policy")
			p, err = PlanAWS(context.Background(), c.exec, awsOwner(), eks, true, true)
			if err != nil {
				t.Fatal(err)
			}
			if labels(p) != "Will delete,Will delete" || !strings.Contains(p.Actions[1].Text, tc.says+" can no longer assume it") {
				t.Errorf("revoke with --replace: %s %q", labels(p), p.Actions[1].Text)
			}
		})
	}
}

func TestAWSRevokes(t *testing.T) {
	c := &cloud{answers: [][2]any{
		{"get-caller-identity", `{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/owner"}`},
		{"get-role", role(t, TrustPolicy("arn:aws:iam::123456789012:oidc-provider/"+eksHost, eks))},
		{"list-role-policies", `{"PolicyNames":["read-catalog"]}`},
	}}
	p, err := PlanAWS(context.Background(), c.exec, awsOwner(), eks, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if labels(p) != "Will delete,Will delete" || len(p.Notes) != 1 {
		t.Errorf("revoke: %s", labels(p))
	}
	if a := p.Actions[1]; strings.Join(a.Args[:4], " ") != "iam delete-role --role-name vennir-reader-vennir-eks" {
		t.Errorf("order: %v", a.Args)
	}
	if _, err := PlanAWS(context.Background(), c.exec, awsOwner(), Reader{Name: "x", ServiceAccounts: []string{"a@b.gserviceaccount.com"}}, false, false); err == nil {
		t.Error("service accounts on aws")
	}
}

// A failure that isn't "not found" stops the plan rather than planning to
// create what may exist.
func TestOtherErrorsStop(t *testing.T) {
	c := &cloud{answers: [][2]any{
		{"get-caller-identity", `{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/owner"}`},
		{"get-role", errors.New("AccessDenied")},
	}}
	if _, err := PlanAWS(context.Background(), c.exec, awsOwner(), eks, false, false); err == nil || !strings.Contains(err.Error(), "AccessDenied") {
		t.Errorf("got %v", err)
	}
}

func indexOf(list []string, s string) int {
	for i, v := range list {
		if v == s {
			return i
		}
	}
	return -2
}
