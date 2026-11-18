#!/bin/zsh
# WP-P2-UIX-046 evidence stack:
#   API 3101 / changed Web 3100 / before Web 3102
# Ports 3000/3001 are left to the unrelated local stack.
#
# The database must already exist and be migrated/seeded:
#   DB=solvi_wp046_evidence_test
#   DATABASE_URL=${DATABASE_URL%/solvi}/$DB DATABASE_ADMIN_URL=${DATABASE_ADMIN_URL%/solvi}/$DB \
#     node tools/migrate.mjs up
#   DATABASE_URL=${DATABASE_URL%/solvi}/$DB NODE_ENV=development npx tsx tools/seed.mjs
#   DATABASE_ADMIN_URL=${DATABASE_ADMIN_URL%/solvi}/$DB node setup_fixture.run.mjs .
#
# WEB_AFTER_DIR / WEB_BEFORE_DIR must point at production builds of this working
# tree and of HEAD (UIX-045). Copy the repository to a temporary directory and
# remove `output: 'standalone'` from next.config.mjs before building.
set -e
cd /Users/jp.infra/Dev/SOLVI
set -a; . ./.env; set +a
DB=solvi_wp046_evidence_test
export DATABASE_URL=${DATABASE_URL%/solvi}/$DB
export DATABASE_ADMIN_URL=${DATABASE_ADMIN_URL%/solvi}/$DB
export OTEL_EXPORTER_OTLP_ENDPOINT=''
export S3_ENDPOINT=http://127.0.0.1:${S3_PORT:-9100}
export S3_PUBLIC_ENDPOINT=$S3_ENDPOINT
: "${WEB_AFTER_DIR:?set WEB_AFTER_DIR to a built apps/web directory}"
: "${WEB_BEFORE_DIR:?set WEB_BEFORE_DIR to a built HEAD apps/web directory}"

API_PORT=3101 NODE_ENV=development node node_modules/tsx/dist/cli.mjs services/api/src/main.ts &
API=$!

cd "$WEB_AFTER_DIR"
NODE_ENV=production PORT=3100 API_BASE_URL=http://127.0.0.1:3101 WEB_BASE_URL=http://127.0.0.1:3100 \
  node /Users/jp.infra/Dev/SOLVI/node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3100 &
WEB_AFTER=$!

cd "$WEB_BEFORE_DIR"
NODE_ENV=production PORT=3102 API_BASE_URL=http://127.0.0.1:3101 WEB_BASE_URL=http://127.0.0.1:3102 \
  node /Users/jp.infra/Dev/SOLVI/node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3102 &
WEB_BEFORE=$!

trap "kill $API $WEB_AFTER $WEB_BEFORE 2>/dev/null" EXIT INT TERM
wait
