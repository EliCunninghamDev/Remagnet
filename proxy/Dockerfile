# syntax=docker/dockerfile:1

# Build on the runner's native architecture and cross-compile the target so the
# arm64 image does not spend 30+ minutes under QEMU.
FROM --platform=$BUILDPLATFORM rust:1.100-bookworm AS build

ARG TARGETARCH
WORKDIR /src

RUN case "$TARGETARCH" in \
      amd64) echo "x86_64-unknown-linux-gnu" > /rust-target ;; \
      arm64) \
        echo "aarch64-unknown-linux-gnu" > /rust-target \
        && apt-get update \
        && apt-get install -y --no-install-recommends \
          gcc-aarch64-linux-gnu libc6-dev-arm64-cross \
        && rm -rf /var/lib/apt/lists/* \
        && rustup target add aarch64-unknown-linux-gnu ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac

ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc

COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN target="$(cat /rust-target)" \
    && cargo build --release --locked --target "$target" \
    && cp "target/$target/release/remagnet-bridge" /usr/local/bin/remagnet-bridge

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /usr/local/bin/remagnet-bridge /usr/local/bin/remagnet-bridge

RUN useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin bridge \
    && mkdir -p /data \
    && chown bridge:bridge /data

USER bridge
ENV DATA_DIR=/data
ENV BIND_ADDR=0.0.0.0:8080
EXPOSE 8080

ENTRYPOINT ["remagnet-bridge"]
