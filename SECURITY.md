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

- **Administrator account.** The first visitor creates one administrator account.
  Passwords are hashed with Argon2id and must contain at least 12 characters.
  Failed sign-in attempts are rate limited per client address (five failures in
  five minutes by default). Changing the password revokes every existing
  administrator session.
- **Two-factor authentication.** TOTP is optional. When enabled, sign-in also
  requires a current 6-digit code or one of eight single-use recovery codes
  shown once at enrolment. Enabling or disabling 2FA requires an administrator
  session, and disabling it also requires the password (and a current code while
  it is enabled). The TOTP secret is stored in `auth.json`; recovery codes are
  stored only as SHA-256 hashes.
- **Administrator sessions.** The browser session is a random, in-memory token in
  the `remagnet_session` cookie with `HttpOnly; SameSite=Strict; Path=/` and,
  when the request arrived over HTTPS, `Secure`. Sessions expire after seven days
  and are revoked on sign-out, password change, or proxy restart.
- **Per-device tokens.** Direct sign-in from the extension or Android app and
  pairing both mint an `rmg_…` device token. The proxy stores only its SHA-256
  hash. Device tokens reach `/api/health`, `/api/torrents*`, the archive ticket
  and `/archive/:hash`, and are rejected with `403` on administrative routes.
  A device can be revoked from the proxy page, which immediately invalidates its
  token.
- **Pairing.** A `remagnet://pair` v2 response contains only the proxy URL and a
  newly minted device token, encrypted with AES-256-GCM under a key derived from
  the one-time code. qBittorrent credentials and magnet defaults never leave the
  proxy. Pairing requires an administrator session to mint a code, but claiming
  it needs no password or second factor; the 60-second, single-use code proves
  presence. Pairing therefore remains available to someone holding a valid
  administrator session even when they cannot produce a TOTP code.
- **Archive tickets.** `POST /api/archive/{hash}/ticket` issues a 60-second,
  single-use ticket bound to one info hash. The download route consumes it and
  accepts no long-lived token in a query string, so a device token does not leak
  into browser history, download logs or a shared URL.
- **Credentials at rest.** qBittorrent API keys and passwords, the Argon2id
  password hash, the optional TOTP secret, recovery-code hashes and device-token
  hashes live only on the Remagnet Proxy, in `config.json` and `auth.json` with
  mode `0600` inside `DATA_DIR`. The browser extension stores only the proxy URL
  and its device token, encrypted with a non-extractable AES-GCM key; the Android
  app stores only the proxy URL and its device token, encrypted with the Android
  Keystore. Passwords and 2FA codes are never persisted by either client.
- **No stored torrent data.** The proxy streams completed files from
  qBittorrent's Web API into a ZIP response and does not keep a copy.
- **Transport.** The proxy serves plain HTTP. Put it behind an HTTPS reverse
  proxy before exposing it outside a trusted network, and keep it off the
  public internet without TLS. Sign-in sends the administrator password, and
  pairing requires HTTPS unless the origin is loopback or the Android emulator
  host.

## Out of scope

- Vulnerabilities in qBittorrent itself, the browser, or the Android platform.
- Exposing the proxy directly to the internet over HTTP without a reverse
  proxy, or choosing a weak or reused administrator password. These are
  documented deployment mistakes, not undisclosed flaws.
- Reports that require an already compromised host, browser profile or
  unlocked device.
- Denial of service from resource exhaustion on a self-hosted deployment with
  no rate limiting in front of it.
- Social engineering and physical access.
