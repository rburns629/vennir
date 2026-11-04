// SPDX-License-Identifier: MIT

// Package catalogtemplate holds catalog-template/ as released with this
// CLI, so a released vennir makes catalogs whose format its own release's
// console reads. The release workflow writes template.tgz (`git archive`
// of catalog-template/) before building; a build from a checkout has it
// empty and reads the checkout's (`vennir: source`).
package catalogtemplate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

//go:embed template.tgz
var archive []byte

// Embedded says whether this binary carries the template.
func Embedded() bool { return len(archive) > 0 }

// Extract writes the template into dir and returns its catalog-template/.
func Extract(dir string) (string, error) {
	if !Embedded() {
		return "", errors.New("this vennir was built without the catalog template")
	}
	return extract(archive, dir)
}

// extract unpacks a gzipped tar of catalog-template/ into dir, keeping each
// file's executable bit (./vennir, the scripts) and refusing anything but
// plain files and directories inside catalog-template/.
func extract(data []byte, dir string) (string, error) {
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return "", fmt.Errorf("the embedded catalog template: %w", err)
	}
	tr := tar.NewReader(gz)
	root := filepath.Join(dir, "catalog-template")
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", fmt.Errorf("the embedded catalog template: %w", err)
		}
		name := filepath.Clean(filepath.FromSlash(h.Name))
		if name != "catalog-template" && !strings.HasPrefix(name, "catalog-template"+string(filepath.Separator)) {
			if h.Typeflag == tar.TypeXGlobalHeader {
				continue // git archive's commit id
			}
			return "", fmt.Errorf("the embedded catalog template has %q, outside catalog-template/", h.Name)
		}
		target := filepath.Join(dir, name)
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return "", err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return "", err
			}
			mode := os.FileMode(0o644)
			if h.Mode&0o111 != 0 {
				mode = 0o755
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
			if err != nil {
				return "", err
			}
			_, err = io.Copy(f, tr)
			if cerr := f.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return "", err
			}
		default:
			return "", fmt.Errorf("the embedded catalog template has %q, not a file or directory", h.Name)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "vennir")); err != nil {
		return "", errors.New("the embedded catalog template has no ./vennir")
	}
	return root, nil
}
