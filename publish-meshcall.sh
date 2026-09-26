#!/usr/bin/env bash

# MeshCall - GitHub + GitHub Pages publishing script
# Run this script from the root of the Vite project generated for MeshCall.
#
# Prerequisites:
#   git, gh (GitHub CLI), node, npm
#
# First-time GitHub setup (one time only):
#   gh auth login
#
# Usage:
#   chmod +x publish-meshcall.sh
#   ./publish-meshcall.sh

set -Eeuo pipefail

REPO_NAME="meshcall"
DEFAULT_BRANCH="main"
BASE_PATH="/${REPO_NAME}/"
DESCRIPTION="WebRTC mesh VoIP calling application built with Vite and TypeScript"
WORKFLOW_FILE=".github/workflows/deploy-pages.yml"

log()  { printf '\033[1;36m[MeshCall]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

cleanup() {
  rm -f "${WORKFLOW_FILE}.tmp"
}
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command '$1' was not found."
}

log "Checking prerequisites..."
require_command git
require_command gh
require_command node
require_command npm

[[ -f package.json ]] || die "package.json was not found. Run this from the Vite project root."
[[ -f index.html ]] || warn "index.html was not found. Continue only if your Vite project intentionally uses a different root."

if ! gh auth status >/dev/null 2>&1; then
  die "GitHub CLI is not authenticated. Run 'gh auth login' once, then run this script again."
fi

OWNER="$(gh api user -q '.login')"
REPO_FULL="${OWNER}/${REPO_NAME}"
REPO_URL="https://github.com/${REPO_FULL}.git"

log "GitHub account: ${OWNER}"
log "Repository: ${REPO_FULL}"
log "GitHub Pages base path: ${BASE_PATH}"

# -----------------------------------------------------------------------------
# Git initialization
# -----------------------------------------------------------------------------
if [[ ! -d .git ]]; then
  log "Initializing Git repository..."
  git init
else
  ok "Git repository already initialized."
fi

git branch -M "${DEFAULT_BRANCH}"

# -----------------------------------------------------------------------------
# GitHub Pages workflow
# Vite's nested repository deployment requires /meshcall/ as the public base.
# The build command also passes --base explicitly so the script works even if
# vite.config.ts does not yet contain a base option.
# -----------------------------------------------------------------------------
log "Creating/updating GitHub Pages workflow..."
mkdir -p "$(dirname "$WORKFLOW_FILE")"

cat > "${WORKFLOW_FILE}.tmp" <<'YAML'
name: Deploy MeshCall to GitHub Pages

on:
  push:
    branches:
      - main
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: github-pages
  cancel-in-progress: true

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v7

      - name: Setup Node.js
        uses: actions/setup-node@v7
        with:
          node-version: lts/*
          cache: npm

      - name: Install dependencies
        shell: bash
        run: |
          if [[ -f package-lock.json ]]; then
            npm ci
          else
            npm install
          fi

      - name: Build Vite application for GitHub Pages
        run: npm run build -- --base=/meshcall/

      - name: Ensure SPA fallback exists
        shell: bash
        run: |
          if [[ -f dist/index.html && ! -f dist/404.html ]]; then
            cp dist/index.html dist/404.html
          fi

      - name: Configure GitHub Pages
        uses: actions/configure-pages@v6

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v5
        with:
          path: ./dist

      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v5
YAML

mv "${WORKFLOW_FILE}.tmp" "$WORKFLOW_FILE"
ok "GitHub Pages workflow created at ${WORKFLOW_FILE}"

# -----------------------------------------------------------------------------
# Make sure the Vite project ignores generated files and local env files.
# Do not overwrite an existing .gitignore; append only missing entries.
# -----------------------------------------------------------------------------
if [[ ! -f .gitignore ]]; then
  cat > .gitignore <<'EOF_GITIGNORE'
node_modules/
dist/
.env
.env.local
.env.*.local
.DS_Store
*.log
EOF_GITIGNORE
  ok "Created .gitignore"
else
  touch .gitignore
  for entry in "node_modules/" "dist/" ".env" ".env.local" ".env.*.local"; do
    grep -Fqx "$entry" .gitignore 2>/dev/null || printf '%s\n' "$entry" >> .gitignore
  done
fi

# -----------------------------------------------------------------------------
# Initial commit / local changes
# -----------------------------------------------------------------------------
log "Staging project files..."
git add -A

if git diff --cached --quiet; then
  warn "No new local changes to commit."
else
  git commit -m "chore: publish MeshCall to GitHub Pages"
  ok "Local commit created."
fi

# -----------------------------------------------------------------------------
# Create GitHub repository if it does not exist.
# gh repo create supports creating a remote repository from an existing local
# repository and pushing the current branch.
# -----------------------------------------------------------------------------
if gh repo view "$REPO_FULL" >/dev/null 2>&1; then
  ok "GitHub repository already exists: ${REPO_FULL}"
else
  log "Creating public GitHub repository '${REPO_NAME}'..."
  gh repo create "$REPO_NAME" \
    --public \
    --source=. \
    --remote=origin \
    --description "$DESCRIPTION"
  ok "GitHub repository created."
fi

# -----------------------------------------------------------------------------
# Configure origin safely
# -----------------------------------------------------------------------------
if git remote get-url origin >/dev/null 2>&1; then
  CURRENT_ORIGIN="$(git remote get-url origin)"
  if [[ "$CURRENT_ORIGIN" != "$REPO_URL" && "$CURRENT_ORIGIN" != "git@github.com:${REPO_FULL}.git" ]]; then
    warn "Current origin is: $CURRENT_ORIGIN"
    die "Origin points to a different repository. Refusing to replace it automatically."
  fi
else
  git remote add origin "$REPO_URL"
  ok "Added origin: ${REPO_URL}"
fi

# -----------------------------------------------------------------------------
# Verify remote history is compatible before pushing.
# -----------------------------------------------------------------------------
git fetch origin "$DEFAULT_BRANCH" >/dev/null 2>&1 || true

if git rev-parse --verify "origin/${DEFAULT_BRANCH}" >/dev/null 2>&1; then
  if ! git merge-base --is-ancestor "origin/${DEFAULT_BRANCH}" HEAD; then
    die "The remote '${REPO_FULL}' already has commits that are not ancestors of this local branch.\nPull/reconcile the remote history manually, then run this script again."
  fi
fi

log "Pushing ${DEFAULT_BRANCH} to GitHub..."
git push -u origin "$DEFAULT_BRANCH"
ok "Code pushed to GitHub."

# -----------------------------------------------------------------------------
# Enable GitHub Pages with a GitHub Actions publishing source.
# -----------------------------------------------------------------------------
log "Configuring GitHub Pages to use GitHub Actions..."

PAGES_BODY=$(cat <<JSON
{
  "build_type": "workflow",
  "source": {
    "branch": "${DEFAULT_BRANCH}",
    "path": "/"
  }
}
JSON
)

if gh api "repos/${REPO_FULL}/pages" >/dev/null 2>&1; then
  gh api --method PUT "repos/${REPO_FULL}/pages" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    --input - <<<"$PAGES_BODY" >/dev/null
  ok "Existing GitHub Pages configuration updated."
else
  gh api --method POST "repos/${REPO_FULL}/pages" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    --input - <<<"$PAGES_BODY" >/dev/null
  ok "GitHub Pages enabled with GitHub Actions."
fi

# -----------------------------------------------------------------------------
# Trigger the workflow explicitly after Pages is configured.
# -----------------------------------------------------------------------------
log "Triggering Pages deployment workflow..."
gh workflow run "${WORKFLOW_FILE}" --ref "$DEFAULT_BRANCH" >/dev/null 2>&1 || true

sleep 2

RUN_ID="$(gh run list --repo "$REPO_FULL" --workflow "$WORKFLOW_FILE" --branch "$DEFAULT_BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId // empty')"

if [[ -n "$RUN_ID" ]]; then
  log "Watching GitHub Pages deployment #${RUN_ID}..."
  if gh run watch "$RUN_ID" --repo "$REPO_FULL" --exit-status; then
    ok "GitHub Pages deployment completed successfully."
  else
    warn "The Pages workflow did not finish successfully. Open the Actions run for details."
  fi
else
  warn "Could not find the deployment workflow yet. It should start from the push to main."
fi

# -----------------------------------------------------------------------------
# Print final URLs
# -----------------------------------------------------------------------------
PAGES_URL="$(gh api "repos/${REPO_FULL}/pages" -q '.html_url' 2>/dev/null || true)"

printf '\n'
ok "MeshCall publishing finished."
printf '  Repository : %s\n' "https://github.com/${REPO_FULL}"
if [[ -n "$PAGES_URL" ]]; then
  printf '  Pages      : %s\n' "$PAGES_URL"
else
  printf '  Pages      : %s\n' "https://${OWNER}.github.io/${REPO_NAME}/"
fi
printf '\n'
printf '%s\n' "Future deployment: commit/push to main and GitHub Actions will rebuild and publish automatically."
printf '%s\n' "Important: make sure your Vite app uses /meshcall/ as its public base (the workflow also builds with --base=/meshcall/)."
