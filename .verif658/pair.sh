#!/usr/bin/env bash
# Verificador #658 — dispara DOIS processos de turno no mesmo thread com uma janela de largada comum.
# Uso: pair.sh <outdir> <tenant> <instance> <convA:ciA:msgA:respA:idA:delayA> <convB:...> [lead_ms]
set -euo pipefail
WT=/Users/gabrieljablonski/dev/agents-pubclone-658
source "$WT/.verif658/env.sh"
OUT=$1; TENANT=$2; INSTANCE=$3; A=$4; B=$5; LEAD=${6:-3000}
mkdir -p "$OUT"
START_AT=$(( $(date +%s%3N 2>/dev/null || python3 -c 'import time;print(int(time.time()*1000))') + LEAD ))
run_one() {
  local label=$1 spec=$2
  IFS=: read -r conv ci msg resp mid delay <<< "$spec"
  cd "$WT"
  V_LABEL="$label" V_TENANT="$TENANT" V_INSTANCE="$INSTANCE" V_CONV="$conv" \
    V_CONTACT_INBOX="$ci" V_MSG="$msg" V_RESP="$resp" V_MSG_ID="$mid" \
    V_MODEL_DELAY_MS="$delay" V_START_AT="$START_AT" \
    bun run "$WT/.verif658/turn.ts" > "$OUT/$label.out" 2> "$OUT/$label.err"
}
run_one A "$A" &
PA=$!
run_one B "$B" &
PB=$!
wait $PA || echo "A exited nonzero"
wait $PB || echo "B exited nonzero"
grep -h __V658__ "$OUT/A.out" "$OUT/B.out" | sed 's/__V658__//'
