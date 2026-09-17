#!/usr/bin/env bash
# Verificador #658 — s1/s8: N repeticoes de dois turnos simultaneos no mesmo thread, canal lido no fim.
set -euo pipefail
WT=/Users/gabrieljablonski/dev/agents-pubclone-658
source "$WT/.verif658/env.sh"
BASE=~/.local/state/ship/rodadas/fazer-ai-agents/658/evidence
N=${1:-5}
TAG=${2:-s1}
for i in $(seq 1 "$N"); do
  OUT="$BASE/$TAG/run$i"
  mkdir -p "$OUT"
  cd "$WT"
  IDS=$(SEED_CONVS="65801:658001" bun run "$WT/.verif658/seed.ts" 2>/dev/null | tail -1)
  echo "$IDS" > "$OUT/seed.json"
  T=$(echo "$IDS" | python3 -c 'import json,sys;print(json.load(sys.stdin)["tenantId"])')
  I=$(echo "$IDS" | python3 -c 'import json,sys;print(json.load(sys.stdin)["instanceId"])')
  "$WT/.verif658/pair.sh" "$OUT" "$T" "$I" "65801:658001:MSG-A:RESP-A:1001:1500" "65801:658001:MSG-B:RESP-B:1002:1500" > "$OUT/pair.json" 2>"$OUT/pair.err"
  V_THREAD="$T:$I:ci:658001" V_TENANT="$T" V_INSTANCE="$I" V_CONTACT_INBOX=658001 \
    bun run "$WT/.verif658/read-channel.ts" 2>/dev/null | grep __V658__ | sed 's/__V658__//' > "$OUT/channel.json"
  echo "--- run $i (tenant $T) ---"
  cat "$OUT/pair.json"
  cat "$OUT/channel.json"
done
