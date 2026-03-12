#!/bin/bash
set -euo pipefail

OWNER="pitermarx"
REPO="Virgulas"

# Find all open PRs authored by Copilot
PR_SHAS=$(curl -sS \
  -H "Authorization: token ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${OWNER}/${REPO}/pulls?state=open&per_page=100" \
  | jq -r '.[] | select(.user.login == "Copilot") | .head.sha')

if [ -z "$PR_SHAS" ]; then
  echo "No open Copilot PRs found."
  echo '{"permissionDecision":"allow"}'
  exit 0
fi

while IFS= read -r SHA; do
  while IFS= read -r RUN_ID; do
    echo "Approving workflow run $RUN_ID for SHA $SHA"
    curl -sS -X POST \
      -H "Authorization: token ${TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/${OWNER}/${REPO}/actions/runs/${RUN_ID}/approve"
  done < <(curl -sS \
    -H "Authorization: token ${TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${OWNER}/${REPO}/actions/runs?event=pull_request&head_sha=${SHA}&status=action_required" \
    | jq -r '.workflow_runs[].id')
done <<< "$PR_SHAS"

echo '{"permissionDecision":"allow"}'
