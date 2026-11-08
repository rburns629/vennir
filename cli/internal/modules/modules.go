// SPDX-License-Identifier: MIT

// Package modules holds the OpenTofu modules, one per cloud, embedded so a
// CLI version always runs the module it was tested with. Each is also a
// plain module, for teams that run OpenTofu or Terraform themselves.
package modules

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

//go:embed gcp/*.tf gcp/.terraform.lock.hcl aws/*.tf aws/.terraform.lock.hcl azure/*.tf azure/.terraform.lock.hcl
var files embed.FS

// Write puts a cloud's module into dir (the environment's tofu/), replacing
// the .tf files and the lock file from an older CLI. State and plans stay.
func Write(cloud, dir string) error {
	entries, err := fs.ReadDir(files, cloud)
	if err != nil {
		return fmt.Errorf("no OpenTofu module for %s", cloud)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	old, _ := filepath.Glob(filepath.Join(dir, "*.tf"))
	for _, f := range old {
		if err := os.Remove(f); err != nil {
			return err
		}
	}
	for _, e := range entries {
		data, err := files.ReadFile(cloud + "/" + e.Name())
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, e.Name()), data, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// Names lists a module's files (for tests).
func Names(cloud string) []string {
	entries, _ := fs.ReadDir(files, cloud)
	var names []string
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), "_") {
			names = append(names, e.Name())
		}
	}
	return names
}

// Read returns one of a module's files (for tests).
func Read(cloud, name string) ([]byte, error) {
	return files.ReadFile(cloud + "/" + name)
}
