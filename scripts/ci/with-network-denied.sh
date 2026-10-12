#!/usr/bin/env bash
set -euo pipefail

if [[ "${CI:-}" != "true" || "$(uname -s)" != "Linux" ]]; then
  echo "External-network denial is restricted to Linux CI." >&2
  exit 1
fi
if [[ "$#" -eq 0 ]]; then
  echo "Usage: scripts/ci/with-network-denied.sh <command> [args...]" >&2
  exit 1
fi

chain="TRACERA_${$}_OUT"

cleanup() {
  sudo iptables -D OUTPUT -j "$chain" 2>/dev/null || true
  sudo iptables -F "$chain" 2>/dev/null || true
  sudo iptables -X "$chain" 2>/dev/null || true
  sudo ip6tables -D OUTPUT -j "$chain" 2>/dev/null || true
  sudo ip6tables -F "$chain" 2>/dev/null || true
  sudo ip6tables -X "$chain" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sudo iptables -N "$chain"
sudo iptables -A "$chain" -d 127.0.0.0/8 -j ACCEPT
sudo iptables -A "$chain" -j REJECT
sudo iptables -I OUTPUT 1 -j "$chain"

sudo ip6tables -N "$chain"
sudo ip6tables -A "$chain" -d ::1/128 -j ACCEPT
sudo ip6tables -A "$chain" -j REJECT
sudo ip6tables -I OUTPUT 1 -j "$chain"

echo "External networking denied; only loopback remains available." >&2
"$@"
