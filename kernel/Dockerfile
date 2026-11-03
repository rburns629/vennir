# The kernel: one static binary, `kernel`, whose subcommand picks the
# process (the chart's `command:`): api, scheduler, migrate, sleep.
# On the builder's own platform, cross-compiling for the target: no emulation.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/kernel ./cmd/kernel

# No shell, no package manager: CA certificates, /tmp and the binary.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/kernel /usr/local/bin/kernel
# Not root. Numeric, so a Pod's runAsNonRoot can verify it.
USER 65532
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/kernel"]
