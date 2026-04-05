#!/usr/bin/env bash
# build.sh — Minify and package Stella for the Chrome Web Store.
# Usage:  ./build.sh [--skip-tests]
# Output: release/stella-<version>.zip

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}▶${NC} $*"; }
ok()    { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}⚠${NC} $*"; }
error() { echo -e "${RED}✗${NC} $*"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TERSER="./node_modules/.bin/terser"
CLEANCSS="./node_modules/.bin/cleancss"

[[ -x "$TERSER" ]]   || error "terser not found. Run: npm install"
[[ -x "$CLEANCSS" ]] || error "clean-css-cli not found. Run: npm install"

# ── Read version ──────────────────────────────────────────────────────────────
VERSION=$(node -e "const m = require('./manifest.json'); if (!m.version) throw new Error('version missing'); process.stdout.write(m.version)")
info "Stella v${VERSION} — production build"

# ── Pre-flight checks ─────────────────────────────────────────────────────────
info "Pre-flight checks…"
for f in manifest.json sidepanel.html sidepanel.js sidepanel.css ai-core.js background.js config.js; do
    [[ -f "$f" ]] || error "Required file missing: $f"
done
[[ -d "icons" ]] || error "icons/ directory missing"
ok "All required files present"

# ── Prepare dist/ ─────────────────────────────────────────────────────────────
info "Preparing dist/…"
rm -rf dist
mkdir -p dist/icons

BANNER="/* Stella © $(date +%Y) Hatim Cherkaoui — All rights reserved. */"

# ── Minify JavaScript ─────────────────────────────────────────────────────────
info "Minifying config.js…"
$TERSER config.js \
    --compress passes=3,drop_debugger=true \
    --mangle --ecma 2020 \
    --output dist/config.js
printf '%s\n' "$BANNER" | cat - dist/config.js > dist/config.js.tmp && mv dist/config.js.tmp dist/config.js
ok "config.js minified"

info "Minifying ai-core.js…"
$TERSER ai-core.js \
    --compress passes=3,drop_debugger=true \
    --mangle --ecma 2020 \
    --output dist/ai-core.js
printf '%s\n' "$BANNER" | cat - dist/ai-core.js > dist/ai-core.js.tmp && mv dist/ai-core.js.tmp dist/ai-core.js
ok "ai-core.js minified"

info "Minifying sidepanel.js…"
$TERSER sidepanel.js \
    --compress passes=3,drop_debugger=true \
    --mangle --ecma 2020 \
    --output dist/sidepanel.js
ok "sidepanel.js minified"

info "Minifying background.js…"
$TERSER background.js \
    --compress passes=3,drop_debugger=true \
    --mangle --ecma 2020 \
    --output dist/background.js
ok "background.js minified"

# ── Minify CSS ────────────────────────────────────────────────────────────────
info "Minifying sidepanel.css…"
$CLEANCSS -o dist/sidepanel.css sidepanel.css
ok "sidepanel.css minified"

# ── Process HTML ──────────────────────────────────────────────────────────────
info "Processing sidepanel.html…"
sed \
    -e 's/<!--.*-->//g' \
    -e '/^\s*<!--/,/-->/d' \
    sidepanel.html > dist/sidepanel.html
ok "sidepanel.html processed"

# ── Copy static files ─────────────────────────────────────────────────────────
info "Copying static files…"
cp manifest.json dist/manifest.json
cp -r icons/. dist/icons/
ok "Static files copied"

# ── Package ───────────────────────────────────────────────────────────────────
mkdir -p release

ZIP_NAME="stella-${VERSION}.zip"
ZIP_PATH="release/${ZIP_NAME}"
[[ -f "$ZIP_PATH" ]] && rm "$ZIP_PATH"

info "Packaging ${ZIP_NAME} from dist/…"
pushd dist > /dev/null
zip -r "../${ZIP_PATH}" . -x "*.DS_Store" -x "__MACOSX/*"
popd > /dev/null

ok "Build complete → ${ZIP_PATH}"
echo ""
echo -e "${GREEN}dist/  ${NC}— unpacked extension (load via chrome://extensions)"
echo -e "${GREEN}${ZIP_PATH}${NC} — Chrome Web Store upload"
