---
summary: "Safely configure and verify HubSpot private app tokens without exposing secrets."
read_when:
  - "Adding, rotating, or testing HubSpot credentials."
title: "HubSpot Credential Verification"
---

# HubSpot Credential Verification SOP

Use this SOP when adding, rotating, or troubleshooting HubSpot credentials in `.env.local`.
The goal is to prove that the expected environment variable loads and that HubSpot accepts the token,
without printing the token or CRM data.

## Rules

- Never print HubSpot token values, token prefixes, full response bodies, or CRM records in logs.
- Never commit `.env.local`, `.env`, `secrets/*.json`, or copied token material.
- Do not include `Bearer ` in `.env.local`; repo scripts add the Bearer header.
- Prefer `HUBSPOT_PRIVATE_TOKEN` for new HubSpot private app tokens.
- Use `HUBSPOT_ACCESS_TOKEN` only for existing scripts that explicitly require it.
- Avoid `HUBSPOT_API_KEY` for new private app tokens. Treat it as an integration-specific alias
  that must be tested before use.

## Env Var Conventions

Recommended `.env.local` entry:

```sh
HUBSPOT_PRIVATE_TOKEN='pat-...'
```

Existing scripts are not fully standardized. Before running a HubSpot script,
check which variable it expects:

```sh
rg -n "HUBSPOT_(PRIVATE_TOKEN|ACCESS_TOKEN|API_KEY)|--hubspot-key-env" scripts
```

If a script supports `--hubspot-key-env`, prefer passing the variable name explicitly:

```sh
python3 scripts/example.py --hubspot-key-env HUBSPOT_PRIVATE_TOKEN --dry-run
```

If a script requires `HUBSPOT_ACCESS_TOKEN`, map the token for that command only:

```sh
HUBSPOT_ACCESS_TOKEN="$HUBSPOT_PRIVATE_TOKEN" node scripts/example.js --dry-run
```

## Safe Authentication Test

Run this from the repo root. It reads `.env.local`, suppresses the HubSpot response body,
and prints only the HTTP status interpretation.

```sh
HUBSPOT_TOKEN_ENV=HUBSPOT_PRIVATE_TOKEN \
HUBSPOT_TEST_PATH="/crm/v3/objects/contacts?limit=1" \
bash -lc '
set -euo pipefail

if [[ ! -f .env.local ]]; then
  echo ".env.local missing"
  exit 2
fi

set -a
source .env.local
set +a

token_name="${HUBSPOT_TOKEN_ENV:-HUBSPOT_PRIVATE_TOKEN}"
token="${!token_name:-}"
test_path="${HUBSPOT_TEST_PATH:-/crm/v3/objects/contacts?limit=1}"

if [[ -z "$token" ]]; then
  echo "$token_name: missing or empty"
  exit 2
fi

body_file="$(mktemp)"
trap "rm -f \"$body_file\"" EXIT

http_status="$(curl -sS -o "$body_file" -w "%{http_code}" \
  -H "Authorization: Bearer ${token}" \
  -H "Accept: application/json" \
  "https://api.hubapi.com${test_path}")"

case "$http_status" in
  200)
    echo "$token_name: authenticated and authorized for ${test_path} (HTTP 200)"
    ;;
  401)
    echo "$token_name: rejected by HubSpot (HTTP 401 unauthorized)"
    ;;
  403)
    echo "$token_name: authenticated but missing permission for ${test_path} (HTTP 403)"
    ;;
  404)
    echo "$token_name: endpoint not found or unsupported test path (HTTP 404)"
    ;;
  429)
    echo "$token_name: rate limited by HubSpot (HTTP 429); retry later"
    ;;
  *)
    echo "$token_name: unexpected HTTP ${http_status} from ${test_path}"
    ;;
esac
'
```

To test another variable, rerun the same command and change the first line:

```sh
HUBSPOT_TOKEN_ENV=HUBSPOT_API_KEY \
```

## Result Interpretation

- `HTTP 200`: the token is valid and has permission for the tested endpoint.
- `HTTP 403`: the token reached HubSpot, but the private app is missing the tested scope.
  Add the correct scope or test an endpoint covered by the token.
- `HTTP 401`: the value is not accepted as a HubSpot Bearer token. Check that the correct
  env var is loaded, the token was copied completely, the token has not been revoked,
  and the value is not a legacy API key or unrelated credential.
- `HTTP 404`: the path is wrong for the HubSpot API version being tested.
- `HTTP 429`: retry after the rate-limit window.

Owners endpoints can return `HTTP 403` for otherwise valid tokens if the private app does not
have the required owner/account permission. For workflow-specific confidence, test the lowest-risk
endpoint that matches the script's real scope, then run the script in dry-run mode if it supports one.

## Troubleshooting

1. Confirm `.env.local` is present in the worktree where the command runs.
2. Confirm the target script's expected env var name.
3. Run the safe authentication test with that exact env var.
4. If `HUBSPOT_API_KEY` returns `HTTP 401`, replace it with a current HubSpot private app token
   or switch the script to the env var that already contains the valid private app token.
5. If a token returns `HTTP 403`, update HubSpot private app scopes or choose a test endpoint
   covered by the current scopes.
6. Rerun the target workflow with `--dry-run`, `--max-*`, or another bounded option before allowing writes.

## Evidence To Record

Record only non-secret evidence in task logs and PRs:

- Env var name tested.
- Endpoint path tested.
- HTTP status and interpretation.
- Whether the run was dry-run or write-enabled.
- Follow-up action, such as "rotated token" or "added contacts read scope."

Do not record token length, token prefix, token suffix, response bodies, contact names,
company names, email addresses, or HubSpot object IDs unless the task explicitly requires
CRM-object evidence and the destination is approved for that data.
