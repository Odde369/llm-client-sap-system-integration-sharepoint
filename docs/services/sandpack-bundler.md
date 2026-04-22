# Sandpack Bundler Mirror

**Container:** `sandpack-bundler`
**Port:** `3300`
**Source:** `docker/sandpack-bundler/`

A local static server that mirrors the Sandpack code bundler (v2.19.8). Required for corporate environments where `*.codesandbox.io` is blocked by the network/proxy.

---

## Why This Exists

LibreChat renders `application/vnd.react` artifacts using [Sandpack](https://sandpack.codesandbox.io/). Sandpack loads its runtime bundler from a CDN:

```
https://2-19-8-sandpack.codesandbox.io/
```

In corporate networks, `*.codesandbox.io` is often blocked by web proxies or firewalls. The iframe fails to load, Sandpack cannot compile or run any React code, and no artifact renders.

**Solution:** Build a Docker image that downloads all required Sandpack assets at build time and serves them locally.

---

## How It Works

**Dockerfile** (build-time asset download):
```dockerfile
FROM node:18-alpine AS downloader
RUN wget -q -O /app/dist/index.html "https://2-19-8-sandpack.codesandbox.io/"
# Parse index.html for JS/CSS references, download each file
RUN grep -oE '(src|href)="[^"]*\.(js|css)[^"]*"' /app/dist/index.html | ...
```

All 6 JS files (~1.3 MB total) are baked into the image:
- `browserfs.min.js` — Browser filesystem abstraction
- `vendors~sandbox.chunk.js` — Vendor dependencies
- `default~sandbox~sandbox-startup.chunk.js`
- `sandbox.js` — Main Sandpack bundler runtime
- `vendors~sandbox-startup.chunk.js`
- `sandbox-startup.js`

**server.js** — Fastify static server with required CORS headers:
```js
res.setHeader("Access-Control-Allow-Origin", "*");
res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
```

These headers are mandatory for Sandpack's SharedArrayBuffer usage.

---

## LibreChat Integration

Add to `.env`:
```env
SANDPACK_BUNDLER_URL=http://localhost:3300
```

LibreChat's API server reads this and passes it to the browser via `/api/config`. The browser uses it as the Sandpack iframe source instead of the CDN URL.

Verify the config is applied:
```bash
curl -s http://localhost:3080/api/config | grep bundlerURL
# Expected: "bundlerURL":"http://localhost:3300"
```

---

## Upgrading Sandpack Version

When `@codesandbox/sandpack-react` is updated in the LibreChat client:

1. Find the new CDN version. The version is embedded in the built JS bundle name (e.g. `sandpack.DKCSWDiU.js`). Search for the version string:
   ```bash
   docker exec LibreChat grep -o '[0-9-]*-sandpack.codesandbox.io' /app/client/dist/assets/sandpack.*.js
   ```

2. Update `docker/sandpack-bundler/Dockerfile`:
   ```dockerfile
   # Change the CDN URL to the new version
   wget -q -O /app/dist/index.html "https://2-19-9-sandpack.codesandbox.io/"
   ```

3. Rebuild:
   ```bash
   docker build -t sandpack-bundler-mirror docker/sandpack-bundler/
   docker compose -f docker-compose.yml -f docker-compose.override.yml up -d sandpack-bundler
   ```

---

## Docker Configuration

```yaml
# docker-compose.override.yml
sandpack-bundler:
  container_name: sandpack-bundler
  image: sandpack-bundler-mirror   # pre-built, not built by compose
  restart: unless-stopped
  ports:
    - "3300:3300"
```

The image must be built manually before first use:
```bash
docker build -t sandpack-bundler-mirror docker/sandpack-bundler/
```
