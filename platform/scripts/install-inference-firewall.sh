#!/bin/sh
# Explicit candidate-host operation. Never called from application startup/build.
# Blocks proxy custom-provider DNS rebinding into host/private infrastructure.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run on the Linux Docker host as root.' >&2; exit 1; }
[ "$#" = 1 ] && [ -d "$1/private" ] || { echo 'Pass the initialized candidate root directory.' >&2; exit 1; }
iptables -w -nL DOCKER-USER >/dev/null
# The API's optional forward proxy must not initiate host/private connections.
# Its organization proxy subnet is the sole private service exception; run
# responses use ESTABLISHED state. Docker's embedded DNS runs independently.
iptables -w -N WME-API-EGRESS 2>/dev/null || true
iptables -w -F WME-API-EGRESS
iptables -w -A WME-API-EGRESS -m addrtype --dst-type LOCAL -j REJECT
iptables -w -A WME-API-EGRESS -d 172.31.251.0/24 -j RETURN
for range in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  iptables -w -A WME-API-EGRESS -d "$range" -j REJECT
done
iptables -w -A WME-API-EGRESS -j RETURN
iptables -w -N WME-INFERENCE 2>/dev/null || true
iptables -w -F WME-INFERENCE
iptables -w -A WME-INFERENCE -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -w -A WME-INFERENCE -s 172.31.251.2/32 -j WME-API-EGRESS
iptables -w -A WME-INFERENCE -s 172.31.251.2/32 -j RETURN
for range in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  iptables -w -A WME-INFERENCE -d "$range" -j REJECT
done
iptables -w -A WME-INFERENCE -j RETURN
iptables -w -C DOCKER-USER -i br-wmeinference -j WME-INFERENCE 2>/dev/null || iptables -w -I DOCKER-USER 1 -i br-wmeinference -j WME-INFERENCE
iptables -w -N WME-INFERENCE-HOST 2>/dev/null || true
iptables -w -F WME-INFERENCE-HOST
iptables -w -A WME-INFERENCE-HOST -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -w -A WME-INFERENCE-HOST -j REJECT
iptables -w -C INPUT -i br-wmeinference -j WME-INFERENCE-HOST 2>/dev/null || iptables -w -I INPUT 1 -i br-wmeinference -j WME-INFERENCE-HOST
# Docker --internal blocks routed egress but not the host's own bridge addresses.
# Only these dedicated v2 bridge prefixes are affected; existing host policy is retained.
iptables -w -N WME-ISOLATED-HOST 2>/dev/null || true
iptables -w -F WME-ISOLATED-HOST
iptables -w -A WME-ISOLATED-HOST -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -w -A WME-ISOLATED-HOST -j REJECT
for prefix in br-wmerun+ br-wmeapp+; do
  iptables -w -C INPUT -i "$prefix" -j WME-ISOLATED-HOST 2>/dev/null || iptables -w -I INPUT 1 -i "$prefix" -j WME-ISOLATED-HOST
done
umask 077
cat /proc/sys/kernel/random/boot_id > "$1/private/firewall-boot-id"
echo 'Candidate inference egress rules installed. Persist/reapply these rules before enabling inference after a host reboot.'
