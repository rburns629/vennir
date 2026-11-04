// SPDX-License-Identifier: MIT

// Package tofu runs OpenTofu in an environment's tofu/ directory, as you:
// init, plan (summarised for the approval screen), apply the approved plan,
// read outputs, destroy. State stays in that directory.
package tofu

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/rburns629/vennir/cli/internal/run"
)

// Dir is an environment's OpenTofu directory.
type Dir struct {
	Path string
	r    *run.Runner
}

// In returns the tofu/ directory inside an environment's directory.
func In(r *run.Runner, envDir string) Dir {
	return Dir{Path: filepath.Join(envDir, "tofu"), r: r}
}

const (
	varsFile = "vennir.auto.tfvars.json"
	planFile = "tfplan"
)

func (d Dir) args(cmd string, extra ...string) []string {
	return append([]string{"-chdir=" + d.Path, cmd, "-input=false", "-no-color"}, extra...)
}

// Init downloads the pinned provider, checked against the module's lock file.
func (d Dir) Init(ctx context.Context) error {
	if _, err := d.r.Output(ctx, "tofu", d.args("init", "-lockfile=readonly")...); err != nil {
		return fmt.Errorf("tofu init: %w", err)
	}
	return nil
}

// WriteVars writes the module's inputs, generated from the config.
func (d Dir) WriteVars(vars map[string]any) error {
	data, err := json.MarshalIndent(vars, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(d.Path, varsFile), data, 0o644)
}

// Change is one resource the plan changes.
type Change struct {
	Address string
	Type    string
	Action  string // create, update, delete, replace
}

// Plan makes the plan apply will carry out, and returns what it changes.
func (d Dir) Plan(ctx context.Context, destroy bool) ([]Change, error) {
	extra := []string{"-out=" + planFile}
	if destroy {
		extra = append(extra, "-destroy")
	}
	if _, err := d.r.Output(ctx, "tofu", d.args("plan", extra...)...); err != nil {
		return nil, fmt.Errorf("tofu plan: %w", err)
	}
	out, err := d.r.Output(ctx, "tofu", "-chdir="+d.Path, "show", "-json", planFile)
	if err != nil {
		return nil, fmt.Errorf("tofu show: %w", err)
	}
	return parsePlan([]byte(out))
}

func parsePlan(data []byte) ([]Change, error) {
	var plan struct {
		ResourceChanges []struct {
			Address string `json:"address"`
			Type    string `json:"type"`
			Mode    string `json:"mode"`
			Change  struct {
				Actions []string `json:"actions"`
			} `json:"change"`
		} `json:"resource_changes"`
	}
	if err := json.Unmarshal(data, &plan); err != nil {
		return nil, fmt.Errorf("reading the plan: %w", err)
	}
	var changes []Change
	for _, rc := range plan.ResourceChanges {
		if rc.Mode == "data" {
			continue
		}
		action := strings.Join(rc.Change.Actions, ",")
		switch action {
		case "no-op", "read":
			continue
		case "create", "update", "delete":
		case "delete,create", "create,delete":
			action = "replace"
		}
		changes = append(changes, Change{Address: rc.Address, Type: rc.Type, Action: action})
	}
	return changes, nil
}

// Apply carries out the saved plan (the one approved).
func (d Dir) Apply(ctx context.Context) error {
	return d.r.Run(ctx, "tofu", d.args("apply", planFile)...)
}

// ApplyOnly applies the current inputs to the given resources alone, at
// once: destroy uses it to record a setting (letting a bucket with objects
// in it go) before deleting.
func (d Dir) ApplyOnly(ctx context.Context, addresses ...string) error {
	args := d.args("apply", "-auto-approve")
	for _, a := range addresses {
		args = append(args, "-target="+a)
	}
	return d.r.Run(ctx, "tofu", args...)
}

// Outputs returns the module's outputs, by name.
func (d Dir) Outputs(ctx context.Context) (map[string]json.RawMessage, error) {
	out, err := d.r.Output(ctx, "tofu", "-chdir="+d.Path, "output", "-json")
	if err != nil {
		return nil, fmt.Errorf("tofu output: %w", err)
	}
	var raw map[string]struct {
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal([]byte(out), &raw); err != nil {
		return nil, err
	}
	values := map[string]json.RawMessage{}
	for k, v := range raw {
		values[k] = v.Value
	}
	return values, nil
}

// Attribute is a string attribute of a resource in the state (the module's
// own, not a child module's), or "" when the state doesn't hold it.
func (d Dir) Attribute(ctx context.Context, address, name string) (string, error) {
	out, err := d.r.Output(ctx, "tofu", "-chdir="+d.Path, "show", "-json")
	if err != nil {
		return "", fmt.Errorf("tofu show: %w", err)
	}
	var state struct {
		Values struct {
			RootModule struct {
				Resources []struct {
					Address string         `json:"address"`
					Values  map[string]any `json:"values"`
				} `json:"resources"`
			} `json:"root_module"`
		} `json:"values"`
	}
	if err := json.Unmarshal([]byte(out), &state); err != nil {
		return "", fmt.Errorf("tofu show: %w", err)
	}
	for _, r := range state.Values.RootModule.Resources {
		if r.Address == address {
			value, _ := r.Values[name].(string)
			return value, nil
		}
	}
	return "", nil
}

// Forget removes resources from the state without deleting them, so a
// destroy leaves them (a backup bucket, the task registry you chose to keep).
// An address the state doesn't have is skipped: `state rm` refuses one, and
// destroy names what the config could have made (a managed database's
// install has no backup bucket; a setting may postdate the last apply).
func (d Dir) Forget(ctx context.Context, addresses ...string) error {
	if len(addresses) == 0 {
		return nil
	}
	out, err := d.r.Output(ctx, "tofu", "-chdir="+d.Path, "state", "list")
	if err != nil {
		return fmt.Errorf("tofu state list: %w", err)
	}
	inState := map[string]bool{}
	for _, a := range strings.Split(out, "\n") {
		inState[strings.TrimSpace(a)] = true
	}
	var there []string
	for _, a := range addresses {
		if inState[a] {
			there = append(there, a)
		}
	}
	if len(there) == 0 {
		return nil
	}
	return d.r.Run(ctx, "tofu", append([]string{"-chdir=" + d.Path, "state", "rm"}, there...)...)
}

// HasState reports whether anything has been applied.
func (d Dir) HasState(ctx context.Context) bool {
	out, err := d.r.Output(ctx, "tofu", "-chdir="+d.Path, "state", "list")
	return err == nil && strings.TrimSpace(out) != ""
}

// names are how the approval screen calls a module's resource types.
var names = map[string][2]string{
	"google_container_cluster":                       {"cluster", "clusters"},
	"google_container_node_pool":                     {"node pool", "node pools"},
	"google_compute_network":                         {"network", "networks"},
	"google_compute_subnetwork":                      {"subnet", "subnets"},
	"google_artifact_registry_repository":            {"registry", "registries"},
	"google_service_account":                         {"service account", "service accounts"},
	"google_storage_bucket":                          {"bucket", "buckets"},
	"google_project_service":                         {"API enabled", "APIs enabled"},
	"google_project_iam_member":                      {"permission", "permissions"},
	"google_artifact_registry_repository_iam_member": {"permission", "permissions"},
	"google_service_account_iam_member":              {"permission", "permissions"},
	"google_storage_bucket_iam_member":               {"permission", "permissions"},
	"google_kms_crypto_key_iam_member":               {"permission", "permissions"},
	"google_kms_key_ring":                            {"KMS key ring", "KMS key rings"},
	"google_kms_crypto_key":                          {"signing key", "signing keys"},
	"google_compute_global_address":                  {"address", "addresses"},
	"google_service_networking_connection":           {"private connection", "private connections"},
	"google_sql_database_instance":                   {"database server", "database servers"},
	"google_sql_database":                            {"database", "databases"},
	"google_sql_user":                                {"database user", "database users"},
	"google_iam_workload_identity_pool":              {"identity pool", "identity pools"},
	"google_iam_workload_identity_pool_provider":     {"identity provider", "identity providers"},
	"random_id":                               {"name suffix", "name suffixes"},
	"aws_eks_cluster":                         {"cluster", "clusters"},
	"aws_acm_certificate":                     {"certificate", "certificates"},
	"aws_route53_zone":                        {"DNS zone", "DNS zones"},
	"aws_route53_record":                      {"DNS record", "DNS records"},
	"aws_eks_node_group":                      {"node group", "node groups"},
	"aws_eks_addon":                           {"cluster add-on", "cluster add-ons"},
	"aws_vpc":                                 {"network", "networks"},
	"aws_subnet":                              {"subnet", "subnets"},
	"aws_internet_gateway":                    {"internet gateway", "internet gateways"},
	"aws_route_table":                         {"route table", "route tables"},
	"aws_route_table_association":             {"route", "routes"},
	"aws_ecr_repository":                      {"registry", "registries"},
	"aws_ecr_repository_creation_template":    {"registry template", "registry templates"},
	"aws_iam_role":                            {"role", "roles"},
	"aws_iam_role_policy":                     {"permission", "permissions"},
	"aws_iam_role_policy_attachment":          {"permission", "permissions"},
	"aws_eks_pod_identity_association":        {"identity binding", "identity bindings"},
	"aws_db_instance":                         {"database server", "database servers"},
	"aws_db_subnet_group":                     {"database subnet group", "database subnet groups"},
	"aws_db_parameter_group":                  {"database settings", "database settings"},
	"aws_security_group":                      {"security group", "security groups"},
	"aws_vpc_security_group_ingress_rule":     {"firewall rule", "firewall rules"},
	"aws_kms_key":                             {"signing key", "signing keys"},
	"aws_iam_openid_connect_provider":         {"identity provider", "identity providers"},
	"aws_s3_bucket":                           {"bucket", "buckets"},
	"aws_s3_bucket_lifecycle_configuration":   {"bucket setting", "bucket settings"},
	"aws_s3_bucket_public_access_block":       {"bucket setting", "bucket settings"},
	"aws_s3_bucket_versioning":                {"bucket setting", "bucket settings"},
	"aws_s3_bucket_object_lock_configuration": {"bucket setting", "bucket settings"},
	"aws_prometheus_workspace":                {"Prometheus workspace", "Prometheus workspaces"},
	"aws_prometheus_alert_manager_definition": {"alert routing", "alert routings"},
	"aws_sns_topic":                           {"alert topic", "alert topics"},
	"aws_sns_topic_policy":                    {"permission", "permissions"},
	"aws_sns_topic_subscription":              {"alert subscription", "alert subscriptions"},
}

// Summary says what changes, per action, e.g. "create": "cluster, 2 node
// pools, 9 permissions".
func Summary(changes []Change) map[string]string {
	counts := map[string]map[string]int{}
	order := map[string][]string{}
	for _, ch := range changes {
		n, ok := names[ch.Type]
		key := ch.Type
		if ok {
			key = n[0]
		}
		if counts[ch.Action] == nil {
			counts[ch.Action] = map[string]int{}
		}
		if counts[ch.Action][key] == 0 {
			order[ch.Action] = append(order[ch.Action], key)
		}
		counts[ch.Action][key]++
	}
	plural := map[string]string{}
	for _, n := range names {
		plural[n[0]] = n[1]
	}
	out := map[string]string{}
	for action, keys := range order {
		sort.SliceStable(keys, func(i, j int) bool { return rank(keys[i]) < rank(keys[j]) })
		var parts []string
		for _, k := range keys {
			n := counts[action][k]
			switch {
			case n == 1:
				parts = append(parts, k)
			case plural[k] != "":
				parts = append(parts, fmt.Sprintf("%d %s", n, plural[k]))
			default:
				parts = append(parts, fmt.Sprintf("%d %s", n, k))
			}
		}
		out[action] = strings.Join(parts, ", ")
	}
	return out
}

// rank puts the big things first.
func rank(name string) int {
	for i, n := range []string{"cluster", "node pool", "network", "subnet", "registry", "bucket", "service account", "role", "permission", "API enabled"} {
		if n == name {
			return i
		}
	}
	return 99
}

// Has reports whether address is in the state (this install made it).
func (d Dir) Has(ctx context.Context, address string) bool {
	out, err := d.r.Output(ctx, "tofu", "-chdir="+d.Path, "state", "list", address)
	return err == nil && strings.TrimSpace(out) == address
}
