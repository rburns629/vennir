// SPDX-License-Identifier: MIT

package main

import (
	"strings"
	"testing"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// Every command says more than its one line and shows how it's used, and
// no flag's text has <...> (which manual pages would drop) or backticks
// around anything but its value's name.
func TestEveryCommandHasItsHelp(t *testing.T) {
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		path := c.CommandPath()
		builtin := strings.HasPrefix(path, "vennir completion") || path == "vennir help"
		topic := c.Runnable() == false && !c.HasSubCommands()
		if !c.Hidden && !builtin && !topic {
			if c.Long == "" {
				t.Errorf("%s: no longer description (help.go)", path)
			}
			if c.Example == "" {
				t.Errorf("%s: no examples (help.go)", path)
			}
		}
		c.LocalFlags().VisitAll(func(f *pflag.Flag) {
			if strings.ContainsAny(f.Usage, "<>") {
				t.Errorf("%s --%s: <...> in its text, which man pages drop", path, f.Name)
			}
			// Backticks name the flag's value (`REF`): anything else shows
			// up as the value's name in the flag list.
			if name, _ := pflag.UnquoteUsage(f); strings.Contains(f.Usage, "`") && strings.ToUpper(name) != name {
				t.Errorf("%s --%s: backticks around %q make it the value's name", path, f.Name, name)
			}
		})
		for _, sub := range c.Commands() {
			walk(sub)
		}
	}
	root := newRoot()
	walk(root)
	for path := range help {
		found := false
		var find func(c *cobra.Command)
		find = func(c *cobra.Command) {
			if c.CommandPath() == path {
				found = true
			}
			for _, sub := range c.Commands() {
				find(sub)
			}
		}
		find(root)
		if !found {
			t.Errorf("help.go describes %q, which isn't a command", path)
		}
	}
}
