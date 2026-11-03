# This product's language support (python3.12, per product.yaml's `runtime`
# field) is declared here, and only here -- the entrypoint dispatcher
# (entrypoint.sh) is language-agnostic on purpose.
#
# google-api-python-client, not a google-cloud-* GAPIC package: the Cloud
# SQL Admin API has no dedicated GAPIC client library (unlike Resource
# Manager/Billing, see gcp/_project's own Dockerfile) -- see
# actions/create.py's own comment on why.
FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
# The base image's OS packages lag behind Debian's security fixes; catalog
# CI's image scan fails on any high or critical CVE that has a fix.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
# Exactly what requirements.txt pins (made from requirements.in, as its
# header says), each package checked against its hash, so every build
# installs the same code. pip isn't needed once the image is built, and
# the copies of other packages it bundles (urllib3, msgpack, setuptools'
# pkg_resources) fail the scan.
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt \
    && pip uninstall --yes pip

WORKDIR /app
COPY entrypoint.sh /app/entrypoint.sh
COPY actions/ /app/actions/
RUN chmod +x /app/entrypoint.sh /app/actions/*

# Not root: nothing here needs it, and a compromised action running as root
# has far more room to break out of its container. The kernel's mounts
# (/platform/input, /platform/output, /platform/secrets) work for any user.
ENV HOME=/tmp
USER 65532:65532

ENTRYPOINT ["/app/entrypoint.sh"]
