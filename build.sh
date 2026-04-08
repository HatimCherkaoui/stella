#!/usr/bin/env bash
# build.sh — Minify, obfuscate and package Stella for the Chrome Web Store.
# Usage:  ./build.sh [--skip-tests] [--no-obfuscate]
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
OBFUSCATOR="./node_modules/.bin/javascript-obfuscator"

[[ -x "$TERSER" ]]     || error "terser not found. Run: npm install"
[[ -x "$CLEANCSS" ]]   || error "clean-css-cli not found. Run: npm install"
[[ -x "$OBFUSCATOR" ]] || error "javascript-obfuscator not found. Run: npm install"

# ── Flags ─────────────────────────────────────────────────────────────────────
SKIP_TESTS=false
OBFUSCATE=true
for arg in "$@"; do
    [[ "$arg" == "--skip-tests" ]]   && SKIP_TESTS=true
    [[ "$arg" == "--no-obfuscate" ]] && OBFUSCATE=false
done

# ── Read version ──────────────────────────────────────────────────────────────
VERSION=$(node -e "const m = require('./manifest.json'); if (!m.version) throw new Error('version missing'); process.stdout.write(m.version)")
info "Stella v${VERSION} — production build"
[[ "$OBFUSCATE" == "true" ]] && info "Obfuscation: ENABLED" || warn "Obfuscation: disabled"

# ── Pre-flight checks ─────────────────────────────────────────────────────────
info "Pre-flight checks…"
for f in manifest.json sidepanel.html sidepanel.js sidepanel.css ai-core.js background.js config.js; do
    [[ -f "$f" ]] || error "Required file missing: $f"
done
[[ -d "icons" ]] || error "icons/ directory missing"
ok "All required files present"

# ── Tests ─────────────────────────────────────────────────────────────────────
if [[ "$SKIP_TESTS" == "false" ]]; then
    info "Running test suite…"
    JEST="./node_modules/.bin/jest"
    [[ -x "$JEST" ]] || error "jest not found. Run: npm install"
    "$JEST" --testPathPatterns=tests/ --forceExit 2>&1 | tail -20
    ok "All tests passed"
else
    warn "Tests skipped (--skip-tests)"
fi

# ── Prepare dist/ ─────────────────────────────────────────────────────────────
info "Preparing dist/…"
rm -rf dist
mkdir -p dist/icons

BANNER="/* Stella © $(date +%Y) Hatim Cherkaoui — All Rights Reserved. Unauthorised copying or redistribution is prohibited. */"

# ── Helper: minify then optionally obfuscate a JS file ────────────────────────
# Usage: process_js <src> <dest>
process_js() {
    local src="$1" dest="$2"
    local tmp="${dest}.tmp.js"

    # Step 1: Terser — dead-code elimination, constant folding, mangle names
    $TERSER "$src" \
        --compress passes=3,drop_debugger=true,pure_funcs='[console.log]' \
        --mangle --ecma 2020 \
        --output "$tmp"

    if [[ "$OBFUSCATE" == "true" ]]; then
        # Step 2: javascript-obfuscator — control-flow flattening, string hex encoding,
        #   dead-code injection, self-defending. Renaming is already done by Terser.
        $OBFUSCATOR "$tmp" \
            --output "$dest" \
            --compact true \
            --control-flow-flattening true \
            --control-flow-flattening-threshold 0.5 \
            --dead-code-injection true \
            --dead-code-injection-threshold 0.3 \
            --string-array true \
            --string-array-encoding 'base64' \
            --string-array-threshold 0.6 \
            --string-array-rotate true \
            --string-array-shuffle true \
            --split-strings true \
            --split-strings-chunk-length 8 \
            --self-defending true \
            --disable-console-output true \
            --identifier-names-generator 'hexadecimal' \
            --seed 2026
        rm "$tmp"
    else
        mv "$tmp" "$dest"
    fi

    # Prepend copyright banner
    printf '%s\n' "$BANNER" | cat - "$dest" > "${dest}.bak" && mv "${dest}.bak" "$dest"
}

# ── Minify + obfuscate JavaScript ─────────────────────────────────────────────
for jsfile in config.js ai-core.js sidepanel.js background.js; do
    info "Processing ${jsfile}…"
    process_js "$jsfile" "dist/${jsfile}"
    ok "${jsfile} → dist/${jsfile}"
done

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
echo ""
[[ "$OBFUSCATE" == "true" ]] && echo -e "${GREEN}✓ Obfuscated${NC} — dist/ JS is protected" || warn "Not obfuscated — for release builds, omit --no-obfuscate"
