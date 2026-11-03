# Everything a product needs to run, and nothing else. Keep these lines as
# they are; add your own dependencies on the marked line.
FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1
# Security fixes released since the base image was published: CI's scan
# fails on a high or critical vulnerability that has a fix.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
# Your dependencies, if any, each pinned: e.g. RUN pip install --no-cache-dir
# requests==2.32.3, or better, by hash, as the cloud samples do (a
# requirements.txt from pip-compile --generate-hashes, --require-hashes).
# pip isn't needed once the image is built, and the copies of other packages
# it bundles (urllib3, msgpack, setuptools' pkg_resources) fail the scan.
RUN pip uninstall --yes pip

WORKDIR /app
COPY entrypoint.sh /app/entrypoint.sh
COPY actions/ /app/actions/
RUN chmod +x /app/entrypoint.sh /app/actions/*

# Never root. The platform's mounts (/platform/input, /platform/output,
# /platform/secrets) work for any user.
ENV HOME=/tmp
USER 65532:65532

ENTRYPOINT ["/app/entrypoint.sh"]
