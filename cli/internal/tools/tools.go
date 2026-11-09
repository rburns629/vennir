// SPDX-License-Identifier: MIT

// Package tools checks for the command-line tools an install needs, and
// downloads the single-binary ones (kubectl, helm, kind) on consent:
// pinned versions, checked against their projects' published checksums,
// into vennir's own directory. It never uses sudo or changes PATH, and
// it doesn't download tools that need a real installer (docker, the cloud
// CLIs): for those it gives the install command. It also pulls the
// third-party Helm charts vennir installs, each checked against its pin.
package tools

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/roburns/vennir/cli/internal/run"
)

// Dir is where downloaded tools live: ~/.vennir/bin. With no home
// directory there's none, rather than a shared one such as the temp
// directory, where another user could put a tool for vennir to run.
func Dir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("no home directory for vennir's tools (~/.vennir/bin): %w", err)
	}
	return filepath.Join(home, ".vennir", "bin"), nil
}

// ExtendPath adds the directories vennir's tools may be in to this
// process's PATH (never your shell's): its own downloads, and gcloud's SDK
// bin, where `gcloud components install` puts gke-gcloud-auth-plugin
// (kubectl runs that by name).
func ExtendPath() {
	var dirs []string
	if dir, err := Dir(); err == nil {
		dirs = append(dirs, dir)
	}
	if gcloud, err := exec.LookPath("gcloud"); err == nil {
		if real, err := filepath.EvalSymlinks(gcloud); err == nil {
			dirs = append(dirs, filepath.Dir(real))
		}
	}
	path := os.Getenv("PATH")
	for _, d := range dirs {
		if !slices.Contains(filepath.SplitList(path), d) {
			path += string(os.PathListSeparator) + d
		}
	}
	_ = os.Setenv("PATH", path)
}

// Path returns the executable to run for a tool: vennir's own copy if
// it downloaded one, else the one on PATH, else the bare name.
func Path(name string) string {
	if dir, err := Dir(); err == nil {
		own := filepath.Join(dir, name)
		if info, err := os.Stat(own); err == nil && !info.IsDir() {
			return own
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	return name
}

// Requirement is one tool a selection needs.
type Requirement struct {
	Tool string
	Why  string
	// Check, when set, verifies more than presence (Docker running, Helm 4).
	Check func(ctx context.Context, path string) error
}

// For returns the tools a target needs.
func For(target string, fromSource bool) []Requirement {
	reqs := []Requirement{
		{Tool: "kubectl", Why: "talks to the cluster"},
		{Tool: "helm", Why: "installs Vennir's charts", Check: helmFour},
	}
	switch target {
	case "kind":
		reqs = append(reqs,
			Requirement{Tool: "docker", Why: "runs kind's node and the local registry", Check: dockerRunning},
			Requirement{Tool: "kind", Why: "creates the local cluster"},
		)
	case "gcp":
		reqs = append(reqs,
			Requirement{Tool: "tofu", Why: "creates the cloud side (OpenTofu)"},
			Requirement{Tool: "gcloud", Why: "your Google Cloud sign-in", Check: gcloudSignedIn},
			Requirement{Tool: "gke-gcloud-auth-plugin", Why: "lets kubectl sign in to GKE"},
		)
		if fromSource {
			reqs = append(reqs, Requirement{Tool: "docker", Why: "builds the platform images from source", Check: dockerRunning})
		}
	case "aws":
		reqs = append(reqs,
			Requirement{Tool: "tofu", Why: "creates the cloud side (OpenTofu)"},
			Requirement{Tool: "aws", Why: "your AWS sign-in, and kubectl's sign-in to EKS"},
		)
		if fromSource {
			reqs = append(reqs, Requirement{Tool: "docker", Why: "builds the platform images from source", Check: dockerRunning})
		}
	case "azure":
		reqs = append(reqs,
			Requirement{Tool: "tofu", Why: "creates the cloud side (OpenTofu)"},
			Requirement{Tool: "az", Why: "your Azure sign-in", Check: azSignedIn},
			Requirement{Tool: "kubelogin", Why: "lets kubectl sign in to AKS (Microsoft Entra)"},
		)
		if fromSource {
			reqs = append(reqs, Requirement{Tool: "docker", Why: "builds the platform images from source", Check: dockerRunning})
		}
	case "existing":
		if fromSource {
			reqs = append(reqs, Requirement{Tool: "docker", Why: "builds the platform images from source", Check: dockerRunning})
		}
	}
	return reqs
}

// ForCatalog returns the tools `vennir catalog create` needs on GitHub.
func ForCatalog() []Requirement {
	return []Requirement{
		{Tool: "git", Why: "the catalog's first commit"},
		{Tool: "gh", Why: "creates the repository, its variables and secrets, as you", Check: ghSignedIn},
	}
}

func ghSignedIn(ctx context.Context, path string) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, path, "auth", "status").Run(); err != nil {
		return errors.New("installed, but not signed in: `gh auth login --scopes repo,workflow`")
	}
	return nil
}

func gcloudSignedIn(ctx context.Context, path string) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "auth", "list", "--filter=status:ACTIVE", "--format=value(account)").Output()
	if err != nil || strings.TrimSpace(string(out)) == "" {
		return errors.New("installed, but not signed in: `gcloud auth login`, then `gcloud auth application-default login` (OpenTofu uses the second)")
	}
	return nil
}

func azSignedIn(ctx context.Context, path string) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, "account", "show", "--query", "user.name", "--output", "tsv").Output()
	if err != nil || strings.TrimSpace(string(out)) == "" {
		return errors.New("installed, but not signed in: `az login` (OpenTofu uses the same sign-in)")
	}
	return nil
}

// Status is one requirement's state.
type Status struct {
	Requirement
	Path    string
	Version string
	Problem string
	// Downloadable: missing, and vennir can fetch it.
	Downloadable bool
	// Install is the command to install it, when it can't be downloaded.
	Install string
}

// OK reports whether the requirement is met.
func (s Status) OK() bool { return s.Problem == "" }

// CheckAll returns each requirement's status.
// The tools are asked side by side: gcloud alone takes a second or more.
func CheckAll(ctx context.Context, reqs []Requirement) []Status {
	out := make([]Status, len(reqs))
	checks := make([]func(), len(reqs))
	for i, r := range reqs {
		checks[i] = func() { out[i] = check(ctx, r) }
	}
	run.Together(checks...)
	return out
}

func check(ctx context.Context, r Requirement) Status {
	s := Status{Requirement: r}
	path := Path(r.Tool)
	if path == r.Tool { // not found anywhere
		s.Problem = "not installed"
		if _, ok := pins[r.Tool]; ok {
			s.Downloadable = true
		} else {
			s.Install = installHint(r.Tool)
		}
		return s
	}
	s.Path = path
	s.Version = versionOf(ctx, r.Tool, path)
	if r.Check != nil {
		if err := r.Check(ctx, path); err != nil {
			s.Problem = err.Error()
			if _, ok := pins[r.Tool]; ok && r.Tool == "helm" {
				s.Downloadable = true
			}
		}
	}
	return s
}

// Summary is a one-line account of the statuses, for the approval screen.
func Summary(statuses []Status) string {
	var parts []string
	ok := true
	for _, s := range statuses {
		v := s.Version
		if v == "" {
			v = "?"
		}
		parts = append(parts, s.Tool+" "+v)
		ok = ok && s.OK()
	}
	if ok {
		return strings.Join(parts, ", ") + ": all present"
	}
	return strings.Join(parts, ", ") + ": something's missing (vennir check)"
}

func versionOf(ctx context.Context, tool, path string) string {
	args := map[string][]string{
		"kubectl": {"version", "--client", "-o", "yaml"},
		"helm":    {"version", "--short"},
		"kind":    {"version"},
		"docker":  {"version", "--format", "{{.Client.Version}}"},
		"tofu":    {"version"},
		"gh":      {"--version"},
		"git":     {"--version"},
		"gcloud":  {"version", "--format", "value(\"Google Cloud SDK\")"},
		"aws":     {"--version"},
	}[tool]
	if args == nil {
		args = []string{"--version"}
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, path, args...).Output()
	if err != nil {
		return ""
	}
	m := regexp.MustCompile(`v?(\d+\.\d+\.\d+)`).FindStringSubmatch(string(out))
	if m == nil {
		return ""
	}
	return m[1]
}

func helmFour(ctx context.Context, path string) error {
	v := versionOf(ctx, "helm", path)
	major, _ := strconv.Atoi(strings.SplitN(v, ".", 2)[0])
	if major != 4 {
		return fmt.Errorf("Helm %s found; Vennir's charts need Helm 4", v)
	}
	return nil
}

func dockerRunning(ctx context.Context, path string) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, path, "info", "--format", "{{.ServerVersion}}").Run(); err != nil {
		return errors.New("installed, but Docker isn't running: start Docker Desktop (or the docker service)")
	}
	return nil
}

func installHint(tool string) string {
	return hintFor(tool, runtime.GOOS == "darwin", runtime.GOOS == "linux" && inWSL())
}

// inWSL is whether this Linux is WSL, Windows' own, where Docker is usually
// Docker Desktop's, on the Windows side.
func inWSL() bool {
	if os.Getenv("WSL_DISTRO_NAME") != "" {
		return true
	}
	release, err := os.ReadFile("/proc/sys/kernel/osrelease")
	return err == nil && strings.Contains(strings.ToLower(string(release)), "microsoft")
}

// hintFor says how to install a tool vennir doesn't download: on macOS,
// on Linux, or on Linux in WSL (docs/clouds/computer.md).
func hintFor(tool string, mac, wsl bool) string {
	switch tool {
	case "gcloud":
		if mac {
			return "`brew install --cask gcloud-cli`, or https://cloud.google.com/sdk/docs/install ; then `gcloud auth login`"
		}
		return "https://cloud.google.com/sdk/docs/install (apt, dnf or the archive); then `gcloud auth login`"
	case "aws":
		if mac {
			return "`brew install awscli` (or AWS's installer: https://aws.amazon.com/cli/), then `aws login`"
		}
		return "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html , then `aws login`"
	case "az":
		if mac {
			return "`brew install azure-cli`, then `az login`"
		}
		return "https://learn.microsoft.com/cli/azure/install-azure-cli (apt, dnf), then `az login`"
	case "gh":
		if mac {
			return "`brew install gh`, then `gh auth login --scopes repo,workflow`"
		}
		return "https://github.com/cli/cli#installation (apt, dnf), then `gh auth login --scopes repo,workflow`"
	case "git":
		if mac {
			return "`xcode-select --install` (or `brew install git`)"
		}
		return "your package manager: `apt install git` or `dnf install git`"
	case "gke-gcloud-auth-plugin":
		return "`gcloud components install gke-gcloud-auth-plugin` (with apt or dnf: the google-cloud-cli-gke-gcloud-auth-plugin package)"
	case "docker":
		if mac {
			return "install Docker Desktop: https://docs.docker.com/desktop/setup/install/mac-install/ (or `brew install --cask docker-desktop`), and start it"
		}
		if wsl {
			return "install Docker Desktop for Windows: https://docs.docker.com/desktop/setup/install/windows-install/ , start it, and turn on Settings → Resources → WSL integration for this distribution"
		}
		return "install Docker Engine: https://docs.docker.com/engine/install/ , start it (`sudo systemctl enable --now docker`), and add yourself to the docker group (`sudo usermod -aG docker $USER`, then sign in again)"
	}
	return "install " + tool
}

// Download fetches a pinned tool into Dir, verifying its checksum.
func Download(ctx context.Context, tool string) (string, error) {
	pin, ok := pins[tool]
	if !ok {
		return "", fmt.Errorf("%s can't be downloaded by vennir: %s", tool, installHint(tool))
	}
	key := runtime.GOOS + "/" + runtime.GOARCH
	sum, ok := pin.SHA256[key]
	if !ok {
		return "", fmt.Errorf("no %s download for %s", tool, key)
	}
	url := strings.NewReplacer("{os}", runtime.GOOS, "{arch}", runtime.GOARCH, "{version}", pin.Version).Replace(pin.URL)

	dir, err := Dir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(dir, tool+"-*.download")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := (&http.Client{Timeout: 5 * time.Minute}).Do(req)
	if err != nil {
		return "", fmt.Errorf("downloading %s: %w", tool, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("downloading %s from %s: %s", tool, url, resp.Status)
	}
	hash := sha256.New()
	if _, err := io.Copy(io.MultiWriter(tmp, hash), resp.Body); err != nil {
		return "", fmt.Errorf("downloading %s: %w", tool, err)
	}
	tmp.Close()
	if got := hex.EncodeToString(hash.Sum(nil)); got != sum {
		return "", fmt.Errorf("%s's checksum doesn't match (%s, expected %s): refusing to use it", tool, got, sum)
	}

	dest := filepath.Join(dir, tool)
	if pin.Member != "" {
		member := strings.NewReplacer("{os}", runtime.GOOS, "{arch}", runtime.GOARCH).Replace(pin.Member)
		unpack := extract
		if strings.HasSuffix(url, ".zip") {
			unpack = extractZip
		}
		if err := unpack(tmp.Name(), member, dest); err != nil {
			return "", fmt.Errorf("unpacking %s: %w", tool, err)
		}
	} else if err := os.Rename(tmp.Name(), dest); err != nil {
		return "", err
	}
	if err := os.Chmod(dest, 0o755); err != nil {
		return "", err
	}
	return dest, nil
}

// PullChart fetches a pinned third-party chart into a new directory and
// checks it against its pinned SHA-256, returning the checked package to
// install from (never the repository, which could serve another by then)
// and a cleanup that removes it.
func PullChart(ctx context.Context, r *run.Runner, chart string) (string, func(), error) {
	pin, ok := charts[chart]
	if !ok {
		return "", nil, fmt.Errorf("no pinned chart %s", chart)
	}
	dir, err := os.MkdirTemp("", "vennir-chart-*")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	archive, err := PullChartTo(ctx, r, dir, pin.SHA256, chart, "--repo", pin.Repo, "--version", pin.Version)
	if err != nil {
		cleanup()
		return "", nil, err
	}
	return archive, cleanup, nil
}

// PullChartTo fetches a chart (helm pull's arguments, the chart first) into
// dir, an empty directory, and checks it against sum: the package's path.
func PullChartTo(ctx context.Context, r *run.Runner, dir, sum string, args ...string) (string, error) {
	if _, err := r.Output(ctx, "helm", append(append([]string{"pull"}, args...), "--destination", dir)...); err != nil {
		return "", err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	if len(entries) != 1 || !strings.HasSuffix(entries[0].Name(), ".tgz") {
		return "", fmt.Errorf("helm pull %s: expected one chart package in %s", args[0], dir)
	}
	archive := filepath.Join(dir, entries[0].Name())
	if err := CheckSHA256(archive, sum); err != nil {
		return "", fmt.Errorf("%s: %w", args[0], err)
	}
	return archive, nil
}

// CheckSHA256 refuses a file whose SHA-256 isn't sum.
func CheckSHA256(path, sum string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, f); err != nil {
		return err
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != sum {
		return fmt.Errorf("%s's checksum doesn't match (%s, expected %s): refusing to use it", filepath.Base(path), got, sum)
	}
	return nil
}

// untarLimit is the biggest file Untar unpacks.
const untarLimit = 64 << 20

// Untar unpacks a .tgz's directories and regular files into dest; anything
// else (links), a name that would land outside dest, or a file over
// untarLimit, is refused.
func Untar(archive, dest string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if !filepath.IsLocal(h.Name) {
			return fmt.Errorf("%s: %q is outside the archive", filepath.Base(archive), h.Name)
		}
		path := filepath.Join(dest, h.Name)
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(path, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if h.Size > untarLimit {
				return fmt.Errorf("%s: %q is bigger than a chart's file should be", filepath.Base(archive), h.Name)
			}
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
			if err != nil {
				return err
			}
			if _, err := io.Copy(out, tr); err != nil {
				out.Close()
				return err
			}
			if err := out.Close(); err != nil {
				return err
			}
		default:
			return fmt.Errorf("%s: %q isn't a file or a directory", filepath.Base(archive), h.Name)
		}
	}
}

// extractZip is extract for a .zip.
func extractZip(archive, member, dest string) error {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, f := range zr.File {
		if f.Name != member {
			continue
		}
		in, err := f.Open()
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, io.LimitReader(in, 512<<20)); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	}
	return fmt.Errorf("%s not in the archive", member)
}

func extract(archive, member, dest string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("%s not in the archive", member)
		}
		if err != nil {
			return err
		}
		if h.Name != member {
			continue
		}
		out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, io.LimitReader(tr, 512<<20)); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	}
}
