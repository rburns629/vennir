// SPDX-License-Identifier: MIT

// Package releases knows Vennir's published releases: which is newest, and
// what an upgrade passes over. The list is GitHub's, read without signing
// in and cached a day, so asking costs a command nothing most of the time.
package releases

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Repository is where Vennir is released.
const Repository = "rburns629/vennir"

// First is Vennir's first release. The repository's earlier ones are
// Vertra's (the platform's name until 2026-11-03), published under
// ghcr.io/rburns629/vertra and signed by that repository's workflow, which
// this vennir can't install: the vertra CLI does.
const First = "0.11.0"

const (
	listURL       = "https://api.github.com/repos/" + Repository + "/releases?per_page=100"
	cacheLifetime = 24 * time.Hour
)

// NotesURL is a release's page, its notes.
func NotesURL(version string) string {
	return "https://github.com/" + Repository + "/releases/tag/v" + version
}

type cache struct {
	Fetched  time.Time
	Versions []string
}

// List is every released version (prereleases left out), newest first.
func List(ctx context.Context) ([]string, error) {
	path := cachePath()
	var c cache
	if data, err := os.ReadFile(path); err == nil && json.Unmarshal(data, &c) == nil && time.Since(c.Fetched) < cacheLifetime {
		return c.Versions, nil
	}
	versions, err := fetch(ctx)
	if err != nil {
		return nil, err
	}
	if data, err := json.Marshal(cache{Fetched: time.Now(), Versions: versions}); err == nil && path != "" {
		if os.MkdirAll(filepath.Dir(path), 0o755) == nil {
			_ = os.WriteFile(path, data, 0o644)
		}
	}
	return versions, nil
}

// Newest is the newest released version, "" when it can't be had.
func Newest(ctx context.Context) string {
	versions, err := List(ctx)
	if err != nil || len(versions) == 0 {
		return ""
	}
	return versions[0]
}

func fetch(ctx context.Context) ([]string, error) {
	// Never long: it's only advice.
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, listURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("reading Vennir's releases: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("reading Vennir's releases: %s", resp.Status)
	}
	return parse(body)
}

// parse picks the released versions out of GitHub's list, newest first.
func parse(body []byte) ([]string, error) {
	var list []struct {
		TagName    string `json:"tag_name"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
	}
	if err := json.Unmarshal(body, &list); err != nil {
		return nil, fmt.Errorf("Vennir's releases: %w", err)
	}
	var versions []string
	for _, r := range list {
		v := strings.TrimPrefix(r.TagName, "v")
		if !r.Draft && !r.Prerelease && Valid(v) && Compare(v, First) >= 0 {
			versions = append(versions, v)
		}
	}
	slices.SortFunc(versions, func(a, b string) int { return Compare(b, a) })
	return versions, nil
}

var semver = regexp.MustCompile(`^(\d+)\.(\d+)\.(\d+)$`)

// Valid says v is a release's version, x.y.z.
func Valid(v string) bool { return semver.MatchString(v) }

// Compare orders two x.y.z versions: -1, 0 or 1.
func Compare(a, b string) int {
	pa, pb := semver.FindStringSubmatch(a), semver.FindStringSubmatch(b)
	if pa == nil || pb == nil {
		return strings.Compare(a, b)
	}
	for i := 1; i <= 3; i++ {
		x, _ := strconv.Atoi(pa[i])
		y, _ := strconv.Atoi(pb[i])
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

// Between is the released versions after from and before to, oldest
// first: what an upgrade from from to to passes over.
func Between(versions []string, from, to string) []string {
	var out []string
	for _, v := range versions {
		if Compare(v, from) > 0 && Compare(v, to) < 0 {
			out = append(out, v)
		}
	}
	slices.SortFunc(out, Compare)
	return out
}

// ChartVersion is the version in a release's chart, as helm lists it
// ("execution-kernel-0.5.2" → "0.5.2").
func ChartVersion(chart string) string {
	if i := strings.LastIndex(chart, "-"); i >= 0 && Valid(chart[i+1:]) {
		return chart[i+1:]
	}
	return ""
}

func cachePath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".vennir", "cache", "releases.json")
}

// Upgrade is what to know before moving an install from installed (its
// chart's version, "" when nothing's installed) to target (a version or
// "source"), with this vennir at cli: notes for the approval screen, or an
// error when the move can't be made by an apply. versions is the release
// list, nil when it couldn't be read.
func Upgrade(installed, target, cli string, versions []string) ([]string, error) {
	var notes []string
	if Valid(cli) && Valid(target) && Compare(cli, target) < 0 {
		notes = append(notes, fmt.Sprintf("This vennir is %s, older than the %s it installs: its settings and the charts are released together, so get vennir %s first (%s)", cli, target, target, NotesURL(target)))
	}
	if !Valid(target) {
		return notes, nil
	}
	// A version never released is an install built from source (its
	// charts say 0.1.0): nothing to compare.
	if versions != nil && !slices.Contains(versions, installed) {
		installed = ""
	}
	if Valid(installed) {
		if Compare(target, installed) < 0 {
			return nil, fmt.Errorf("%s is older than the %s installed, and migrations only go forward: older code waits forever on a newer database. To go back, restore a backup taken before the upgrade (docs/operations.md, Rolling back), or set vennir back to %s", target, installed, installed)
		}
		if skipped := Between(versions, installed, target); len(skipped) > 0 {
			notes = append(notes, fmt.Sprintf("This upgrade passes over %s: their migrations run in order, but read their notes (%s) for anything to do by hand", strings.Join(skipped, ", "), NotesURL(skipped[0])))
		}
	}
	if len(versions) > 0 && Compare(versions[0], target) > 0 {
		notes = append(notes, fmt.Sprintf("Vennir %s is out (this installs %s): `vennir config set vennir %s` to move to it", versions[0], target, versions[0]))
	}
	return notes, nil
}

// Platforms are those vennir is released for.
var Platforms = []string{"linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"}

// Checksums are a release's binaries' SHA-256s by platform, from its
// vennir-checksums.txt: what a catalog's ./vennir pins.
func Checksums(ctx context.Context, version string) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	url := "https://github.com/" + Repository + "/releases/download/v" + version + "/vennir-checksums.txt"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("reading vennir %s's checksums: %w", version, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("reading vennir %s's checksums (%s): %s", version, url, resp.Status)
	}
	return parseChecksums(string(body), version)
}

var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

// parseChecksums reads sha256sum's lines, "<sha256>  vennir-<platform>",
// keeping the binaries' (not the manual pages'), and wants every platform.
func parseChecksums(body, version string) (map[string]string, error) {
	sums := map[string]string{}
	for _, line := range strings.Split(body, "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && sha256Hex.MatchString(f[0]) && slices.Contains(Platforms, strings.TrimPrefix(f[1], "vennir-")) {
			sums[strings.TrimPrefix(f[1], "vennir-")] = f[0]
		}
	}
	for _, p := range Platforms {
		if sums[p] == "" {
			return nil, fmt.Errorf("vennir %s's checksums have none for %s", version, p)
		}
	}
	return sums, nil
}
