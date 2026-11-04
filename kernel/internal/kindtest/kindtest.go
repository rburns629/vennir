// SPDX-License-Identifier: MIT

// Package kindtest gives tests a real Kubernetes cluster: the kind cluster
// of kubectl's current context, with its test namespace (execution-kernel)
// and test images built with Docker and loaded into it. Without one the
// tests skip; with KERNEL_TESTS_REQUIRE_KUBERNETES=1 (CI's kubernetes job)
// they fail instead.
package kindtest

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

// Namespace is where the tests dispatch, as the Python suite did.
const Namespace = "execution-kernel"

// The images the tests run: a fixture exercising the executor's own
// mechanics, and the two demo products (examples/).
const (
	FixtureImage     = "execution-kernel-test-fixture:local"
	ProjectImage     = "demo-project-product:local"
	ApplicationImage = "demo-application-product:local"
)

var imageDirs = map[string]string{
	FixtureImage:     "kernel/internal/kindtest/fixture",
	ProjectImage:     "examples/project-product",
	ApplicationImage: "examples/application-product",
}

func unavailable(t *testing.T, format string, args ...any) {
	t.Helper()
	if os.Getenv("KERNEL_TESTS_REQUIRE_KUBERNETES") == "1" {
		t.Fatalf(format, args...)
	}
	t.Skipf(format, args...)
}

var (
	clusterOnce sync.Once
	client      kubernetes.Interface
	kindName    string
	clusterErr  error
)

// Cluster is a client for the current context's kind cluster.
func Cluster(t *testing.T) kubernetes.Interface {
	t.Helper()
	clusterOnce.Do(func() {
		rules := clientcmd.NewDefaultClientConfigLoadingRules()
		loader := clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, &clientcmd.ConfigOverrides{})
		raw, err := loader.RawConfig()
		if err != nil || !strings.HasPrefix(raw.CurrentContext, "kind-") {
			clusterErr = fmt.Errorf("the current kubectl context (%q) isn't a kind cluster", raw.CurrentContext)
			return
		}
		kindName = strings.TrimPrefix(raw.CurrentContext, "kind-")
		config, err := loader.ClientConfig()
		if err == nil {
			client, err = kubernetes.NewForConfig(config)
		}
		if err == nil {
			_, err = client.CoreV1().Namespaces().Get(context.Background(), Namespace, metav1.GetOptions{})
		}
		if err != nil {
			clusterErr = fmt.Errorf("the cluster isn't reachable, or has no %s namespace: %w", Namespace, err)
		}
	})
	if clusterErr != nil {
		unavailable(t, "%v", clusterErr)
	}
	return client
}

// The local install's registry (make kind-registry), when it's running.
const localRegistry = "localhost:5001"

var (
	imagesMu sync.Mutex
	loaded   = map[string]result{}
)

type result struct {
	ref string
	err error
}

// Image builds a test image and gets it to the cluster, once per run, and
// is the reference to run it by. With the local registry running it's
// pushed there: on a kind node backed by Docker Desktop's containerd image
// store, the kubelet doesn't find images `kind load` put there (it tries
// to pull them). Without one (CI) it's kind-loaded.
func Image(t *testing.T, tag string) string {
	t.Helper()
	Cluster(t)
	imagesMu.Lock()
	defer imagesMu.Unlock()
	r, done := loaded[tag]
	if !done {
		r.ref, r.err = buildAndLoad(tag)
		loaded[tag] = r
	}
	if r.err != nil {
		unavailable(t, "%v", r.err)
	}
	return r.ref
}

func run(args ...string) error {
	if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
		return fmt.Errorf("%s: %v: %s", strings.Join(args, " "), err, out)
	}
	return nil
}

func buildAndLoad(tag string) (string, error) {
	root, err := repoRoot()
	if err != nil {
		return "", err
	}
	if err := run("docker", "build", "-q", "-t", tag, filepath.Join(root, imageDirs[tag])); err != nil {
		return "", err
	}
	if out, _ := exec.Command("docker", "container", "inspect", "-f", "{{.State.Running}}", "kind-registry").Output(); strings.TrimSpace(string(out)) == "true" {
		ref := localRegistry + "/vennir-test/" + tag
		if err := run("docker", "tag", tag, ref); err != nil {
			return "", err
		}
		if err := run("docker", "push", "-q", ref); err != nil {
			return "", err
		}
		// By digest: a node keeps what it pulled under a tag, so a fixture
		// changed since would otherwise run as it was.
		out, err := exec.Command("docker", "inspect", "-f", "{{range .RepoDigests}}{{println .}}{{end}}", ref).Output()
		if err != nil {
			return "", fmt.Errorf("docker inspect %s: %v", ref, err)
		}
		for _, digest := range strings.Fields(string(out)) {
			if strings.HasPrefix(digest, localRegistry+"/vennir-test/") {
				return digest, nil
			}
		}
		return "", fmt.Errorf("%s was pushed, but docker names no digest for it", ref)
	}
	return tag, run("kind", "load", "docker-image", tag, "--name", kindName)
}

// repoRoot is found from the working directory (a package directory, as
// go test runs it), so a test binary built elsewhere works too.
func repoRoot() (string, error) {
	dir, err := os.Getwd()
	for err == nil {
		if _, statErr := os.Stat(filepath.Join(dir, "kernel", "go.mod")); statErr == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("not inside the repository (no kernel/go.mod above the working directory)")
}
