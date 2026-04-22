# Mirrors the built sandpack-bundler from the official CDN and serves it locally.
# This avoids a long parcel build and makes the bundler available in air-gapped/
# corporate networks where *.codesandbox.io is blocked in the browser.
#
# The version MUST match what is embedded in sandpack.DKCSWDiU.js:
#   docker exec LibreChat sh -c "grep -ao '\"2\.[0-9]*\.[0-9]*\"' /app/client/dist/assets/sandpack.DKCSWDiU.js | head -1"
# Currently: 2.19.8 → URL: https://2-19-8-sandpack.codesandbox.io

FROM node:18-alpine

WORKDIR /app

# Download the built bundler SPA from the official CDN
RUN apk add --no-cache wget curl && \
    mkdir -p /app/dist && \
    # Download the main SPA entry point
    wget -q -O /app/dist/index.html "https://2-19-8-sandpack.codesandbox.io/" && \
    # Extract all JS/CSS file references and download them
    grep -oE '(src|href)="[^"]*\.(js|css)[^"]*"' /app/dist/index.html | \
        grep -oE '"[^"]*"' | tr -d '"' | \
        while read f; do \
            url="https://2-19-8-sandpack.codesandbox.io${f}"; \
            dest="/app/dist${f}"; \
            mkdir -p "$(dirname $dest)"; \
            wget -q -O "$dest" "$url" || true; \
        done

COPY server.js /app/server.js
COPY package.json /app/package.json

RUN npm install

EXPOSE 3300

CMD ["node", "/app/server.js"]
