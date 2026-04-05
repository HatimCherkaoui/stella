/**
 * helpers.js — shared test utilities
 *
 * Loads the three source files into an isolated vm.createContext sandbox so they
 * can run in Node.js / Jest without a real DOM or chrome extension API.
 *
 * All three files are concatenated into ONE script so that const/let declarations
 * in each file are still in scope for the export block at the end.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.join(__dirname, '..');

// ── Load source text ──────────────────────────────────────────────────────────
const configSrc    = fs.readFileSync(path.join(ROOT, 'config.js'),    'utf8');
const aiCoreSrc    = fs.readFileSync(path.join(ROOT, 'ai-core.js'),   'utf8');
const sidepanelSrc = fs.readFileSync(path.join(ROOT, 'sidepanel.js'), 'utf8');

const strip = src => src.replace(/^'use strict';\s*/m, '');

// ── DOM element stub ──────────────────────────────────────────────────────────
function domStub() {
    return {
        classList:        { add: ()=>{}, remove: ()=>{}, toggle: ()=>{}, contains: ()=>false },
        setAttribute:     () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        value:            '',
        disabled:         false,
        innerHTML:        '',
        textContent:      '',
        scrollTop:        0,
        scrollHeight:     0,
        appendChild:      () => {},
        remove:           () => {},
        style:            {},
        dataset:          {},
        querySelector:    () => domStub(),
        querySelectorAll: () => [],
        focus:            () => {},
        rows:             1,
    };
}

// ── Build an explicit vm sandbox ──────────────────────────────────────────────
// Everything the source files reference as globals must live here.
const sandbox = {
    // Chrome extension API shims
    chrome: {
        storage: { local: { get: (_k, cb) => cb({}), set: () => {} } },
        runtime: { getManifest: () => ({ version: '1.0.0' }), sendMessage: async () => null },
        tabs:    { query: async () => [], remove: async () => {} },
    },
    // DOM shims
    document: {
        getElementById:    () => domStub(),
        createElement:     () => domStub(),
        querySelector:     () => domStub(),
        querySelectorAll:  () => [],
        addEventListener:  () => {},
        readyState:        'complete',  // initChat() called directly (no DOMContentLoaded wait)
    },
    // Sidepanel helper shims
    $:    domStub,
    qS:   () => domStub(),
    // Web APIs
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    URL,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}), body: null }),
    AbortController,
    TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : function(){},
    Event: function(){},
    // Output collector — functions place their exports here
    __out: {},
};
// window must equal the sandbox (e.g. Object.defineProperty(window, 'tabContext', ...))
sandbox.window = sandbox;

const ctx = vm.createContext(sandbox);

// ── Run all source files + export stub as one flat script ─────────────────────
// NO IIFE wrapper — top-level function declarations land on the sandbox (global
// scope), making them patchable between tests. const/let in the top-level script
// scope are still accessible to the export block at the end of the same script.
const combined = `
${strip(configSrc)}

${strip(aiCoreSrc)}

${strip(sidepanelSrc)}

/* ── Export everything the tests need ── */
__out.interceptTabIntent           = interceptTabIntent;
__out.isTabContentQuery            = isTabContentQuery;
__out.findOpenTabsReferencedInText = findOpenTabsReferencedInText;
__out.buildMessages                = buildMessages;
__out.SLASH_COMMANDS               = SLASH_COMMANDS;
__out.executeSlashCommand          = executeSlashCommand;
__out.addTabToContext              = addTabToContext;
__out.clearTabContext              = clearTabContext;
__out.clearTabListContext          = clearTabListContext;
__out.setTabListContext            = setTabListContext;
__out.newSession                   = newSession;
__out.ensureSession                = ensureSession;
__out.getActiveSession             = getActiveSession;
__out.AI_PROVIDERS                 = AI_PROVIDERS;
__out.AI_MODEL_LIST                = AI_MODEL_LIST;
__out.AI_DEFAULT_MODEL             = AI_DEFAULT_MODEL;
__out.STELLA_CONFIG                = STELLA_CONFIG;
`;

try {
    vm.runInContext(combined, ctx);
} catch (e) {
    // initChat() runs DOM wiring; the stubs absorb most errors.
    // Re-throw only for errors that would break the export block itself.
    if (!sandbox.__out.isTabContentQuery) {
        throw new Error(`helpers.js failed to initialise: ${e.message}`);
    }
}

module.exports = sandbox.__out;

// Also expose the sandbox itself so tests can monkey-patch globals
// (e.g. showConsentBubble, getBrowserWindowId, chrome.tabs.query)
// that live inside the vm context.
module.exports.__sandbox = sandbox;
