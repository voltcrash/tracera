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
docker_subnet="$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Subnet}}')"
if [[ ! "$docker_subnet" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]]; then
  echo "Unable to resolve the local Docker bridge subnet." >&2
  exit 1
fi

cleanup() {
  sudo iptables -D OUTPUT -j "$chain" 2>/dev/null || true
  sudo iptables -F "$chain" 2>/dev/null || true
  sudo iptables -X "$chain" 2>/dev/null || true
  sudo ip6tables -D OUTPUT -j "$chain" 2>/dev/null || true
  sudo ip6tables -F "$chain" 2>/dev/null || true
  sudo ip6tables -X "$chain" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sudo iptables -N "$chain"
sudo iptables -A "$chain" -d 127.0.0.0/8 -j ACCEPT
sudo iptables -A "$chain" -d "$docker_subnet" -j ACCEPT
sudo iptables -A "$chain" -j REJECT
sudo iptables -I OUTPUT 1 -j "$chain"

sudo ip6tables -N "$chain"
sudo ip6tables -A "$chain" -d ::1/128 -j ACCEPT
sudo ip6tables -A "$chain" -j REJECT
sudo ip6tables -I OUTPUT 1 -j "$chain"

echo "External networking denied; loopback and Docker bridge ${docker_subnet} remain available." >&2
"$@"
