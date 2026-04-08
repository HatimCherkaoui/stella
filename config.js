// Copyright © 2026 Hatim Cherkaoui. All rights reserved.
// Unauthorized copying, modification, or distribution is strictly prohibited.
'use strict';
/* ── config.js — Single source of truth for app metadata and external links ───
   Loaded before ai-core.js and sidepanel.js.
   Version is intentionally omitted here; read it at runtime via:
     chrome.runtime.getManifest().version
   so that manifest.json remains the single authoritative source.
   ─────────────────────────────────────────────────────────────────────────── */

const STELLA_CONFIG = {
    name:      'Stella AI',
    shortName: 'Stella',

    author: {
        name:   'Hatim Cherkaoui',
        github: 'https://github.com/HatimCherkaoui',
    },

    links: {
        repo:          'https://github.com/HatimCherkaoui/stella',
        privacyPolicy: 'https://github.com/HatimCherkaoui/stella/blob/main/PRIVACY.md',
        paypal:        'https://paypal.me/hcherkao',
    },

    // Default AI model — must match a valid provider / modelId in AI_PROVIDERS (ai-core.js)
    defaultModel: { provider: 'openai', modelId: 'gpt-4o-mini' },
};
