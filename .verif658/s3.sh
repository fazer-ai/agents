#!/usr/bin/env bash
# Verificador #658 — s3: A segura a ocupacao alem do teto da espera (modelo dorme 420s, renovando o
# lease a cada 100s). B pede o mesmo thread e e cronometrado ate um desfecho. Amostra a linha de
# claim durante a espera, para mostrar contra o que o teto de B esta sendo medido.
set -euo pipefail
WT=/Users/gabrieljablonski/dev/agents-pubclone-658
source "$WT/.verif658/env.sh"
OUT=~/.local/state/ship/rodadas/fazer-ai-agents/658/evidence/s3
mkdir -p "$OUT"
cd "$WT"
IDS=$(SEED_CONVS="65801:658001" bun run "$WT/.verif658/seed.ts" 2>/dev/null | tail -1)
echo "$IDS" > "$OUT/seed.json"
T=$(echo "$IDS" | python3 -c 'import json,sys;print(json.load(sys.stdin)["tenantId"])')
I=$(echo "$IDS" | python3 -c 'import json,sys;print(json.load(sys.stdin)["instanceId"])')
START_AT=$(python3 -c "import time;print(int(time.time()*1000)+4000)")

V_LABEL=A V_TENANT=$T V_INSTANCE=$I V_CONV=65801 V_CONTACT_INBOX=658001 \
  V_MSG=MSG-A V_RESP=RESP-A V_MSG_ID=3001 V_MODEL_DELAY_MS=420000 V_START_AT=$START_AT \
  bun run "$WT/.verif658/turn.ts" > "$OUT/A.out" 2> "$OUT/A.err" &
PA=$!
# B entra 2s depois da largada de A, ja com a ocupacao de A no ar.
V_LABEL=B V_TENANT=$T V_INSTANCE=$I V_CONV=65801 V_CONTACT_INBOX=658001 \
  V_MSG=MSG-B V_RESP=RESP-B V_MSG_ID=3002 V_MODEL_DELAY_MS=1000 V_START_AT=$((START_AT+2000)) \
  bun run "$WT/.verif658/turn.ts" > "$OUT/B.out" 2> "$OUT/B.err" &
PB=$!

# Amostragem do lease enquanto B espera.
(
  for k in $(seq 1 90); do
    ts=$(python3 -c 'import time;print(int(time.time()*1000))')
    row=$(docker exec secretaria-v4-postgres psql -U postgres -d "$V_DB" -At -F'|' -c \
      "select turn_holders, turn_held_until, turn_epoch from agent_threads where tenant_id=$T and contact_inbox_id=658001" 2>/dev/null || echo err)
    echo "$ts|$row"
    sleep 5
  done
) > "$OUT/lease-samples.txt" &
PS=$!

BSTART=$(python3 -c 'import time;print(int(time.time()*1000))')
# Teto duro do cenario: 305s (teto declarado) + 60s de margem = 365s. Passou disso, B nao terminou.
BKILLED=0
for k in $(seq 1 3700); do
  if ! kill -0 $PB 2>/dev/null; then break; fi
  sleep 0.1
  now=$(python3 -c 'import time;print(int(time.time()*1000))')
  if [ $((now-BSTART)) -gt 380000 ]; then BKILLED=1; kill -9 $PB 2>/dev/null || true; break; fi
done
wait $PB 2>/dev/null || true
BEND=$(python3 -c 'import time;print(int(time.time()*1000))')
echo "B_killed=$BKILLED" | tee "$OUT/B-killed.txt"
kill $PS 2>/dev/null || true
echo "B_wall_ms=$((BEND-BSTART))" | tee "$OUT/B-wall.txt"
cat "$OUT/B.out" | grep __V658__ | sed 's/__V658__//' || echo "B sem saida"
kill -9 $PA 2>/dev/null || true; wait $PA 2>/dev/null || true
grep -h __V658__ "$OUT/A.out" | sed 's/__V658__//' || true
