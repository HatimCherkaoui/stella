#!/usr/bin/env bash
# release.sh — Bump version, build, commit, tag, push, and create a GitHub release.
# Usage:  ./release.sh [patch|minor|major]  (default: patch)

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}▶${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
error() { echo -e "${RED}✗${NC} $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BUMP="${1:-patch}"
[[ "$BUMP" =~ ^(patch|minor|major)$ ]] || error "Usage: $0 [patch|minor|major]"

# ── Require clean working tree ────────────────────────────────────────────────
info "Checking git status…"
[[ -z "$(git status --porcelain)" ]] || error "Working tree not clean. Commit or stash changes first."
git fetch --quiet origin
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[[ "$BRANCH" == "main" ]] || warn "Not on main — releasing from branch: $BRANCH"
ok "Working tree clean"

# ── Read current version ──────────────────────────────────────────────────────
CURRENT=$(node -e "process.stdout.write(require('./manifest.json').version)")
info "Current version: ${CURRENT}"

# ── Semver bump ───────────────────────────────────────────────────────────────
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
case "$BUMP" in
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    patch) PATCH=$((PATCH + 1)) ;;
esac
NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
info "New version: ${NEW_VERSION}"

# ── Confirm ───────────────────────────────────────────────────────────────────
read -r -p "$(echo -e "${YELLOW}Release${NC} Stella v${NEW_VERSION}? [y/N] ")" CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || { warn "Aborted."; exit 0; }

# ── Update manifest.json ──────────────────────────────────────────────────────
info "Updating manifest.json → ${NEW_VERSION}…"
node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
m.version = '${NEW_VERSION}';
fs.writeFileSync('manifest.json', JSON.stringify(m, null, 2) + '\n');
"
ok "manifest.json updated"

# ── Build ─────────────────────────────────────────────────────────────────────
info "Building…"
./build.sh
ok "Build successful"

ZIP_PATH="release/stella-${NEW_VERSION}.zip"

# ── Git commit + tag + push ───────────────────────────────────────────────────
info "Committing version bump…"
git add manifest.json
git commit -m "chore: release v${NEW_VERSION}"

TAG="v${NEW_VERSION}"
info "Creating tag ${TAG}…"
git tag -a "$TAG" -m "Stella ${TAG}"

info "Pushing to origin…"
git push origin "$BRANCH" --follow-tags
ok "Pushed ${TAG}"

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}✓ Stella ${TAG} tag pushed successfully!${NC}"
echo -e "${BLUE}▶${NC} GitHub Actions will now build, test, create the GitHub release,"
echo -e "  and publish the zip to ${BLUE}HatimCherkaoui/stella-releases${NC} automatically."
echo -e "  Follow progress at: https://github.com/HatimCherkaoui/stella/actions"
