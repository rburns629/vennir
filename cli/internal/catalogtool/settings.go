// SPDX-License-Identifier: MIT

package catalogtool

import (
	"fmt"
	"os"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// Settings say where products go: vertra.yaml, each overridable by an
// environment variable (CI sets them from the repository's variables).
type Settings struct {
	Registry    string
	SigningMode string
	SigningKey  string
	// Platform the images are built for, such as linux/amd64; empty: see
	// BuildPlatform.
	Platform string
	// BuildEnvironments are the teams whose products are built in a GitHub
	// Environment of their own (team-<name>, main only), with that
	// Environment's secrets offered to docker build (buildenv.go).
	BuildEnvironments []string
}

// BuildsInEnvironment says whether team's products are built only in its
// own Environment.
func (s Settings) BuildsInEnvironment(team string) bool {
	for _, t := range s.BuildEnvironments {
		if t == team {
			return true
		}
	}
	return false
}

var platformPattern = regexp.MustCompile(`^[a-z0-9]+/[a-z0-9]+(/[a-z0-9]+)?$`)

// BuildPlatform is what docker builds for: the setting, else this
// machine's own for a local registry (kind runs on this machine), else
// linux/amd64, what cloud clusters' nodes run unless told otherwise (a
// Mac's arm64 images wouldn't run there). Empty: Docker's default.
func (s Settings) BuildPlatform() string {
	if s.Platform != "" || s.Registry == "" {
		return s.Platform
	}
	host := strings.SplitN(s.Registry, "/", 2)[0]
	if name := strings.SplitN(host, ":", 2)[0]; name == "localhost" || name == "127.0.0.1" || name == "kind-registry" {
		return ""
	}
	return "linux/amd64"
}

// FormerSettingsFile is vertra.yaml's name until the platform was renamed
// Vertra (2026-10-20).
const FormerSettingsFile = "acyclix.yaml"

// Settings reads vertra.yaml (if any) and the environment.
func (c *Catalog) Settings() (Settings, error) {
	var file struct {
		Registry string `yaml:"registry"`
		Signing  struct {
			Mode string `yaml:"mode"`
			Key  string `yaml:"key"`
		} `yaml:"signing"`
		Platform          string   `yaml:"platform"`
		BuildEnvironments []string `yaml:"buildEnvironments"`
	}
	data, err := os.ReadFile(c.path("vertra.yaml"))
	if err == nil {
		if err := yaml.Unmarshal(data, &file); err != nil {
			return Settings{}, fmt.Errorf("vertra.yaml: not valid YAML: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return Settings{}, err
	} else if _, err := os.Stat(c.path(FormerSettingsFile)); err == nil {
		// Never read past silently: its registry would be lost.
		return Settings{}, fmt.Errorf("%s: renamed vertra.yaml on 2026-10-20: ./vertra catalog migrate renames it", FormerSettingsFile)
	}
	or := func(env, fallback string) string {
		if v := c.Getenv(env); v != "" {
			return v
		}
		return fallback
	}
	mode := file.Signing.Mode
	if mode == "" {
		mode = "none"
	}
	return Settings{
		Registry:    or("VERTRA_REGISTRY", file.Registry),
		SigningMode: or("VERTRA_SIGNING_MODE", mode),
		SigningKey:  or("VERTRA_SIGNING_KEY", file.Signing.Key),
		Platform:    or("VERTRA_PLATFORM", file.Platform),
		// Never from the environment: which teams' values reach which
		// builds is the catalog admins' file, reviewed like the workflow.
		BuildEnvironments: file.BuildEnvironments,
	}, nil
}

// Problems are what stops publishing with these settings.
func (s Settings) Problems() []string {
	var found []string
	switch {
	case s.Registry == "":
		found = append(found, "no registry: set registry in vertra.yaml or VERTRA_REGISTRY")
	case strings.Contains(s.Registry, "://") || strings.HasSuffix(s.Registry, "/"):
		found = append(found, fmt.Sprintf("registry %s: a path like host[:port]/path, no scheme or trailing /", quote(s.Registry)))
	}
	if s.SigningMode != "none" && s.SigningMode != "key" && s.SigningMode != "keyless" {
		found = append(found, fmt.Sprintf("signing mode %s: one of none, key, keyless", quote(s.SigningMode)))
	}
	if s.Platform != "" && !platformPattern.MatchString(s.Platform) {
		found = append(found, fmt.Sprintf("platform %s: os/arch, such as linux/amd64", quote(s.Platform)))
	}
	if s.SigningMode == "key" && s.SigningKey == "" {
		found = append(found, "signing mode key needs a key: signing.key or VERTRA_SIGNING_KEY")
	}
	return found
}
