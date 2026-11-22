# Security policy

## Reporting a vulnerability

Please report security issues privately. Do not open a public issue, and do not
include working tokens, API keys or other live credentials in a report.

- **Private GitHub report**:
  <https://github.com/EliCunninghamDev/Remagnet/security/advisories/new>
- **Email**: <contact@elijahcunningham.dev>

A useful report includes the affected component (browser extension, Android
app, or Remagnet Proxy), the version, tag or commit, steps to reproduce, and the
impact you expect. Proof-of-concept code or a screen recording helps but is not
required.

## What to expect

- We aim to acknowledge a report within three business days.
- We will confirm the issue, work on a fix, and keep you updated on progress.
- Fixes ship from the default branch and in the next release. This is a
  volunteer project, so there is no bug bounty.
- We will credit you in the advisory unless you ask us not to, and we will
  coordinate the disclosure date with you.

## Supported versions

Security fixes target the latest release and the `main` branch. Older tags and
builds are not maintained; upgrade before reporting if you can.

## Security model

Remagnet runs on infrastructure you control, so some reports depend on
deployment choices rather than a code defect.

- **Remagnet Proxy token.** `BRIDGE_TOKEN` is a bearer token that guards the
  proxy's config API and the `/archive/:hash` endpoint. It must be at least 16
  characters and should be generated with `openssl rand -hex 32`. Anyone with
  the token can read the proxy config and download completed torrents.
- **Credentials at rest.** qBittorrent API keys and passwords are stored
  encrypted with the Android Keystore on Android and in extension storage in
  the browser. The proxy keeps its own qBittorrent credentials in
  `config.json` with mode `0600` inside `DATA_DIR`.
- **No stored torrent data.** The proxy streams completed files from
  qBittorrent's Web API into a ZIP response and does not keep a copy.
- **Transport.** The proxy serves plain HTTP. Put it behind an HTTPS reverse
  proxy before exposing it outside a trusted network, and keep it off the
  public internet without TLS.

## Out of scope

- Vulnerabilities in qBittorrent itself, the browser, or the Android platform.
- Exposing the proxy directly to the internet over HTTP without a reverse
  proxy, or reusing a weak or shared `BRIDGE_TOKEN`. These are documented
  deployment mistakes, not undisclosed flaws.
- Reports that require an already compromised host, browser profile or
  unlocked device.
- Denial of service from resource exhaustion on a self-hosted deployment with
  no rate limiting in front of it.
- Social engineering and physical access.
