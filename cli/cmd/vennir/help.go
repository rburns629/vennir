// SPDX-License-Identifier: MIT

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
	"github.com/spf13/cobra/doc"

	"github.com/roburns/vennir/cli/internal/config"
	"github.com/roburns/vennir/cli/internal/plan"
)

// rootLong is `vennir --help`'s introduction.
const rootLong = `vennir installs and operates Vennir: on your machine (kind), Google Cloud,
AWS, or a Kubernetes cluster you already have.

  vennir init dev          ask the questions, write deploy/dev/vennir.yaml
  vennir apply dev         show what it will create and cost; on approval, do it
  vennir console dev       open the console at http://localhost:18080

Each environment is a folder, deploy/<env>/ (or --config, or VENNIR_CONFIG),
holding vennir.yaml: its settings, names and references only, never a
secret. A command's [env] can be left out when there's only one.

Nothing in the cloud or the cluster changes until you approve apply's
screen (or pass --yes). Change a setting with ` + "`vennir config set`" + `, then apply;
` + "`vennir help settings`" + ` explains each one, ` + "`vennir help sizes`" + ` what each size is.

Guides: docs/setup.md (installing), docs/operations.md (running it).`

// rootExample is `vennir --help`'s examples.
const rootExample = `  vennir init dev && vennir apply dev
  vennir config set -e dev size resilient && vennir apply dev
  vennir help settings`

// help is each command's longer description and examples, by its path
// (applied to the tree by withHelp; a test keeps every command covered).
var help = map[string]struct{ long, example string }{
	"vennir init": {
		long: `Asks where and how to install Vennir, with what each choice costs or gives
up: where (kind, gcp, aws, azure, existing), the size, sleeping when idle, the
database (in-cluster, or managed: Cloud SQL, Amazon RDS), the first admin,
the console's address, the catalog, and what else it keeps and serves.
It checks the tools and your sign-in to the cloud, then writes
deploy/<env>/vennir.yaml. Nothing is created until ` + "`vennir apply`" + `.

Every question has a flag, so with --non-interactive the flags and
defaults answer. --force replaces an environment's settings.`,
		example: `  vennir init dev
  vennir init prod --target gcp --project my-project --size resilient --database managed
  vennir init dev --non-interactive --target kind --admin-email admin@example.com`,
	},
	"vennir apply": {
		long: `Plans everything and shows it on one screen: what it will create, change or
delete in the cloud and the cluster, what it builds and installs, and an
estimate of the monthly cost (gcp: your billing account's prices when you
may read them; otherwise list prices, and it says which). Nothing happens
until you approve. Then it creates the cloud side (OpenTofu), readies the
cluster and installs or upgrades both charts. Run it again after any
change: it makes the install match vennir.yaml, and does nothing more
when it already does. The approved screen is saved as last-plan.txt.

Changing database.type from in-cluster to managed moves the data: the
screen says so, the platform stops while both databases are copied in the
cluster, and starts on the managed server (vennir help settings).

Upgrading is setting vennir to a newer release (vennir config set vennir
0.6.0), then apply. Its screen names the releases an upgrade passes over
(read their notes), and says when this vennir is older than the release
it installs. It refuses to go to an older release: migrations only go
forward.`,
		example: `  vennir apply dev
  vennir apply dev --plan-only     # the screen only
  vennir apply dev --yes           # no question (CI, scripts)`,
	},
	"vennir check": {
		long: `Checks without changing anything: the tools, your sign-in to the cloud,
the cluster, and what's installed. What a run of apply would need, and
what's wrong if it would fail. It says when a newer release than the
installed one is out. On aws with the chat on, it also asks
Amazon Bedrock whether the account may still use the chat's model.`,
		example: `  vennir check dev`,
	},
	"vennir status": {
		long: `Says what's installed (each release and its version), each of the
platform's Deployments and how many of its copies are ready, and whether
it's asleep. With a public console: its address (on gcp, with its
certificate's state); on an existing cluster, a check of its DNS record
and certificate.`,
		example: `  vennir status dev`,
	},
	"vennir logs": {
		long: `Shows the platform's logs, each line with its Pod and time: by default the
console, the gateway, kernel-api and the scheduler, the last hour, at most
200 lines a Pod. Name components to choose others: console, gateway, api,
scheduler, postgres, migrate, backup, sleeper, scanner, loki.

With --execution, an execution's steps' logs instead, from the team
namespaces they ran in, while their Pods are still there. Observe in the
console keeps logs longer, and searchable (with logs on).`,
		example: `  vennir logs dev
  vennir logs dev scheduler -f
  vennir logs dev migrate --since 24h
  vennir logs dev --execution 3f2c9a7e-0b1d-4a51-9c6e-2d8f4b7a1e05`,
	},
	"vennir backup": {
		long: `Backs up both databases now, the kernel's and the console's, as one pair
with one timestamp:
  - With backups on (gcp, aws), it runs the backup Job now and waits: the
    dumps go to the bucket, as the daily ones do.
  - With --to a folder, it dumps them into that folder instead, from any
    install's in-cluster Postgres, kind included. They hold everything in
    the console: keep them safe.
  - With a managed database, it takes an on-demand backup with your own
    sign-in: a Cloud SQL backup, or an RDS snapshot.
Before an upgrade is a good time.`,
		example: `  vennir backup dev
  vennir backup dev --to ~/vennir-dumps`,
	},
	"vennir backups": {
		long: `Lists the backups: the pairs in the bucket (each the kernel's and the
console's database, by its time), or a managed database's, as its cloud
lists them.`,
		example: `  vennir backups dev`,
	},
	"vennir restore": {
		long: `Replaces both databases of the in-cluster Postgres with a backup: one from
the bucket, by its time (vennir backups lists them), or from a folder of
dumps (--from, its newest unless a time is given). Everything since the
backup is lost, so it asks first, and dumps the databases as they are into
~/.vennir/backups/<env>/before-restore.

It stops what writes to the databases (and the sleeper), restores both,
then starts them again at the copies they had. If it fails partway they
stay stopped, and running it again finishes. When the backup's schema is
older than the one it replaced, it says to run vennir apply, which
migrates it forward.

A managed database is restored by its cloud; it says how.`,
		example: `  vennir restore dev 2026-10-29T03-00-00Z
  vennir restore dev --from ~/vennir-dumps`,
	},
	"vennir console": {
		long: `Port-forwards the console to http://localhost:18080 (or --port) until
Ctrl-C: for a console that isn't public, or to reach one directly.`,
		example: `  vennir console dev
  vennir console dev --port 8080`,
	},
	"vennir sleep": {
		long: `Scales the platform to zero, keeping its data: the console and API stop
answering, and on a cloud the nodes go. It won't while steps are running,
unless --force. ` + "`vennir wake`" + ` brings it back; with scaleDown on, it also sleeps by
itself when idle (scaleDown.idleAfter) or at scaleDown.schedule. A
managed database keeps running (and billing) while asleep.`,
		example: `  vennir sleep dev
  vennir sleep dev --force`,
	},
	"vennir wake": {
		long: `Brings a sleeping platform back, as it was before it slept, and waits until
the console answers.`,
		example: `  vennir wake dev`,
	},
	"vennir destroy": {
		long: `Removes what vennir created: the releases, and on a cloud the cluster and
everything the module made. It asks about each kind of data first (the
database, its backups, logs, the registry), keeping whatever you say;
--all deletes them too. A kept managed database keeps its network. The
audit log's write-once copy is always kept. The environment's folder stays.
On an existing cluster it also asks about the team namespaces the console
made (by name; none labelled by hand) and each add-on vennir installed there
(--all doesn't answer those: they're kept unless you say yes).`,
		example: `  vennir destroy dev
  vennir destroy dev --all --yes   # everything, data included, no questions`,
	},
	"vennir config": {
		long: `Reads or changes the settings in deploy/<env>/vennir.yaml. A change is
checked, then saved; ` + "`vennir apply`" + ` makes the install match it.
` + "`vennir help settings`" + ` explains every key.`,
		example: `  vennir config get -e dev
  vennir config set -e dev size resilient`,
	},
	"vennir config get": {
		long:    `Prints one setting, or every setting that has a value.`,
		example: "  vennir config get -e dev\n  vennir config get -e dev database.type",
	},
	"vennir config set": {
		long: `Changes one setting (a dotted key, ` + "`vennir help settings`" + `), checks the result
and saves it. Nothing changes in the install until ` + "`vennir apply`" + `. A list
takes commas.`,
		example: `  vennir config set -e dev size resilient
  vennir config set -e dev scaleDown.schedule "0 20 * * 1-5"
  vennir config set -e dev gateway.backendHosts "api.example.com,*.run.app"`,
	},
	"vennir tools": {
		long: `Lists the tools an environment needs (kubectl, helm, OpenTofu, kind,
docker; gcloud, aws or az for a cloud) and which are missing. --install
downloads the ones vennir can, each a pinned version checked against its
checksum, into ~/.vennir/bin. Docker and the clouds' CLIs are yours to
install.`,
		example: `  vennir tools dev
  vennir tools --target aws --install`,
	},
	"vennir version": {
		long: `Prints vennir's version: a release's, or dev for one built from a checkout;
and when a newer release is out, which (GitHub's list, cached a day).`,
		example: `  vennir version`,
	},
	"vennir admin": {
		long:    `Recovers access to the console from the cluster's side.`,
		example: `  vennir admin reset-password dev`,
	},
	"vennir admin reset-password": {
		example: `  vennir admin reset-password dev
  vennir admin reset-password dev --email ops@example.com`,
	},
	"vennir sso": {
		long:    `Sets up single sign-on with Google Workspace; passwords keep working.`,
		example: `  vennir sso google dev`,
	},
	"vennir sso google": {
		example: `  vennir sso google dev
  vennir sso google dev --client-file ~/Downloads/client.json --domains example.com`,
	},
	"vennir sso google-groups": {
		example: `  vennir sso google-groups dev
  vennir sso google-groups dev --off`,
	},
	"vennir sso off": {
		long:    `Stops Google sign-in at the next apply; people sign in with passwords.`,
		example: `  vennir sso off dev`,
	},
	"vennir catalog": {
		long: `A catalog is a repository of your teams' products, templates and APIs.
` + "`vennir catalog create`" + ` makes one, and ` + "`vennir catalog grant`" + ` lets another install
read it; the rest run inside it, through its ./vennir
(which pins vennir's version): locally while writing a product, and in
its CI, which publishes what's merged as a signed release each install
pulls.`,
		example: `  vennir catalog create dev
  ./vennir catalog check teams/web/products/site
  ./vennir catalog publish teams/web/products/site && ./vennir catalog release`,
	},
	"vennir catalog create": {
		example: `  vennir catalog create dev
  vennir catalog create dev --plan-only`,
	},
	"vennir catalog grant": {
		long: `Run in the environment of the install that owns the catalog: lets another
install read it (its images and its release, nothing else), granted to
exactly that install's identity, with no key stored anywhere. The reader's
` + "`vennir apply`" + ` prints the command to run, its flags filled in.

  --issuer and --subject: a reader on another cloud, or another AWS
  account, by its cluster's OIDC identity (its console's ServiceAccount).
  gcp: a provider in the pool vennir-installs trusting that issuer for
  that subject alone, given roles/artifactregistry.reader on the
  repository. aws: an IAM OIDC provider for the issuer, and a role
  (vennir-reader-NAME) only that subject may assume by web identity,
  which may pull and list tags in the catalog's repositories alone. When
  that role already trusts another issuer or subject (another reader of
  the same name), it refuses, on --revoke too, unless --replace.
  --service-account: a reader on Google Cloud reading an Artifact
  Registry, by its own service accounts, each given read on the
  repository.

It looks first and shows what it will change, then asks (--yes doesn't);
running it again changes nothing. It runs gcloud or aws as you. Then the
reader sets what it prints (the provider or the role) and applies.
--revoke takes the grant away.`,
		example: `  vennir catalog grant prod --reader vennir-eks --issuer https://oidc.eks.us-east-2.amazonaws.com/id/EXAMPLE \
    --subject system:serviceaccount:vennir-system:console-execution-console
  vennir catalog grant prod --reader vennir-gke --service-account vennir-gke-console@reader.iam.gserviceaccount.com \
    --service-account vennir-gke-nodes@reader.iam.gserviceaccount.com
  vennir catalog grant prod --reader vennir-eks --issuer ... --subject ... --revoke`,
	},
	"vennir catalog validate": {
		long: `Checks product.yaml and team.yaml against the catalog's schemas, the types
products wire by, and that each product has tests. No Docker needed.`,
		example: `  ./vennir catalog validate
  ./vennir catalog validate teams/web/products/site`,
	},
	"vennir catalog check": {
		long: `What a pull request runs: validates, builds each product's image, runs its
tests against it the way the platform runs a step (hardened, no network),
and scans it (Trivy, OSV); a fixable high or critical vulnerability or a
secret fails it.`,
		example: `  ./vennir catalog check teams/web/products/site
  ./vennir catalog check --changed origin/main`,
	},
	"vennir catalog publish": {
		long: `Checks, then pushes each product's image to the registry, pinned by digest
and signed when the install requires it.`,
		example: `  ./vennir catalog publish teams/web/products/site`,
	},
	"vennir catalog release": {
		long: `Pushes the catalog's release (every team, product and template as of this
commit) as an OCI artifact, signed when the install requires it; each
install's console pulls and applies it, refusing one it can't verify when
it trusts a signer.`,
		example: `  ./vennir catalog release`,
	},
	"vennir catalog promote": {
		long: `Makes a version (vX.Y.Z) of the release main published for a commit, for
installs that follow versions (catalogVersion: newest, or a pinned one).`,
		example: `  ./vennir catalog promote v1.4.0
  ./vennir catalog promote v1.4.1 --from 3f2c9e1`,
	},
	"vennir catalog plan": {
		long: `Writes, as JSON, the builds publishing needs from teams that build in a
GitHub Environment of their own (buildEnvironments in vennir.yaml): each
such team's products publish would choose. In CI it first refuses any
team whose Environment, team-<name>, can be used from more than main.
Catalog CI's plan job; its build jobs read it.`,
		example: `  ./vennir catalog plan --changed origin/main --out plan.json`,
	},
	"vennir catalog build": {
		long: `Builds one team's products in its own Environment, offering each of the
Environment's secrets (VENNIR_BUILD_SECRETS, a JSON object) to docker
build as a BuildKit secret of its own name, then saves each image to
DIR/<team>/<product>.tar for publish --images to load, test, scan, push
and sign. It pushes nothing. A Dockerfile reads a secret with
RUN --mount=type=secret,id=NAME, so it never lands in a layer.`,
		example: `  VENNIR_BUILD_SECRETS='{"NPM_TOKEN":"..."}' ./vennir catalog build --out images teams/web/products/site`,
	},
	"vennir catalog environments": {
		long: `Makes the GitHub Environment (team-<name>) of each team buildEnvironments
lists in vennir.yaml, and limits it to main, so no pull request can have
its secrets; its secrets, reviewers and wait timer are kept. Run it as a
catalog admin (gh signed in as one) after listing a team, before adding
the team's secrets to its Environment.`,
		example: `  ./vennir catalog environments
  ./vennir catalog environments --repo your-org/catalog`,
	},
	"vennir catalog changed": {
		long:    `Lists the products changed since a ref, as JSON: what CI checks and publishes.`,
		example: `  ./vennir catalog changed --base origin/main`,
	},
	"vennir catalog migrate": {
		long:    `Rewrites an older catalog's files to the current format, in place, for you to review and commit.`,
		example: `  ./vennir catalog migrate`,
	},
	"vennir catalog bases": {
		long: `Pins every Dockerfile's FROM to its digest, so a build always starts from
the same bytes. --update re-pins to what each tag names now.`,
		example: `  ./vennir catalog bases
  ./vennir catalog bases --update`,
	},
	"vennir catalog bases mirror": {
		long: `Copies each approved base image (bases.yaml) into the catalog's registry,
scans the copy (reported, not blocking: a product's own scan blocks), and
signs it when the catalog signs. Products then build FROM the copy
(` + "`bases --use-mirror`" + `) rather than a public registry.`,
		example: `  ./vennir catalog bases mirror`,
	},
	"vennir catalog secret-stores": {
		long:    `Checks the teams' SecretStore files, which a release carries to each install.`,
		example: `  ./vennir catalog secret-stores check`,
	},
	"vennir catalog secret-stores check": {
		long: `Checks each team's secret-stores/*.yaml against the rules every install's
console enforces when it applies them (which store kinds and identities a
team may use, and that no identity is two teams'), so a pull request finds
out before a release refuses the file.`,
		example: `  ./vennir catalog secret-stores check
  ./vennir catalog secret-stores check web`,
	},
}

// withHelp gives each command its longer description and examples, and adds
// the help topics and `vennir man`.
func withHelp(root *cobra.Command) *cobra.Command {
	root.Long, root.Example = rootLong, rootExample
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		if h, ok := help[c.CommandPath()]; ok {
			if h.long != "" {
				c.Long = h.long
			}
			c.Example = h.example
		}
		for _, sub := range c.Commands() {
			walk(sub)
		}
	}
	walk(root)
	root.AddCommand(settingsTopic(), sizesTopic(), manCmd(root))
	return root
}

// settingsTopic is `vennir help settings`: every key of vennir.yaml.
func settingsTopic() *cobra.Command {
	var b strings.Builder
	b.WriteString("Every setting in deploy/<env>/vennir.yaml, by its dotted key, as\n`vennir config get` and `vennir config set` name it. Apply after a change.\n\n")
	for _, s := range config.Settings {
		fmt.Fprintf(&b, "  %s\n      %s\n", s.Key, s.About)
	}
	return &cobra.Command{Use: "settings", Short: "Every setting in vennir.yaml, and what it does", Long: strings.TrimRight(b.String(), "\n")}
}

// sizesTopic is `vennir help sizes`: what each size gives.
func sizesTopic() *cobra.Command {
	var b strings.Builder
	b.WriteString("What each size sets (`vennir config set size <size>`, then apply). Each\nalso sizes the database and every service's connections to it; a volume\ngrows with the size, never shrinks.\n")
	for _, s := range config.Sizes {
		f := plan.Floors[s]
		fmt.Fprintf(&b, "\n  %s\n    %s; platform %s, %s awake\n    steps: %s\n    in-cluster database volume: %s\n", s, f.Copies, f.CPU, f.Memory, f.Steps, f.Volume)
	}
	return &cobra.Command{Use: "sizes", Short: "What each size gives: copies, steps, the database", Long: strings.TrimRight(b.String(), "\n")}
}

// manCmd is `vennir man`: a manual page per command.
func manCmd(root *cobra.Command) *cobra.Command {
	return &cobra.Command{
		Use:   "man [dir]",
		Short: "Write vennir's manual pages (one per command) to a folder",
		Long: "Writes a manual page for vennir and each of its commands to dir/man1\n" +
			"(dir defaults to ./man), for man(1) to read: a dir already on MANPATH,\n" +
			"such as ~/.local/share/man, or one you add to it.",
		Example: "  vennir man ~/.local/share/man && man vennir-apply\n  vennir man ./man && MANPATH=./man:$MANPATH man vennir",
		Args:    cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir := "man"
			if len(args) == 1 {
				dir = args[0]
			}
			dir = filepath.Join(dir, "man1")
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return err
			}
			header := &doc.GenManHeader{Title: "VENNIR", Section: "1", Source: "vennir " + Version, Manual: "Vennir"}
			root.DisableAutoGenTag = true
			escapeForMan(root)
			if err := doc.GenManTree(root, header, dir); err != nil {
				return err
			}
			fmt.Fprintf(cmd.OutOrStdout(), "Wrote vennir's manual pages to %s: `man vennir` once its parent is on MANPATH.\n", dir)
			return nil
		},
	}
}

// escapeForMan keeps <env>, <key> and the like in the manual pages: their
// text passes through Markdown, which takes <...> for HTML and drops it.
// (Examples are code blocks, and flags' text isn't Markdown: both are left
// as they are, and a test keeps flags' text free of <...>.) The process
// ends after.
func escapeForMan(c *cobra.Command) {
	esc := strings.NewReplacer("<", `\<`, ">", `\>`)
	c.Use, c.Short, c.Long = esc.Replace(c.Use), esc.Replace(c.Short), esc.Replace(c.Long)
	for _, sub := range c.Commands() {
		escapeForMan(sub)
	}
}
