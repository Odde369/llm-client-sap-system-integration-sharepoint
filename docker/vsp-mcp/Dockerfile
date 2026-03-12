FROM golang:1.24-bookworm AS vsp-build

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG VSP_REPO=https://github.com/oisee/vibing-steampunk.git
ARG VSP_REF=v2.25.0

WORKDIR /src
RUN git clone --depth 1 --branch ${VSP_REF} ${VSP_REPO} vibing-steampunk

WORKDIR /src/vibing-steampunk
RUN go build -o /out/vsp ./cmd/vsp

FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends iptables ca-certificates wireguard-tools iproute2 \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g mcp-proxy@latest

COPY --from=vsp-build /out/vsp /usr/local/bin/vsp
RUN chmod +x /usr/local/bin/vsp
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV MCP_PROXY_PORT=3000
ENV VSP_MODE=focused
ENV VSP_EGRESS_LOCKDOWN=true

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
