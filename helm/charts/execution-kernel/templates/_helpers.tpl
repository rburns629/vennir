{{- define "execution-kernel.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "execution-kernel.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "execution-kernel.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "execution-kernel.labels" -}}
app.kubernetes.io/name: {{ include "execution-kernel.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "execution-kernel.selectorLabels" -}}
app.kubernetes.io/name: {{ include "execution-kernel.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "execution-kernel.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "execution-kernel.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
The namespace Kubernetes Jobs run in — defaults to the release namespace so
a plain `helm install` just works.
*/}}
{{- define "execution-kernel.databaseSecretName" -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecret -}}
{{- else -}}
{{- include "execution-kernel.fullname" . -}}-db
{{- end -}}
{{- end -}}

{{- define "execution-kernel.databaseSecretKey" -}}
{{- if .Values.existingSecret -}}
{{- .Values.existingSecretKey -}}
{{- else -}}
database-url
{{- end -}}
{{- end -}}

{{/*
Built from postgres.auth.* when the bundled Postgres is enabled;
externalDatabaseUrl otherwise. Not used at all when existingSecret is set —
that Secret is referenced directly instead of one this chart creates.
*/}}
{{- define "execution-kernel.databaseUrl" -}}
{{- $root := .root -}}
{{- if $root.Values.postgres.enabled -}}
postgresql://{{ $root.Values.postgres.auth.kernelUsername | default $root.Values.postgres.auth.username }}:{{ .password }}@{{ include "execution-kernel.fullname" $root }}-postgres:5432/{{ $root.Values.postgres.auth.database }}{{ include "execution-kernel.databaseTls" $root }}
{{- else -}}
{{- $root.Values.externalDatabaseUrl -}}
{{- end -}}
{{- end -}}

{{/*
The bundled Postgres's password: postgres.auth.password if set; otherwise
the one already in this release's Secret, so upgrades keep it; otherwise a
new random one. Random each time it's called on a fresh install: call it
once per render and reuse the value (secret.yaml does).
*/}}
{{- define "execution-kernel.postgresPassword" -}}
{{- if .Values.postgres.auth.password -}}
{{- .Values.postgres.auth.password -}}
{{- else -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "execution-kernel.databaseSecretName" .) -}}
{{- if and $existing (index ($existing.data | default dict) "postgres-password") -}}
{{- index $existing.data "postgres-password" | b64dec -}}
{{- else -}}
{{- randAlphaNum 32 -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
The kernel's own login role's password (postgres.auth.kernelUsername): the
one already in this release's Secret, so upgrades keep it; otherwise a new
random one. Call it once per render (secret.yaml does).
*/}}
{{- define "execution-kernel.kernelPassword" -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (include "execution-kernel.databaseSecretName" .) -}}
{{- if and $existing (index ($existing.data | default dict) "kernel-password") -}}
{{- index $existing.data "kernel-password" | b64dec -}}
{{- else -}}
{{- randAlphaNum 32 -}}
{{- end -}}
{{- end -}}

{{/*
kernel-api's ServiceAccount: its own when the chart creates ServiceAccounts.
*/}}
{{- define "execution-kernel.apiServiceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- printf "%s-api" (include "execution-kernel.fullname" .) -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
An image reference from {repository, tag, digest}: by digest when one is set
(the tag kept for people reading it), so what runs can't change under a
moved tag. Usage: include "execution-kernel.image" .Values.image
*/}}
{{- define "execution-kernel.image" -}}
{{- if .digest -}}
{{ .repository }}:{{ .tag }}@{{ .digest }}
{{- else -}}
{{ .repository }}:{{ .tag }}
{{- end -}}
{{- end }}

{{/*
This chart's own image: values' image, its tag defaulting to the chart's
appVersion, so a released chart runs the image released with it.
Usage: include "execution-kernel.appImage" .
*/}}
{{- define "execution-kernel.appImage" -}}
{{- include "execution-kernel.image" (dict "repository" .Values.image.repository "tag" (.Values.image.tag | default .Chart.AppVersion) "digest" .Values.image.digest) -}}
{{- end }}

{{/*
Pod Security's restricted, for this chart's own Pods: required, so a change
to an image can't quietly start running as root. The image picks its
(numeric, non-root) user; the root filesystem is read-only, /tmp an emptyDir.
Usage: include "execution-kernel.podSecurityContext" . (and containerSecurityContext)
*/}}
{{- define "execution-kernel.podSecurityContext" -}}
runAsNonRoot: true
seccompProfile: {type: RuntimeDefault}
{{- end }}

{{- define "execution-kernel.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities: {drop: ["ALL"]}
{{- end }}

{{/*
TLS inside the cluster (tls.yaml). databaseTls ends a URL for the bundled
Postgres: TLS required, the server checked against this release's CA
(verify-full), which tlsCaVolume and tlsCaMount put at /etc/vertra/tls in
every Pod that connects to it or to kernel-api.
*/}}
{{- define "execution-kernel.databaseTls" -}}
{{- if and .Values.tls.enabled .Values.postgres.enabled -}}
?sslmode=verify-full&sslrootcert=/etc/vertra/tls/ca.crt
{{- end -}}
{{- end -}}

{{/*
tlsMade works out tls.yaml's CA and server certificates once per render,
kept in .Values.tls._made: tls.yaml writes them, and tlsChecksum hashes the
same certificates. A first install's Pods so carry the checksum the next
upgrade computes from the Secret, and restart only when a certificate
really changes.
*/}}
{{- define "execution-kernel.tlsMade" -}}
{{- if not (hasKey .Values.tls "_made") }}
{{- $fullname := include "execution-kernel.fullname" . }}
{{- $ns := .Release.Namespace }}
{{- $existing := (lookup "v1" "Secret" $ns (printf "%s-tls" $fullname)).data | default dict }}
{{- $days := int .Values.tls.days }}
{{- $ca := dict }}
{{- if and (hasKey $existing "ca.crt") (hasKey $existing "ca.key") }}
  {{- $ca = buildCustomCert (index $existing "ca.crt") (index $existing "ca.key") }}
{{- else }}
  {{- $ca = genCA (printf "%s CA" $fullname) $days }}
{{- end }}
{{- $servers := dict "postgres" (printf "%s-postgres" $fullname) "api" (printf "%s-api" $fullname) }}
{{- $certs := dict }}
{{- range $item, $service := $servers }}
  {{- $hosts := list $service (printf "%s.%s" $service $ns) (printf "%s.%s.svc" $service $ns) (printf "%s.%s.svc.cluster.local" $service $ns) }}
  {{- $crt := index $existing (printf "%s.crt" $item) | default "" }}
  {{- $key := index $existing (printf "%s.key" $item) | default "" }}
  {{- $hostsKey := printf "%s.hosts" $item }}
  {{- if and $crt $key (eq (index $existing $hostsKey | default "" | b64dec) (join "," $hosts)) (hasKey $existing "ca.key") }}
    {{- $_ := set $certs $item (dict "crt" ($crt | b64dec) "key" ($key | b64dec)) }}
  {{- else }}
    {{- $cert := genSignedCert $service nil $hosts $days $ca }}
    {{- $_ := set $certs $item (dict "crt" $cert.Cert "key" $cert.Key) }}
  {{- end }}
  {{- $_ := set (index $certs $item) "hosts" (join "," $hosts) }}
{{- end }}
{{- $_ := set .Values.tls "_made" (dict "ca" (dict "crt" $ca.Cert "key" $ca.Key) "certs" $certs) }}
{{- end }}
{{- end -}}

{{/* The Pods' checksum/tls: the CA's and the servers' certificates. */}}
{{- define "execution-kernel.tlsChecksum" -}}
{{- include "execution-kernel.tlsMade" . -}}
{{- $made := index .Values.tls "_made" -}}
{{- $parts := list $made.ca.crt -}}
{{- range $item, $cert := $made.certs -}}
{{- $parts = append $parts $cert.crt -}}
{{- end -}}
{{- $parts | toJson | sha256sum -}}
{{- end -}}

{{- define "execution-kernel.tlsCaVolume" -}}
{{- if .Values.tls.enabled }}
- name: tls-ca
  secret:
    secretName: {{ include "execution-kernel.fullname" . }}-tls-ca
    # The upgrade that turns tls on runs its pre-upgrade migration before
    # the Secret exists; it still connects as before then, without TLS.
    optional: true
{{- end }}
{{- if .Values.database.caSecret }}
# A managed database's server CA (database.caSecret), which the URL's
# sslrootcert names.
- name: db-ca
  secret:
    secretName: {{ .Values.database.caSecret }}
{{- end }}
{{- end -}}

{{- define "execution-kernel.tlsCaMount" -}}
{{- if .Values.tls.enabled }}
- {name: tls-ca, mountPath: /etc/vertra/tls, readOnly: true}
{{- end }}
{{- if .Values.database.caSecret }}
- {name: db-ca, mountPath: /etc/vertra/tls-db, readOnly: true}
{{- end }}
{{- end -}}

{{/* The bundled Postgres's pg_hba with tls: the Pod's own tools over its
socket as before; from the network, TLS and a password only. */}}
{{- define "execution-kernel.pgHba" -}}
local   all  all            trust
hostssl all  all  0.0.0.0/0 scram-sha-256
hostssl all  all  ::/0      scram-sha-256
{{- end -}}

{{/*
Whether the bundled Postgres runs as its user (999) from the start
(postgres.nonRoot): "true" or "". auto: when its volume is new or was made
that way (the claim's vertra.dev/postgres-layout: nonroot); a volume made
before keeps the image's way, starting as root to take ownership of it,
until "true" moves it (postgres-deployment.yaml's postgres-layout).
*/}}
{{- define "execution-kernel.postgresNonRoot" -}}
{{- $mode := toString .Values.postgres.nonRoot -}}
{{- if eq $mode "true" -}}
true
{{- else if eq $mode "auto" -}}
{{- $pvc := lookup "v1" "PersistentVolumeClaim" .Release.Namespace (printf "%s-postgres" (include "execution-kernel.fullname" .)) -}}
{{- $layout := "" -}}
{{- if $pvc }}{{ $layout = index ($pvc.metadata.annotations | default dict) "vertra.dev/postgres-layout" | default "" }}{{ end -}}
{{- if or (not .Values.postgres.persistence.enabled) (not $pvc) (eq $layout "nonroot") -}}
true
{{- end -}}
{{- else if ne $mode "false" -}}
{{- fail "postgres.nonRoot must be auto, true or false." -}}
{{- end -}}
{{- end -}}

{{/* A Pod running only the Postgres image's tools, never its data: its user. */}}
{{- define "execution-kernel.postgresToolsSecurityContext" -}}
runAsNonRoot: true
runAsUser: 999
runAsGroup: 999
seccompProfile: {type: RuntimeDefault}
{{- end }}
