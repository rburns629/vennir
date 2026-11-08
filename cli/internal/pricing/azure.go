// SPDX-License-Identifier: MIT

package pricing

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Azure's Retail Prices API: public list prices, no sign-in.
const azureRetailPrices = "https://prices.azure.com/api/retail/prices"

// azurePools are the azure module's pools per size: the system pool's VM,
// the steps pool's, and each node's OS disk (keep in step with
// modules/azure/main.tf's pools). vCPU and GiB per VM are Azure's.
var azurePools = map[string]struct {
	platform, steps string
	disk            string // the OS disk's Premium SSD tier
}{
	"minimal":   {"Standard_B2ms", "Standard_B2s", "P4"},
	"resilient": {"Standard_D2as_v5", "Standard_D4as_v5", "P6"},
	"scaled":    {"Standard_D2as_v5", "Standard_D4as_v5", "P6"},
	"auto":      {"Standard_D2as_v5", "Standard_D4as_v5", "P6"},
}

// azureVMs are each VM's vCPU and GiB.
var azureVMs = map[string][2]float64{
	"Standard_B2s": {2, 4}, "Standard_B2ms": {2, 8}, "Standard_D2as_v5": {2, 8}, "Standard_D4as_v5": {4, 16},
}

// AzurePrices are the list prices an estimate needs, in USD.
type AzurePrices struct {
	Region  string
	Fetched time.Time
	// Linux VMs, per hour: on-demand, and Spot (0 where there's none, as
	// for B-series).
	VMs map[string]VMPrice
	// AKS's Standard load balancer (its first rules, the outbound one
	// among them) and its outbound address, per hour.
	LoadBalancer, PublicIP float64
	// ACR Basic, per day.
	Registry float64
	// Managed disks, per month, by tier (P4, E3, ...).
	Disks map[string]float64
}

// VMPrice is one VM's hourly prices.
type VMPrice struct{ OnDemand, Spot float64 }

// azureItem is one price the API gives.
type azureItem struct {
	ProductName   string  `json:"productName"`
	SkuName       string  `json:"skuName"`
	MeterName     string  `json:"meterName"`
	ArmRegionName string  `json:"armRegionName"`
	RetailPrice   float64 `json:"retailPrice"`
	Type          string  `json:"type"`
}

// azureQuery asks the API for the prices a filter matches (one page: the
// filters here are narrow).
func azureQuery(ctx context.Context, filter string) ([]azureItem, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, azureRetailPrices+"?"+url.Values{"$filter": {filter}}.Encode(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Azure's price list answered %s", resp.Status)
	}
	var body struct {
		Items []azureItem `json:"Items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, err
	}
	var items []azureItem
	for _, i := range body.Items {
		if i.Type == "Consumption" {
			items = append(items, i)
		}
	}
	return items, nil
}

// FetchAzure reads the prices an azure install's estimate needs, cached a
// day.
func FetchAzure(ctx context.Context, region string) (*AzurePrices, error) {
	cache := cachePath("azure-" + region + ".json")
	if data, err := readRaw(cache); err == nil {
		var p AzurePrices
		if json.Unmarshal(data, &p) == nil && time.Since(p.Fetched) < gcpCacheLifetime && p.Region == region {
			return &p, nil
		}
	}
	p := &AzurePrices{Region: region, Fetched: time.Now(), VMs: map[string]VMPrice{}, Disks: map[string]float64{}}
	for vm := range azureVMs {
		items, err := azureQuery(ctx, fmt.Sprintf("serviceName eq 'Virtual Machines' and armRegionName eq '%s' and armSkuName eq '%s'", region, vm))
		if err != nil {
			return nil, err
		}
		var price VMPrice
		for _, i := range items {
			if strings.Contains(i.ProductName, "Windows") || strings.Contains(i.ProductName, "Cloud Services") || strings.Contains(i.SkuName, "Low Priority") {
				continue
			}
			if strings.HasSuffix(i.SkuName, " Spot") {
				price.Spot = i.RetailPrice
			} else {
				price.OnDemand = i.RetailPrice
			}
		}
		if price.OnDemand == 0 {
			return nil, fmt.Errorf("no price for %s in %s", vm, region)
		}
		p.VMs[vm] = price
	}
	one := func(into *float64, filter string, match func(azureItem) bool) error {
		items, err := azureQuery(ctx, filter)
		if err != nil {
			return err
		}
		for _, i := range items {
			if match(i) {
				*into = i.RetailPrice
				return nil
			}
		}
		return fmt.Errorf("no price for %s", filter)
	}
	// The load balancer's rules are priced globally.
	if err := one(&p.LoadBalancer, "serviceName eq 'Load Balancer' and skuName eq 'Standard' and meterName eq 'Standard Included LB Rules and Outbound Rules'",
		func(i azureItem) bool { return i.ArmRegionName == "Global" || i.ArmRegionName == region }); err != nil {
		return nil, err
	}
	if err := one(&p.PublicIP, fmt.Sprintf("serviceName eq 'Virtual Network' and armRegionName eq '%s' and meterName eq 'Standard IPv4 Static Public IP'", region),
		func(azureItem) bool { return true }); err != nil {
		return nil, err
	}
	if err := one(&p.Registry, fmt.Sprintf("serviceName eq 'Container Registry' and armRegionName eq '%s' and skuName eq 'Basic' and meterName eq 'Basic Registry Unit'", region),
		func(azureItem) bool { return true }); err != nil {
		return nil, err
	}
	for _, tier := range []string{"P4", "P6", "E3", "E6", "E10"} {
		var price float64
		product := "Premium SSD Managed Disks"
		if strings.HasPrefix(tier, "E") {
			product = "Standard SSD Managed Disks"
		}
		if err := one(&price, fmt.Sprintf("serviceName eq 'Storage' and armRegionName eq '%s' and skuName eq '%s LRS' and meterName eq '%s LRS Disk'", region, tier, tier),
			func(i azureItem) bool { return i.ProductName == product }); err != nil {
			return nil, err
		}
		p.Disks[tier] = price
	}
	if data, err := json.Marshal(p); err == nil {
		writeRaw(cache, data)
	}
	return p, nil
}
