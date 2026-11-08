// SPDX-License-Identifier: MIT

package pricing

import (
	"fmt"
	"strings"

	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/plan"
)

// azureAllocatable is what AKS leaves Pods on each VM, vCPU and GiB: its
// kube-reserved CPU (100m of two cores, 140m of four) and memory (the lesser
// of 20 MB a Pod of the node's 250 and a quarter of its memory, so the
// quarter), less the 100 MiB eviction threshold.
var azureAllocatable = map[string][2]float64{
	"Standard_B2s": {1.9, 2.9}, "Standard_B2ms": {1.9, 5.9}, "Standard_D2as_v5": {1.9, 5.9}, "Standard_D4as_v5": {3.86, 11.9},
}

// What else needs room besides the platform's requests, vCPU and GiB: on
// every node AKS's own Pods (Cilium, the CSI drivers, the cloud node
// manager), and once a cluster two CoreDNS, two metrics-server, two
// konnectivity agents and Workload Identity's webhook. Estimates, not yet
// checked against a live node.
var (
	aksPerNode = [2]float64{0.25, 0.35}
	aksSystem  = [2]float64{0.4, 0.6}
)

// azureVolumeTier is the Standard SSD tier a Postgres volume of gib rounds
// up to (AKS's default StorageClass, managed-csi).
func azureVolumeTier(gib float64) string {
	switch {
	case gib <= 16:
		return "E3"
	case gib <= 64:
		return "E6"
	}
	return "E10"
}

// azureSpot is whether the steps pool is Spot, as the module decides it.
func azureSpot(c *config.Config, f plan.Floor) bool {
	return f.Spot && !c.Azure.OnDemandSteps && !strings.HasPrefix(azurePools[c.Size].steps, "Standard_B")
}

// Azure is the cost section of the approval screen for an azure install.
func Azure(p *AzurePrices, c *config.Config, fetched string) []plan.Line {
	f := plan.FloorOf(c)
	pools := azurePools[c.Size]
	disk := p.Disks[pools.disk] / hoursPerMonth
	platform := p.VMs[pools.platform]
	a := azureAllocatable[pools.platform]
	nodes := nodesFor(f, aksSystem, [2]float64{a[0] - aksPerNode[0], a[1] - aksPerNode[1]})
	nodeMonth := (platform.OnDemand + disk) * hoursPerMonth

	// AKS's control plane is free (its Free tier); its load balancer, with
	// the outbound address, the registry and the database's volume aren't.
	fixed := (p.LoadBalancer+p.PublicIP)*hoursPerMonth + p.Registry*hoursPerMonth/24 + p.Disks[azureVolumeTier(f.VolumeGiB)]
	always := fixed + float64(nodes[0])*nodeMonth
	more := float64(nodes[1]-nodes[0]) * nodeMonth

	steps := p.VMs[pools.steps]
	price, capacity := steps.OnDemand, "on-demand"
	switch {
	case azureSpot(c, f) && steps.Spot > 0:
		price, capacity = steps.Spot, "Spot"
	case f.Spot && c.Azure.OnDemandSteps:
		capacity = "on-demand: Spot is off (azure.onDemandSteps)"
	case f.Spot:
		capacity = "on-demand: " + pools.steps + " has no Spot"
	}
	vm := azureVMs[pools.steps]
	stepHour := max(f.StepCPU/vm[0], f.StepMemGiB/vm[1]) * (price + disk)
	if c.StepHeadroom > 0 {
		// The steps pool keeps a whole node for it.
		always += (price + disk) * hoursPerMonth
	}
	likely := always + stepHour*lightStepHours
	return []plan.Line{
		{Label: "Estimated cost", Text: fmt.Sprintf("a month, list prices in USD, %s, %s", p.Region, fetched)},
		{Label: "  Always", Text: fmt.Sprintf("%s: %s for the platform (as many as its requests need), AKS's load balancer and outbound address, the registry and the database's volume, awake or asleep (AKS's Free tier: no cluster fee)",
			moneySpan(always, always+more), nodeWords(nodes, pools.platform))},
		{Label: "  Steps", Text: fmt.Sprintf("%s per step-hour at the default size (%s, %s); %s a month at the cap of %d if always busy",
			money(stepHour), pools.steps, capacity, money(stepHour*float64(f.StepCap)*hoursPerMonth), f.StepCap)},
		{Label: "  Likely", Text: fmt.Sprintf("%s for light use (%d step-hours); sleeping saves nothing here, since the platform's nodes stay",
			moneySpan(likely, likely+more), lightStepHours)},
		{Label: "  Not included", Text: notIncluded("discounts, credits (a Free Trial's among them), taxes, data transfer, backups and images in storage (cents a GB)", "your products' own Azure usage")},
	}
}
