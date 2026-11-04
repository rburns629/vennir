// SPDX-License-Identifier: MIT

package catalogtool

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// dockerBinary is $DOCKER, docker on the PATH, or Docker Desktop's.
func (c *Catalog) dockerBinary() (string, error) {
	candidates := []string{c.Getenv("DOCKER")}
	if path, err := exec.LookPath("docker"); err == nil {
		candidates = append(candidates, path)
	}
	candidates = append(candidates, "/Applications/Docker.app/Contents/Resources/bin/docker")
	for _, candidate := range candidates {
		if candidate != "" && exists(candidate) {
			return candidate, nil
		}
	}
	return "", errors.New("docker not found: install it, or set DOCKER to its path")
}

type runResult struct {
	code     int
	stdout   string
	stderr   string
	timedOut bool
}

// run runs a command; with capture, its output is returned rather than
// shown. A command that can't start is an error; one that fails isn't.
func (c *Catalog) run(timeout time.Duration, capture bool, name string, args ...string) (runResult, error) {
	return c.runWith(timeout, capture, nil, name, args...)
}

// runWith is run with env (KEY=value) added to the process's own.
func (c *Catalog) runWith(timeout time.Duration, capture bool, env []string, name string, args ...string) (runResult, error) {
	ctx := context.Background()
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, name, args...)
	if len(env) > 0 {
		cmd.Env = append(os.Environ(), env...)
	}
	var stdout, stderr bytes.Buffer
	if capture {
		cmd.Stdout, cmd.Stderr = &stdout, &stderr
	} else {
		cmd.Stdout, cmd.Stderr = c.Stdout, c.Stderr
	}
	err := cmd.Run()
	result := runResult{stdout: stdout.String(), stderr: stderr.String(), timedOut: ctx.Err() == context.DeadlineExceeded}
	var exit *exec.ExitError
	switch {
	case err == nil:
	case result.timedOut:
		result.code = -1
	case errors.As(err, &exit):
		result.code = exit.ExitCode()
	default:
		return result, fmt.Errorf("running %s: %w", name, err)
	}
	return result, nil
}

// docker runs docker; an error unless it succeeds.
func (c *Catalog) docker(capture bool, args ...string) (runResult, error) {
	binary, err := c.dockerBinary()
	if err != nil {
		return runResult{}, err
	}
	result, err := c.run(0, capture, binary, args...)
	if err == nil && result.code != 0 {
		err = fmt.Errorf("docker %s failed (exit %d): %s", args[0], result.code, lastChars(strings.TrimSpace(result.stderr), 500))
	}
	return result, err
}

func lastChars(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

// Build builds a product's image, on its base's current patch level.
func (c *Catalog) Build(p *Product) bool {
	binary, err := c.dockerBinary()
	var s Settings
	if err == nil {
		s, err = c.Settings()
	}
	if err == nil {
		args := []string{"build", "--pull"}
		if platform := s.BuildPlatform(); platform != "" {
			c.info("  building for %s", platform)
			args = append(args, "--platform", platform)
		}
		var secrets, env []string
		if secrets, env, err = c.buildSecrets(); err == nil && len(secrets) > 0 {
			c.info("  offering build secrets %s", strings.Join(secrets, ", "))
			for _, name := range secrets {
				args = append(args, "--secret", "id="+name+",env="+buildSecretPrefix+name)
			}
		}
		var result runResult
		if err == nil {
			result, err = c.runWith(0, false, env, binary, append(args, "-t", p.LocalImage(), p.Dir)...)
		}
		if err == nil && result.code != 0 {
			err = errors.New("docker build failed")
		}
	}
	if err != nil {
		c.errorAt(p.Dir, err.Error())
		return false
	}
	return true
}

// Every FROM names its base by digest (python:3.12-slim@sha256:…), so a
// build is the same bytes until someone deliberately moves it:
// ./vertra catalog bases --update re-pins each tag to what it names now.
var fromLine = regexp.MustCompile(`(?i)^(FROM\s+(?:--platform=\S+\s+)?)(\S+)(.*)$`)

// stageAlias is the name a FROM line gives its stage ("AS name"), or "".
func stageAlias(rest string) string {
	if !strings.Contains(" "+strings.ToLower(rest)+" ", " as ") {
		return ""
	}
	fields := strings.Fields(rest)
	return strings.ToLower(fields[len(fields)-1])
}

func baseProblems(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return []string{err.Error()}
	}
	stages := map[string]bool{}
	var problems []string
	for i, line := range strings.Split(string(data), "\n") {
		m := fromLine.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		image, rest := m[2], m[3]
		if !stages[strings.ToLower(image)] && image != "scratch" && !strings.Contains(image, "@sha256:") {
			problems = append(problems, fmt.Sprintf("Dockerfile line %d: base image %s isn't pinned by digest: run ./vertra catalog bases", i+1, image))
		}
		if alias := stageAlias(rest); alias != "" {
			stages[alias] = true
		}
	}
	return problems
}

// userLine is a Dockerfile's USER instruction.
var userLine = regexp.MustCompile(`(?i)^USER\s+(\S+)`)

// numericUser is a non-root user (and group) by number: 65532, 65532:65532.
var numericUser = regexp.MustCompile(`^[0-9]+(:[0-9]+)?$`)

// userProblems: a step runs with runAsNonRoot, which Kubernetes can only
// check against a number, so the final stage must end with a numeric,
// non-root USER (the kubelet refuses to start a named user's or root's
// container: IMAGE_USER_NOT_ALLOWED).
func userProblems(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return []string{err.Error()}
	}
	user, line := "", 0
	for i, l := range strings.Split(string(data), "\n") {
		l = strings.TrimSpace(l)
		if fromLine.MatchString(l) {
			user, line = "", 0
		}
		if m := userLine.FindStringSubmatch(l); m != nil {
			user, line = m[1], i+1
		}
	}
	switch {
	case user == "":
		return []string{"Dockerfile: the final stage sets no USER; end it with a numeric, non-root one, such as USER 65532:65532 (the platform runs steps as non-root and can only check a number)"}
	case !numericUser.MatchString(user):
		return []string{fmt.Sprintf("Dockerfile line %d: USER %s isn't numeric; the platform can only check a number is non-root (USER 65532:65532)", line, user)}
	case strings.SplitN(user, ":", 2)[0] == "0":
		return []string{fmt.Sprintf("Dockerfile line %d: USER %s is root; steps run as non-root", line, user)}
	}
	return nil
}

// Dockerfiles are every product's and starter's, and the samples' (never
// published from there, but copied as starters).
func (c *Catalog) Dockerfiles() []string {
	var files []string
	for _, pattern := range []string{"teams/*/products/*/Dockerfile", "templates/*/Dockerfile", "samples/*/products/*/Dockerfile"} {
		files = append(files, c.glob(pattern)...)
	}
	return files
}

func (c *Catalog) digestOf(image string) (string, error) {
	result, err := c.docker(true, "buildx", "imagetools", "inspect", image, "--format", "{{json .Manifest.Digest}}")
	if err != nil {
		return "", err
	}
	var digest string
	if json.Unmarshal([]byte(result.stdout), &digest) != nil || !strings.HasPrefix(digest, "sha256:") {
		return "", fmt.Errorf("no digest for %s: %s", image, lastChars(result.stdout, 200))
	}
	return digest, nil
}

// Bases pins every unpinned FROM to its tag's current digest; with update,
// re-pins the pinned ones too; with useMirror, points a FROM of an approved
// base (bases.yaml) at its copy in the registry, pinned.
func (c *Catalog) Bases(update, useMirror bool) error {
	changed := 0
	digests := map[string]string{}
	mirrors := map[string]string{}
	if useMirror {
		s, err := c.Settings()
		if err != nil {
			return err
		}
		bases, problems := c.LoadBases()
		if len(problems) > 0 {
			return fmt.Errorf("bases.yaml: %s", strings.Join(problems, "; "))
		}
		if s.Registry == "" {
			return errors.New("--use-mirror needs the registry: registry in vertra.yaml or VERTRA_REGISTRY")
		}
		for _, b := range bases {
			mirrors[b.Image] = s.MirrorRepository(b) + ":" + mirrorTag(b)
		}
	}
	for _, path := range c.Dockerfiles() {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		lines := strings.SplitAfter(string(data), "\n")
		stages := map[string]bool{}
		for i, line := range lines {
			m := fromLine.FindStringSubmatch(strings.TrimSpace(strings.TrimRight(line, "\n")))
			if m == nil {
				continue
			}
			prefix, image, rest := m[1], m[2], m[3]
			if alias := stageAlias(rest); alias != "" {
				stages[alias] = true
			}
			tag := strings.SplitN(image, "@", 2)[0]
			mirror, mirrored := mirrors[tag]
			if stages[strings.ToLower(image)] || image == "scratch" || (strings.Contains(image, "@sha256:") && !update && !mirrored) {
				continue
			}
			if mirrored {
				tag = mirror
			}
			if digests[tag] == "" {
				if digests[tag], err = c.digestOf(tag); err != nil {
					return err
				}
			}
			pinned := tag + "@" + digests[tag]
			if pinned != image {
				lines[i] = prefix + pinned + rest + "\n"
				changed++
				c.info("  %s: %s", c.rel(path), pinned)
			}
		}
		if err := os.WriteFile(path, []byte(strings.Join(lines, "")), 0o644); err != nil {
			return err
		}
	}
	c.info("%d base image(s) pinned.", changed)
	return nil
}

// tempDir makes a work folder that the scanners' and tests' containers
// can mount (resolved, so macOS's /var symlink doesn't get in the way).
func tempDir(prefix string) (string, func(), error) {
	dir, err := os.MkdirTemp("", prefix)
	if err != nil {
		return "", nil, err
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		os.RemoveAll(dir)
		return "", nil, err
	}
	return resolved, func() { os.RemoveAll(dir) }, nil
}
