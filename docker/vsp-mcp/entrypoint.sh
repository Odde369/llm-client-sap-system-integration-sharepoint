#!/bin/sh
set -eu

# ─── WireGuard Tunnel ────────────────────────────────────────────────
# Option A: Mount the config as a volume: ./wg/wg0.conf:/etc/wireguard/wg0.conf:ro
# Option B: Set WG_CONF_B64 env var (base64-encoded wg0.conf contents)
#           Generate with: base64 -w0 wg/wg0.conf
# Note: Remove the DNS line from the config — DNS is set manually below.
WG_CONF="/etc/wireguard/wg0.conf"

if [ -n "${WG_CONF_B64:-}" ] && [ ! -f "$WG_CONF" ]; then
  mkdir -p /etc/wireguard
  echo "$WG_CONF_B64" | base64 -d > "$WG_CONF"
  chmod 600 "$WG_CONF"
  echo "[wireguard] Config written from WG_CONF_B64"
fi

if [ -f "$WG_CONF" ]; then
  echo "[wireguard] Config found at $WG_CONF — bringing up wg0..."
  # Strip DNS line — resolvconf is not available; DNS is set manually below
  sed -i '/^DNS[[:space:]]*=/d' "$WG_CONF"
  wg-quick up wg0
  if [ -n "${WG_DNS:-}" ]; then
    echo "nameserver $WG_DNS" > /etc/resolv.conf
    echo "[wireguard] DNS set to $WG_DNS"
  else
    echo "nameserver 192.168.126.5" > /etc/resolv.conf
    echo "[wireguard] DNS set to 192.168.126.5 (default)"
  fi
  echo "[wireguard] Tunnel active. Interface:"
  wg show wg0
  echo "[wireguard] Routes:"
  ip route | grep wg0 || true
else
  echo "[wireguard] No config at $WG_CONF — skipping tunnel setup."
fi
# ─────────────────────────────────────────────────────────────────────

if [ -z "${SAP_URL:-}" ]; then
  echo "SAP_URL is required"
  exit 1
fi

SAP_SCHEME="$(echo "$SAP_URL" | sed -E 's#^(https?)://.*#\1#')"
SAP_TARGET="$(echo "$SAP_URL" | sed -E 's#^https?://##')"
SAP_HOST_PORT="$(echo "$SAP_TARGET" | cut -d/ -f1)"
SAP_PATH_RAW="$(echo "$SAP_TARGET" | cut -s -d/ -f2-)"
SAP_HOST="${SAP_HOST_PORT%%:*}"
SAP_PORT="${SAP_HOST_PORT##*:}"

if [ "$SAP_PORT" = "$SAP_HOST_PORT" ]; then
  if [ "$SAP_SCHEME" = "https" ]; then
    SAP_PORT=443
  else
    SAP_PORT=80
  fi
fi

if [ -n "${SAP_PATH_RAW}" ]; then
  SAP_PATH="/${SAP_PATH_RAW}"
else
  SAP_PATH=""
fi

SAP_IP="$(getent hosts "$SAP_HOST" | awk 'NR==1 {print $1}')"
if [ -z "$SAP_IP" ]; then
  echo "Could not resolve SAP host: $SAP_HOST"
  exit 1
fi

if [ "${VSP_EGRESS_LOCKDOWN:-true}" = "true" ]; then
  iptables -P OUTPUT DROP
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -A OUTPUT -p tcp -d "$SAP_IP" --dport "$SAP_PORT" -j ACCEPT
  if [ -f "$WG_CONF" ]; then
    WG_ENDPOINT_IP="$(grep -oP 'Endpoint\s*=\s*\K[^:]+' "$WG_CONF" || true)"
    WG_ENDPOINT_PORT="$(grep -oP 'Endpoint\s*=\s*[^:]+:\K\d+' "$WG_CONF" || true)"
    if [ -n "$WG_ENDPOINT_IP" ] && [ -n "$WG_ENDPOINT_PORT" ]; then
      iptables -A OUTPUT -p udp -d "$WG_ENDPOINT_IP" --dport "$WG_ENDPOINT_PORT" -j ACCEPT
      echo "[wireguard] Egress rule added for endpoint $WG_ENDPOINT_IP:$WG_ENDPOINT_PORT"
    fi
    iptables -A OUTPUT -o wg0 -j ACCEPT
  fi
fi

export SAP_URL="${SAP_SCHEME}://${SAP_IP}:${SAP_PORT}${SAP_PATH}"

set -- vsp --url "$SAP_URL" --client "${SAP_CLIENT:-001}" --mode "${VSP_MODE:-focused}"

if [ -n "${SAP_USER:-}" ]; then
  set -- "$@" --user "$SAP_USER"
fi

if [ -n "${SAP_PASSWORD:-}" ]; then
  set -- "$@" --password "$SAP_PASSWORD"
fi

if [ "${SAP_INSECURE:-false}" = "true" ]; then
  set -- "$@" --insecure
fi

if [ "${SAP_READ_ONLY:-true}" = "true" ]; then
  set -- "$@" --read-only
fi

if [ -n "${VSP_EXTRA_ARGS:-}" ]; then
  # shellcheck disable=SC2086
  set -- "$@" ${VSP_EXTRA_ARGS}
fi

exec mcp-proxy --server stream --port "${MCP_PROXY_PORT:-3000}" -- "$@"
