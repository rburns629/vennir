.PHONY: gke-verify-release gke-deploy-console-from-source gke-deploy-kernel-from-source kind-tls kind-audit-store quickstart _quickstart-prereqs kind-cluster kind-namespaces \
	build-products kind-sample-api console-docs catalog-publish kind-registry kind-deploy kind-deploy-kernel kind-deploy-console kind-deploy-eso \
	kind-e2e-secrets up down logs gke-logs test test-db test-db-down proto gke-deploy-policy-controller \
	gke-deploy gke-deploy-console gke-deploy-kernel gke-deploy-eso _gke-confirm

# Docker Desktop on macOS doesn't always put its command-line tools on PATH
# (docker, and the docker-credential-desktop helper `docker push` needs).
# Appended, so a docker already on PATH still wins.
DOCKER_DESKTOP_BIN := /Applications/Docker.app/Contents/Resources/bin
ifneq ($(wildcard $(DOCKER_DESKTOP_BIN)/docker),)
export PATH := $(PATH):$(DOCKER_DESKTOP_BIN)
endif
# Programs make runs directly (no shell) are looked up on make's own PATH,
# which the export above doesn't change, so recipes name docker by full path.
DOCKER := $(shell command -v docker 2>/dev/null || echo $(DOCKER_DESKTOP_BIN)/docker)

# Every local target names the kind context explicitly rather than trusting
# kubectl's current-context: with a GKE context configured alongside it,
# `make up` would otherwise force-delete "Unknown" pods on whichever
# cluster kubectl happened to point at. One name decides the cluster, its
# context and its node: KIND_CLUSTER=vertra-perf works on the performance
# cluster (perf/README.md) and nothing else.
KIND_CLUSTER ?= vertra-local
KIND_CONTEXT ?= kind-$(KIND_CLUSTER)
# Where the platform itself (kernel + console + their Postgres) is
# installed. Deliberately not `default` -- that's the admins' own team
# namespace, and tasks can never be dispatched into this one (see
# helm/charts/execution-kernel/templates/dispatch-policy.yaml).
PLATFORM_NAMESPACE ?= vertra-system
KUBECTL := kubectl --context $(KIND_CONTEXT)
# One definition, so `up`'s pgrep and `down`'s pkill always match the exact
# command line that was started -- port included, so a forward someone
# started on another port is never mistaken for this one, or killed.
PORT_FORWARD := $(KUBECTL) -n $(PLATFORM_NAMESPACE) port-forward svc/console-execution-console 18080:8080
# What pgrep and pkill match it by: the bracket keeps it from matching itself
# in the shell that runs them (Linux's don't skip their own ancestors). A
# recipe that also starts it writes it port-"forward", which the shell reads
# the same but which keeps that recipe's own shell from matching.
PORT_FORWARD_MATCH := $(subst port-forward,port-forwar[d],$(PORT_FORWARD))

# kind's image source: a local registry, so kind runs images the same way
# GKE does -- from a registry path the image policy allows (the
# execution-kernel chart's imagePolicy.sourceRegistry, localhost:5001 here)
# -- instead of `kind load`-ed images with no registry at all, which no
# allowed source can match. Push with `docker push localhost:5001/<name>`.
KIND_REGISTRY_NAME ?= kind-registry
KIND_REGISTRY_PORT ?= 5001
KIND_REGISTRY := localhost:$(KIND_REGISTRY_PORT)
KIND_NODE ?= $(KIND_CLUSTER)-control-plane

# Idempotent: starts the registry if needed, joins it to kind's network,
# and points the node's containerd at it. That last part is kind's own
# documented local-registry setup, applied to the existing node instead of
# at `kind create cluster` (make kind-cluster has the from-scratch
# version); containerd is restarted only if its config actually changed,
# and running Pods survive a containerd restart.
# The registry's image, by digest (vertra's cluster.RegistryImage, the same).
KIND_REGISTRY_IMAGE := registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373
kind-registry:
	@if [ "$$($(DOCKER) inspect -f '{{.State.Running}}' $(KIND_REGISTRY_NAME) 2>/dev/null)" != "true" ]; then \
		$(DOCKER) start $(KIND_REGISTRY_NAME) 2>/dev/null || \
		$(DOCKER) run -d --restart=always -p "127.0.0.1:$(KIND_REGISTRY_PORT):5000" --name $(KIND_REGISTRY_NAME) $(KIND_REGISTRY_IMAGE); \
	fi
	@$(DOCKER) network connect kind $(KIND_REGISTRY_NAME) 2>/dev/null || true
	@$(DOCKER) exec $(KIND_NODE) sh -c '\
		mkdir -p /etc/containerd/certs.d/$(KIND_REGISTRY) && \
		printf "[host.\"http://$(KIND_REGISTRY_NAME):5000\"]\n" > /etc/containerd/certs.d/$(KIND_REGISTRY)/hosts.toml && \
		if ! grep -q "config_path" /etc/containerd/config.toml; then \
			printf "\n[plugins.\"io.containerd.grpc.v1.cri\".registry]\n  config_path = \"/etc/containerd/certs.d\"\n" >> /etc/containerd/config.toml && \
			systemctl restart containerd && echo "containerd now reads /etc/containerd/certs.d"; \
		fi'
	@echo "Local registry ready: push to $(KIND_REGISTRY)/<image>, reference it the same way in DAGs."

# ---------------------------------------------------------------------------
# `make quickstart`: from nothing to a running Vertra on a local kind
# cluster, with the README's example ready to submit. Safe to run again: it
# creates only what's missing, and on an existing cluster rebuilds the
# images from this checkout and restarts the platform onto them.
# A stopgap until the vertra CLI's installer exists.
# ---------------------------------------------------------------------------
# The team the README's example runs in.
QUICKSTART_TEAM ?= team-a
CONSOLE_URL := http://localhost:18080
ADMIN_EMAIL := admin@example.com
# Set only for local kind clusters, in helm/values/kind/console.yaml.
ADMIN_PASSWORD := vertra-local

quickstart: _quickstart-prereqs kind-cluster kind-registry kind-namespaces
	$(DOCKER) build -t execution-kernel:latest kernel/
	$(DOCKER) build -t execution-console:latest console/
	$(DOCKER) build -t execution-gateway:latest gateway/
	kind load docker-image execution-kernel:latest execution-console:latest execution-gateway:latest --name $(KIND_CLUSTER)
	@$(MAKE) --no-print-directory build-products
	@for release in kernel console; do \
		existed=false; \
		helm status $$release --kube-context $(KIND_CONTEXT) -n $(PLATFORM_NAMESPACE) > /dev/null 2>&1 && existed=true; \
		echo "Installing $$release..."; \
		if $$existed; then \
			helm upgrade $$release helm/charts/execution-$$release $(KIND_HELM_UPGRADE) \
				-f helm/values/kind/$$release.yaml || exit 1; \
		else \
			helm upgrade --install $$release helm/charts/execution-$$release $(KIND_HELM_INSTALL) \
				-f helm/values/kind/$$release.yaml || exit 1; \
			$(KUBECTL) -n $(PLATFORM_NAMESPACE) rollout status deployment \
				--selector app.kubernetes.io/instance=$$release --timeout=10m > /dev/null || exit 1; \
		fi; \
		if $$existed; then \
			echo "Restarting $$release onto the image just built (the :latest tag is reused)..."; \
			case $$release in \
				kernel) deployments="kernel-execution-kernel-api kernel-execution-kernel-scheduler";; \
				console) deployments="console-execution-console";; \
			esac; \
			for d in $$deployments; do \
				$(KUBECTL) -n $(PLATFORM_NAMESPACE) rollout restart deployment $$d > /dev/null || exit 1; \
				$(KUBECTL) -n $(PLATFORM_NAMESPACE) rollout status deployment $$d --timeout=5m > /dev/null || exit 1; \
			done; \
		fi; \
	done
	@pkill -f "$(PORT_FORWARD_MATCH)" 2>/dev/null || true
	@$(MAKE) --no-print-directory up
	@echo "Creating the console team $(QUICKSTART_TEAM)..."
	@token=$$(curl -sf -X POST $(CONSOLE_URL)/api/vertra.console.v1.AuthService/Login -H 'Content-Type: application/json' \
		-d '{"email":"$(ADMIN_EMAIL)","password":"$(ADMIN_PASSWORD)"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'); \
	if [ -z "$$token" ]; then echo "Couldn't sign in to the console to create $(QUICKSTART_TEAM); create it on the Admin page."; exit 1; fi; \
	answer=$$(curl -s -X POST $(CONSOLE_URL)/api/vertra.console.v1.TeamService/EnsureTeam \
		-H "Authorization: Bearer $$token" -H 'Content-Type: application/json' -d '{"name":"$(QUICKSTART_TEAM)"}'); \
	case "$$answer" in *'"created":true'*) echo "  created";; *'"created":false'*) echo "  already exists";; \
		*) echo "  failed ($$answer); create it on the Admin page"; exit 1;; esac
	@echo ""
	@echo "Vertra is running."
	@echo "  Console:  $(CONSOLE_URL)   (sign in as $(ADMIN_EMAIL) / $(ADMIN_PASSWORD), local only)"
	@echo "  Try it:   Executions -> Submit new, and paste the example from README.md"
	@echo "  Watch:    make logs        Stop: make down        Start again: make up"

# Every tool quickstart needs, with how to get it.
_quickstart-prereqs:
	@missing=0; \
	for tool in docker kind kubectl helm curl; do \
		if ! command -v $$tool > /dev/null 2>&1; then \
			missing=1; \
			case $$tool in \
				docker) echo "Missing: docker. Install Docker Desktop (https://docs.docker.com/get-docker/) and start it.";; \
				kind|kubectl|helm) echo "Missing: $$tool. Install it with: brew install $$tool  (or see its project's install docs)";; \
				*) echo "Missing: $$tool.";; \
			esac; \
		fi; \
	done; \
	[ $$missing -eq 0 ] || exit 1; \
	$(DOCKER) info > /dev/null 2>&1 || { echo "Docker isn't running. Start Docker Desktop, then run make quickstart again."; exit 1; }

# The kind cluster, created if missing (started if stopped). Its containerd
# reads per-registry config from certs.d, so it can pull from the local
# registry kind-registry starts.
kind-cluster:
	@STATUS="$$($(DOCKER) inspect $(KIND_NODE) --format '{{.State.Status}}' 2>/dev/null)"; \
	if [ "$$STATUS" = "running" ]; then \
		echo "Cluster $(KIND_CLUSTER) is running."; \
	elif [ -n "$$STATUS" ]; then \
		echo "Starting cluster $(KIND_CLUSTER)..."; $(DOCKER) start $(KIND_NODE) > /dev/null; \
	else \
		echo "Creating cluster $(KIND_CLUSTER)..."; \
		printf '%s\n' \
			'kind: Cluster' \
			'apiVersion: kind.x-k8s.io/v1alpha4' \
			'containerdConfigPatches:' \
			'  - |-' \
			'    [plugins."io.containerd.grpc.v1.cri".registry]' \
			'      config_path = "/etc/containerd/certs.d"' \
		| kind create cluster --name $(KIND_CLUSTER) --config=- || exit 1; \
	fi
	@until $(KUBECTL) get nodes $(KIND_NODE) 2>/dev/null | grep -q " Ready"; do sleep 2; done

# The platform's namespace, the quickstart team's (labelled so tasks may run
# there), and execution-kernel, where the kernel's Kubernetes tests run.
kind-namespaces:
	@for ns in $(PLATFORM_NAMESPACE) $(QUICKSTART_TEAM) execution-kernel; do \
		$(KUBECTL) create namespace $$ns --dry-run=client -o yaml | $(KUBECTL) apply -f - > /dev/null; \
	done
	@$(KUBECTL) label namespace default $(QUICKSTART_TEAM) vertra/team=true --overwrite > /dev/null
	@echo "Namespaces ready: $(PLATFORM_NAMESPACE) (platform), $(QUICKSTART_TEAM) and default (teams), execution-kernel (tests)."

# Fake product images used by the local demo DAGs, pushed to the local
# registry above. They're referenced by image name from submitted DAGs,
# not services of the kernel itself.
build-products: kind-registry
	$(DOCKER) build -t $(KIND_REGISTRY)/demo-project-product:local examples/project-product
	$(DOCKER) build -t $(KIND_REGISTRY)/demo-application-product:local examples/application-product
	$(DOCKER) push $(KIND_REGISTRY)/demo-project-product:local
	$(DOCKER) push $(KIND_REGISTRY)/demo-application-product:local

# The platform's docs, copied into the console's image (console/docs/reference/
# SOURCES lists them): run after changing any of them, or the console's tests fail.
console-docs:
	@bash .github/scripts/console-docs.sh

# The backend of the local sample's API product (samples/local/apis/greetings),
# run in the local team's namespace as the team itself would run it: the
# gateway reaches it through the console's vertra-gateway-ingress policy.
# Publish the local sample first (make catalog-publish), so the namespace
# and the API exist.
kind-sample-api: kind-registry
	$(DOCKER) build -t $(KIND_REGISTRY)/local/greetings-api:demo examples/greetings-api
	$(DOCKER) push $(KIND_REGISTRY)/local/greetings-api:demo
	$(KUBECTL) apply -f examples/greetings-api/deploy.yaml
	$(KUBECTL) -n local rollout restart deployment greetings
	$(KUBECTL) -n local rollout status deployment greetings --timeout=2m

# Local mode: publish a catalog repository's products to kind without any Git
# hosting or CI, with ./vertra (built from this checkout), the tool its CI runs:
# each product is validated, built, tested and scanned and pushed to the
# local registry, then the catalog's release is, and the console is asked to
# apply it now rather than at its next look (every team folder becomes a team
# with its namespace, each product is registered). CATALOG is
# the catalog repository's folder; without one, catalog-template/ is
# published with SAMPLES (default: local, the five-language team) installed
# as teams. PRODUCTS limits it to some product folders, relative to the
# catalog (default: all).
CATALOG ?=
SAMPLES ?= local
# Where it's published: the registry path the cluster's console reads its
# release from (perf/kind-console.yaml gives the perf cluster its own).
CATALOG_REGISTRY ?= $(KIND_REGISTRY)
PRODUCTS ?=
catalog-publish: kind-registry
	@if [ -n "$(CATALOG)" ]; then test -x "$(CATALOG)/vertra" || { echo "No catalog at $(CATALOG)."; exit 1; }; fi
	@# This checkout's vertra.
	@VERTRA_BIN=$$(bash .github/scripts/build-vertra.sh) || exit 1; \
	export VERTRA_BIN VERTRA_REGISTRY=$(CATALOG_REGISTRY); \
	if [ -z "$(CATALOG)" ]; then \
		SAMPLES="$(SAMPLES)" bash .github/scripts/catalog-template.sh publish $(PRODUCTS) -- release; \
	else \
		(cd $(CATALOG) && ./vertra catalog publish $(PRODUCTS) && ./vertra catalog release); \
	fi || exit 1; \
	token=$$(jq -nc --arg email "$(ADMIN_EMAIL)" --arg password "$(ADMIN_PASSWORD)" '{email: $$email, password: $$password}' \
		| curl -sf -X POST -H 'Content-Type: application/json' -d @- $(CONSOLE_URL)/api/vertra.console.v1.AuthService/Login | jq -r '.token // empty'); \
	[ -n "$$token" ] || { echo "Released; couldn't sign in to $(CONSOLE_URL) to sync now (make up?): the console applies it within a minute."; exit 0; }; \
	curl -sf -X POST -H "Authorization: Bearer $$token" -H 'Content-Type: application/json' -d '{}' \
		$(CONSOLE_URL)/api/vertra.console.v1.AdminService/SyncCatalog \
		| jq -r '.status | "Applied \(.commit // "-"): \((.problems // []) | length) problem(s)", ((.problems // [])[] | "  \(.item): \(.message)"), (.error // empty)'

# Rebuild the platform from this checkout and deploy it to kind, with the
# settings in helm/values/kind/*.yaml (--reset-values: the files are the whole
# story). The image is loaded straight onto the node; the restart is because
# the tag is a reused :latest.
# --force-conflicts: the console edits two of the kernel chart's admission
# policies (allowed image sources, registered products), which makes it the
# owner of those fields under Helm 4's server-side apply, so a plain upgrade
# fails with a conflict. The chart writes back whatever the console last set
# (it looks the policy up first), so forcing changes ownership, not content.
KIND_HELM_UPGRADE := --kube-context $(KIND_CONTEXT) -n $(PLATFORM_NAMESPACE) --reset-values --force-conflicts --wait --timeout 10m
# A first install can't --wait: the charts migrate in a post-install hook,
# which Helm runs only after --wait sees every Pod ready, and the console
# isn't ready until its tables exist. Helm still waits for the hook Job.
KIND_HELM_INSTALL := --kube-context $(KIND_CONTEXT) -n $(PLATFORM_NAMESPACE) --reset-values --force-conflicts --timeout 10m

kind-deploy-kernel:
	$(DOCKER) build -t execution-kernel:latest kernel/
	kind load docker-image execution-kernel:latest --name $(KIND_CLUSTER)
	helm upgrade kernel helm/charts/execution-kernel $(KIND_HELM_UPGRADE) -f helm/values/kind/kernel.yaml \
		$(foreach file,$(KIND_KERNEL_VALUES),-f $(file))
	$(KUBECTL) -n $(PLATFORM_NAMESPACE) rollout restart deployment kernel-execution-kernel-api kernel-execution-kernel-scheduler
	$(KUBECTL) -n $(PLATFORM_NAMESPACE) rollout status deployment kernel-execution-kernel-scheduler --timeout=5m
	$(KUBECTL) -n $(PLATFORM_NAMESPACE) rollout status deployment kernel-execution-kernel-api --timeout=5m

# Optional: HTTPS for the console on kind, through cert-manager (a private
# test CA) and Traefik (an Ingress controller and a Gateway). Then deploy the
# console with ingress.certManager.issuer or gatewayApi (docs/operations.md).
CERT_MANAGER_VERSION := v1.21.2
TRAEFIK_CHART_VERSION := 41.6.1
GATEWAY_API_VERSION := v1.6.3
GATEWAY_API_SHA256 := 356c2b8e286a964dc20995435659ad1095386329974793af10bbfe3eff977fe5
kind-tls:
	@# Gateway API's resource definitions, which Traefik needs first: checked before applying.
	curl -sSfL -o /tmp/vertra-gateway-api.yaml \
		https://github.com/kubernetes-sigs/gateway-api/releases/download/$(GATEWAY_API_VERSION)/standard-install.yaml
	echo "$(GATEWAY_API_SHA256)  /tmp/vertra-gateway-api.yaml" | shasum -a 256 -c -
	$(KUBECTL) apply --server-side -f /tmp/vertra-gateway-api.yaml
	helm repo add jetstack https://charts.jetstack.io --force-update > /dev/null
	helm repo add traefik https://traefik.github.io/charts --force-update > /dev/null
	helm upgrade --install cert-manager jetstack/cert-manager --version $(CERT_MANAGER_VERSION) \
		--kube-context $(KIND_CONTEXT) -n cert-manager --create-namespace --wait --timeout 10m -f helm/values/kind/cert-manager.yaml
	helm upgrade --install traefik traefik/traefik --version $(TRAEFIK_CHART_VERSION) \
		--kube-context $(KIND_CONTEXT) -n traefik --create-namespace --wait --timeout 10m -f helm/values/kind/traefik.yaml
	$(KUBECTL) apply -f helm/values/kind/tls-test.yaml
	$(KUBECTL) -n cert-manager wait --for=condition=Ready certificate/vertra-test-ca --timeout=2m

# Optional: a write-once store for the console's audit copy on kind
# (SeaweedFS, S3 with Object Lock). Then deploy the console with audit.export
# pointing at it (docs/operations.md, "The audit log's copy").
kind-audit-store:
	@# Rerunnable: the bucket's Job is immutable, and the store's data is an
	@# emptyDir, so the bucket is made again whenever the store restarts.
	$(KUBECTL) -n vertra-audit-store delete job audit-bucket --ignore-not-found
	$(KUBECTL) apply -f helm/values/kind/audit-store.yaml
	$(KUBECTL) -n vertra-audit-store rollout status deployment seaweedfs --timeout=5m
	$(KUBECTL) -n vertra-audit-store wait --for=condition=complete job/audit-bucket --timeout=5m

kind-deploy-console:
	$(DOCKER) build -t execution-console:latest console/
	kind load docker-image execution-console:latest --name $(KIND_CLUSTER)
	$(DOCKER) build -t execution-gateway:latest gateway/
	kind load docker-image execution-gateway:latest --name $(KIND_CLUSTER)
	helm upgrade console helm/charts/execution-console $(KIND_HELM_UPGRADE) -f helm/values/kind/console.yaml \
		$(foreach file,$(KIND_CONSOLE_VALUES),-f $(file))
	$(KUBECTL) -n $(PLATFORM_NAMESPACE) rollout restart deployment console-execution-console console-execution-console-gateway
	$(KUBECTL) -n $(PLATFORM_NAMESPACE) rollout status deployment console-execution-console --timeout=5m
	$(KUBECTL) -n $(PLATFORM_NAMESPACE) rollout status deployment console-execution-console-gateway --timeout=5m
	@# A running port-forward stays attached to the replaced pod; stop it so
	@# the next `make up` connects to the new one.
	@pkill -f "$(PORT_FORWARD_MATCH)" 2>/dev/null && echo "Stopped the old port-forward; run make up." || true

# Kernel first: the console calls the kernel, never the other way round.
kind-deploy: kind-deploy-kernel kind-deploy-console

# External Secrets Operator, which secret syncing needs (the Team page's
# "Where secrets come from"). The same pinned version on every cluster.
ESO_CHART_VERSION ?= 2.10.0
ESO_HELM := helm upgrade --install external-secrets external-secrets/external-secrets \
	--version $(ESO_CHART_VERSION) -n external-secrets --create-namespace --wait --timeout 10m

kind-deploy-eso:
	helm repo add external-secrets https://charts.external-secrets.io --force-update > /dev/null
	$(ESO_HELM) --kube-context $(KIND_CONTEXT) -f helm/values/kind/external-secrets.yaml

# Resumes the existing kind node container -- NOT `kind create cluster`,
# which is for when the cluster doesn't exist at all (see docs/demo-
# runbook.md's "If the cluster doesn't exist yet" for that from-scratch
# path). Also clears out any pods left in "Unknown" state by whatever
# stopped the node -- their Deployment/Job recreates them fresh once
# deleted; needed after every real recovery seen so far, not a one-off.
# Then starts the kubectl port-forward in the background (log:
# /tmp/vertra-port-forward.log) so `make up` leaves execution-console
# actually reachable rather than just printing a reminder -- `make down`
# kills it by matching this same command line via pkill.
up:
	@STATUS="$$($(DOCKER) inspect $(KIND_NODE) --format '{{.State.Status}}' 2>/dev/null)"; \
	if [ "$$STATUS" = "running" ]; then \
		echo "$(KIND_NODE) is already running."; \
	elif [ -n "$$STATUS" ]; then \
		$(DOCKER) start $(KIND_NODE); \
	else \
		echo "$(KIND_NODE) doesn't exist: make quickstart creates it" ; \
		echo "(docs/operations.md)."; \
		exit 1; \
	fi
	@echo "Waiting for the node to be Ready..."
	@until $(KUBECTL) get nodes $(KIND_NODE) 2>/dev/null | grep -q " Ready"; do sleep 2; done
	@echo "Node is Ready. Cleaning up any pods stuck in Unknown state from the restart..."
	@$(KUBECTL) get pods -A --no-headers 2>/dev/null | awk '$$4 == "Unknown" {print $$1, $$2}' | \
		while read -r ns name; do \
			echo "  deleting stuck pod $$ns/$$name"; \
			$(KUBECTL) delete pod "$$name" -n "$$ns" --force --grace-period=0 > /dev/null; \
		done
	@echo "Waiting for execution-console's own pod to be Ready (its replacement, if it was just deleted above)..."
	@until [ -n "$$($(KUBECTL) -n $(PLATFORM_NAMESPACE) get pods -l app.kubernetes.io/component=app --no-headers 2>/dev/null)" ]; do sleep 1; done
	@$(KUBECTL) -n $(PLATFORM_NAMESPACE) wait --for=condition=Ready pod -l app.kubernetes.io/component=app --timeout=120s > /dev/null
	@echo "Starting port-forward in the background (restarting it if it dies while the node finishes settling)..."
	@i=0; \
	while ! curl -sf http://localhost:18080/health/ready > /dev/null 2>&1; do \
		if ! pgrep -f "$(PORT_FORWARD_MATCH)" > /dev/null 2>&1; then \
			nohup $(subst port-forward,port-"forward",$(PORT_FORWARD)) \
				> /tmp/vertra-port-forward.log 2>&1 & \
		fi; \
		i=$$((i + 1)); \
		if [ $$((i % 5)) -eq 0 ]; then \
			echo "  still unreachable; restarting the port-forward (it may point at a replaced pod)"; \
			pkill -f "$(PORT_FORWARD_MATCH)" 2>/dev/null || true; \
		fi; \
		if [ "$$i" -gt 60 ]; then \
			echo "Timed out after 2 minutes waiting for execution-console to become reachable."; \
			echo "Check /tmp/vertra-port-forward.log."; \
			exit 1; \
		fi; \
		sleep 2; \
	done
	@echo "execution-console is reachable at http://localhost:18080"

# Stops the kind cluster's node container -- deliberately `docker stop`,
# not `kind delete cluster`, which would destroy the cluster's data
# (loaded images, provisioned namespaces/RBAC/secrets, the demo teams).
# `make up` brings it back (docs/operations.md, "Troubleshooting").
# Also kills any leftover `kubectl port-forward` to it, since a forward
# pointed at a stopped cluster is just confusing noise otherwise.
down:
	@if $(DOCKER) ps -a --format '{{.Names}}' | grep -q '^$(KIND_NODE)$$'; then \
		$(DOCKER) stop $(KIND_NODE); \
	else \
		echo "$(KIND_NODE) doesn't exist -- nothing to stop."; \
	fi
	@pkill -f "$(PORT_FORWARD_MATCH)" 2>/dev/null || true

# Tails the platform's own processes (kernel-api, kernel-scheduler,
# execution-console) live, interleaved and color-coded by pod, using
# stern (https://github.com/stern/stern -- `brew install stern`) rather
# than plain `kubectl logs`, which only tails one pod at a time. Matches
# on pod name, not a fixed name, so it survives pod restarts without
# needing to look up a current pod name first. wait-for-postgres is
# excluded -- it's just a one-shot init container polling until Postgres
# is reachable, not something worth watching. Doesn't include a team's
# own task pods -- those come and go per submission; see docs/demo-
# runbook.md for the `stern . -n <team>` pattern for that instead.
#
# --since 1s: stern otherwise replays each pod's whole log history first.
logs:
	@command -v stern > /dev/null 2>&1 || { \
		echo "stern isn't installed -- brew install stern"; \
		exit 1; \
	}
	stern --context $(KIND_CONTEXT) -n $(PLATFORM_NAMESPACE) "kernel-execution-kernel|console-execution-console" --exclude-container wait-for-postgres --since 1s

# Like `logs`, for the GKE cluster: its context named explicitly, across
# all namespaces, and including task Pods ("^ek-", the kernel's Job name
# prefix). Health-check requests, logged every few seconds by every Pod,
# are filtered out.
gke-logs:
	@command -v stern > /dev/null 2>&1 || { \
		echo "stern isn't installed -- brew install stern"; \
		exit 1; \
	}
	stern --context gke_my-gcp-project_us-central1_vertra-gke \
		"kernel-execution-kernel|console-execution-console|^ek-" \
		--exclude-container wait-for-postgres --all-namespaces --since 1s \
		| grep -v '"httpPath": "/health\|"url":"/health'

# ---------------------------------------------------------------------------
# Contributor tests. Separate from everything above: no cluster, and never
# the databases of an install. The test Postgres is a throwaway container,
# published on localhost only and on its own port, so it can't collide with
# a Postgres you already run on 5432. Nothing else calls these targets.
#
#   make test           # create/migrate the test databases, run both suites
#   make test-db        # just the databases (then run go test / npm test yourself)
#   make test-db-down   # remove the container and its data
#
# Needs Docker (the kernel's migrations and Go tests run in the pinned Go
# image) and `npm ci` in console/ and console/frontend/. The kernel's
# Kubernetes tests need kind and skip without it (and in that image).
# ---------------------------------------------------------------------------
# The APIs (proto/: the console's, and kernel-api's, which only the console
# calls): lint, then generate their code, which is committed (CI regenerates
# and fails on any difference).
#
#   make proto
#
# TypeScript comes from the console's pinned npm packages (`npm ci` in
# console/ first); Go from the plugins pinned as tools in cli/go.mod, built
# and run in the same Go image as CI, with buf at the same version as the
# npm package.
# ---------------------------------------------------------------------------
BUF := console/node_modules/.bin/buf
BUF_VERSION := 1.74.0
GO_IMAGE ?= golang:1.27-alpine@sha256:f2c872bcee949b7be9c490efd02b48a8a2fbf947cdf533f1c58525ec9d8170fd

proto:
	$(BUF) lint
	$(BUF) generate --template buf.gen.es.yaml
	$(BUF) generate --template buf.gen.frontend.yaml
	@# The API reference page's data, comments included (console/scripts/api-reference.ts):
	@# the console's API only; kernel-api's is internal.
	$(BUF) build --path proto/vertra/console -o console/.api-image.binpb
	cd console && npx tsx scripts/api-reference.ts .api-image.binpb > frontend/src/gen/api-reference.json; \
		status=$$?; rm -f .api-image.binpb; exit $$status
	$(DOCKER) run --rm -v "$(CURDIR)":/repo -v vertra-gocache:/root/.cache -v vertra-gomod:/go/pkg/mod \
		-w /repo/cli $(GO_IMAGE) sh -c 'go build -o /tmp/plugins/ \
			google.golang.org/protobuf/cmd/protoc-gen-go connectrpc.com/connect/cmd/protoc-gen-connect-go \
		&& cd /repo && PATH=/tmp/plugins:$$PATH go run github.com/bufbuild/buf/cmd/buf@v$(BUF_VERSION) \
			generate --template buf.gen.go.yaml \
		&& PATH=/tmp/plugins:$$PATH go run github.com/bufbuild/buf/cmd/buf@v$(BUF_VERSION) \
			generate --template buf.gen.kernel.yaml'

# ---------------------------------------------------------------------------
TEST_DB_CONTAINER ?= vertra-test-db
TEST_DB_PORT ?= 55432
TEST_DB_IMAGE ?= postgres:16.15@sha256:1beaa3084eee2676f20a9cd9928f0bf2c5bf674f8e49f81017912183d377c61c
TEST_DB_HOST := postgres@127.0.0.1:$(TEST_DB_PORT)
KERNEL_TEST_DB := execution_kernel_test
CONSOLE_TEST_DB := execution_console_test

# Idempotent: reuses the container if it exists, creates each database only
# if missing, and migrates both to head every time.
test-db:
	@if ! $(DOCKER) container inspect $(TEST_DB_CONTAINER) > /dev/null 2>&1; then \
		echo "Starting $(TEST_DB_CONTAINER) on 127.0.0.1:$(TEST_DB_PORT)"; \
		$(DOCKER) run -d --name $(TEST_DB_CONTAINER) \
			-e POSTGRES_HOST_AUTH_METHOD=trust \
			-p 127.0.0.1:$(TEST_DB_PORT):5432 $(TEST_DB_IMAGE) > /dev/null; \
	else \
		$(DOCKER) start $(TEST_DB_CONTAINER) > /dev/null; \
	fi
	@# Over TCP, not the socket: during first-time init the image runs a
	@# socket-only server that answers pg_isready, then restarts.
	@for i in $$(seq 1 60); do \
		$(DOCKER) exec $(TEST_DB_CONTAINER) pg_isready -q -h 127.0.0.1 -U postgres && break; \
		sleep 1; \
	done
	@for db in $(KERNEL_TEST_DB) $(CONSOLE_TEST_DB); do \
		$(DOCKER) exec $(TEST_DB_CONTAINER) psql -U postgres -tAc \
			"SELECT 1 FROM pg_database WHERE datname = '$$db'" | grep -q 1 \
		|| $(DOCKER) exec $(TEST_DB_CONTAINER) createdb -U postgres $$db; \
	done
	$(DOCKER) run --rm --network host -e DATABASE_URL=postgresql://$(TEST_DB_HOST)/$(KERNEL_TEST_DB) \
		-v "$(CURDIR)/kernel":/src -v vertra-gomod:/go/pkg/mod -w /src $(GO_IMAGE) go run ./cmd/kernel migrate
	cd console && DATABASE_URL=postgresql://$(TEST_DB_HOST)/$(CONSOLE_TEST_DB) \
		JWT_SECRET=unused-by-migrations-but-32-bytes-long KERNEL_API_URL=http://unused npm run --silent db:migrate

test: test-db
	$(DOCKER) run --rm --network host -e TEST_DATABASE_URL=postgresql://$(TEST_DB_HOST)/$(KERNEL_TEST_DB) \
		-v "$(CURDIR)":/src -v vertra-gomod:/go/pkg/mod -w /src/kernel $(GO_IMAGE) go test ./...
	cd console && TEST_DATABASE_URL=postgresql://$(TEST_DB_HOST)/$(CONSOLE_TEST_DB) npm test
	cd console/frontend && npm test

test-db-down:
	-$(DOCKER) rm -f $(TEST_DB_CONTAINER)

# ---------------------------------------------------------------------------
# Deploying to the real GKE cluster. Everything above is local (kind) or
# read-only; these targets change a real, billed cluster, so they:
#   - name the GKE context explicitly (never kubectl's current-context);
#   - say exactly what they're about to ship, including whether the working
#     tree has uncommitted changes (Cloud Build ships the working tree, not
#     a commit);
#   - refuse to start until you type the cluster's name.
# Prove the change on kind first (docs/operations.md).
#
#   make gke-deploy-console   # console/ -> execution-console
#   make gke-deploy-kernel    # kernel/ -> kernel-api + kernel-scheduler
#   make gke-deploy           # both
#
# Each one: builds the image with Cloud Build (never a local docker push),
# runs `helm upgrade` (whose hook applies pending database migrations before
# the new code starts), then restarts the Deployment, since the image tag is
# a reused `:latest` that a Helm upgrade alone wouldn't roll.
# Settings come from helm/values/gke/*.yaml, with --reset-values: what's in the
# repo is exactly what's deployed, nothing lingers from an earlier --set.
# ---------------------------------------------------------------------------
GKE_PROJECT ?= my-gcp-project
GKE_CLUSTER ?= vertra-gke
GKE_CONTEXT ?= gke_$(GKE_PROJECT)_us-central1_$(GKE_CLUSTER)
GKE_REGISTRY ?= us-central1-docker.pkg.dev/$(GKE_PROJECT)/platform-images
# Still `default` on GKE until the platform is moved to its own namespace
# there (it's vertra-system on kind).
GKE_NAMESPACE ?= default
GKE_KUBECTL := kubectl --context $(GKE_CONTEXT) -n $(GKE_NAMESPACE)
# --force-conflicts: see KIND_HELM_UPGRADE.
GKE_HELM_UPGRADE := --kube-context $(GKE_CONTEXT) -n $(GKE_NAMESPACE) \
	--reset-values --force-conflicts --wait --timeout 10m

# Set CONFIRM=<cluster name> to skip the prompt (the combined `gke-deploy`
# does this after asking once).
_gke-confirm:
	@echo ""
	@echo "About to deploy $(GKE_WHAT) to a REAL cluster:"
	@echo "  cluster:   $(GKE_CLUSTER)  (context $(GKE_CONTEXT))"
	@echo "  namespace: $(GKE_NAMESPACE)"
	@echo "  source:    $$(git rev-parse --short HEAD) + $$(git status --porcelain -- console kernel helm | wc -l | tr -d ' ') uncommitted file(s) in console/, kernel/, helm/"
	@echo ""
	@if [ "$(CONFIRM)" = "$(GKE_CLUSTER)" ]; then \
		echo "Confirmed via CONFIRM=$(CONFIRM)."; \
	else \
		printf "Type the cluster name (%s) to continue: " "$(GKE_CLUSTER)"; \
		read -r answer; \
		if [ "$$answer" != "$(GKE_CLUSTER)" ]; then echo "Not confirmed -- nothing was deployed."; exit 1; fi; \
	fi

# A release, as CI built, scanned and signed it (.github/workflows/release.yml):
# its signed charts, which run its signed images (each chart's appVersion),
# each signature checked against the release workflow's identity at exactly
# that tag before anything is deployed.
# make gke-deploy VERSION=v0.2.3
RELEASE_REGISTRY ?= ghcr.io/rburns629/vertra
RELEASE_IDENTITY = https://github.com/$(subst ghcr.io/,,$(RELEASE_REGISTRY))/.github/workflows/release.yml@refs/tags/$(VERSION)
# The cosign the release signs with (install-scanners.sh's COSIGN_VERSION):
# v3 stores signatures as OCI referrers, which v2 can't find.
COSIGN := $(DOCKER) run --rm ghcr.io/sigstore/cosign/cosign:v3.1.3@sha256:9e5c2f2edc34351160407ca3416c61855bdf9403c3c5936e0f0be7fc261611b8
COSIGN_VERIFY = $(COSIGN) verify --certificate-identity $(RELEASE_IDENTITY) \
	--certificate-oidc-issuer https://token.actions.githubusercontent.com -o text

gke-verify-release:
	@test -n "$(VERSION)" || { echo "VERSION=v<x.y.z>: the release to deploy."; exit 1; }
	@for ref in execution-kernel:$(VERSION:v%=%) execution-console:$(VERSION:v%=%) execution-gateway:$(VERSION:v%=%) \
		charts/execution-kernel:$(VERSION:v%=%) charts/execution-console:$(VERSION:v%=%); do \
		printf "  %-40s " "$$ref"; \
		$(COSIGN_VERIFY) $(RELEASE_REGISTRY)/$$ref > /dev/null 2>&1 \
			&& echo "signed by the $(VERSION) release" \
			|| { echo "NOT VERIFIED: nothing was deployed."; exit 1; }; \
	done

gke-deploy-console: GKE_WHAT = the console, release $(VERSION)
gke-deploy-console: gke-verify-release _gke-confirm
	helm upgrade console oci://$(RELEASE_REGISTRY)/charts/execution-console --version $(VERSION:v%=%) \
		$(GKE_HELM_UPGRADE) -f helm/values/gke/console.yaml
	$(GKE_KUBECTL) rollout status deployment console-execution-console --timeout=5m
	@echo "Console $(VERSION) deployed. Hard-refresh open browser tabs to load the new UI."

gke-deploy-kernel: GKE_WHAT = the kernel, release $(VERSION)
gke-deploy-kernel: gke-verify-release _gke-confirm
	helm upgrade kernel oci://$(RELEASE_REGISTRY)/charts/execution-kernel --version $(VERSION:v%=%) \
		$(GKE_HELM_UPGRADE) -f helm/values/gke/kernel.yaml
	$(GKE_KUBECTL) rollout status deployment kernel-execution-kernel-api --timeout=5m
	$(GKE_KUBECTL) rollout status deployment kernel-execution-kernel-scheduler --timeout=5m
	@echo "Kernel $(VERSION) deployed."

# From the working copy instead (Cloud Build, :latest, unsigned): for trying
# a change on a cluster that isn't production. Says so before it starts.
gke-deploy-console-from-source: GKE_WHAT = the console from the WORKING COPY (unreleased, unsigned)
gke-deploy-console-from-source: _gke-confirm
	gcloud builds submit --project $(GKE_PROJECT) --tag $(GKE_REGISTRY)/execution-console:latest console/
	helm upgrade console helm/charts/execution-console $(GKE_HELM_UPGRADE) -f helm/values/gke/console.yaml \
		--set image.repository=$(GKE_REGISTRY)/execution-console --set image.tag=latest
	$(GKE_KUBECTL) rollout restart deployment console-execution-console
	$(GKE_KUBECTL) rollout status deployment console-execution-console --timeout=5m
	@echo "Console deployed. Hard-refresh open browser tabs to load the new UI."

gke-deploy-kernel-from-source: GKE_WHAT = the kernel from the WORKING COPY (unreleased, unsigned)
gke-deploy-kernel-from-source: _gke-confirm
	gcloud builds submit --project $(GKE_PROJECT) --tag $(GKE_REGISTRY)/execution-kernel:latest kernel/
	helm upgrade kernel helm/charts/execution-kernel $(GKE_HELM_UPGRADE) -f helm/values/gke/kernel.yaml \
		--set image.repository=$(GKE_REGISTRY)/execution-kernel --set image.tag=latest
	$(GKE_KUBECTL) rollout restart deployment kernel-execution-kernel-api kernel-execution-kernel-scheduler
	$(GKE_KUBECTL) rollout status deployment kernel-execution-kernel-api --timeout=5m
	$(GKE_KUBECTL) rollout status deployment kernel-execution-kernel-scheduler --timeout=5m
	@echo "Kernel deployed."

# Sigstore's policy-controller, which verifies catalog image signatures for
# the kernel's imageSignature. Rarely changes; see the values file's notes.
gke-deploy-policy-controller: GKE_WHAT = policy-controller (cosign-system)
gke-deploy-policy-controller: _gke-confirm
	helm upgrade --install policy-controller sigstore/policy-controller --version 0.10.8 \
		--kube-context $(GKE_CONTEXT) -n cosign-system --create-namespace \
		-f helm/values/gke/policy-controller.yaml --wait --timeout 10m

gke-deploy-eso: GKE_WHAT = External Secrets Operator (external-secrets)
gke-deploy-eso: _gke-confirm
	helm repo add external-secrets https://charts.external-secrets.io --force-update > /dev/null
	$(ESO_HELM) --kube-context $(GKE_CONTEXT) -f helm/values/gke/external-secrets.yaml

# Both, asking once. Kernel first: the console calls the kernel, never the
# other way round.
gke-deploy: GKE_WHAT = the kernel and the console, release $(VERSION)
gke-deploy: gke-verify-release _gke-confirm
	@$(MAKE) --no-print-directory gke-deploy-kernel CONFIRM=$(GKE_CLUSTER) VERSION=$(VERSION)
	@$(MAKE) --no-print-directory gke-deploy-console CONFIRM=$(GKE_CLUSTER) VERSION=$(VERSION)

# A team's secret end to end on the kind install (helm/tests/secrets-e2e.sh):
# a SecretStore (ESO's fake provider) syncs it, a registered product's step
# reads it, and a step that isn't one, or another team's, is refused. Needs
# make up's port-forward; it cleans up after itself.
kind-e2e-secrets:
	CONSOLE_URL=$(CONSOLE_URL) ADMIN_PASSWORD=$(ADMIN_PASSWORD) KUBE_CONTEXT=$(KIND_CONTEXT) bash helm/tests/secrets-e2e.sh
