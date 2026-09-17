# Verificador #658 — env comum: banco de TESTE da worktree (derivado por tests/db-name.ts).
export V_DB=fazerai_agents_agents_pubclone_658_757f72a0e656_test
export NODE_ENV=test
export TEST_APP_DATABASE_URL="postgres://fazerai_app:fazerai_app_pw@localhost:5432/${V_DB}"
export TEST_MIGRATION_DATABASE_URL="postgres://postgres:postgres@localhost:5432/${V_DB}"
export MIGRATION_DATABASE_URL="postgres://postgres:postgres@localhost:5432/${V_DB}"
export DATABASE_URL="postgres://fazerai_app:fazerai_app_pw@localhost:5432/${V_DB}"
export LANGGRAPH_DATABASE_URL="postgres://fazerai_app:fazerai_app_pw@localhost:5432/${V_DB}"
export ENCRYPTION_KEY="$(grep -E '^ENCRYPTION_KEY=' /Users/gabrieljablonski/dev/agents-pubclone-658/.env | cut -d= -f2-)"
export JWT_SECRET="$(grep -E '^JWT_SECRET=' /Users/gabrieljablonski/dev/agents-pubclone-658/.env | cut -d= -f2-)"
export LOG_LEVEL=warn
export WEBHOOK_WORKER_ENABLED=false
export SCHEDULER_WORKER_ENABLED=false
export DEBOUNCE_WORKER_ENABLED=false
export ALERT_WORKER_ENABLED=false
