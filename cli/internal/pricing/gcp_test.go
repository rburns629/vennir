// SPDX-License-Identifier: MIT

package pricing

import (
	"encoding/json"
	"math"
	"os"
	"strings"
	"testing"

	"github.com/rburns629/vertra/cli/internal/config"
	"github.com/rburns629/vertra/cli/internal/plan"
)

// testdata/gcp-skus.json: real catalog entries (October 2026), the ones the
// estimate needs for us-central1 plus near misses (another region, another
// compute class, regional disks, the EMEA group).
func fixture(t *testing.T) (gke, compute []sku) {
	t.Helper()
	data, err := os.ReadFile("testdata/gcp-skus.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct{ GKE, Compute, Networking []sku }
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	return f.GKE, append(f.Compute, f.Networking...)
}

func TestPricesFromTheCatalog(t *testing.T) {
	gke, compute := fixture(t)
	p, err := PricesFromGCP(gke, compute, "us-central1")
	if err != nil {
		t.Fatal(err)
	}
	for name, got := range map[string][2]float64{
		"Autopilot vCPU":      {p.AutopilotCPU, 0.0445},
		"Autopilot GiB":       {p.AutopilotMem, 0.004922},
		"Autopilot Spot vCPU": {p.AutopilotSpotCPU, 0.0133},
		"cluster fee":         {p.ClusterFee, 0.1},
		"E2 core":             {p.E2Core, 0.021812},
		"E2 Spot core":        {p.E2SpotCore, 0.01309},
		"balanced disk":       {p.BalancedDisk, 0.1},
		"forwarding rule":     {p.ForwardingRule, 0.025},
	} {
		if math.Abs(got[0]-got[1]) > 0.0000011 {
			t.Errorf("%s: %v, want %v", name, got[0], got[1])
		}
	}
}

func TestMissingPricesFailRatherThanGuess(t *testing.T) {
	gke, compute := fixture(t)
	if _, err := PricesFromGCP(gke, compute, "asia-east1"); err == nil {
		t.Error("a region the catalog doesn't price should fail")
	}
}

func prices() *GCPPrices {
	return &GCPPrices{
		Region: "us-central1", AutopilotCPU: 0.044, AutopilotMem: 0.005, AutopilotSpotCPU: 0.013, AutopilotSpotMem: 0.0015,
		ClusterFee: 0.1, E2Core: 0.022, E2Ram: 0.003, E2SpotCore: 0.013, E2SpotRam: 0.00175, BalancedDisk: 0.1, ForwardingRule: 0.025,
	}
}

func text(lines []plan.Line) string {
	var b strings.Builder
	for _, l := range lines {
		b.WriteString(l.Label + ": " + l.Text + "\n")
	}
	return b.String()
}

func TestAutopilotEstimate(t *testing.T) {
	c := config.Default("gcp")
	c.Console.Public = false
	out := text(GCP(prices(), c, "fetched now"))
	// minimal: 0.55 vCPU and 1.75 GiB awake = $0.03295/h, $24.05 a month.
	for _, want := range []string{"Cluster fee: $73", "Always: $1.00: disks", "While awake: ~$24.05", "$0.004 per step-hour", "(Spot)", "at the cap of 10", "about 4 hours a weekday"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	// Light use: disks + 88 h awake + 50 step-hours, then the fee on top.
	low := 1.0 + 0.03295*88 + (0.25*0.013+0.5*0.0015)*50
	if !strings.Contains(out, money(low)+"–"+money(low+73)) {
		t.Errorf("likely range, want %s–%s:\n%s", money(low), money(low+73), out)
	}
}

// Log search's and the bundled Prometheus's 2Gi volumes are each billed as
// GKE's smallest pd-balanced disk, 10 GB.
func TestTheOptionalVolumesAreBilledAtGKEsSmallestDisk(t *testing.T) {
	c := config.Default("gcp")
	c.Console.Public = false
	c.Logs.Enabled, c.Monitoring = true, config.Monitoring{Enabled: true, Provider: "bundled"}
	// The database's 10 GiB and two 10 GB disks at $0.10.
	if out := text(GCP(prices(), c, "fetched now")); !strings.Contains(out, "Always: $3.00: disks") {
		t.Errorf("three disks:\n%s", out)
	}
}

func TestStandardEstimateKeepsItsNode(t *testing.T) {
	c := config.Default("gcp")
	c.Cluster.Mode = "standard"
	c.Console.Public = false
	c.Size = "scaled" // on-demand steps
	out := text(GCP(prices(), c, "fetched now"))
	// scaled's 1.8 vCPU and GKE's own Pods need two e2-standard-2s.
	node := (2*0.022+8*0.003)*hoursPerMonth + 50*0.1
	disks := 100 * 0.1
	if !strings.Contains(out, "Always: "+money(2*node+disks)+": 2 e2-standard-2 nodes for the platform") {
		t.Errorf("want the nodes and disks always:\n%s", out)
	}
	if !strings.Contains(out, "(on-demand)") || strings.Contains(out, "While asleep") {
		t.Errorf("scaled is on-demand, and standard doesn't save asleep:\n%s", out)
	}
}

// The platform pool autoscales, so standard prices the nodes the platform's
// requests and GKE's own Pods need.
func TestStandardPricesTheNodesTheRequestsNeed(t *testing.T) {
	for _, tc := range []struct {
		size string
		want string
	}{
		{"resilient", "one e2-standard-2 node for the platform"},
		{"auto", "one e2-standard-2 node for the platform"},
		// An e2-medium leaves about 0.7 vCPU after GKE's own Pods.
		{"minimal", "2 e2-medium nodes for the platform"},
	} {
		c := config.Default("gcp")
		c.Cluster.Mode, c.Console.Public, c.Size = "standard", false, tc.size
		if out := text(GCP(prices(), c, "fetched now")); !strings.Contains(out, tc.want) {
			t.Errorf("%s: want %q:\n%s", tc.size, tc.want, out)
		}
	}
}

func TestNodesFor(t *testing.T) {
	room := [2]float64{1.88, 3.1}
	for _, tc := range []struct {
		cpu, mem [2]float64
		want     [2]int
	}{
		{[2]float64{0.1, 0.1}, [2]float64{0.1, 0.1}, [2]int{1, 1}},       // at least one
		{[2]float64{1.2, 1.2}, [2]float64{3.625, 3.625}, [2]int{2, 2}},   // by memory
		{[2]float64{2, 2}, [2]float64{1, 1}, [2]int{2, 2}},               // by CPU
		{[2]float64{0.95, 1.35}, [2]float64{2.625, 4.125}, [2]int{1, 2}}, // a range
		{[2]float64{0.55 + 0.05, 0.6}, [2]float64{3.1, 3.1}, [2]int{1, 1}},
	} {
		f := plan.Floor{CPUCores: tc.cpu, MemGiB: tc.mem}
		if got := nodesFor(f, [2]float64{}, room); got != tc.want {
			t.Errorf("%v vCPU, %v GiB: %v, want %v", tc.cpu, tc.mem, got, tc.want)
		}
	}
}

func TestMoney(t *testing.T) {
	for v, want := range map[float64]string{0.0042: "$0.004", 12.345: "$12.35", 1234.5: "$1234"} {
		if got := money(v); got != want {
			t.Errorf("%v: %s, want %s", v, got, want)
		}
	}
}

func TestAPublicConsoleCostsItsLoadBalancer(t *testing.T) {
	c := config.Default("gcp")
	c.Console.Public = true
	out := text(GCP(prices(), c, "fetched now"))
	if !strings.Contains(out, "Always: "+money(1.0+0.025*hoursPerMonth)+": disks, the console's load balancer") {
		t.Errorf("want the load balancer always:\n%s", out)
	}
}

// testdata/gcp-cloudsql.json: Cloud SQL for PostgreSQL's real entries
// (October 2026) for the Americas and EMEA groups.
func TestCloudSQLPricesFromTheCatalog(t *testing.T) {
	data, err := os.ReadFile("testdata/gcp-cloudsql.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct{ CloudSQL []sku }
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	p := &GCPPrices{Region: "us-central1"}
	if err := p.addSQL(f.CloudSQL); err != nil {
		t.Fatal(err)
	}
	if !p.HasSQL() || p.SQLSmall != [2]float64{0.035, 0.07} || p.SQLCPU != [2]float64{0.0413, 0.0826} || p.SQLStorage != [2]float64{0.17, 0.34} {
		t.Errorf("prices = %+v", p)
	}
	if err := (&GCPPrices{Region: "asia-east1"}).addSQL(f.CloudSQL); err == nil {
		t.Error("a region the catalog doesn't price should fail")
	}
}

func TestAManagedDatabaseIsPricedAndItsVolumeIsNot(t *testing.T) {
	p := prices()
	p.SQLSmall, p.SQLCPU, p.SQLRam, p.SQLStorage = [2]float64{0.035, 0.07}, [2]float64{0.0413, 0.0826}, [2]float64{0.007, 0.014}, [2]float64{0.17, 0.34}
	c := config.Default("gcp")
	c.Console.Public = false
	c.Database.Type = "managed"
	// minimal: the shared-core instance, 730 h, and 10 GB of SSD.
	if got := CloudSQLMonth(p, c); math.Abs(got-(0.035*730+1.7)) > 0.001 {
		t.Errorf("minimal, zonal: %v", got)
	}
	out := text(GCP(p, c, "fetched now"))
	if !strings.Contains(out, "Database: $27.25: Cloud SQL") || !strings.Contains(out, "Always: $27.25: the database and disks") {
		t.Errorf("the database, and no 10 GB volume beside it:\n%s", out)
	}
	c.Size, c.Database.HighAvailability = "scaled", true
	if got := CloudSQLMonth(p, c); math.Abs(got-((2*0.0826+7.5*0.014)*730+3.4)) > 0.001 {
		t.Errorf("scaled, regional: %v", got)
	}
}
