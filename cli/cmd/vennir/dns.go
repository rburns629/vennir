// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"slices"
	"strings"
	"time"

	"github.com/rburns629/vennir/cli/internal/cluster"
	"github.com/rburns629/vennir/cli/internal/config"
	"github.com/rburns629/vennir/cli/internal/install"
)

// consoleRecord is the DNS record a public console's hostname needs when
// adding it is the user's to do: a hostname of theirs on gcp (to the
// reserved address), or on an existing cluster (to its Ingress
// controller). None for a nip.io name, or on aws (vennir writes it in the
// zone it made).
func (a *app) consoleRecord(ctx context.Context, c *config.Config, made *install.Cloud) (host, kind, target string) {
	switch {
	case made != nil && made.Provider == "gcp" && c.Console.Hostname != "" && made.ConsoleIP != "":
		return c.Console.Hostname, "A", made.ConsoleIP
	case c.Target == "existing" && c.Console.Public:
		// The controller's address, once it has published it on the Ingress.
		var ip, name string
		_ = waitFor(ctx, 3*time.Minute, 10*time.Second, func() (bool, error) {
			out, _ := a.runner.Output(ctx, "kubectl", "--context", cluster.Context(c), "--namespace", c.Namespace,
				"get", "ingress", install.ConsoleRelease+"-execution-console",
				"-o", "jsonpath={.status.loadBalancer.ingress[0].ip} {.status.loadBalancer.ingress[0].hostname}")
			fields := strings.Fields(out)
			for _, f := range fields {
				if net.ParseIP(f) != nil {
					ip = f
				} else {
					name = f
				}
			}
			return ip != "" || name != "", nil
		})
		if ip != "" {
			return c.Console.Hostname, "A", ip
		}
		if name != "" {
			return c.Console.Hostname, "CNAME", name
		}
		return c.Console.Hostname, "", ""
	}
	return "", "", ""
}

// resolvesTo is whether host already leads to target (an address, or the
// name a CNAME points at).
func resolvesTo(ctx context.Context, host, kind, target string) bool {
	if kind == "CNAME" {
		cname, err := net.DefaultResolver.LookupCNAME(ctx, host)
		return err == nil && strings.TrimSuffix(cname, ".") == strings.TrimSuffix(target, ".")
	}
	addrs, err := net.DefaultResolver.LookupHost(ctx, host)
	return err == nil && slices.Contains(addrs, target)
}

// consoleDNS says which record to add, if any is missing, and, asked
// interactively, waits for it to resolve (a certificate can't be issued
// for a name that leads nowhere).
func (a *app) consoleDNS(ctx context.Context, out io.Writer, c *config.Config, made *install.Cloud) {
	host, kind, target := a.consoleRecord(ctx, c, made)
	if host == "" {
		return
	}
	if target == "" {
		fmt.Fprintf(out, "DNS: %s should point at your Ingress controller, which hasn't published an address yet (kubectl get ingress -n %s).\n", host, c.Namespace)
		return
	}
	if resolvesTo(ctx, host, kind, target) {
		fmt.Fprintf(out, "DNS: %s → %s ✓\n", host, target)
		return
	}
	fmt.Fprintf(out, "\nAdd this DNS record where %s is managed (the name part only, if your provider adds the domain):\n", parentDomain(host))
	fmt.Fprintf(out, "  %-5s %s → %s   (TTL 300)\n", kind, host, target)
	if !a.ask.Interactive {
		fmt.Fprintln(out, "The certificate is issued once it resolves; `vennir status` checks.")
		return
	}
	fmt.Fprintln(out, "Waiting for it to resolve (Ctrl-C to stop: the certificate follows by itself once it does)...")
	if err := waitFor(ctx, 30*time.Minute, 15*time.Second, func() (bool, error) {
		return resolvesTo(ctx, host, kind, target), nil
	}); err == nil {
		fmt.Fprintf(out, "DNS: %s → %s ✓\n", host, target)
	}
}
