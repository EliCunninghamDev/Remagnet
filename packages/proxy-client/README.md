# @remagnet/proxy-client

Typed TypeScript client for the Remagnet Proxy, generated from
[`proxy/openapi.yaml`](../../proxy/openapi.yaml).

`src/schema.d.ts` is produced by `openapi-typescript`; `src/client.ts` is a small
hand-written wrapper that configures `openapi-fetch` with the proxy URL and
bearer token. The package also owns proxy archive URL construction so clients do
not duplicate path or token logic.

## Usage

```ts
import { createProxyClient, proxyErrorMessage } from "@remagnet/proxy-client";

const proxy = createProxyClient({
  baseUrl: "https://remagnet.example.com",
  token, // the proxy's BRIDGE_TOKEN
});

const { data, error, response } = await proxy.GET("/api/health");
if (error) throw new Error(proxyErrorMessage(response, error));

console.log(data.appVersion);
```

For a browser download, use `archiveDownloadUrl(baseUrl, hash, token, useHeader)`
and pass the resulting URL to the browser's download API. Firefox can attach the
Authorization header; other browsers use the `?token=` fallback.

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
