# Build the bridge in a throwaway stage and ship only the static binary.
FROM rust:1.100-bookworm AS build

WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/target/release/remagnet-bridge /usr/local/bin/remagnet-bridge

RUN useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin bridge \
    && mkdir -p /data \
    && chown bridge:bridge /data

USER bridge
ENV DATA_DIR=/data
ENV BIND_ADDR=0.0.0.0:8080
EXPOSE 8080

ENTRYPOINT ["remagnet-bridge"]
