# Containerized integration tests

End-to-end regression tests that run the real Remagnet Proxy container against
real torrent client containers (`lscr.io/linuxserver/qbittorrent` and
`lscr.io/linuxserver/transmission`).

## What is verified

For every client in the matrix, [`run.ts`](run.ts) exercises:

1. `/healthz` liveness and `apiVersion: 1`.
2. First-run admin setup with `SETUP_CODE` enforcement.
3. Configuring the client through `PUT /api/config` and testing `GET /api/health`.
4. Direct device sign-in (`POST /api/auth/device`) and `403` isolation from admin routes.
5. Encrypted `remagnet://pair` v2 device enrollment without 2FA.
6. Paused magnet add, normalized list state (`stopped`), hash lookup, and deletion.
7. Strict tag/category isolation: unrelated torrents added directly to the client
   are hidden from `GET /api/torrents` and return `404` on `DELETE`, archive
   ticket minting, and archive download.
8. Deterministic offline 100%-complete ZIP streaming (both Bearer header and
   single-use `?ticket=`, plus replay rejection) with SHA-256 payload verification.
9. Self-service device revocation (`DELETE /api/devices/current`).

## Running locally

Requires Docker Compose and Bun:

```bash
# qBittorrent
bun run tests/integration/prepare.ts --client qbittorrent
docker compose -f tests/integration/compose.qbittorrent.yml up -d --build
bun run tests/integration/run.ts --client qbittorrent
docker compose -f tests/integration/compose.qbittorrent.yml down -v

# Transmission
bun run tests/integration/prepare.ts --client transmission
docker compose -f tests/integration/compose.transmission.yml up -d --build
bun run tests/integration/run.ts --client transmission
docker compose -f tests/integration/compose.transmission.yml down -v
```

CI runs this matrix automatically in
[`.github/workflows/integration.yml`](../../.github/workflows/integration.yml).
