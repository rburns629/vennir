// SPDX-License-Identifier: MIT

package catalogtool

import (
	"context"
	"fmt"
	"strings"
)

func (c *Catalog) layoutOK() bool {
	teams := c.ValidateTeams()
	owners := c.ValidateCodeowners()
	dags := c.ValidateDags()
	apis := c.ValidateAPIs()
	bases := c.ValidateBases()
	types := c.ValidateWiringTypes()
	environments := c.ValidateBuildEnvironments()
	return teams && owners && dags && apis && bases && types && environments
}

// Check validates, builds, tests and scans, and returns the products that
// passed all of it (checkProduct: some are loaded rather than built, and
// some only validated unless publishing). Every product is tried, so one
// failure never hides another's result.
func (c *Catalog) Check(products []*Product, publishing bool) []*Product {
	layout := c.layoutOK()
	// A vertra.yaml that doesn't read is layoutOK's to report.
	s, _ := c.Settings()
	var passed []*Product
	for _, p := range products {
		end := c.group(p.Label())
		if c.checkProduct(p, s, publishing) {
			c.info("PASS %s", p.Label())
			passed = append(passed, p)
		} else {
			c.info("FAIL %s", p.Label())
		}
		end()
	}
	if !layout {
		return nil
	}
	return passed
}

// withUnpublished is the products changed, and every other product whose
// image for its commit isn't in the registry, or isn't signed, as a release
// needs it (publishedImage). A change the diff nets out (changed, then
// reverted) still moves the product's commit, and a run the concurrency
// group skipped never published its products: this publishes them, rather
// than every later release being refused until someone runs CI by hand.
func (c *Catalog) withUnpublished(ctx context.Context, changed []*Product, s Settings) []*Product {
	chosen := map[string]bool{}
	for _, p := range changed {
		chosen[p.Label()] = true
	}
	var out []*Product
	for _, p := range c.AllProducts() {
		if !chosen[p.Label()] && !p.IsTemplate() {
			if _, problem := c.publishedImage(ctx, p, s); problem != "" {
				c.info("Also publishing %s: %s", p.Label(), problem)
				chosen[p.Label()] = true
			}
		}
		if chosen[p.Label()] {
			out = append(out, p)
		}
	}
	return out
}

// Products runs validate, check or publish on the products named (or
// changed since a ref, or all), and says whether every one passed.
func (c *Catalog) Products(ctx context.Context, command string, names []string, changedSince *string) (bool, error) {
	products, err := c.SelectProducts(names, changedSince)
	if err != nil {
		return false, err
	}
	var settings Settings
	if command == "publish" {
		if settings, err = c.Settings(); err != nil {
			return false, err
		}
		if problems := settings.Problems(); len(problems) > 0 {
			for _, p := range problems {
				c.errorAt(c.path("vertra.yaml"), p)
			}
			return false, nil
		}
		if changedSince != nil && c.Getenv("GITHUB_SHA") != "" {
			products = c.withUnpublished(ctx, products, settings)
		}
	}
	if len(products) == 0 {
		c.info("No products to check.")
		ok := c.layoutOK()
		// A change that only removed products is still checked.
		if changedSince != nil {
			ok = c.Compatibility(*changedSince, nil) && ok
		}
		return ok, nil
	}
	if command == "validate" {
		ok := c.layoutOK()
		for _, p := range products {
			ok = c.ValidateProduct(p) && ok
		}
		if changedSince != nil {
			ok = c.Compatibility(*changedSince, products) && ok
		}
		return ok, nil
	}

	if command == "publish" {
		var templates []string
		var publishable []*Product
		for _, p := range products {
			if p.IsTemplate() {
				templates = append(templates, p.Label())
			} else {
				publishable = append(publishable, p)
			}
		}
		if len(templates) > 0 && len(names) > 0 {
			return false, fmt.Errorf("templates are checked, never published: %s", strings.Join(templates, ", "))
		}
		products = publishable
	}

	passed := c.Check(products, command == "publish")
	// A breaking change fails every product's run, as a layout problem does:
	// it's the catalog's contract, not one product's build.
	if changedSince != nil && !c.Compatibility(*changedSince, passed) {
		passed = nil
	}
	if command != "publish" {
		c.info("\n%d of %d product(s) passed.", len(passed), len(products))
		return len(passed) == len(products), nil
	}
	published := 0
	for _, p := range passed {
		if c.Publish(p, settings) {
			published++
		}
	}
	c.info("\nPublished %d of %d product(s).", published, len(products))
	return published == len(products), nil
}
