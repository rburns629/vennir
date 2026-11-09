// SPDX-License-Identifier: MIT

package pricing

import (
	"strings"
	"testing"

	"github.com/roburns/vennir/cli/internal/config"
)

// eastus2's list prices on 2026-11-08.
func azurePrices() *AzurePrices {
	return &AzurePrices{
		Region: "eastus2",
		VMs: map[string]VMPrice{
			"Standard_D2als_v6": {OnDemand: 0.0804, Spot: 0.014858}, "Standard_D2as_v6": {OnDemand: 0.0908, Spot: 0.01678},
			"Standard_D4as_v6": {OnDemand: 0.182, Spot: 0.033634},
		},
		LoadBalancer: 0.025, PublicIP: 0.005, Registry: 0.1666,
		Disks: map[string]float64{"P4": 4.8001, "P6": 9.2801, "E3": 1.2, "E6": 4.8, "E10": 9.6},
	}
}

func TestAzureMinimal(t *testing.T) {
	c := config.Default("azure")
	c.Azure.OnDemandSteps = true // a Free Trial's
	lines := Azure(azurePrices(), c, "now")
	text := map[string]string{}
	for _, l := range lines {
		text[strings.TrimSpace(l.Label)] = l.Text
	}
	// One D2as_v6 and its P4 ($71.08), the load balancer and its address
	// ($21.90), ACR Basic ($5.07) and an E3 for Postgres ($1.20).
	if !strings.HasPrefix(text["Always"], "$99.25: one Standard_D2as_v6 node") {
		t.Errorf("always: %s", text["Always"])
	}
	// A quarter vCPU and half a GiB is an eighth of a D2als_v6, on-demand.
	if !strings.HasPrefix(text["Steps"], "$0.011 per step-hour at the default size (Standard_D2als_v6, on-demand: Spot is off (azure.onDemandSteps))") {
		t.Errorf("steps: %s", text["Steps"])
	}
}

func TestAzureSpotSteps(t *testing.T) {
	c := config.Default("azure")
	c.Size = "resilient"
	if got := Azure(azurePrices(), c, "now")[2].Text; !strings.Contains(got, "(Standard_D4as_v6, Spot)") {
		t.Errorf("steps: %s", got)
	}
	c.Azure.OnDemandSteps = true
	if got := Azure(azurePrices(), c, "now")[2].Text; !strings.Contains(got, "on-demand: Spot is off (azure.onDemandSteps)") {
		t.Errorf("steps, on-demand: %s", got)
	}
}
