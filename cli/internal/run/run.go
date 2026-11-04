// SPDX-License-Identifier: MIT

// Package run runs the external tools vennir drives (kubectl, helm,
// kind, docker, the cloud CLIs): always as an argument list, never through
// a shell, so no value can become part of a command line.
package run

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
)

// Runner runs commands. Tool names are resolved through Resolve, so a tool
// downloaded into vennir's own directory is used without being on PATH.
type Runner struct {
	// Verbose echoes each command before running it.
	Verbose bool
	Out     io.Writer
	Err     io.Writer
	// Resolve maps a tool name to the executable to run; nil runs it by name.
	Resolve func(name string) string
}

// New returns a Runner writing to the terminal.
func New(verbose bool, resolve func(string) string) *Runner {
	return &Runner{Verbose: verbose, Out: os.Stdout, Err: os.Stderr, Resolve: resolve}
}

func (r *Runner) command(ctx context.Context, name string, args []string) *exec.Cmd {
	path := name
	if r.Resolve != nil {
		path = r.Resolve(name)
	}
	if r.Verbose {
		fmt.Fprintf(r.Err, "+ %s %s\n", name, strings.Join(args, " "))
	}
	return exec.CommandContext(ctx, path, args...)
}

// Interactive runs a command attached to this terminal (a sign-in that
// opens a browser and asks questions).
func (r *Runner) Interactive(ctx context.Context, name string, args ...string) error {
	cmd := r.command(ctx, name, args)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %s: %w", name, firstArg(args), err)
	}
	return nil
}

// Exec is Output in the shape the access checks take.
func (r *Runner) Exec(ctx context.Context, name string, args ...string) (string, error) {
	return r.Output(ctx, name, args...)
}

// Run runs a command with its output shown as it happens.
func (r *Runner) Run(ctx context.Context, name string, args ...string) error {
	cmd := r.command(ctx, name, args)
	cmd.Stdout, cmd.Stderr = r.Out, r.Err
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %s: %w", name, firstArg(args), err)
	}
	return nil
}

// RunInput is Run with stdin supplied (manifests for kubectl apply -f -).
func (r *Runner) RunInput(ctx context.Context, input string, name string, args ...string) error {
	cmd := r.command(ctx, name, args)
	cmd.Stdin = strings.NewReader(input)
	cmd.Stdout, cmd.Stderr = r.Out, r.Err
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %s: %w", name, firstArg(args), err)
	}
	return nil
}

// OutputInput is Output with stdin supplied (a request body, a secret).
func (r *Runner) OutputInput(ctx context.Context, input string, name string, args ...string) (string, error) {
	cmd := r.command(ctx, name, args)
	cmd.Stdin = strings.NewReader(input)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return strings.TrimSpace(stdout.String()), fmt.Errorf("%s %s: %s", name, firstArg(args), msg)
	}
	return strings.TrimSpace(stdout.String()), nil
}

// ToWriter runs a command with its standard output written to w (a file:
// a database dump, too big to hold). On failure the error carries its
// standard error.
func (r *Runner) ToWriter(ctx context.Context, w io.Writer, name string, args ...string) error {
	cmd := r.command(ctx, name, args)
	var stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = w, &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("%s %s: %s", name, firstArg(args), msg)
	}
	return nil
}

// FromReader runs a command with in as its standard input (a file, too big
// to hold) and its output shown.
func (r *Runner) FromReader(ctx context.Context, in io.Reader, name string, args ...string) error {
	cmd := r.command(ctx, name, args)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = in, r.Out, r.Err
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s %s: %w", name, firstArg(args), err)
	}
	return nil
}

// Output runs a command and returns its standard output, trimmed. On
// failure the error carries the command's standard error.
func (r *Runner) Output(ctx context.Context, name string, args ...string) (string, error) {
	cmd := r.command(ctx, name, args)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return strings.TrimSpace(stdout.String()), fmt.Errorf("%s %s: %s", name, firstArg(args), msg)
	}
	return strings.TrimSpace(stdout.String()), nil
}

// Succeeds reports whether a command exits zero, discarding its output.
func (r *Runner) Succeeds(ctx context.Context, name string, args ...string) bool {
	cmd := r.command(ctx, name, args)
	return cmd.Run() == nil
}

// firstArg names a command for its errors: its first word that isn't a
// flag or a flag's value (kubectl --context x --namespace y exec: exec).
func firstArg(args []string) string {
	for i := 0; i < len(args); i++ {
		switch a := args[i]; {
		case a == "--" || a == "-":
			return a
		case strings.HasPrefix(a, "-"):
			if !strings.Contains(a, "=") && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") && valued[a] {
				i++ // its value
			}
		default:
			return a
		}
	}
	if len(args) > 0 {
		return args[0]
	}
	return ""
}

// valued are the flags vennir puts before a command's word that take a
// value.
var valued = map[string]bool{"--context": true, "--namespace": true, "-n": true, "--kube-context": true, "--profile": true, "--region": true, "--project": true}

// Together runs fs at once and waits for them all: independent lookups,
// each a second or more against a cloud cluster, made side by side.
func Together(fs ...func()) {
	var wg sync.WaitGroup
	for _, f := range fs {
		wg.Go(f)
	}
	wg.Wait()
}
