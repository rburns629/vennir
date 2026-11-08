// SPDX-License-Identifier: MIT

package pricing

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/roburns/vennir/cli/internal/run"
)

// AWS's prices: the Price List Query API (only served from us-east-1,
// whatever region is priced) and EC2's Spot price history, both read with
// your AWS sign-in (`aws pricing`, `aws ec2`). Cached a day per region.

// AWSPrices are the prices an estimate needs, in USD.
type AWSPrices struct {
	Region  string
	Fetched time.Time
	// The EKS cluster fee, per hour.
	ClusterFee float64
	// Per instance type: on-demand, Spot (averaged across zones now), and
	// Auto Mode's management fee, per hour.
	Instances map[string]InstancePrice
	// gp3 storage, per GiB-month; a public IPv4 address, per hour.
	GP3      float64
	PublicIP float64
	// SpotUnavailable: Spot prices couldn't be read.
	SpotUnavailable bool
	// The public console: an Application Load Balancer, per hour, and its
	// Route 53 zone, per month.
	LoadBalancer, HostedZone float64
	// RDS for PostgreSQL, when a managed database is priced: per instance
	// class, [0] Single-AZ and [1] Multi-AZ, per hour; gp3 storage likewise,
	// per GiB-month.
	RDS        map[string][2]float64
	RDSStorage [2]float64
}

// RDSClasses are the instance classes the aws module picks by size (keep
// in step with its locals).
var RDSClasses = map[string]string{"minimal": "db.t4g.small", "resilient": "db.t4g.medium", "auto": "db.t4g.medium", "scaled": "db.m7g.large"}

// InstancePrice is one instance type's hourly prices.
type InstancePrice struct {
	VCPU, MemGiB        float64
	OnDemand, Spot, Fee float64
}

// awsInstances are the instance types the estimate prices: what Auto Mode
// would likely pick for the platform and for steps (keep in step with
// estimate_aws.go).
var awsInstances = map[string][2]float64{"c6a.large": {2, 4}, "m6a.large": {2, 8}}

func awsArgs(profile string, a ...string) []string {
	if profile != "" {
		a = append(a, "--profile", profile)
	}
	return a
}

// FetchAWS returns the region's prices, from the cache when it's less than a
// day old; with withRDS, RDS's too.
func FetchAWS(ctx context.Context, r *run.Runner, profile, region string, withRDS bool) (*AWSPrices, error) {
	cache := cachePath("aws-" + region + ".json")
	if p := readAWSCache(cache); p != nil && time.Since(p.Fetched) < 24*time.Hour && (!withRDS || len(p.RDS) > 0) {
		return p, nil
	}
	p := &AWSPrices{Region: region, Instances: map[string]InstancePrice{}}
	// Each price is its own call to the price list (a second or so each,
	// mostly the aws CLI starting): made a few at a time, not in a row.
	var prices []priceCall
	price := func(into *float64, service string, filters ...string) {
		prices = append(prices, priceCall{into: into, get: func() (float64, error) {
			return awsPrice(ctx, r, profile, service, region, filters...)
		}})
	}
	price(&p.ClusterFee, "AmazonEKS",
		"Type=TERM_MATCH,Field=operation,Value=CreateOperation",
		"Type=TERM_MATCH,Field=locationType,Value=AWS Region",
		"Type=CONTAINS,Field=usagetype,Value=AmazonEKS-Hours:perCluster")
	price(&p.GP3, "AmazonEC2",
		"Type=TERM_MATCH,Field=productFamily,Value=Storage",
		"Type=TERM_MATCH,Field=volumeApiName,Value=gp3")
	price(&p.PublicIP, "AmazonVPC",
		"Type=CONTAINS,Field=usagetype,Value=PublicIPv4:InUseAddress")
	price(&p.LoadBalancer, "AWSELB",
		"Type=TERM_MATCH,Field=productFamily,Value=Load Balancer-Application",
		"Type=TERM_MATCH,Field=locationType,Value=AWS Region",
		"Type=CONTAINS,Field=usagetype,Value=LoadBalancerUsage")
	// Route 53 is priced globally: no region filter.
	prices = append(prices, priceCall{into: &p.HostedZone, get: func() (float64, error) {
		return awsGlobalPrice(ctx, r, profile, "AmazonRoute53", "Type=TERM_MATCH,Field=usagetype,Value=HostedZone")
	}})
	instances := map[string]*InstancePrice{}
	for name, size := range awsInstances {
		ip := &InstancePrice{VCPU: size[0], MemGiB: size[1]}
		instances[name] = ip
		price(&ip.OnDemand, "AmazonEC2",
			"Type=TERM_MATCH,Field=instanceType,Value="+name,
			"Type=TERM_MATCH,Field=operatingSystem,Value=Linux",
			"Type=TERM_MATCH,Field=tenancy,Value=Shared",
			"Type=TERM_MATCH,Field=preInstalledSw,Value=NA",
			"Type=TERM_MATCH,Field=capacitystatus,Value=Used")
		price(&ip.Fee, "AmazonEKS",
			"Type=TERM_MATCH,Field=operation,Value=EKSAutoUsage",
			"Type=CONTAINS,Field=usagetype,Value=EKS-Auto:"+name+"-management-hours")
		// Spot prices can be off limits (an organization's policy may deny
		// reading them): then steps are priced on-demand, and the screen says so.
		prices = append(prices, priceCall{into: &ip.Spot, optional: true, get: func() (float64, error) {
			return spotPrice(ctx, r, profile, region, name)
		}})
	}
	rds := map[string]*[2]float64{}
	if withRDS {
		for _, class := range RDSClasses {
			both := &[2]float64{}
			rds[class] = both
			for i, deployment := range []string{"Single-AZ", "Multi-AZ"} {
				price(&both[i], "AmazonRDS",
					"Type=TERM_MATCH,Field=instanceType,Value="+class,
					"Type=TERM_MATCH,Field=databaseEngine,Value=PostgreSQL",
					"Type=TERM_MATCH,Field=deploymentOption,Value="+deployment)
			}
		}
		for i, deployment := range []string{"Single-AZ", "Multi-AZ"} {
			price(&p.RDSStorage[i], "AmazonRDS",
				"Type=TERM_MATCH,Field=productFamily,Value=Database Storage",
				"Type=TERM_MATCH,Field=volumeType,Value=General Purpose-GP3",
				"Type=TERM_MATCH,Field=databaseEngine,Value=PostgreSQL",
				"Type=TERM_MATCH,Field=deploymentOption,Value="+deployment)
		}
	}
	unavailable, err := getAll(prices, 8)
	if err != nil {
		return nil, err
	}
	p.SpotUnavailable = unavailable
	for name, ip := range instances {
		p.Instances[name] = *ip
	}
	if withRDS {
		p.RDS = map[string][2]float64{}
		for class, both := range rds {
			p.RDS[class] = *both
		}
	}
	p.Fetched = time.Now()
	if data, err := json.Marshal(p); err == nil {
		writeRaw(cache, data)
	}
	return p, nil
}

// priceCall is one price to fetch, and where it goes. An optional one that
// fails is left at zero.
type priceCall struct {
	into     *float64
	get      func() (float64, error)
	optional bool
}

// getAll makes the calls, limit at a time. It returns the first required
// call's error, and whether an optional one failed.
func getAll(calls []priceCall, limit int) (optionalFailed bool, err error) {
	errs := make([]error, len(calls))
	slots := make(chan struct{}, limit)
	var wg sync.WaitGroup
	for i, call := range calls {
		wg.Go(func() {
			slots <- struct{}{}
			defer func() { <-slots }()
			*call.into, errs[i] = call.get()
		})
	}
	wg.Wait()
	for i, call := range calls {
		switch {
		case errs[i] == nil:
		case call.optional:
			*call.into, optionalFailed = 0, true
		default:
			return optionalFailed, errs[i]
		}
	}
	return optionalFailed, nil
}

// awsPrice is the one on-demand price matching filters in region.
func awsPrice(ctx context.Context, r *run.Runner, profile, service, region string, filters ...string) (float64, error) {
	args := []string{"pricing", "get-products", "--region", "us-east-1", "--service-code", service, "--output", "json",
		"--max-results", "10", "--filters", "Type=TERM_MATCH,Field=regionCode,Value=" + region}
	args = append(args, filters...)
	out, err := r.Output(ctx, "aws", awsArgs(profile, args...)...)
	if err != nil {
		return 0, fmt.Errorf("reading AWS's prices: %w", err)
	}
	prices, err := onDemandPrices([]byte(out))
	if err != nil {
		return 0, err
	}
	if len(prices) == 0 {
		return 0, fmt.Errorf("AWS's price list has no %s price for %v in %s", service, filters, region)
	}
	// Several entries can match (a free first tier, say): the highest is
	// what's paid past it.
	best := 0.0
	for _, v := range prices {
		best = max(best, v)
	}
	return best, nil
}

// awsGlobalPrice is awsPrice for a service priced the same everywhere.
func awsGlobalPrice(ctx context.Context, r *run.Runner, profile, service string, filters ...string) (float64, error) {
	args := append([]string{"pricing", "get-products", "--region", "us-east-1", "--service-code", service, "--output", "json",
		"--max-results", "10", "--filters"}, filters...)
	out, err := r.Output(ctx, "aws", awsArgs(profile, args...)...)
	if err != nil {
		return 0, fmt.Errorf("reading AWS's prices: %w", err)
	}
	prices, err := onDemandPrices([]byte(out))
	if err != nil || len(prices) == 0 {
		return 0, fmt.Errorf("AWS's price list has no %s price for %v", service, filters)
	}
	best := 0.0
	for _, v := range prices {
		best = max(best, v)
	}
	return best, nil
}

// onDemandPrices reads `aws pricing get-products` output: each product's
// OnDemand price dimensions, in USD.
func onDemandPrices(data []byte) ([]float64, error) {
	var out struct {
		PriceList []string `json:"PriceList"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	var prices []float64
	for _, raw := range out.PriceList {
		var item struct {
			Terms struct {
				OnDemand map[string]struct {
					PriceDimensions map[string]struct {
						PricePerUnit map[string]string `json:"pricePerUnit"`
					} `json:"priceDimensions"`
				} `json:"OnDemand"`
			} `json:"terms"`
		}
		if err := json.Unmarshal([]byte(raw), &item); err != nil {
			return nil, err
		}
		for _, term := range item.Terms.OnDemand {
			for _, d := range term.PriceDimensions {
				if v, err := strconv.ParseFloat(d.PricePerUnit["USD"], 64); err == nil {
					prices = append(prices, v)
				}
			}
		}
	}
	return prices, nil
}

// spotPrice is an instance type's current Spot price, averaged across the
// region's zones.
func spotPrice(ctx context.Context, r *run.Runner, profile, region, instance string) (float64, error) {
	out, err := r.Output(ctx, "aws", awsArgs(profile, "ec2", "describe-spot-price-history", "--region", region, "--output", "json",
		"--instance-types", instance, "--product-descriptions", "Linux/UNIX",
		"--start-time", time.Now().UTC().Format(time.RFC3339))...)
	if err != nil {
		return 0, fmt.Errorf("reading Spot prices: %w", err)
	}
	return averageSpot([]byte(out))
}

func averageSpot(data []byte) (float64, error) {
	var out struct {
		SpotPriceHistory []struct {
			SpotPrice string `json:"SpotPrice"`
		} `json:"SpotPriceHistory"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return 0, err
	}
	total, n := 0.0, 0
	for _, s := range out.SpotPriceHistory {
		if v, err := strconv.ParseFloat(s.SpotPrice, 64); err == nil {
			total += v
			n++
		}
	}
	if n == 0 {
		return 0, fmt.Errorf("no Spot price")
	}
	return total / float64(n), nil
}

func readAWSCache(path string) *AWSPrices {
	data, err := readRaw(path)
	if err != nil {
		return nil
	}
	var p AWSPrices
	if json.Unmarshal(data, &p) != nil || p.Instances == nil {
		return nil
	}
	return &p
}
