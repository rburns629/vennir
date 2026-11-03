// SPDX-License-Identifier: MIT

package catalogtool

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeTools puts a docker and a cosign that log their arguments in a
// folder on PATH (cosign failing when fail is set), and returns the log.
func fakeTools(t *testing.T, c *Catalog, failSign bool) string {
	t.Helper()
	bin := t.TempDir()
	log := filepath.Join(bin, "calls")
	docker := `#!/bin/sh
echo "docker $*" >> "` + log + `"
if [ "$1" = inspect ]; then echo '["registry.test/catalog/a/mine@sha256:` + strings.Repeat("a", 64) + `"]'; fi
`
	cosign := "#!/bin/sh\necho \"cosign $1\" >> \"" + log + "\"\n"
	if failSign {
		cosign += "exit 1\n"
	}
	for file, script := range map[string]string{"docker": docker, "cosign": cosign} {
		if err := os.WriteFile(filepath.Join(bin, file), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	c.Getenv = func(key string) string {
		if key == "DOCKER" {
			return filepath.Join(bin, "docker")
		}
		return ""
	}
	return log
}

// :latest moves only once the image is signed: a failed sign leaves it
// naming the last signed one.
func TestLatestIsTaggedOnlyOnceSigned(t *testing.T) {
	s := Settings{Registry: "registry.test/catalog", SigningMode: "keyless"}
	for _, failSign := range []bool{false, true} {
		c := catalogWith(t, product("mine", "[]"))
		log := fakeTools(t, c, failSign)
		p := c.AllProducts()[0]
		if c.Publish(p, s) == failSign {
			t.Fatalf("failSign %v: published %v", failSign, !failSign)
		}
		data, _ := os.ReadFile(log)
		calls := string(data)
		pushed := strings.Index(calls, "docker push registry.test/catalog/a/mine:local-")
		signed := strings.Index(calls, "cosign sign")
		latest := strings.Index(calls, "docker push registry.test/catalog/a/mine:latest")
		switch {
		case pushed < 0 || signed < pushed:
			t.Errorf("failSign %v: not pushed, then signed:\n%s", failSign, calls)
		case failSign && latest >= 0:
			t.Errorf(":latest moved though the sign failed:\n%s", calls)
		case !failSign && latest < signed:
			t.Errorf(":latest not moved after signing:\n%s", calls)
		}
	}
}
