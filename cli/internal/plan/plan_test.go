// SPDX-License-Identifier: MIT

package plan

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/rburns629/vertra/cli/internal/config"
)

func TestWrap(t *testing.T) {
	got := wrap("one two three four", 9)
	if strings.Join(got, "|") != "one two|three|four" {
		t.Errorf("got %q", got)
	}
	if got := wrap("", 10); len(got) != 1 || got[0] != "" {
		t.Errorf("empty: %q", got)
	}
	// Counted in characters, not bytes.
	if got := wrap("0.55–0.95 vCPU", 14); len(got) != 1 {
		t.Errorf("multi-byte: %q", got)
	}
}

func TestRenderAlignsAndWraps(t *testing.T) {
	p := &Plan{
		Title:    "Vertra source → kind (local) [dev]",
		Settings: []Line{{Label: "Size", Text: "minimal"}, {Label: "Task images", Text: strings.Repeat("word ", 40)}},
		Changes:  []Line{{Label: "Will create", Text: "kind cluster vertra"}},
		Cost:     []Line{{Label: "Estimated cost", Text: "$0"}},
		Notes:    []string{"a note"},
	}
	var b strings.Builder
	p.Render(&b)
	out := b.String()
	for _, line := range strings.Split(out, "\n") {
		if n := utf8.RuneCountInString(line); n > Width {
			t.Errorf("line of %d characters: %q", n, line)
		}
	}
	for _, want := range []string{
		"Size         minimal\n",
		"Task images  word",
		"\n             word", // continuation lines line up with the text
		"Will create  kind cluster vertra",
		"Estimated cost  $0",
		"Note  a note",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
}

func TestFloorOf(t *testing.T) {
	c := config.Default("gcp")
	c.Size, c.Gateway.Enabled, c.Logs.Enabled, c.Monitoring.Enabled = "minimal", false, false, false
	if f := FloorOf(c); f.CPU != Floors["minimal"].CPU || f.Memory != Floors["minimal"].Memory {
		t.Fatalf("nothing optional: %s, %s", f.CPU, f.Memory)
	}
	c.Gateway.Enabled = true
	if f := FloorOf(c); f.CPU != "0.6 vCPU" || f.Memory != "1.81 GiB" {
		t.Fatalf("with the gateway: %s, %s", f.CPU, f.Memory)
	}
	c.Size, c.Logs.Enabled = "auto", true
	if f := FloorOf(c); f.CPU != "1–1.4 vCPU" || f.Memory != "2.69–4.19 GiB" {
		t.Fatalf("auto, with the gateway and logs: %s, %s", f.CPU, f.Memory)
	}
	c.Monitoring = config.Monitoring{Enabled: true, Provider: "operator"}
	if f := FloorOf(c); f.CPU != "1–1.4 vCPU" || len(f.OptionalVolumesGiB) != 1 {
		t.Fatalf("the cluster's own Prometheus costs nothing here: %s, %v GiB", f.CPU, f.OptionalVolumesGiB)
	}
	c.Monitoring.Provider = "bundled"
	if f := FloorOf(c); len(f.OptionalVolumesGiB) != 2 || f.OptionalVolumesGiB[0]+f.OptionalVolumesGiB[1] != 4 || f.VolumeGiB != Floors["auto"].VolumeGiB {
		t.Fatalf("log search's volume and the bundled Prometheus's: %v GiB (the database's %v)", f.OptionalVolumesGiB, f.VolumeGiB)
	}
}

// A managed database's install runs no Postgres Pod, so its floor hasn't it.
func TestAManagedDatabaseFloorHasNoPostgresPod(t *testing.T) {
	c := config.Default("gcp")
	c.Size, c.Gateway.Enabled, c.Logs.Enabled, c.Monitoring.Enabled = "scaled", false, false, false
	c.Database.Type = "managed"
	if f := FloorOf(c); f.CPU != "0.8 vCPU" || f.Memory != "3.25 GiB" || f.CPUCores != [2]float64{0.8, 0.8} {
		t.Fatalf("scaled, managed: %s, %s", f.CPU, f.Memory)
	}
	c.Size = "minimal"
	if f := FloorOf(c); f.CPU != "0.3 vCPU" || f.Memory != "1.25 GiB" {
		t.Fatalf("minimal, managed: %s, %s", f.CPU, f.Memory)
	}
}
