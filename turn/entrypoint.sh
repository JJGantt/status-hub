#!/bin/sh
# The TURN relay for live screen shares (status-hub docs/SCREEN.md). Fly delivers UDP only to sockets
# bound to the `fly-global-services` address, and a reply has to leave from it, so both the listener and
# every relay socket are bound there, and the public IPv4 is announced as its external address.
set -eu
GS=$(getent hosts fly-global-services | awk '{print $1}' | head -1)
[ -n "$GS" ] || { echo "fly-global-services does not resolve" >&2; exit 1; }
: "${TURN_SECRET:?TURN_SECRET is not set}"
: "${PUBLIC_IP:?PUBLIC_IP is not set}"
# Fly's TCP proxy connects to the machine's primary eth0 address, which is not fly-global-services (a
# secondary address on the same interface): without a listener there, TURN over TCP is refused.
ETH=$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1 | grep -vx "$GS" | head -1)
exec turnserver -n --log-file=stdout --simple-log \
  --listening-ip="$GS" --listening-ip="$ETH" --relay-ip="$GS" --external-ip="$PUBLIC_IP/$GS" \
  --listening-port=3478 --min-port=50000 --max-port=50099 \
  --use-auth-secret --static-auth-secret="$TURN_SECRET" --realm=jared-turn \
  --fingerprint --no-cli --no-tls --no-dtls --no-multicast-peers --no-software-attribute \
  --stale-nonce=600 --total-quota=20 --user-quota=6 \
  --denied-peer-ip=0.0.0.0-0.255.255.255 --denied-peer-ip=10.0.0.0-10.255.255.255 \
  --denied-peer-ip=100.64.0.0-100.127.255.255 --denied-peer-ip=127.0.0.0-127.255.255.255 \
  --denied-peer-ip=169.254.0.0-169.254.255.255 --denied-peer-ip=172.16.0.0-172.31.255.255 \
  --denied-peer-ip=192.168.0.0-192.168.255.255 --denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
