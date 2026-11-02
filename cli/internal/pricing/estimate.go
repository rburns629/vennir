// SPDX-License-Identifier: MIT

package pricing

import (
	"fmt"

	"github.com/rburns629/vertra/cli/internal/config"
	"github.com/rburns629/vertra/cli/internal/plan"
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
var gkeStandardNodes = map[string]struct{ cores, ramGiB float64 }{
	"minimal":   {1, 4}, // e2-medium: billed as one core and 4 GiB
	"resilient": {2, 8}, // e2-standard-2
	"scaled":    {2, 8},
	"auto":      {2, 8},
}

// nodeDiskGiB is each standard node's boot disk (the module's disk_size_gb).
const nodeDiskGiB = 50

// GCP is the cost section of the approval screen for a gcp install.
func GCP(p *GCPPrices, c *config.Config, fetched string) []plan.Line {
	f := plan.FloorOf(c)
	standard := c.Cluster.Mode == "standard"
	disks := (f.VolumeGiB + f.OptionalVolumeGiB) * p.BalancedDisk
	fee := p.ClusterFee * hoursPerMonth

	var stepHour float64
	var platformHour [2]float64
	var always float64 // besides the fee
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
		disks += nodeDiskGiB * p.BalancedDisk
		// The platform's node runs whether or not the platform sleeps.
		always = (node.cores*p.E2Core + node.ramGiB*p.E2Ram) * hoursPerMonth
		if c.StepHeadroom > 0 {
			// The steps pool keeps one node (e2-standard-4) for it.
			always += (4*core + 16*ram) * hoursPerMonth
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
	likelyHigh := likelyLow + fee + (platformHour[1]-platformHour[0])*awakeHours

	lines := []plan.Line{
		{Label: "Estimated cost", Text: fmt.Sprintf("a month, %s in USD, %s, %s", orList(p.Basis), p.Region, fetched)},
		{Label: "  Cluster fee", Text: fmt.Sprintf("%s (GKE's free tier credit covers one Autopilot or zonal cluster per billing account)", money(fee))},
	}
	if sqlMonth > 0 {
		lines = append(lines, plan.Line{Label: "  Database", Text: fmt.Sprintf("%s: Cloud SQL, its %d GB of SSD and backups' first copy, awake or asleep (in Always below)", money(sqlMonth), sqlDiskGiB)})
	}
	if standard {
		lines = append(lines, plan.Line{Label: "  Always", Text: fmt.Sprintf("%s: the platform's node and %s%s, awake or asleep", money(always), alwaysWhat(c), lbNote(c))})
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
		plan.Line{Label: "  Not included", Text: "discounts, taxes, network egress, backups and images in storage (cents a GB), your products' own cloud usage"},
	)
	return lines
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

func moneyRange(lo, hi float64) string {
	if hi-lo < 0.5 {
		return "~" + money(lo)
	}
	return money(lo) + "–" + money(hi)
}
