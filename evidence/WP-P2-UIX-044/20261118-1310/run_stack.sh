#!/bin/zsh
# WP-P2-UIX-044 evidence: API (dev, local auth) + Web (production build) against the throwaway DB.
# Ports 3100/3101 are used so an unrelated local stack on 3000/3001 is left untouched.
#
# Web: WEB_DIR must point at a built apps/web. If another local stack shares the
# repository's .next directory, copy the repository to a temporary directory and
# set WEB_DIR to its apps/web (the build must not run while that stack is serving).
set -e
cd /Users/jp.infra/Dev/SOLVI
set -a; . ./.env; set +a
DB=solvi_wp044_evidence_test
export DATABASE_URL=${DATABASE_URL%/solvi}/$DB
export DATABASE_ADMIN_URL=${DATABASE_ADMIN_URL%/solvi}/$DB
export OTEL_EXPORTER_OTLP_ENDPOINT=''
export S3_ENDPOINT=http://127.0.0.1:${S3_PORT:-9100}
export S3_PUBLIC_ENDPOINT=$S3_ENDPOINT
API_PORT=3101 NODE_ENV=development node node_modules/tsx/dist/cli.mjs services/api/src/main.ts &
API=$!
WEB_DIR=${WEB_DIR:-/Users/jp.infra/Dev/SOLVI/apps/web}
cd "$WEB_DIR"
NODE_ENV=production PORT=3100 API_BASE_URL=http://127.0.0.1:3101 WEB_BASE_URL=http://127.0.0.1:3100 \
  node ../../node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3100 &
WEB=$!
trap "kill $API $WEB 2>/dev/null" EXIT INT TERM
wait
