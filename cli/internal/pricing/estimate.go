// SPDX-License-Identifier: MIT

package pricing

import (
	"fmt"
	"math"
	"strings"

	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/plan"
)

// hoursPerMonth is the clouds' billing month.
const hoursPerMonth = 730

// Light use, for the "likely" line: awake about four hours a weekday (when
// it sleeps; always otherwise) and fifty step-hours a month.
const (
	lightAwakeHours = 4 * 22
	lightStepHours  = 50
)

// gkeStandardNodes are standard mode's platform node per size, as the gcp
// module sizes them (keep in step with modules/gcp/main.tf's pools).
var gkeStandardNodes = map[string]struct {
	machine       string
	cores, ramGiB float64
}{
	"minimal":   {"e2-medium", 1, 4}, // billed as one core and 4 GiB
	"resilient": {"e2-standard-2", 2, 8},
	"scaled":    {"e2-standard-2", 2, 8},
	"auto":      {"e2-standard-2", 2, 8},
}

// gkeStepsNodes are standard mode's steps node per size, vCPU and GiB, as
// the gcp module sizes them (its pools' steps_type): e2-standard-2 at
// minimal, e2-standard-4 otherwise.
var gkeStepsNodes = map[string][2]float64{
	"minimal": {2, 8}, "resilient": {4, 16}, "scaled": {4, 16}, "auto": {4, 16},
}

// gkeStandardRoom is what one standard platform node leaves the platform's
// Pods, vCPU and GiB: its allocatable after GKE's reservations
// (cloud.google.com/kubernetes-engine/docs/concepts/plan-node-sizes:
// e2-medium about 0.94 vCPU and 2.8 GiB, e2-standard-2 1.93 vCPU and 6.1
// GiB), less GKE's own Pods on every node (Dataplane V2's anetd,
// fluentbit-gke, gke-metrics-agent, pdcsi-node, netd), estimated at 0.25
// vCPU and 0.35 GiB. Not yet checked against a live node.
var gkeStandardRoom = map[string][2]float64{
	"minimal":   {0.94 - 0.25, 2.8 - 0.35},
	"resilient": {1.93 - 0.25, 6.1 - 0.35},
	"scaled":    {1.93 - 0.25, 6.1 - 0.35},
	"auto":      {1.93 - 0.25, 6.1 - 0.35},
}

// gkeSystemPods are GKE's Pods that run once a cluster, on the platform
// pool since the steps pool is tainted (kube-dns and its autoscaler,
// metrics-server, konnectivity-agent, event-exporter), estimated at 0.35
// vCPU and 0.35 GiB of requests.
var gkeSystemPods = [2]float64{0.35, 0.35}

// nodesFor is how many nodes the platform's requests (and extra, what else
// runs beside them once a cluster) need, lowest and highest (auto scales):
// by CPU or by memory, whichever needs more, room being what each node
// leaves them. The node pool, or Auto Mode, adds nodes until they fit.
func nodesFor(f plan.Floor, extra, room [2]float64) [2]int {
	var n [2]int
	for i := range n {
		// Less a hair, so a sum like 0.55+0.05 can't round up a node.
		cpu := math.Ceil((f.CPUCores[i]+extra[0])/room[0] - 1e-9)
		mem := math.Ceil((f.MemGiB[i]+extra[1])/room[1] - 1e-9)
		n[i] = int(max(1, cpu, mem))
	}
	return n
}

// nodeWords says how many nodes of a type.
func nodeWords(n [2]int, instance string) string {
	switch {
	case n[0] != n[1]:
		return fmt.Sprintf("%d–%d %s nodes", n[0], n[1], instance)
	case n[0] == 1:
		return "one " + instance + " node"
	default:
		return fmt.Sprintf("%d %s nodes", n[0], instance)
	}
}

// nodeDiskGiB is each standard node's boot disk (the module's disk_size_gb).
const nodeDiskGiB = 50

// GCP is the cost section of the approval screen for a gcp install.
func GCP(p *GCPPrices, c *config.Config, fetched string) []plan.Line {
	f := plan.FloorOf(c)
	standard := c.Cluster.Mode == "standard"
	disks := f.VolumeGiB * p.BalancedDisk
	for _, gib := range f.OptionalVolumesGiB {
		// GKE provisions a pd-balanced disk at 10 GB at least.
		disks += max(gib, 10) * p.BalancedDisk
	}
	fee := p.ClusterFee * hoursPerMonth

	var stepHour float64
	var platformHour [2]float64
	var always float64     // besides the fee
	var alwaysMore float64 // more at the top of auto's range
	var platformNodes [2]int
	capacity := "Spot"
	if !f.Spot {
		capacity = "on-demand"
	}
	if standard {
		node := gkeStandardNodes[c.Size]
		core, ram := p.E2SpotCore, p.E2SpotRam
		if !f.Spot {
			core, ram = p.E2Core, p.E2Ram
		}
		stepHour = f.StepCPU*core + f.StepMemGiB*ram
		// The platform's nodes, as many as its requests need (the pool
		// autoscales), run whether or not the platform sleeps.
		platformNodes = nodesFor(f, gkeSystemPods, gkeStandardRoom[c.Size])
		nodeMonth := (node.cores*p.E2Core+node.ramGiB*p.E2Ram)*hoursPerMonth + nodeDiskGiB*p.BalancedDisk
		always = float64(platformNodes[0]) * nodeMonth
		alwaysMore = float64(platformNodes[1]-platformNodes[0]) * nodeMonth
		if c.StepHeadroom > 0 {
			// The steps pool keeps one node for it.
			steps := gkeStepsNodes[c.Size]
			always += (steps[0]*core + steps[1]*ram) * hoursPerMonth
			disks += nodeDiskGiB * p.BalancedDisk
		}
	} else {
		cpu, mem := p.AutopilotSpotCPU, p.AutopilotSpotMem
		if !f.Spot {
			cpu, mem = p.AutopilotCPU, p.AutopilotMem
		}
		stepHour = f.StepCPU*cpu + f.StepMemGiB*mem
		for i := range platformHour {
			platformHour[i] = f.CPUCores[i]*p.AutopilotCPU + f.MemGiB[i]*p.AutopilotMem
		}
		if c.StepHeadroom > 0 {
			always += float64(c.StepHeadroom) * stepHour * hoursPerMonth
		}
	}
	sqlMonth := 0.0
	if c.Database.Type == "managed" {
		// No Postgres volume in the cluster; the instance runs whether or
		// not the platform sleeps.
		always -= f.VolumeGiB * p.BalancedDisk
		sqlMonth = CloudSQLMonth(p, c)
		always += sqlMonth
	}
	always += disks
	if c.Console.Public {
		always += p.ForwardingRule * hoursPerMonth
	}

	awakeHours := float64(hoursPerMonth)
	if c.ScaleDown.Enabled {
		awakeHours = lightAwakeHours
	}
	likelyLow := always + platformHour[0]*awakeHours + stepHour*lightStepHours
	likelyHigh := likelyLow + fee + (platformHour[1]-platformHour[0])*awakeHours + alwaysMore

	lines := []plan.Line{
		{Label: "Estimated cost", Text: fmt.Sprintf("a month, %s in USD, %s, %s", orList(p.Basis), p.Region, fetched)},
		{Label: "  Cluster fee", Text: fmt.Sprintf("%s (GKE's free tier credit covers one Autopilot or zonal cluster per billing account)", money(fee))},
	}
	if sqlMonth > 0 {
		lines = append(lines, plan.Line{Label: "  Database", Text: fmt.Sprintf("%s: Cloud SQL, its %d GB of SSD and backups' first copy, awake or asleep (in Always below)", money(sqlMonth), sqlDiskGiB)})
	}
	if standard {
		lines = append(lines, plan.Line{Label: "  Always", Text: fmt.Sprintf("%s: %s for the platform (as many as its requests need) and %s%s, awake or asleep",
			moneySpan(always, always+alwaysMore), nodeWords(platformNodes, gkeStandardNodes[c.Size].machine), alwaysWhat(c), lbNote(c))})
	} else {
		lines = append(lines,
			plan.Line{Label: "  Always", Text: fmt.Sprintf("%s: %s%s%s", money(always), alwaysWhat(c), lbNote(c), headroomNote(c))},
			plan.Line{Label: "  While awake", Text: fmt.Sprintf("%s a month if never asleep (the platform's Pods)", moneyRange(platformHour[0]*hoursPerMonth, platformHour[1]*hoursPerMonth))},
			plan.Line{Label: "  While asleep", Text: "nothing more: Autopilot bills Pods, and asleep there are none"},
		)
	}
	lines = append(lines,
		plan.Line{Label: "  Steps", Text: fmt.Sprintf("%s per step-hour at the default size (%s); %s a month at the cap of %d if always busy",
			money(stepHour), capacity, money(stepHour*float64(f.StepCap)*hoursPerMonth), f.StepCap)},
		plan.Line{Label: "  Likely", Text: fmt.Sprintf("%s for light use (%s, %d step-hours; the low end if the free tier covers the cluster fee)",
			moneyRange(likelyLow, likelyHigh), awakeWords(c), lightStepHours)},
		plan.Line{Label: "  Not included", Text: notIncluded("discounts, taxes, network egress, backups and images in storage (cents a GB)", "your products' own cloud usage", gcpUnpriced(c)...)},
	)
	return lines
}

// gcpUnpriced is what c makes on gcp that the estimate doesn't price:
// billed per use, or a small monthly fee.
func gcpUnpriced(c *config.Config) []string {
	var more []string
	if c.Monitoring.Enabled && c.Monitoring.ProviderName() == "google" {
		more = append(more, "Managed Prometheus (per sample ingested)")
	}
	if c.ModuleSigning() == "kms" {
		more = append(more, "the Cloud KMS signing key (a monthly fee per key version)")
	}
	return more
}

// notIncluded is the "Not included" line: what every estimate leaves out,
// then what this install makes that isn't priced, then the products' own.
func notIncluded(head, tail string, more ...string) string {
	return strings.Join(append(append([]string{head}, more...), tail), ", ")
}

// sqlDiskGiB is the managed database's disk as the gcp module makes it
// (it grows itself as needed).
const sqlDiskGiB = 10

// CloudSQLMonth is the managed database's monthly list price: its machine
// (the gcp module's tier for the size), zonal or regional, and its disk.
func CloudSQLMonth(p *GCPPrices, c *config.Config) float64 {
	i := 0
	if c.Database.HighAvailability {
		i = 1
	}
	hour := map[string]float64{
		"minimal":   p.SQLSmall[i],
		"resilient": p.SQLCPU[i] + 3.75*p.SQLRam[i],
		"auto":      p.SQLCPU[i] + 3.75*p.SQLRam[i],
		"scaled":    2*p.SQLCPU[i] + 7.5*p.SQLRam[i],
	}[c.Size]
	return hour*hoursPerMonth + sqlDiskGiB*p.SQLStorage[i]
}

// alwaysWhat is what's billed awake or asleep besides nodes and the
// load balancer.
func alwaysWhat(c *config.Config) string {
	if c.Database.Type == "managed" {
		return "the database and disks"
	}
	return "disks"
}

func lbNote(c *config.Config) string {
	if c.Console.Public {
		return ", the console's load balancer"
	}
	return ""
}

func headroomNote(c *config.Config) string {
	if c.StepHeadroom > 0 {
		return fmt.Sprintf(", and room for %d steps kept around the clock", c.StepHeadroom)
	}
	return ""
}

func awakeWords(c *config.Config) string {
	if c.ScaleDown.Enabled {
		return "awake about 4 hours a weekday"
	}
	return "always awake"
}

// orList is whose prices an estimate used, list prices unless it says.
func orList(basis string) string {
	if basis == "" {
		return "list prices"
	}
	return basis
}

func money(v float64) string {
	switch {
	case v < 0.1:
		return fmt.Sprintf("$%.3f", v)
	case v < 100:
		return fmt.Sprintf("$%.2f", v)
	default:
		return fmt.Sprintf("$%.0f", v)
	}
}

// moneySpan is one amount, or a range when they differ.
func moneySpan(lo, hi float64) string {
	if hi-lo < 0.005 {
		return money(lo)
	}
	return money(lo) + "–" + money(hi)
}

func moneyRange(lo, hi float64) string {
	if hi-lo < 0.5 {
		return "~" + money(lo)
	}
	return money(lo) + "–" + money(hi)
}
