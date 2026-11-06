# TODO

Open work, roughly by area. Before starting something here, check the code:
an item may be partly done. When you finish one, remove it; when you find a
new one, add it. Larger items are worth an issue first, to agree on the
design.

## Next, in order (agreed 2026-10-29 and 2026-10-30)

Solid before features: housekeeping and tests first, then features with
steps left, then one billed proof run per cloud, and the MCP server and
Azure last.

1. The next billed run: what's below in "To prove on a cloud".
2. Last: the MCP server, then Azure (its target, its managed Prometheus,
   the Azure sample signing in).

Blocked: the chat agent on Bedrock (the account's model access) and
Sigstore's newer signature format (policy-controller). Needs a decision:
masking Secret values in logs (suggested: leave it, documented in
`docs/security-model.md`, "Never print or return a secret").

## To prove on a cloud

Built and tested, proven on kind or against fakes, and not yet seen on a
cloud. One billed run, on acyclix-dev and a minimal EKS install, as the
last one was.

- [ ] **The step-Pods policy on GKE and EKS** (#216): that their Job
  controller makes Pods as a kube-system ServiceAccount, as kind's does, so
  every step's Pod is admitted.
- [ ] **Reading another install's catalog from ECR** (built 2026-10-30): a
  GKE reader of an EKS owner's ECR by AWS web identity
  (`externalCatalog.awsRoleArn`, `registryCheck.awsFederation`), and an EKS
  reader in a second account; each granted with `vennir catalog grant`,
  re-granted (no change) and revoked (refused within the hour): the release
  applied, a step pulled by the kubelet, policy-controller verifying through
  `vennir-pull`, the scan Job signing in. Also: the GKE issuer accepted as
  an IAM OIDC provider with no thumbprint, and gcloud accepting the prefixed
  `google.subject` mapping.
- [ ] **What a run created, labelled `vennir-team` on the cloud**: the
  samples label what they make with the run's team, and delete only what
  carries it (resources made before have none, and are refused until
  relabelled, as the sample READMEs say).
- [ ] **The base images' weekly mirror** (`vennir catalog bases mirror` in
  catalog CI): copying is tested against a registry; the weekly run itself
  isn't seen yet.
- [ ] **`vennir apply` waiting for a hostname's DNS record** on a cluster
  whose Ingress has a public address (`vennir status` showing it and the
  certificate).
- [ ] **A narrowed schema's refusal at checkout**, seen on a cluster: tested
  in the kernel, but no runnable sample provides a target type yet.
- [ ] **A team building in its own Environment** (built 2026-11-03,
  `buildEnvironments`): in a real catalog repository, `./vennir catalog
  environments` making `team-<team>` main only (and keeping a hand-added
  reviewer); the plan job reading its rules with the job's token (`actions:
  read`) and refusing one open to another branch; a Dockerfile reading a
  secret through `RUN --mount=type=secret`; the image handed to publish,
  loaded, scanned, pushed and signed; the weekly check loading it; a pull
  request only validating it.
- [ ] **The gateway on the internet, on GKE and EKS** (documented
  2026-11-03, `console/docs/21-api-gateway.md`): the values file it gives
  (`gateway.publicListener`, its Ingress, `publicListenerFrom`,
  `trustedProxies`) behind GKE's load balancer (a reserved address, a
  Google-managed certificate, the health check on `/.vennir/health`) and an
  ALB (ACM, `target-type: ip`); a backend seeing the caller's own address.
  Proven only on kind with Traefik.
- [ ] **Deploy GKE from a release once** (`make gke-deploy VERSION=...`,
  which deploys the release's signed charts and images, each signature
  checked against the release workflow's identity at that tag first): the
  one part of the billed run's plan not run (it installed the release with
  `vennir apply` instead).

## Found in the billed run (2026-10-31 and 2026-11-01)

Released 0.6.0 on GKE Autopilot and EKS standard. Each item names where
it was seen.

- [ ] **Move the GKE reference install out of `default`** (an admins' team
  namespace) into `vennir-system`, on the next billed GKE run. The repo is
  ready (the values, the Makefile, the chart's `allowReleaseNamespace`
  removed); the move, the console's and scanner's Workload Identity
  bindings to the new namespace, and policy-controller now covering
  `default` are proven only there (`docs/operations.md`, "Moving the
  platform out of a team's namespace").
- [ ] **Completion lag on GKE is policy-controller's webhook** (the r7 run,
  `perf/README.md`, "On GKE again"): with 40 at once, Job creations waited
  out its 10 s and were retried, and a pass that dispatches records nothing
  that finished until it's done. Recorded first now, in a transaction of its
  own (2026-11-02, the kernel's `RecordPass`, then `DispatchPass`; to see on
  GKE). And policy-controller checks Pods only now (the kernel chart's
  policy `match`; a refused Pod read as `IMAGE_NOT_SIGNED`), with a second
  policy passing Jobs and other workloads, so a Job's creation never waits
  on it; `no-match-policy` stays `deny`, so only signed source-registry
  images run in team namespaces (seen on kind, 2026-11-02). To see on GKE:
  the webhook still admits each Job (no signature fetched), so if Job
  creation is still slow there, size policy-controller for the install (CPU
  on Autopilot, a second replica on resilient and scaled). The Admin page's
  image sources card says added sources don't run where signing is required
  (board 12j, 2026-11-02). Also to see on the next GKE run: build-image's
  encoded package name over gRPC (#74; seen only by REST).
- [ ] **Cloud SQL's roles held to the instance by an IAM condition** (#165):
  unproven that `cloudsql.instances.login` (Instance User) is checked
  against the instance, so that `resource.name ==
  "projects/<project>/instances/<instance>"` admits it. Before relying on
  it, prove one IAM sign-in on acyclix-dev with a managed database (the
  kernel, console, gateway and `kernel database-setup` all connect), and
  that upgrading an install whose bindings had no condition keeps sign-ins
  working through the apply.

## Installing and operating

- [ ] **The gcp access check reads only a location policy's allowed values**
  (found 2026-11-03): `orgPolicyValues` (`cli/internal/access/gcp.go`) reads
  `listPolicy.allowedValues`, so a `gcp.resourceLocations` policy that lists
  `deniedValues` isn't seen. It fails toward no problem: the apply stops
  when Google refuses the region.

- [ ] **A `vennir` setting for the gateway's internet listener** (found
  2026-11-03, writing the gateway guide): `vennir` asks only `enabled`,
  `backendHosts` and `internetTeams`, so `internetTeams` does nothing until
  someone writes a values file with the public listener and its Ingress. On
  gcp and aws it could make them as it does the console's (a reserved
  address and Google's certificate; an ALB with ACM's), with
  `publicListenerFrom` and `trustedProxies` filled in.

- [ ] **A fixed outbound address, as an option** (found 2026-11-03,
  `console/docs/22-addresses-and-firewalls.md`): `vennir`'s clusters give
  nodes public addresses (no NAT), which change, so a target that admits
  only known addresses can't be given one. An option for private nodes with
  Cloud NAT on reserved addresses (gcp) and private subnets with a NAT
  gateway and Elastic IPs (aws), priced on the approval screen.

- [ ] **`vennir`: GitLab as a second git host, then the azure target**
  (last). The rest of `cli/DESIGN.md`'s build order is done; its decisions
  (targets, OpenTofu, sizes, the approval screen, git hosts behind one
  layer) are recorded there.

- [ ] **A first step on a new GKE Autopilot install can time out**: seen on
  both GKE proofs (2026-10-26, 2026-10-27). Fixed (2026-10-27): a step's
  timeout counts from its container's start, and waiting to start has its
  own limit (`scheduler.taskStartTimeoutSeconds`, 10 minutes), past which it
  fails as `TASK_NOT_STARTED` (retryable) instead of a misleading
  `TASK_TIMEOUT`. Why a minimal install had three nodes (looked at in the
  billed run): every Vennir Pod was on one; the other two, in other zones,
  held only GKE's own Pods (DaemonSets, konnectivity-agent spread across
  zones, balloon Pods). Autopilot bills Pods, so they cost nothing, but
  their boot disks count against the project's SSD quota: at 500 GB, a
  step's node couldn't be added at 40 at once. `vennir apply` warns of the
  quota; a project raising it to 1000 GB was enough.

## Security

- [ ] **Next release: drop API backends in their team's namespace** (API
  backends moved to `<team>-apis` on 2026-11-05): for one release the
  gateway still serves an in-cluster backend in the team's own namespace,
  logging `api_backend_in_team_namespace`, and the console counts it live.
  Then hold it like any other namespace (`gateway/internal/store`
  `BackendPlace`, `console/src/core/apis.ts` `backendPlace`), stop writing
  `vennir-gateway-ingress` into team namespaces and delete the copies there
  (`console/src/teamNetwork.ts`; the write fence then needs to allow that
  delete, or the chart's upgrade notes say to), and drop the team's own
  namespace from API backends' log search (`console/src/core/logs.ts`).
  Before, check the gateway's logs for the warning on each install.

- [ ] **Every API shares the gateway's origin** (found 2026-11-03, in the
  review of the day's fixes): the gateway keeps a backend's cookies to its
  API's path, so no backend can set or overwrite another's, but a path is no
  boundary inside one origin. A page one team's backend serves can run
  script that reads another API's cookies that aren't HttpOnly (through a
  same-origin frame), and can fetch other APIs' paths with their cookies
  attached. The gateway's own sign-in is a bearer header, so that fetch gets
  the gateway's 401, but a backend that takes its own cookies as sign-in
  would answer it. The gateway takes only a bearer token, which a browser
  never sends on a navigation or a frame, so no browser can load an API's
  page there as a signed-in person; check this holds, then close the item.
  Decision 26 (`docs/assessment.md`, approved 2026-11-05): the paths stay,
  the gateway passes everything through, and each API has an access list
  of grants to groups or users (built: `console/src/core/apiAccess.ts`, the
  gateway's `accessFor`) with its console pages (what they can't show yet
  is below, under Console).

- [ ] **Drop the `apis.share_with` column** (the release after the one
  that stopped reading it, 2026-11-06): nothing reads or writes it now
  (migration 0073 emptied it, so a gateway from before still running
  during that upgrade let nobody in through it); a gateway from before
  still selects it, so it stays one release. Then drop it in a migration,
  and the `shareWith` key `upsertApi` is given in `catalogSync.ts`.
- [ ] **A grant's last call** (decision 26's open question, 2026-11-05):
  grants don't expire; the proposal is that the API's team sees each
  grant's last call and revokes unused ones. The gateway would need to
  write a `last_used_at` per grant (as for API tokens, at a few minutes'
  resolution; a grant to `vennir_gateway` of that one column). A renamed
  API starts with no grants (the old name's are kept 30 days, away, and come
  back only under the old name).

- [ ] **The console can still loosen some of the cluster's policies**
  (narrowed 2026-11-06 by decision 27, `docs/assessment.md`): with a signed
  catalog and the kernel chart's `catalogPolicy`, `kernel policy` verifies
  the release itself and alone writes which digests are a product's
  releases and each API's audiences. What's left: the image sources, the
  scan allowlist and each team's secret names stay the console's (so a
  compromised console can run a reviewed product with any of its team's
  Secrets, or an image that failed its scan as `default`), and an unsigned
  catalog leaves all of it to the console (with `catalogPolicy` on, the
  console's identity policy holds the secret names alone). `kernel policy`
  signs in as a database role of its own, which `kernel migrate` gives
  only what it uses (`migrate.GrantPolicy`): with the bundled Postgres the
  chart makes it (`postgres.auth.policyUsername`); with Cloud SQL or RDS,
  its own IAM user (the gcp module's `policy` service account, the aws
  module's `policy` role). On GKE and EKS `vennir` turns it on for an
  install whose own catalog is signed
  (`catalogPolicyValues`), reading the catalog's registry as that service
  account, with the console's release, signers and gateway token audience
  (one helper each, so the two charts can't disagree). Next:
  - **Prove `kernel policy` on EKS** (built 2026-11-06, unproven): the
    aws module gives it a role of its own (`<name>-policy`, by Pod
    Identity: ECR read on the task registry, and `rds-db:connect` as
    `vennir_kernel_policy`, which `database-setup` makes in `rds_iam`), and
    `vennir` turns it on as on GKE (`registry.ecrToken`). Needs a billed
    run on AWS, as the GKE one (2026-11-06) did.
  - **Another install's catalog**: `kernel policy` is off when the catalog
    is another install's (`externalCatalog`): the console reads it by its
    own identity, or by federation, which `kernel policy` doesn't borrow.
    It needs its own grant on that registry (`vennir catalog grant`), or
    federation of its own.

## Console

- [ ] **Take the dropped items off the redesign's boards** (decided
  2026-10-30): the Kubernetes Job's name in "Who acted"; a resource's run
  name; "since you last looked"; sharing-change and template creation times
  (the catalog's history has them); a total for guide search; a team-scoped
  read of group mappings and each mapping's member count.

- [ ] **Pages that read a failed load as "nothing here"** (found 2026-11-03,
  sweeping for slop): about 30 loads end in `.catch(() => undefined)`. Most
  are display-only extras and say so, but some drive what a page shows: the
  Teams page's offers, APIs, approvals and usage, the Admin People tab's
  teams, a team's Settings members. Each should say it couldn't load, with
  Try again (`components/LoadFailed`, as the Runs page does). Design it on
  the mockups canvas first.

- [ ] **The hourly sign-in that claim groups bring** (found 2026-11-05):
  a session in which a groups claim gave someone a team
  lasts an hour (`console/src/sso.ts`, `CLAIM_GROUPS_SESSION_SECONDS`).
  Two things make that hour cost more than it should: the session ending
  forgets the browser's cart (`AuthContext.tsx`'s `forgetKept`, there for
  the next person to sign in on a shared browser), and single sign-on
  always sends `prompt=select_account` (`auth/oidc.ts`), so the provider
  asks which account even when it could sign the person straight back in.
  Decide: keep the cart for the same person signing back in, and whether
  to drop the prompt (or send it only from the sign-in button). Also not
  yet seen against a real provider: the hour on Entra ID or Okta.

- [ ] **Group-given memberships outlive the hour outside sign-in** (found
  2026-11-05, reviewing #244): while groups come from a claim, sign-in
  (`auth/plugin.ts`, the gateway's `internal/auth`) counts a membership a
  group gave only for a single sign-on from the last hour, but the row
  stays until the person's next single sign-on, and other readers take it
  as it is: `notifier.ts`'s `notifyApprovals`, `scheduleRunner.ts`'s
  `tellMaintainers` and `readiness.ts` (so a maintainer the provider took
  out of the group keeps getting approval and failure notifications), the
  team's Members tab and the admin user list (they still show as a
  member). Decide: have these readers apply the same rule (by the person's
  last sign-in, `users.last_signed_in_at`), or drop group-given rows of
  people who haven't signed in for an hour.

- [ ] **What the API access pages couldn't show** (decision 26; the pages
  were built 2026-11-05 from chapter 15 of the mockups canvas): the boards
  show data no rpc returns yet. Each grant's 7-day calls (the gateway counts
  traffic by `grant:user` and `grant:group:<group>`, not per grant);
  someone else's API's group grants and whether the viewer is in them (15a:
  `ListApiAccess` is the API's team's and admins'; `GetMe` doesn't carry a
  person's groups); who granted the caller's own grant, when, and from which
  request (15d: `MyApiAccess` has the grant's id and rate only); a request's
  person's team and a group's size (15f); the gateway's certificate (15h);
  a picker of people and bots for Add a grant (it takes an email). The
  boards cap a grant's rate at the API's limit; the backend allows up to
  1,000,000 a minute, so the pages say "by default" instead of "up to".
  A grant's last call is the item above.

- [ ] **A page for who read what** (built 2026-11-05, backend only):
  `audit_reads` and `AdminService/ListAuditReads` record and list who was
  shown runs' outputs, logs and secret names (`console/src/auditReads.ts`).
  Admins can read them through the API only. Design the page on the mockups
  canvas first (likely beside Observe's audit log).

## Products and catalog

- [ ] **`vennir catalog create` applies `main`'s ruleset** (found
  2026-11-02). It creates the Environments but no ruleset, so a failing
  check, or a missing code-owner review, doesn't block a merge until someone
  adds one by hand (catalog README, "Protecting main", lists what to
  require: code-owner review and `check`, `secrets`, `code`, `codeowners`).
  Publishing reruns the scans either way. Applying it means deciding who can
  still merge in a new one-person catalog, where the creator can't approve
  their own pull request (a bypass for repository admins, pull requests
  only, is the likely answer).

- [ ] **`samples/gcp`'s `project` turns on no APIs** (found 2026-11-03,
  writing `console/docs/19-deploy-to-gcp.md`): a project it creates has
  only Google's defaults, so `build-image` or `app-hosting` into it in the
  same run fails `SERVICE_DISABLED`. An input of the services to turn on
  (`serviceusage.services.enable`, granted as `roles/serviceusage.serviceUsageAdmin`
  on the folder), or a product of its own.

- [ ] **A sample calling Google Cloud from outside GKE** (found 2026-11-03):
  `caller-identity` shows AWS from any cluster with a public issuer; nothing
  shows Google Cloud from EKS (a workload identity pool trusting the
  cluster's issuer, the provider as a `tokenAudiences` entry, an external
  account credential file). The gateway does it for `googleIdToken`; the
  guide describes it for products, unproven.

- [ ] **Prove the chat agent answering through Bedrock** once the acyclix
  account can: it has the Anthropic use-case form to submit, and every
  Bedrock daily token quota is 0 (AWS Support raises those). Proven so far
  (EKS Auto Mode, 2026-10-28): the console signs each request as its Pod
  Identity role, which passes IAM for its own model and is refused for any
  other; what's left is one answer.

- [ ] **The chat agent's other models, then an MCP server** (decision 24;
  the agent is built and proven: `console/src/chat/`, `ChatService`, the Ask
  panel, on Anthropic's API and on Vertex with Gemini). Left: Claude on
  Bedrock (blocked on the account's model access, above), Claude on Vertex
  if an install asks for it; then the same tools as an MCP server at `/mcp`
  for engineers' own agents (bots, then people through OAuth 2.1). The MCP
  server waits (decided 2026-10-29) until the platform is solid and a team
  asks for it.

## Testing and housekeeping

- [ ] **Drop `api_access_requests.requester_groups` and `requester_groups_read_at`**
  in the release after the one with migration 0072. Since 0072 a request
  keeps only the groups its person offers (`offered_groups`); the old
  columns stay only so a console from before can still insert requests
  during a rolling upgrade (it copies every group of the person's there,
  which nothing reads). Empty them in the same migration that drops them.
- [ ] **Deploy vennir.io from CI.** `site/` is deployed by hand
  (`site/README.md`). A workflow on main that deploys it, signing in to
  Google Cloud by Workload Identity Federation (no stored key) as an account
  that may only deploy Firebase Hosting, would keep it in step with the repo.
- [ ] **Switch to Sigstore's newer signature format** once policy-controller
  reads it (catalog CI signs with `--new-bundle-format=false`). Checked
  2026-10-29: the installed policy-controller (chart 0.10.8, app 0.13.1) has
  an authority's `signatureFormat: bundle`, but its docs say the bundle
  format covers attestations only, not plain signatures, which is what
  catalog CI makes. When it covers signatures: sign without the flag, and
  give the image policy both formats' authorities for the change (they're
  OR'd), then drop `legacy` once old images are gone.
