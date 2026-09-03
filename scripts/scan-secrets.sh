#!/usr/bin/env bash
#
# Fail if the tracked tree contains anything shaped like a credential.
#
#   scripts/scan-secrets.sh              # scan every tracked file
#   scripts/scan-secrets.sh --self-test  # prove each pattern still fires
#
# Only tracked files are scanned, because only tracked files can be pushed.
# `.env` is in .gitignore, but .gitignore is a request, not a gate: `git add -f`
# and a fresh clone with a stale ignore file both get past it, so the tracked
# set is checked directly.
#
# The allowlist below is EMPTY and is meant to stay that way. Every pattern is
# written so that its own text does not match it — the prefix is always followed
# by a character class, never by a value — which is why this file needs no
# exemption from its own scan. If a fixture ever needs a fake token, give it a
# shape no issuer produces (`slr_live_x`, `pt_token=x`) rather than an entry
# here.

set -euo pipefail

cd "$(dirname "$0")/.."

# Paths exempt from the scan. Deliberately empty — see the header.
ALLOWLIST=()

# name|regex, in ERE. Order is cosmetic; every pattern always runs.
PATTERN_NAMES=(
  "Solari live API key"
  "Solari port-preview token"
  "JWT (>= 60 chars, two dots)"
  "Slack bot/user token"
  "Slack app-level token"
  "Telegram bot token"
  "Discord bot token"
)
PATTERN_REGEXES=(
  'slr_live_[A-Za-z0-9]{12,}'
  'pt_token=[A-Za-z0-9._-]{16,}'
  'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{20,}'
  'xox[bp]-[A-Za-z0-9-]{10,}'
  'xapp-[A-Za-z0-9-]{10,}'
  '[0-9]{8,}:[A-Za-z0-9_-]{30,}'
  '[MN][A-Za-z0-9]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}'
)

# Tracked files named `.env` or `.env.<something>`. `.env.example` is the one
# name that is meant to be committed, and it holds names without values.
ENV_FILE_REGEX='(^|/)\.env($|\.)'
ENV_FILE_ALLOWED='(^|/)\.env\.(example|sample|template)$'

self_test() {
  # Samples are assembled at run time from two halves, so this file never
  # itself contains a string matching its own patterns. That is what keeps the
  # allowlist empty. A gate nobody has watched fire is a gate nobody has tested.
  local blob="AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
  local positives=(
    "slr_live_${blob}"
    "https://x-3000.preview.getsolari.com/?pt_token=${blob}.${blob}"
    "eyJ${blob}.${blob}.${blob}"
    "xoxb-${blob}"
    "xapp-${blob}"
    "12345678:${blob}"
    "M${blob}.${blob:0:6}.${blob}"
  )
  # Shapes that already live in this repo and must never trip the scan.
  local negatives=(
    'url: "https://relay.example/?pt_token=x"'
    'says `Present it as ?pt_token=<token>`'
    '`https://example.preview.getsolari.com/?pt_token=${"x".repeat(240)}`'
    'sha256: 3b1f2c9d4e5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e'
  )

  local failed=0 i name regex sample
  for i in "${!PATTERN_REGEXES[@]}"; do
    name="${PATTERN_NAMES[$i]}"
    regex="${PATTERN_REGEXES[$i]}"
    sample="${positives[$i]}"
    if ! printf '%s\n' "$sample" | grep -qE -- "$regex"; then
      printf 'self-test: pattern "%s" no longer matches its own sample\n' "$name" >&2
      failed=1
    fi
    for negative in "${negatives[@]}"; do
      if printf '%s\n' "$negative" | grep -qE -- "$regex"; then
        printf 'self-test: pattern "%s" matches a known-good line: %s\n' "$name" "$negative" >&2
        failed=1
      fi
    done
  done

  if [ "$failed" -ne 0 ]; then
    printf 'self-test FAILED — the secret scan is not doing what it claims.\n' >&2
    exit 1
  fi
  printf 'self-test: %d patterns fire on a live sample and stay quiet on %d known-good lines.\n' \
    "${#PATTERN_REGEXES[@]}" "${#negatives[@]}"
}

scan() {
  local pathspecs=(":(top)")
  local path
  for path in ${ALLOWLIST+"${ALLOWLIST[@]}"}; do
    pathspecs+=(":(top,exclude)${path}")
  done

  local failed=0 i name regex matches
  for i in "${!PATTERN_REGEXES[@]}"; do
    name="${PATTERN_NAMES[$i]}"
    regex="${PATTERN_REGEXES[$i]}"
    matches="$(git grep -nIE -e "$regex" -- "${pathspecs[@]}" || true)"
    if [ -n "$matches" ]; then
      printf '\ncredential shape found — %s:\n%s\n' "$name" "$matches" >&2
      failed=1
    fi
  done

  local env_files
  env_files="$(git ls-files | grep -E "$ENV_FILE_REGEX" | grep -vE "$ENV_FILE_ALLOWED" || true)"
  if [ -n "$env_files" ]; then
    printf '\nenv file is tracked — it must not be:\n%s\n' "$env_files" >&2
    failed=1
  fi

  if [ "$failed" -ne 0 ]; then
    printf '\nsecret scan FAILED. Remove the value, rotate the credential, then rewrite the history that carried it.\n' >&2
    exit 1
  fi
  printf 'secret scan: %d tracked files clean against %d credential shapes.\n' \
    "$(git ls-files | wc -l | tr -d ' ')" "${#PATTERN_REGEXES[@]}"
}

case "${1-}" in
  --self-test) self_test ;;
  "") scan ;;
  *)
    printf 'usage: %s [--self-test]\n' "$0" >&2
    exit 2
    ;;
esac
