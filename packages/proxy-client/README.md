# @remagnet/proxy-client

Typed TypeScript client for the Remagnet Proxy, generated from
[`proxy/openapi.yaml`](../../proxy/openapi.yaml).

`src/schema.d.ts` is produced by `openapi-typescript`; `src/client.ts` is a small
hand-written wrapper that configures `openapi-fetch` with the proxy URL and the
per-device bearer token. The package also owns proxy archive URL construction so
clients do not duplicate path or ticket logic.

## Usage

```ts
import { createProxyClient, proxyErrorCode, proxyErrorMessage } from "@remagnet/proxy-client";

const proxy = createProxyClient({
  baseUrl: "https://remagnet.example.com",
  token, // per-device token from pairing or POST /api/auth/device (`rmg_…`)
});

const { data, error, response } = await proxy.GET("/api/health");
if (error) throw new Error(proxyErrorMessage(response, error));

console.log(data.appVersion);
```

Before a device token exists, use `createPublicProxyClient(baseUrl)` for the
public bootstrap endpoints. Check `proxyErrorCode(error)` for `"totp_required"`
to prompt for a second factor:

```ts
const publicProxy = createPublicProxyClient("https://remagnet.example.com");
const { data, error } = await publicProxy.POST("/api/auth/device", {
  body: { username, password },
});
if (proxyErrorCode(error) === "totp_required") showTotpPrompt();
```

For a browser download, mint a ticket with `POST /api/archive/{hash}/ticket`
and pass it to `archiveDownloadUrl(baseUrl, hash, ticket)`. The resulting URL
carries `?ticket=…` and is single-use for 60 seconds. Omit the ticket to get a
bare `/archive/<hash>` URL for downloads that can attach an `Authorization`
header, such as Firefox and the Android app.

## Regenerate

From the repository root:

```bash
bun run api:generate
```

This rewrites `src/schema.d.ts` and the Kotlin client under
`android/proxy-client/`. Commit generated changes with the spec.

## Test

```bash
bun test
bun run typecheck
```
