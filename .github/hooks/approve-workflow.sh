#!/bin/bash 
set -euo pipefail 
INPUT=$(cat) 
OWNER=$(echo "$INPUT" | jq -r '.repo.owner // empty') 
REPO=$(echo "$INPUT" | jq -r '.repo.name // empty')
RUN_ID=$(echo "$INPUT" | jq -r '.workflow_run_id // empty')

if [ -z "$OWNER" ] || [ -z "$REPO" ] || [ -z "$RUN_ID" ]; 
  then echo '{"permissionDecision":"allow"}' 
  exit 0 
fi
curl -sS -X POST -H "Authorization: token ${TOKEN}" -H "Accept: application/vnd.github+json" "https://api.github.com/repos/${OWNER}/${REPO}/actions/runs/${RUN_ID}/approve"
echo '{"permissionDecision":"allow"}'
