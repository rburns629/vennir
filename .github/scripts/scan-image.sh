#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Scans one platform image (kernel/ or console/), already built into the
# local Docker daemon, and exits non-zero if it must not ship. Run by ci.yml.
# (A copy of vennir-catalog's, which gates product images the same
# way; the two repos are owned separately.)
#
# Blocks on:
#   - a HIGH or CRITICAL vulnerability that has a fix available (Trivy).
#     Unfixable ones are reported but don't block: nothing we can do.
#   - a secret baked into the image (Trivy): a key file, a token in a layer.
#   - a known-malicious package (OSV-Scanner, against the OpenSSF
#     malicious-packages data in OSV: typosquats, hijacked releases).
#
# An accepted vulnerability goes in that directory's .trivyignore, one CVE
# id per line with a comment saying why; PR review is what accepts it.
#
# Usage: scan-image.sh <image ref> <source dir>
set -uo pipefail

image="$1"
product_dir="${2%/}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
report=$(mktemp -d)
failed=0

ignore_args=()
if [ -f "$product_dir/.trivyignore" ]; then
  ignore_args=(--ignorefile "$product_dir/.trivyignore")
  echo "Using $product_dir/.trivyignore"
fi

{
  echo "### Security scan: \`$image\` (\`$product_dir\`)"
  echo
} >> "$summary"

# --- Vulnerabilities and secrets -------------------------------------------
# Every finding goes in the JSON report; the gate is applied when reading it,
# so a scanner that fails outright (no report) blocks too.
if ! trivy image --quiet --scanners vuln,secret --format json --output "$report/trivy.json" \
     ${ignore_args[@]+"${ignore_args[@]}"} "$image"; then
  echo "::error::Trivy couldn't scan $image."
  echo "- :x: Trivy couldn't scan the image." >> "$summary"
  failed=1
else
  python3 - "$report/trivy.json" "$summary" "$image" <<'EOF' || failed=1
import json, sys
report, summary, image = sys.argv[1:]
results = json.load(open(report)).get("Results") or []
blocking, unfixed, secrets = [], 0, []
for result in results:
    for v in result.get("Vulnerabilities") or []:
        if v["Severity"] not in ("HIGH", "CRITICAL"):
            continue
        if v.get("FixedVersion"):
            blocking.append(v)
        else:
            unfixed += 1
    for s in result.get("Secrets") or []:
        secrets.append((result.get("Target", ""), s.get("RuleID"), s.get("Title")))
with open(summary, "a") as out:
    if blocking:
        out.write(f"- :x: {len(blocking)} HIGH/CRITICAL vulnerabilities with a fix available:\n\n")
        out.write("  | Severity | Package | Installed | Fixed in | ID |\n  |---|---|---|---|---|\n")
        for v in sorted(blocking, key=lambda v: (v["Severity"] != "CRITICAL", v["PkgName"])):
            out.write(f"  | {v['Severity']} | {v['PkgName']} | {v.get('InstalledVersion','')} | {v['FixedVersion']} | {v['VulnerabilityID']} |\n")
        out.write("\n  Rebuilding on a fresh base usually fixes these (`apt-get upgrade` for OS packages, a newer pin for language packages).\n")
    else:
        out.write("- :white_check_mark: No HIGH/CRITICAL vulnerability with a fix available.\n")
    if unfixed:
        out.write(f"- :information_source: {unfixed} HIGH/CRITICAL with no fix yet (reported, not blocking).\n")
    if secrets:
        out.write(f"- :x: {len(secrets)} secret(s) baked into the image:\n")
        for target, rule, title in secrets:
            out.write(f"  - `{target}`: {title} ({rule})\n")
    else:
        out.write("- :white_check_mark: No secrets in the image.\n")
print(f"Trivy: {len(blocking)} fixable HIGH/CRITICAL, {unfixed} unfixable (not blocking), {len(secrets)} secret(s)")
for v in blocking:
    print(f"::error::{image}: {v['Severity']} {v['VulnerabilityID']} in {v['PkgName']} {v.get('InstalledVersion','')} (fixed in {v['FixedVersion']})")
for target, rule, title in secrets:
    print(f"::error::{image}: secret in {target}: {title} ({rule})")
sys.exit(1 if blocking or secrets else 0)
EOF
fi

# --- Malicious packages ----------------------------------------------------
# osv-scanner exits non-zero on ANY known vulnerability (Debian advisories
# included), so its exit code isn't the gate: the report is. No report at
# all means the scan itself failed, which blocks.
osv-scanner scan image --format json --output "$report/osv.json" "$image" > "$report/osv.log" 2>&1
if [ ! -s "$report/osv.json" ]; then
  echo "::error::OSV-Scanner couldn't scan $image:"; tail -20 "$report/osv.log"
  echo "- :x: OSV-Scanner couldn't scan the image." >> "$summary"
  failed=1
else
  python3 - "$report/osv.json" "$summary" "$image" <<'EOF' || failed=1
import json, sys
report, summary, image = sys.argv[1:]
data = json.load(open(report))
malicious = sorted({
    (p["package"]["name"], p["package"].get("version", ""), v["id"])
    for r in data.get("results") or []
    for p in r.get("packages") or []
    for v in p.get("vulnerabilities") or []
    if v["id"].startswith("MAL-")
})
with open(summary, "a") as out:
    if malicious:
        out.write(f"- :x: {len(malicious)} known-malicious package(s):\n")
        for name, version, mal_id in malicious:
            out.write(f"  - `{name} {version}`: [{mal_id}](https://osv.dev/vulnerability/{mal_id})\n")
    else:
        out.write("- :white_check_mark: No known-malicious packages.\n")
print(f"OSV-Scanner: {len(malicious)} known-malicious package(s)")
for name, version, mal_id in malicious:
    print(f"::error::{image}: known-malicious package {name} {version} ({mal_id})")
sys.exit(1 if malicious else 0)
EOF
fi

echo >> "$summary"
rm -rf "$report"
if [ "$failed" = "0" ]; then echo "Security scan passed: $image"; else echo "Security scan FAILED: $image"; fi
exit "$failed"
