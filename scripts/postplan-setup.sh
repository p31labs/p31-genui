#!/usr/bin/env bash
# Postplan self-hosting preparation for P31.
#
# Postplan = self-hosted artifact review on Cloudflare (Workers + D1 + R2 + KV).
# It serves HTML byte-for-byte and collects browser comments via a CLI.
#
# This script PREPARES only. It does NOT:
#   - create Cloudflare resources (D1/KV/R2)
#   - apply D1 migrations
#   - deploy workers
#   - set worker secrets
# Those steps require owner approval and are documented in:
#   docs/POSTPLAN_SELF_HOSTING.md
#
# Usage:
#   packages/genui/scripts/postplan-setup.sh [--repo PATH] [--no-install] [--render]
#
#   --repo PATH   Override clone location (default: $HOME/postplan, or $POSTPLAN_REPO)
#   --no-install  Skip `bun install`
#   --render      Run upstream apply-config.sh IF deploy.env is fully filled in
#                 (renders wrangler configs; still does not deploy)
#   --help        Show this help

set -euo pipefail

POSTPLAN_UPSTREAM="${POSTPLAN_UPSTREAM:-https://github.com/headout/postplan.git}"
POSTPLAN_REPO="${POSTPLAN_REPO:-${HOME}/postplan}"
DO_INSTALL=1
DO_RENDER=0

usage() {
  sed -n '1,40p' "$0" | grep '^#' | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) POSTPLAN_REPO="$2"; shift 2 ;;
    --no-install) DO_INSTALL=0; shift ;;
    --render) DO_RENDER=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }
warn() { printf '   [warn] %s\n' "$*" >&2; }
ok() { printf '   [ok]   %s\n' "$*"; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    return 1
  fi
}

# --- 1. Prerequisites ---------------------------------------------------------
log "Checking prerequisites"

require_cmd git || { echo "install git first"; exit 1; }
ok "git $(git --version | awk '{print $3}')"

if ! require_cmd bun; then
  echo "bun is required (https://bun.sh). Install: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi
ok "bun $(bun --version)"

if ! require_cmd wrangler; then
  echo "wrangler not found. Install via: bun add -g wrangler   (or npm i -g wrangler)" >&2
  exit 1
fi
WRANGLER_VERSION="$(wrangler --version 2>&1 | head -1)"
ok "wrangler ${WRANGLER_VERSION}"

log "Checking Cloudflare authentication (wrangler whoami)"
if ! wrangler whoami >/dev/null 2>&1; then
  warn "wrangler is not authenticated."
  echo "   Run:  wrangler login" >&2
  echo "   Then re-run this script." >&2
  exit 1
fi
ok "wrangler authenticated (see 'wrangler whoami' for account details)"

# --- 2. Postplan repo ---------------------------------------------------------
log "Locating Postplan repo"
if [[ ! -d "${POSTPLAN_REPO}/.git" ]]; then
  log "Cloning ${POSTPLAN_UPSTREAM} -> ${POSTPLAN_REPO}"
  git clone "${POSTPLAN_UPSTREAM}" "${POSTPLAN_REPO}"
  ok "cloned"
else
  ok "repo present at ${POSTPLAN_REPO}"
  # Best-effort fast-forward; never overwrite local changes.
  if git -C "${POSTPLAN_REPO}" diff --quiet && git -C "${POSTPLAN_REPO}" diff --cached --quiet; then
    git -C "${POSTPLAN_REPO}" fetch --quiet origin 2>/dev/null || true
    git -C "${POSTPLAN_REPO}" pull --ff-only --quiet 2>/dev/null || warn "could not fast-forward; leaving as-is"
  else
    warn "local changes detected in repo; skipping pull"
  fi
fi

POSTPLAN_HEAD="$(git -C "${POSTPLAN_REPO}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
ok "postplan @ ${POSTPLAN_HEAD}"

# --- 3. Dependencies ---------------------------------------------------------
if [[ "${DO_INSTALL}" -eq 1 ]]; then
  log "Installing Postplan dependencies (bun install)"
  (cd "${POSTPLAN_REPO}" && bun install)
  ok "dependencies installed"
else
  ok "skipping bun install (--no-install)"
fi

# --- 4. deploy.env template ---------------------------------------------------
log "Ensuring deploy.env template"
if [[ ! -f "${POSTPLAN_REPO}/deploy.env" ]]; then
  if [[ -f "${POSTPLAN_REPO}/deploy.example.env" ]]; then
    cp "${POSTPLAN_REPO}/deploy.example.env" "${POSTPLAN_REPO}/deploy.env"
    ok "created ${POSTPLAN_REPO}/deploy.env from example (FILL IN BEFORE DEPLOYING)"
  else
    warn "deploy.example.env missing; cannot create template"
  fi
else
  ok "deploy.env already present (not overwriting)"
fi

# --- 5. Optional config render (no deploy) -----------------------------------
if [[ "${DO_RENDER}" -eq 1 ]]; then
  log "Rendering instance config (apply-config.sh) — no deploy"
  if [[ ! -s "${POSTPLAN_REPO}/deploy.env" ]]; then
    echo "deploy.env is empty; fill it in first." >&2
    exit 1
  fi
  # shellcheck disable=SC1091
  (cd "${POSTPLAN_REPO}" && bash scripts/apply-config.sh)
  ok "configs rendered (wrangler.jsonc, wrangler.content.jsonc, _headers)"
else
  ok "skipping config render (pass --render once deploy.env is filled)"
fi

# --- 6. Summary / next steps --------------------------------------------------
log "Preparation complete — NO Cloudflare resources created, NO deploy performed"
cat <<EOF

Postplan repo:   ${POSTPLAN_REPO}
Postplan commit: ${POSTPLAN_HEAD}

Next steps (require owner approval before running):
  1. Enable R2 on the Cloudflare account (dashboard -> R2 -> accept terms; free tier).
  2. Create the three Cloudflare resources (owner approval):
       bunx wrangler d1 create postplan-db
       bunx wrangler kv namespace create POSTPLAN_SESSIONS
       bunx wrangler r2 bucket create postplan-files
  3. Fill ${POSTPLAN_REPO}/deploy.env with:
       - CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
       - SUPERADMIN_EMAILS, ORG_EMAIL_DOMAINS
       - APP_URL, CONTENT_URL  (two SEPARATE HTTPS origins)
       - WORKER_NAME, CONTENT_WORKER_NAME, D1_DATABASE_NAME
       - WORKERS_SUBDOMAIN, D1_DATABASE_ID, KV_NAMESPACE_ID, R2_BUCKET
       - SESSION_SECRET, CONTENT_TOKEN_SECRET, BOOTSTRAP_TOKEN
         (generate: openssl rand -hex 32)
  4. Render configs:
       cd ${POSTPLAN_REPO} && bash scripts/apply-config.sh
     or: $0 --repo ${POSTPLAN_REPO} --render
  5. (Optional) WorkOS: fill WORKOS_* then run scripts/wire-workos.sh
  6. Deploy (owner approval required):
       cd ${POSTPLAN_REPO} && bun run db:migrate:local   # local only
       cd ${POSTPLAN_REPO} && scripts/setup.sh            # migrates + deploys + secrets
  7. First admin: open \$APP_URL/login and submit BOOTSTRAP_TOKEN.

CLI for this self-hosted instance:
  curl -fsSL \$APP_URL/api/install | sh
  # or: POSTPLAN_API_URL=\$APP_URL npx @notsuhas/postplan login

Note: @meetkiara/postplan (npx) is the hosted Kiara client and is NOT this self-host.
      For P31 self-hosting use @notsuhas/postplan against your own APP_URL.

Docs: docs/POSTPLAN_SELF_HOSTING.md
EOF