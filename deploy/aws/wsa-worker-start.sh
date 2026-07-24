#!/bin/bash
set -euo pipefail

worker="${1:-}"
if [[ "$worker" != "copy" && "$worker" != "risk" && "$worker" != "jobs" ]]; then
  echo "Usage: wsa-worker-start.sh copy|risk|jobs" >&2
  exit 2
fi

export AWS_REGION="${AWS_REGION:-eu-west-2}"
export AWS_DEFAULT_REGION="$AWS_REGION"

read_parameter() {
  aws ssm get-parameter \
    --name "$1" \
    --with-decryption \
    --query Parameter.Value \
    --output text
}

export NEXT_PUBLIC_SUPABASE_URL="$(read_parameter /wsa/test/NEXT_PUBLIC_SUPABASE_URL)"
export SUPABASE_SERVICE_ROLE_KEY="$(read_parameter /wsa/test/SUPABASE_SERVICE_ROLE_KEY)"
export METAAPI_TOKEN="$(read_parameter /wsa/test/METAAPI_TOKEN)"
export ENCRYPTION_KEY="$(read_parameter /wsa/test/ENCRYPTION_KEY)"

export NODE_ENV=production
export BROKER_PROVIDER=metaapi
export BROKER_EXECUTION_ENABLED=true
export WSA_COPY_ENGINE_ENABLED=true
export WSA_COPY_POLL_MS=1000
export WSA_RISK_ENGINE_ENABLED=true
export WSA_RISK_RECONCILE_MS=5000
export WSA_RISK_SNAPSHOT_MS=30000
export WSA_BACKGROUND_WORKER_ENABLED=true
export WSA_BACKGROUND_ACCOUNT_SYNC_ENABLED=false
export WSA_JOB_POLL_MS=2000
export WSA_ACCOUNT_SYNC_INTERVAL_MS=300000
export WSA_EVALUATION_INTERVAL_MS=300000

case "$worker" in
  copy) exec npm run copy:worker ;;
  risk) exec npm run risk:worker ;;
  jobs) exec npm run jobs:worker ;;
esac
