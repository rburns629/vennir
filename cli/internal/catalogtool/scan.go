// SPDX-License-Identifier: MIT

package catalogtool

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// Scanners run from these images when they aren't installed (a laptop). CI
// installs checksum-pinned binaries instead (.github/scripts/install-scanners.sh),
// at the same versions.
const (
	trivyImage      = "aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969"
	osvScannerImage = "ghcr.io/google/osv-scanner:v2.6.0@sha256:afd838850ac1a0fcc15ff4a041dc9ba11123c3f0d2666217a5f0fcf9222b55fa"
	// Trivy's vulnerability database, kept between local runs.
	trivyCacheVolume = "vennir-trivy-cache"
)

// scanner is the command that runs a scanner: installed, or else from its
// pinned image, with work (holding the image archive) mounted at the same path.
func (c *Catalog) scanner(binary, image, work string, args []string, cache bool) ([]string, error) {
	if path, err := exec.LookPath(binary); err == nil {
		return append([]string{path}, args...), nil
	}
	docker, err := c.dockerBinary()
	if err != nil {
		return nil, err
	}
	volumes := []string{"-v", work + ":" + work}
	if cache {
		volumes = append(volumes, "-v", trivyCacheVolume+":/root/.cache")
	}
	return append(append(append([]string{docker, "run", "--rm"}, volumes...), image), args...), nil
}

// Scan blocks a fixable HIGH or CRITICAL vulnerability, a secret baked into
// the image, or a known-malicious package. Unfixable vulnerabilities are
// reported, not blocking. An accepted vulnerability goes in the product's
// .trivyignore, one id per line with a comment saying why; its review is
// what accepts it.
func (c *Catalog) Scan(p *Product) bool {
	work, cleanup, err := tempDir("vennir-scan-")
	if err != nil {
		c.errorAt(p.Dir, err.Error())
		return false
	}
	defer cleanup()
	archive := filepath.Join(work, "image.tar")
	if _, err := c.docker(false, "save", p.LocalImage(), "-o", archive); err != nil {
		c.errorAt(p.Dir, err.Error())
		return false
	}
	trivyArgs := []string{"image", "--input", archive, "--quiet", "--scanners", "vuln,secret",
		"--format", "json", "--output", filepath.Join(work, "trivy.json")}
	if ignore, err := os.ReadFile(filepath.Join(p.Dir, ".trivyignore")); err == nil {
		copied := filepath.Join(work, ".trivyignore")
		if err := os.WriteFile(copied, ignore, 0o644); err != nil {
			c.errorAt(p.Dir, err.Error())
			return false
		}
		trivyArgs = append(trivyArgs, "--ignorefile", copied)
	}
	lines := []string{fmt.Sprintf("### Security scan: `%s`", p.Label()), ""}
	ok := true

	trivyCmd, err := c.scanner("trivy", trivyImage, work, trivyArgs, true)
	var trivyRun runResult
	if err == nil {
		trivyRun, err = c.run(0, false, trivyCmd[0], trivyCmd[1:]...)
	}
	trivyReport, readErr := os.ReadFile(filepath.Join(work, "trivy.json"))
	var report trivyReportJSON
	if err != nil || trivyRun.code != 0 || readErr != nil || json.Unmarshal(trivyReport, &report) != nil {
		lines = append(lines, "- :x: Trivy couldn't scan the image.")
		c.errorAt(p.Dir, "Trivy couldn't scan the image")
		ok = false
	} else {
		ok = c.trivyVerdict(p, report, &lines) && ok
	}
	// Its bill of materials, from the same archive, for publishing to
	// attach (signed) beside the image. Not a verdict: none blocks nothing.
	sbomArgs := []string{"image", "--input", archive, "--quiet", "--format", "cyclonedx", "--output", filepath.Join(work, "sbom.json")}
	if sbomCmd, err := c.scanner("trivy", trivyImage, work, sbomArgs, true); err == nil {
		if r, err := c.run(0, true, sbomCmd[0], sbomCmd[1:]...); err == nil && r.code == 0 {
			p.SBOM, _ = os.ReadFile(filepath.Join(work, "sbom.json"))
		}
	}

	// osv-scanner exits non-zero for any known vulnerability, so its
	// report, not its exit code, is the verdict; no report blocks.
	osvReport := filepath.Join(work, "osv.json")
	osvCmd, err := c.scanner("osv-scanner", osvScannerImage, work,
		[]string{"scan", "image", "--archive", archive, "--format", "json", "--output", osvReport}, false)
	var osvRun runResult
	if err == nil {
		osvRun, err = c.run(0, true, osvCmd[0], osvCmd[1:]...)
	}
	osvData, readErr := os.ReadFile(osvReport)
	var osv osvReportJSON
	if err != nil || readErr != nil || len(osvData) == 0 || json.Unmarshal(osvData, &osv) != nil {
		lines = append(lines, "- :x: OSV-Scanner couldn't scan the image.")
		why := osvRun.stderr
		if why == "" {
			why = osvRun.stdout
		}
		if err != nil {
			why = err.Error()
		}
		c.errorAt(p.Dir, "OSV-Scanner couldn't scan the image: "+lastChars(why, 500))
		ok = false
	} else {
		ok = c.osvVerdict(p, osv, &lines) && ok
	}
	c.summary(strings.Join(lines, "\n") + "\n")
	return ok
}

type trivyReportJSON struct {
	Results []struct {
		Target          string
		Vulnerabilities []struct {
			VulnerabilityID  string
			PkgName          string
			InstalledVersion string
			FixedVersion     string
			Severity         string
		}
		Secrets []struct {
			RuleID string
			Title  string
		}
	}
}

func (c *Catalog) trivyVerdict(p *Product, report trivyReportJSON, lines *[]string) bool {
	type vuln struct{ severity, pkg, installed, fixed, id string }
	type secret struct{ target, rule, title string }
	var blocking []vuln
	var secrets []secret
	unfixed := 0
	for _, r := range report.Results {
		for _, v := range r.Vulnerabilities {
			if v.Severity == "HIGH" || v.Severity == "CRITICAL" {
				if v.FixedVersion != "" {
					blocking = append(blocking, vuln{v.Severity, v.PkgName, v.InstalledVersion, v.FixedVersion, v.VulnerabilityID})
				} else {
					unfixed++
				}
			}
		}
		for _, s := range r.Secrets {
			secrets = append(secrets, secret{r.Target, s.RuleID, s.Title})
		}
	}
	if len(blocking) > 0 {
		*lines = append(*lines, fmt.Sprintf("- :x: %d HIGH/CRITICAL vulnerabilities with a fix available:", len(blocking)), "",
			"  | Severity | Package | Installed | Fixed in | ID |", "  |---|---|---|---|---|")
		sort.SliceStable(blocking, func(i, j int) bool {
			ci, cj := blocking[i].severity == "CRITICAL", blocking[j].severity == "CRITICAL"
			if ci != cj {
				return ci
			}
			return blocking[i].pkg < blocking[j].pkg
		})
		for _, v := range blocking {
			*lines = append(*lines, fmt.Sprintf("  | %s | %s | %s | %s | %s |", v.severity, v.pkg, v.installed, v.fixed, v.id))
			c.errorAt(p.Dir, fmt.Sprintf("%s %s in %s %s (fixed in %s)", v.severity, v.id, v.pkg, v.installed, v.fixed))
		}
		*lines = append(*lines, "", "  Rebuilding on a fresh base usually fixes these (`apt-get upgrade` for "+
			"OS packages, a newer pin for language packages).")
	} else {
		*lines = append(*lines, "- :white_check_mark: No HIGH/CRITICAL vulnerability with a fix available.")
	}
	if unfixed > 0 {
		*lines = append(*lines, fmt.Sprintf("- :information_source: %d HIGH/CRITICAL with no fix yet (reported, not blocking).", unfixed))
	}
	if len(secrets) > 0 {
		*lines = append(*lines, fmt.Sprintf("- :x: %d secret(s) baked into the image:", len(secrets)))
		for _, s := range secrets {
			*lines = append(*lines, fmt.Sprintf("  - `%s`: %s (%s)", s.target, s.title, s.rule))
			c.errorAt(p.Dir, fmt.Sprintf("secret in %s: %s (%s)", s.target, s.title, s.rule))
		}
	} else {
		*lines = append(*lines, "- :white_check_mark: No secrets in the image.")
	}
	c.info("  Trivy: %d fixable HIGH/CRITICAL, %d unfixable (not blocking), %d secret(s)", len(blocking), unfixed, len(secrets))
	return len(blocking) == 0 && len(secrets) == 0
}

type osvReportJSON struct {
	Results []struct {
		Packages []struct {
			Package struct {
				Name    string `json:"name"`
				Version string `json:"version"`
			} `json:"package"`
			Vulnerabilities []struct {
				ID string `json:"id"`
			} `json:"vulnerabilities"`
		} `json:"packages"`
	} `json:"results"`
}

func (c *Catalog) osvVerdict(p *Product, report osvReportJSON, lines *[]string) bool {
	seen := map[[3]string]bool{}
	var malicious [][3]string
	for _, r := range report.Results {
		for _, pkg := range r.Packages {
			for _, v := range pkg.Vulnerabilities {
				key := [3]string{pkg.Package.Name, pkg.Package.Version, v.ID}
				if strings.HasPrefix(v.ID, "MAL-") && !seen[key] {
					seen[key] = true
					malicious = append(malicious, key)
				}
			}
		}
	}
	sort.Slice(malicious, func(i, j int) bool {
		return strings.Join(malicious[i][:], "\x00") < strings.Join(malicious[j][:], "\x00")
	})
	if len(malicious) > 0 {
		*lines = append(*lines, fmt.Sprintf("- :x: %d known-malicious package(s):", len(malicious)))
		for _, m := range malicious {
			*lines = append(*lines, fmt.Sprintf("  - `%s %s`: [%s](https://osv.dev/vulnerability/%s)", m[0], m[1], m[2], m[2]))
			c.errorAt(p.Dir, fmt.Sprintf("known-malicious package %s %s (%s)", m[0], m[1], m[2]))
		}
	} else {
		*lines = append(*lines, "- :white_check_mark: No known-malicious packages.")
	}
	c.info("  OSV-Scanner: %d known-malicious package(s)", len(malicious))
	return len(malicious) == 0
}
