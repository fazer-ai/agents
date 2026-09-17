#!/usr/bin/env bash
# Verificador #658 — s4: atendimento anterior na conversa 65801 ja marcado; dois turnos da conversa
# NOVA 65802 comecam juntos no mesmo thread. Conta divisorias de 65802 e le last_conversation_id.
set -euo pipefail
WT=/Users/gabrieljablonski/dev/agents-pubclone-658
source "$WT/.verif658/env.sh"
BASE=~/.local/state/ship/rodadas/fazer-ai-agents/658/evidence
N=${1:-5}
for i in $(seq 1 "$N"); do
  OUT="$BASE/s4/run$i"; mkdir -p "$OUT"; cd "$WT"
  IDS=$(SEED_CONVS="65801:658001,65802:658001" bun run "$WT/.verif658/seed.ts" 2>/dev/null | tail -1)
  echo "$IDS" > "$OUT/seed.json"
  T=$(echo "$IDS" | python3 -c 'import json,sys;print(json.load(sys.stdin)["tenantId"])')
  I=$(echo "$IDS" | python3 -c 'import json,sys;print(json.load(sys.stdin)["instanceId"])')
  # Atendimento anterior: um turno sozinho na conversa 65801.
  V_LABEL=prev V_TENANT=$T V_INSTANCE=$I V_CONV=65801 V_CONTACT_INBOX=658001 \
    V_MSG=MSG-PREV V_RESP=RESP-PREV V_MSG_ID=4000 V_MODEL_DELAY_MS=200 \
    bun run "$WT/.verif658/turn.ts" > "$OUT/prev.out" 2>"$OUT/prev.err"
  V_THREAD="$T:$I:ci:658001" V_TENANT=$T V_INSTANCE=$I V_CONTACT_INBOX=658001 \
    bun run "$WT/.verif658/read-channel.ts" 2>/dev/null | grep __V658__ | sed 's/__V658__//' > "$OUT/channel-before.json"
  # Dois turnos da conversa NOVA 65802, juntos.
  "$WT/.verif658/pair.sh" "$OUT" "$T" "$I" "65802:658001:MSG-A:RESP-A:4001:1500" "65802:658001:MSG-B:RESP-B:4002:1500" > "$OUT/pair.json" 2>"$OUT/pair.err"
  V_THREAD="$T:$I:ci:658001" V_TENANT=$T V_INSTANCE=$I V_CONTACT_INBOX=658001 \
    bun run "$WT/.verif658/read-channel.ts" 2>/dev/null | grep __V658__ | sed 's/__V658__//' > "$OUT/channel.json"
  echo "--- run $i (tenant $T) ---"
  cat "$OUT/channel-before.json"
  cat "$OUT/pair.json"
  cat "$OUT/channel.json"
done
