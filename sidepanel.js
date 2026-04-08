'use strict';
/* ── sidepanel.js ─────────────────────────────────────────────────────────────
   AI Chat + Tab Management for the Tabaisco Side Panel.
   Depends on: config.js, ai-core.js (loaded before this file).
   ─────────────────────────────────────────────────────────────────────────── */

// ── Storage shim ──────────────────────────────────────────────────────────────
const chatStore = (typeof chrome !== 'undefined' && chrome.storage?.local)
    ? chrome.storage.local
    : { get: (_k, cb) => cb({}), set: () => {} };

// ── Themes ──────────────────────────────────────────────────────────────────
const THEMES = [
    { id: 'system',  label: 'System',  color: null },   /* half-dark/half-light via CSS */
    { id: 'blue',    label: 'Blue',    color: '#6aa3f8' },
    { id: 'violet',  label: 'Violet',  color: '#a78bfa' },
    { id: 'teal',    label: 'Teal',    color: '#2dd4c4' },
    { id: 'rose',    label: 'Rose',    color: '#f472b6' },
    { id: 'amber',   label: 'Amber',   color: '#fbbf24' },
    { id: 'emerald', label: 'Emerald', color: '#34d399' },
];

// Live OS dark/light switch listener — only active when system theme is selected
let _systemThemeMq = null;
function _watchSystemTheme(enable) {
    if (!_systemThemeMq) _systemThemeMq = window.matchMedia('(prefers-color-scheme: dark)');
    // Remove any existing listener first
    _systemThemeMq.removeEventListener('change', _onSystemThemeChange);
    if (enable) _systemThemeMq.addEventListener('change', _onSystemThemeChange);
}
function _onSystemThemeChange() {
    // No token changes needed — CSS media query handles it automatically.
    // Just re-render the settings swatch states to keep UI consistent.
    document.querySelectorAll('.theme-swatch').forEach(el => {
        el.setAttribute('aria-pressed', el.dataset.themeId === 'system' ? 'true' : 'false');
    });
}

function applyTheme(id) {
    const resolved = id || 'blue';
    document.documentElement.dataset.theme = resolved === 'blue' ? '' : resolved;
    if (!resolved || resolved === 'blue') {
        delete document.documentElement.dataset.theme;
    }
    chatStore.set({ stellaTheme: resolved });
    _watchSystemTheme(resolved === 'system');
    document.querySelectorAll('.theme-swatch').forEach(el => {
        el.setAttribute('aria-pressed', el.dataset.themeId === resolved ? 'true' : 'false');
    });
}

// ── State ─────────────────────────────────────────────────────────────────────
let chatSessions      = [];
let activeSdession    = null;
let activeProvider    = AI_DEFAULT_MODEL.provider;
let activeModelId     = AI_DEFAULT_MODEL.modelId;
let apiKeys           = {};
let multiAgentEnabled = false;
let selectedAgents    = new Set();
let abortController   = null;
let tabContexts      = [];     // Array<{ tabId, title, url, meta, text }> — tabs added to chat context
let tabListContext    = null;   // Array<{id,title,url,active}> — all open tabs list (for AI awareness)
let lastActiveTabId  = null;   // last tab the user was on in the browser window (tracked via onActivated)
let streamingCount    = 0;
let reasoningEnabled  = false;   // request model thinking tokens when supported

// Convenience helpers (keep backward compat with any remaining single-context refs)
Object.defineProperty(window, 'tabContext',   { get: () => tabContexts[0] ?? null, configurable: true });
Object.defineProperty(window, 'tabContextId', { get: () => tabContexts[0]?.tabId ?? null, configurable: true });

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const qS = s  => document.querySelector(s);

// ── Session helpers ───────────────────────────────────────────────────────────
function newSession() {
    return {
        id:        `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        title:     '',
        provider:  activeProvider,
        modelId:   activeModelId,
        createdAt: Date.now(),
        messages:  [],
        tokensIn:  0,
        tokensOut: 0,
    };
}

function loadSessions(cb) {
    chatStore.get(['chatSessions'], data => {
        chatSessions = Array.isArray(data.chatSessions) ? data.chatSessions : [];
        cb(chatSessions);
    });
}

function saveSessions() {
    chatStore.set({ chatSessions: chatSessions.slice(0, 100) });
}

function getActiveSession() {
    return chatSessions.find(s => s.id === activeSdession) || null;
}

function ensureSession() {
    let sess = getActiveSession();
    if (!sess) {
        sess = newSession();
        chatSessions.unshift(sess);
        activeSdession = sess.id;
    }
    return sess;
}

// ── Render helpers ────────────────────────────────────────────────────────────
function formatRelativeDate(ts) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1)  return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

function formatTokens(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

// ── Markdown renderer ─────────────────────────────────────────────────────────
// Full-featured, no external dependencies.
// Supports: headings, bold/italic/strikethrough, inline code, fenced code blocks
// (with language label + copy button), blockquotes, ordered/unordered lists,
// horizontal rules, links, images, audio, video, tables, and hard line-breaks.
function renderMarkdown(text) {
    const esc = s => String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    // ── 1. Extract fenced code blocks before any other processing ────────────
    const CODE_PLACEHOLDER = '\x00CODE\x00';
    const codeBlocks = [];
    text = text.replace(/^```([\w.+-]*)\r?\n([\s\S]*?)```\s*$/gm, (_, lang, body) => {
        const safeLang  = esc(lang.trim());
        const safeBody  = esc(body.replace(/\n$/, ''));
        const idx       = codeBlocks.length;
        const label     = safeLang
            ? `<span class="md-code-lang">${safeLang}</span>` : '';
        codeBlocks.push(
            `<div class="md-code-block">`+
              `<div class="md-code-header">${label}`+
                `<button class="md-copy-btn" onclick="mdCopyCode(this)" title="Copy">`+
                  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`+
                    `<rect x="9" y="9" width="13" height="13" rx="2"/>`+
                    `<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`+
                  `</svg>Copy`+
                `</button>`+
              `</div>`+
              `<pre><code class="md-code${safeLang ? ' lang-'+safeLang : ''}">${safeBody}</code></pre>`+
            `</div>`
        );
        return `${CODE_PLACEHOLDER}${idx}${CODE_PLACEHOLDER}`;
    });

    // ── 2. Block-level transforms (operate on whole lines) ───────────────────
    const lines = text.split('\n');
    const out   = [];
    let i = 0;

    while (i < lines.length) {
        const raw = lines[i];

        // Code block placeholder
        const cpMatch = raw.match(new RegExp(`^${CODE_PLACEHOLDER}(\\d+)${CODE_PLACEHOLDER}$`));
        if (cpMatch) { out.push(codeBlocks[+cpMatch[1]]); i++; continue; }

        // Heading h1–h6
        const hMatch = raw.match(/^(#{1,6})\s+(.*)/);
        if (hMatch) {
            const level = hMatch[1].length;
            out.push(`<h${level} class="md-h${level}">${inlineFormat(hMatch[2], esc)}</h${level}>`);
            i++; continue;
        }

        // Horizontal rule
        if (/^(\s*[-*_]){3,}\s*$/.test(raw)) {
            out.push('<hr class="md-hr">');
            i++; continue;
        }

        // Blockquote — collect consecutive > lines
        if (/^\s*>/.test(raw)) {
            const qlines = [];
            while (i < lines.length && /^\s*>/.test(lines[i])) {
                qlines.push(lines[i].replace(/^\s*>\s?/, ''));
                i++;
            }
            out.push(`<blockquote class="md-blockquote">${renderMarkdown(qlines.join('\n'))}</blockquote>`);
            continue;
        }

        // Unordered list — collect consecutive bullet lines
        if (/^\s*[-*+]\s/.test(raw)) {
            const items = [];
            while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) {
                items.push(`<li>${inlineFormat(lines[i].replace(/^\s*[-*+]\s/, ''), esc)}</li>`);
                i++;
            }
            out.push(`<ul class="md-list">${items.join('')}</ul>`);
            continue;
        }

        // Ordered list
        if (/^\s*\d+\.\s/.test(raw)) {
            const items = [];
            while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
                items.push(`<li>${inlineFormat(lines[i].replace(/^\s*\d+\.\s/, ''), esc)}</li>`);
                i++;
            }
            out.push(`<ol class="md-list">${items.join('')}</ol>`);
            continue;
        }

        // Table — detect | header | row |
        if (/^\|.+\|/.test(raw) && i + 1 < lines.length && /^\|[-| :]+\|/.test(lines[i + 1])) {
            const parseRow = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
            const headers  = parseRow(raw);
            i += 2; // skip header + separator
            const rows = [];
            while (i < lines.length && /^\|.+\|/.test(lines[i])) {
                rows.push(parseRow(lines[i])); i++;
            }
            const ths = headers.map(h => `<th>${inlineFormat(h, esc)}</th>`).join('');
            const trs = rows.map(r =>
                `<tr>${r.map(c => `<td>${inlineFormat(c, esc)}</td>`).join('')}</tr>`
            ).join('');
            out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>`);
            continue;
        }

        // Blank line → paragraph break
        if (raw.trim() === '') { out.push('<div class="md-spacer"></div>'); i++; continue; }

        // Normal paragraph line
        out.push(`<p class="md-p">${inlineFormat(raw, esc)}</p>`);
        i++;
    }

    return out.join('');
}

// ── Inline formatting ──────────────────────────────────────────────────────────
function inlineFormat(text, esc) {
    // Protect inline code from further processing
    const INLINE_CODE = '\x01IC\x01';
    const inlineCodes = [];
    text = text.replace(/`([^`]+)`/g, (_, c) => {
        inlineCodes.push(`<code class="md-inline-code">${esc(c)}</code>`);
        return `${INLINE_CODE}${inlineCodes.length - 1}${INLINE_CODE}`;
    });

    text = esc(text);

    // Media: image / video / audio
    // ![alt](url)
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, href) => {
        const safeAlt  = esc(alt);
        const safeHref = esc(href);
        if (/\.(mp4|webm|ogg)(\?.*)?$/i.test(href)) {
            return `<div class="md-media-wrap"><video class="md-video" controls preload="none" src="${safeHref}"><p>${safeAlt}</p></video></div>`;
        }
        if (/\.(mp3|wav|ogg|flac|m4a)(\?.*)?$/i.test(href)) {
            return `<div class="md-media-wrap"><audio class="md-audio" controls preload="none" src="${safeHref}"></audio>${safeAlt ? `<span class="md-media-label">${safeAlt}</span>`:''}</div>`;
        }
        return `<div class="md-img-wrap"><img class="md-img" src="${safeHref}" alt="${safeAlt}" loading="lazy" onclick="this.classList.toggle('md-img-expanded')"></div>`;
    });

    // Links [text](url)
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) =>
        `<a class="md-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`
    );

    // Bold + italic ***text***
    text = text.replace(/\*{3}([^*]+)\*{3}/g, '<strong><em>$1</em></strong>');
    // Bold **text**
    text = text.replace(/\*{2}([^*\n]+)\*{2}/g, '<strong>$1</strong>');
    text = text.replace(/_{2}([^_\n]+)_{2}/g, '<strong>$1</strong>');
    // Italic *text*
    text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    text = text.replace(/_([^_\n]+)_/g, '<em>$1</em>');
    // Strikethrough ~~text~~
    text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    // Restore inline code
    text = text.replace(new RegExp(`${INLINE_CODE}(\\d+)${INLINE_CODE}`, 'g'),
        (_, idx) => inlineCodes[+idx]);

    return text;
}

// ── Copy-to-clipboard handler (called from onclick in rendered HTML) ──────────
function mdCopyCode(btn) {
    const code = btn.closest('.md-code-block')?.querySelector('code');
    if (!code) return;
    navigator.clipboard.writeText(code.innerText).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => {
            btn.innerHTML =
                `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`+
                `<rect x="9" y="9" width="13" height="13" rx="2"/>`+
                `<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`+
                `</svg>Copy`;
        }, 1800);
    }).catch(() => {});
}

// ── Message rendering ─────────────────────────────────────────────────────────
function renderMessage(msg) {
    const wrap = document.createElement('div');
    wrap.className = `chat-msg ${msg.role}`;
    wrap.dataset.msgId = msg.id || '';

    const header = document.createElement('div');
    header.className = 'chat-msg-header';

    if (msg.role === 'assistant') {
        const avatar = document.createElement('span');
        avatar.className = 'chat-msg-avatar';
        avatar.dataset.provider = msg.provider || activeProvider;
        header.appendChild(avatar);
        const name = msg.modelLabel || AI_PROVIDERS[msg.provider || activeProvider]?.label || 'AI';
        header.appendChild(Object.assign(document.createElement('span'), { textContent: name }));
    } else {
        const avatar = document.createElement('span');
        avatar.className = 'chat-msg-avatar';
        avatar.dataset.provider = 'user';
        header.appendChild(avatar);
        header.appendChild(Object.assign(document.createElement('span'), { textContent: 'You' }));
    }

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    const content = document.createElement('div');
    content.className = 'chat-content';

    if (msg.role === 'assistant') {
        content.innerHTML = renderMarkdown(msg.content || '');
    } else {
        content.textContent = msg.content || '';
    }
    bubble.appendChild(content);

    const footer = document.createElement('div');
    footer.className = 'chat-msg-footer';
    if (msg.tokensIn || msg.tokensOut) {
        footer.textContent = `${formatTokens(msg.tokensIn || 0)} in · ${formatTokens(msg.tokensOut || 0)} out`;
        if (msg.cost) footer.textContent += ` · ${msg.cost}`;
        if (msg.ms)   footer.textContent += ` · ${(msg.ms / 1000).toFixed(1)}s`;
    }

    wrap.appendChild(header);
    wrap.appendChild(bubble);
    if (footer.textContent) wrap.appendChild(footer);
    return wrap;
}

function appendMessage(msg) {
    const list  = $('chat-messages');
    const empty = $('chat-empty');
    if (empty) empty.style.display = 'none';
    const el = renderMessage(msg);
    list.appendChild(el);
    list.scrollTop = list.scrollHeight;
    return el;
}

function scrollToBottom() {
    const list = $('chat-messages');
    if (list) list.scrollTop = list.scrollHeight;
}

// ── Typing indicator ──────────────────────────────────────────────────────────
function createTypingIndicator(provider) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg assistant chat-typing-wrap';
    const header = document.createElement('div');
    header.className = 'chat-msg-header';
    const avatar = document.createElement('span');
    avatar.className = 'chat-msg-avatar';
    avatar.dataset.provider = provider;
    header.appendChild(avatar);
    header.appendChild(Object.assign(document.createElement('span'), {
        textContent: AI_PROVIDERS[provider]?.label || 'AI',
    }));
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.innerHTML = '<span class="chat-typing"><span></span><span></span><span></span></span>';
    wrap.appendChild(header);
    wrap.appendChild(bubble);
    const list = $('chat-messages');
    if (list) { list.appendChild(wrap); list.scrollTop = list.scrollHeight; }
    return wrap;
}

// ── URL extractor — handles full URLs, domain.tld, and bare names ────────────
function extractUrlFromText(text) {
    // 1. Full URL already present
    let m = text.match(/https?:\/\/[^\s,!?"']+/i);
    if (m) return m[0];

    // 2. Something like "linkedin.com" or "en.wikipedia.org/wiki/X"
    m = text.match(/\b([a-zA-Z0-9][a-zA-Z0-9-]{1,61}[a-zA-Z0-9]\.[a-zA-Z]{2,}(?:\/[^\s,!?"']*)?)\b/i);
    if (m) return m[1];

    // 3. Bare brand name immediately after an explicit open-tab verb, at end of input
    //    (4+ chars; removed the old "to X" rule that mis-matched "I want to learn")
    m = text.match(/\b(?:open|navigate to|go to|launch)\s+(?:a\s+(?:new\s+)?tab\s+(?:to|for|at)\s*)?([a-zA-Z][a-zA-Z0-9-]{3,})\s*$/i);
    if (m) return m[1].toLowerCase() + '.com';

    return null;
}

// ── Tab intent interception ──────────────────────────────────────────────────
// Runs before the AI call. Returns { action, payload } so sendMessage can
// decide whether to hit the AI at all.
async function interceptTabIntent(text) {
    const readIntent =
        /\b(summarize|summarise|summary|read|analyse|analyze|explain|describe|what'?s? (on|in)|tell me about)\b.{0,40}\b(current|this|the|my|active|open|recent|latest)\b.{0,20}\b(tab|page|site|article|content)\b/i.test(text) ||
        /\b(current|this|active|open|recent|latest)\b.{0,20}\b(tab|page|site)\b.{0,40}\b(summarize|summarise|read|analyze|what|tell|explain)\b/i.test(text) ||
        /\b(summarize|summarise|summary)\b.{0,20}\b(tab|page|site|article|content|it)\b/i.test(text) ||
        // French
        /\b(r[eé]sum[eé]|analyse[rz]?|explique[rz]?|lis|lire)\b.{0,30}\b(cette?|cet|la|l'|le)?\s*(page|onglet|article|site|contenu)\b/i.test(text) ||
        // Spanish
        /\b(resum[ei][r]?|analiz[a-z]+|explica[r]?|lee[r]?)\b.{0,30}\b(esta?|el|la)?\s*(p[aá]gina|pesta[nñ]a|art[ií]culo|sitio)\b/i.test(text) ||
        // German
        /\b(zusammenfasse[nt]?|erkl[aä]r[ent]?|analysi[eé]r[ent]?|lies?|lesen)\b.{0,30}\b(diese[sr]?|den|die|das)?\s*(seite|tab|artikel|inhalt|reiter)\b/i.test(text) ||
        // Arabic
        /\b(لخص|اشرح|حلل|ما الذي)\b.{0,30}\b(هذه الصفحة|هذا المقال|الصفحة|المحتوى)\b/.test(text);

    if (readIntent) {
        if (tabContexts.length > 0) {
            return { action: 'readTab' };
        }
        return { action: 'awaitPermission', originalText: text };
    }

    // ── List / count open tabs ──
    if (/\b(list|show|what are|display|how many)\b.{0,30}\b(my |all |open |current )?(tabs?)\b/i.test(text) ||
        /\b(lister?|montrer?|afficher?|combien)\b.{0,30}\b(mes |tous les |les )?(onglets?)\b/i.test(text) ||
        /\b(listar?|mostrar?|cu[aá]ntos?)\b.{0,30}\b(mis |todas? las |las )?(pesta[nñ]as?)\b/i.test(text) ||
        /\b(liste[nt]?|zeige[nt]?|wie viele)\b.{0,30}\b(meine?|alle )?(tabs?|reiter)\b/i.test(text)) {
        const confirmed = await showConsentBubble(
            'Share your list of open tabs with the AI?',
            'Share tab list'
        );
        if (!confirmed) return { action: 'cancelled' };
        const tabs = await chrome.tabs.query({ windowId: await getBrowserWindowId() });
        setTabListContext(tabs);
        return { action: 'listTabs', count: tabs.length };
    }

    // ── Open a new tab ──
    if (/\b(?:open|go to|navigate to|visit|launch|load|ouvrir|aller [aà]|visiter|navigue[rz]? vers|abrir|ir a|navegar a|[oö]ffnen|gehe? zu|aufrufen|besuchen)\b/i.test(text)) {
        const url = extractUrlFromText(text);
        if (url) {
            const normalised = url.startsWith('http') ? url : 'https://' + url;
            const confirmed = await showConsentBubble(
                `Open new tab: ${normalised}?`,
                'Open tab'
            );
            if (!confirmed) return { action: 'cancelled' };
            await openNewTab(url);
            return { action: 'openTab', url };
        }
    }

    // ── Close the current / active tab ──
    if (/\b(close|shut|kill|fermer|ferme[rz]?|cerrar|cierra?|schlie[sß]en|zumachen)\b.{0,20}\b(this|current|active|the|cette?|cet|la|le|esta?|el|diese[sr]?|den|das)?\s*(tab|page|onglet|p[aá]gina|seite|reiter)\b/i.test(text)) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, windowId: await getBrowserWindowId() });
            if (tab) {
                let display = tab.title || '';
                try { display = new URL(tab.url).hostname; } catch { /* ok */ }
                const confirmed = await showConsentBubble(
                    `Close tab: "${tab.title || display}"?`,
                    'Close tab'
                );
                if (!confirmed) return { action: 'cancelled' };
                await chrome.tabs.remove(tab.id);
                await updateTabsBadge();
                return { action: 'closeTab', title: tab.title || 'tab' };
            }
        } catch (e) {
            return { action: 'closeTabError', error: e.message };
        }
    }

    return { action: null };
}

// ── Detect whether a message is specifically asking about page/tab content ──
// Returns true  → SOURCE blocks should be injected into the model prompt.
// Returns false → general question; let the model answer from its own knowledge.
//
// RULE: every branch MUST require an explicit document noun (page/tab/article/
// site/content) or a deictic (this/the/that) paired with one.
// Bare "summarize X" / "explain recursion" / "key points of AI" are general
// questions — they fall through to Rule E and are answered from training data.
function isTabContentQuery(text) {
    // Quick pre-check: if there is no document/tab noun in the text at all,
    // skip the detailed checks entirely — it cannot be a page-content query.
    if (!/\b(page|tab|article|site|content|post|onglet|artikel|seite|p[aá]gina|pesta[nñ]a)\b/i.test(text)) {
        return false;
    }
    return (
        // ── English ───────────────────────────────────────────────────────────
        // "summarize this page" / "give me a summary of the article"
        /\b(summarize|summarise|summary|sum up|tldr|tl;?dr)\b.{0,50}\b(this|the|current|active|my|that)?\s*(page|tab|article|site|content|post)\b/i.test(text) ||
        /\b(this|the|current|active|my|that)\s*(page|tab|article|site|content|post)\b.{0,50}\b(summarize|summarise|summary|sum up)\b/i.test(text) ||
        // "key points of this article" / "main ideas from the page"
        /\b(key points?|main (ideas?|topics?|points?|takeaways?|insights?))\b.{0,40}\b(this|the|current|active|my|that)?\s*(page|tab|article|site|content|post)\b/i.test(text) ||
        // "what does this page say" / "explain the content"
        /\b(what|tell me|explain|describe|analyze|analyse|discuss|review)\b.{0,40}\b(this|the|current|active|my|that)?\s*(page|tab|article|site|content|post)\b/i.test(text) ||
        // "the page says / contains / is about"
        /\b(page|tab|article|site|content|post)\b.{0,40}\b(say|says|mention|discusses?|covers?|talks?\s*about|contains?|is about)\b/i.test(text) ||
        // "based on this page" / "according to the article"
        /\b(from|based on|according to)\b.{0,20}\b(this|the|that)\b.{0,20}\b(page|tab|article|site|content)\b/i.test(text) ||
        // "what is this about" / "what does this page mean"
        /\b(what('?s| is| does| are))\b.{0,30}\b(this|the|that)\b.{0,30}\b(about|say|discuss|cover|mean|conclude)\b/i.test(text) ||
        // ── French — doc noun already verified above ──────────────────────
        /\b(que (dit|contient|explique|traite))\b.{0,30}\b(cette?|cet|la|le)\b.{0,15}\b(page|article|onglet|site)\b/i.test(text) ||
        /\b(r[eé]sum[eé]|synth[eè]se)\b.{0,40}\b(cette?|cet|la|le|l')?\s*(page|article|onglet|site|contenu)\b/i.test(text) ||
        // ── Spanish ───────────────────────────────────────────────────────
        /\b(resumen|qu[eé] (dice|contiene|habla|trata))\b.{0,40}\b(esta?|la|el)?\s*(p[aá]gina|art[ií]culo|pesta[nñ]a|sitio)\b/i.test(text) ||
        /\b(esta?|la|el)\b.{0,10}\b(p[aá]gina|art[ií]culo|pesta[nñ]a|sitio|contenido)\b.{0,30}\b(dice|habla|trata|explica|contiene)\b/i.test(text) ||
        // ── German ────────────────────────────────────────────────────────
        /\b(zusammenfassung|zusammenfassen|was (steht|sagt|enth[aä]lt|behandelt))\b.{0,30}\b(diese[sr]?|den|die|das)?\s*(seite|tab|artikel|inhalt)\b/i.test(text) ||
        // ── Arabic ────────────────────────────────────────────────────────
        /\b(لخص|ملخص|تلخيص|اشرح|حلل)\b.{0,30}\b(هذه الصفحة|هذا المقال|الصفحة|المحتوى)\b/.test(text)
    );
}

// ── Find open browser tabs the user is referring to by name or hostname ──────
// Used to auto-add a tab to context when the user says e.g. "the Wikipedia tab".
// Guards:
//   1. Text must contain an explicit page/tab indicator word — otherwise
//      "explain React hooks" would silently auto-read any open React tab.
//   2. Hostname root must be ≥5 chars; title words must be ≥10 chars to avoid
//      matching common topic words that happen to appear in tab titles.
async function findOpenTabsReferencedInText(text) {
    if (!/\b(tab|page|article|site|post|onglet|seite|p[aá]gina|pesta[nñ]a)\b/i.test(text)) return [];
    const lower = text.toLowerCase();
    let allTabs = [];
    try {
        allTabs = await chrome.tabs.query({ windowId: await getBrowserWindowId() });
    } catch { return []; }
    return allTabs.filter(tab => {
        if (!isReadableUrl(tab.url)) return false;
        try {
            const hostname = new URL(tab.url).hostname.replace(/^www\./, '');
            const root = hostname.split('.')[0];
            if (root.length >= 5 && lower.includes(root)) return true;
        } catch { /* ignore */ }
        // Only match long specific title words (10+ chars) to avoid false positives
        const words = (tab.title || '').split(/\s+/).filter(w => w.length >= 10);
        return words.some(w => lower.includes(w.toLowerCase()));
    });
}

// ── Confirmation bubble (system action, no AI involved) ──────────────────────
function appendConfirmBubble(text) {
    const msgList = $('chat-messages');
    const empty   = $('chat-empty');
    if (empty) empty.style.display = 'none';
    const div = document.createElement('div');
    div.className = 'chat-msg assistant';
    div.innerHTML = `<div class="chat-bubble" style="border-color:rgba(76,175,80,0.3);">
        <span style="color:#4caf50;margin-right:6px;">✓</span>${escHtml(text)}
    </div>`;
    msgList.appendChild(div);
    msgList.scrollTop = msgList.scrollHeight;
}

// ── Reading tab loading bubble ────────────────────────────────────────────────
function createReadingBubble() {
    const msgList = $('chat-messages');
    const empty   = $('chat-empty');
    if (empty) empty.style.display = 'none';
    const div = document.createElement('div');
    div.className = 'chat-msg assistant sp-reading-bubble';
    div.innerHTML = `<div class="chat-bubble" style="border-color:rgba(66,133,244,0.25);color:#7aadff;display:flex;align-items:center;gap:10px;">
        <span class="chat-typing"><span></span><span></span><span></span></span>
        <span>Reading tab content…</span>
    </div>`;
    msgList.appendChild(div);
    msgList.scrollTop = msgList.scrollHeight;
    return div;
}

function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Consent bubble for any browser action ────────────────────────────────────
function showConsentBubble(message, yesText = 'Confirm') {
    return new Promise(resolve => {
        const msgList = $('chat-messages');
        const empty   = $('chat-empty');
        if (empty) empty.style.display = 'none';
        const div = document.createElement('div');
        div.className = 'chat-msg assistant sp-consent-bubble';
        div.innerHTML = `
            <div class="chat-bubble" style="border-color:rgba(245,158,11,0.3);">
                <p style="margin:0 0 10px;color:var(--text);">${escHtml(message)}</p>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button class="sp-consent-yes" style="background:rgba(76,175,80,0.15);border:1px solid rgba(76,175,80,0.35);border-radius:7px;padding:5px 14px;cursor:pointer;color:#81c784;font-size:12px;">${escHtml(yesText)}</button>
                    <button class="sp-consent-no" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:7px;padding:5px 12px;cursor:pointer;color:var(--text-muted);font-size:12px;">Cancel</button>
                </div>
            </div>`;
        msgList.appendChild(div);
        msgList.scrollTop = msgList.scrollHeight;
        div.querySelector('.sp-consent-yes').addEventListener('click', () => { div.remove(); resolve(true);  });
        div.querySelector('.sp-consent-no' ).addEventListener('click', () => { div.remove(); resolve(false); });
    });
}

// ── Slash commands catalogue ──────────────────────────────────────────────────
const SLASH_COMMANDS = [
    { cmd: '/read',      desc: 'Read current tab and add to context',    icon: '📄' },
    { cmd: '/summarize', desc: 'Summarize tabs in context',              icon: '✦'  },
    { cmd: '/compare',   desc: 'Compare models side by side',           icon: '⧉'  },
    { cmd: '/open',      desc: 'Open a new tab  /open <url>',           icon: '🔗' },
    { cmd: '/close',     desc: 'Close current tab',                      icon: '✕'  },
    { cmd: '/clear',     desc: 'Clear all tab context',                  icon: '⌫'  },
];

let _popupActiveIdx = -1;

function showSlashPopup(query) {
    const popup = $('slash-cmd-popup');
    const lower = query.toLowerCase();
    const matches = SLASH_COMMANDS.filter(c => c.cmd.startsWith(lower));
    if (!matches.length) { hideSlashPopup(); return; }

    popup.innerHTML = '';
    const heading = document.createElement('div');
    heading.className = 'sp-popup-heading';
    heading.textContent = 'Commands';
    popup.appendChild(heading);

    matches.forEach((c, idx) => {
        const item = document.createElement('div');
        item.className = 'sp-popup-item' + (idx === 0 ? ' active' : '');
        item.dataset.cmd = c.cmd;

        const icon = Object.assign(document.createElement('span'), {
            className: 'sp-popup-icon', textContent: c.icon,
        });
        const cmdSpan = Object.assign(document.createElement('span'), {
            className: 'sp-popup-cmd', textContent: c.cmd,
        });
        const descSpan = Object.assign(document.createElement('span'), {
            className: 'sp-popup-desc', textContent: c.desc,
        });
        item.appendChild(icon);
        item.appendChild(cmdSpan);
        item.appendChild(descSpan);
        item.addEventListener('mousedown', e => { e.preventDefault(); executeSlashCommand(c.cmd); });
        popup.appendChild(item);
    });
    _popupActiveIdx = 0;
    popup.classList.remove('hidden');
}

function hideSlashPopup() {
    $('slash-cmd-popup').classList.add('hidden');
    _popupActiveIdx = -1;
}

function executeSlashCommand(cmd) {
    const input = $('chat-input');
    hideSlashPopup();
    if (cmd === '/open') {
        input.value = '/open ';
        autoGrowTextarea(input);
        input.focus();
        $('chat-send-btn').disabled = false;
        return;
    }
    input.value = '';
    autoGrowTextarea(input);
    $('chat-send-btn').disabled = true;

    if (cmd === '/read') {
        const loadingEl = createReadingBubble();
        readActiveTab(loadingEl).then(ok => {
            if (ok) appendConfirmBubble('Tab added to context. Ask me anything about it.');
        });
    } else if (cmd === '/summarize') {
        if (tabContexts.length === 0) {
            const loadingEl = createReadingBubble();
            readActiveTab(loadingEl).then(ok => {
                if (ok) sendMessage('Summarize the content of the tabs in context.');
            });
        } else {
            sendMessage('Summarize the content of the tabs in context.');
        }
    } else if (cmd === '/compare') {
        multiAgentEnabled = !multiAgentEnabled;
        $('chat-multi-btn').classList.toggle('active', multiAgentEnabled);
        $('chat-multi-btn').setAttribute('aria-pressed', String(multiAgentEnabled));
        const bar = $('chat-multi-agent-bar');
        if (multiAgentEnabled) { buildMultiAgentBar(); bar.classList.remove('hidden'); }
        else                   { bar.classList.add('hidden'); selectedAgents.clear(); }
        appendConfirmBubble(multiAgentEnabled
            ? 'Compare mode on — select models in the toolbar.'
            : 'Compare mode off.');
    } else if (cmd === '/clear') {
        clearTabContext();
        clearTabListContext();
        appendConfirmBubble('Tab context cleared.');
    } else if (cmd === '/close') {
        sendMessage('Close the current tab.');
    }
    input.focus();
}

async function showTabPickerPopup(query) {
    const popup = $('tab-picker-popup');
    let allTabs = [];
    try {
        allTabs = await chrome.tabs.query({ windowId: await getBrowserWindowId() });
    } catch { hideTabPickerPopup(); return; }

    const lower = query.toLowerCase();
    const filtered = allTabs.filter(t => {
        if (!isReadableUrl(t.url)) return false;
        if (!lower) return true;
        return (t.title || '').toLowerCase().includes(lower) ||
               (t.url  || '').toLowerCase().includes(lower);
    }).slice(0, 7);

    if (!filtered.length) { hideTabPickerPopup(); return; }

    popup.innerHTML = '';
    const heading = document.createElement('div');
    heading.className = 'sp-popup-heading';
    heading.textContent = lower ? `Tabs matching "${query}"` : 'Open tabs';
    popup.appendChild(heading);

    filtered.forEach((tab, idx) => {
        const item = document.createElement('div');
        item.className = 'sp-popup-item' + (idx === 0 ? ' active' : '');
        item.dataset.tabId = tab.id;

        if (tab.favIconUrl && !tab.favIconUrl.startsWith('chrome://')) {
            const img = document.createElement('img');
            img.className = 'sp-picker-favicon';
            img.src = tab.favIconUrl;
            img.alt = '';
            img.onerror = () => { img.style.display = 'none'; };
            item.appendChild(img);
        } else {
            item.appendChild(Object.assign(document.createElement('span'), {
                className: 'sp-popup-icon', textContent: '🌐',
            }));
        }
        const lbl = document.createElement('div');
        lbl.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;';
        lbl.textContent = tab.title || tab.url;
        item.appendChild(lbl);

        item.addEventListener('mousedown', e => {
            e.preventDefault();
            const input = $('chat-input');
            const at = input.value.lastIndexOf('@');
            if (at !== -1) input.value = input.value.slice(0, at);
            hideTabPickerPopup();
            autoGrowTextarea(input);
            input.focus();
            readTabById(tab.id, tab.title);
        });
        popup.appendChild(item);
    });
    _popupActiveIdx = 0;
    popup.classList.remove('hidden');
}

function hideTabPickerPopup() {
    $('tab-picker-popup').classList.add('hidden');
    _popupActiveIdx = -1;
}

// Navigate active item in a popup (direction: +1 or -1)
function _navigatePopup(popup, direction) {
    const items = popup.querySelectorAll('.sp-popup-item');
    if (!items.length) return;
    items[_popupActiveIdx]?.classList.remove('active');
    _popupActiveIdx = (_popupActiveIdx + direction + items.length) % items.length;
    items[_popupActiveIdx]?.classList.add('active');
    items[_popupActiveIdx]?.scrollIntoView({ block: 'nearest' });
}

// ── No-context tab picker ─────────────────────────────────────────────────────
// Rule F: user's message refers to a tab but no tab is in context.
// Force the user to pick one before the AI is called.
async function showNoContextTabPicker(originalText, sess) {
    const msgList = $('chat-messages');
    const empty   = $('chat-empty');
    if (empty) empty.style.display = 'none';

    const wrap   = document.createElement('div');
    wrap.className = 'chat-msg assistant';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble sp-tab-disambig';
    bubble.style.cssText = 'border-color:rgba(244,169,50,0.35);';

    // ── proceed helper (read + send) ─────────────────────────────────────────
    const proceedWithTab = async (tabId, tabTitle, pickerItemEl) => {
        const alreadyCtx = tabContexts.find(c => c.tabId === tabId);
        if (alreadyCtx) {
            wrap.remove();
            await _dispatchSend(sess, originalText, [alreadyCtx]);
            return;
        }
        if (pickerItemEl) {
            pickerItemEl.closest('.sp-tab-disambig-picker')
                ?.querySelectorAll('button').forEach(b => { b.disabled = true; });
            pickerItemEl.textContent = 'Reading\u2026';
        }
        const loadingEl = createReadingBubble();
        try {
            const data = await bgReadTab(tabId);
            addTabToContext(tabId, data);
            loadingEl.remove();
            wrap.remove();
            const ctx = tabContexts.find(c => c.tabId === tabId);
            await _dispatchSend(sess, originalText, ctx ? [ctx] : null);
        } catch (e) {
            loadingEl.remove();
            wrap.remove();
            appendErrorBubble(`Could not read "${tabTitle}": ${e.message}`);
            const sb = $('chat-send-btn'), inp = $('chat-input');
            if (sb)  sb.disabled  = !inp?.value.trim();
            if (inp) { inp.disabled = false; inp.focus(); }
        }
    };

    // ── helper: dispatch to AI after tab is ready ────────────────────────────
    async function _dispatchSend(s, text, specificTabsChoice) {
        const sendBtn = $('chat-send-btn');
        const input   = $('chat-input');
        if (sendBtn) sendBtn.disabled = true;
        if (input)   input.disabled  = true;
        const currentSess = getActiveSession() || s;
        if (multiAgentEnabled && selectedAgents.size >= 2) {
            await _sendMultiAgent(currentSess, text, true, specificTabsChoice);
        } else {
            await _sendSingle(currentSess, text, true, specificTabsChoice);
        }
        updateStatsBar(currentSess);
        saveSessions();
        if (sendBtn) sendBtn.disabled = !$('chat-input')?.value.trim();
        if (input)   { input.disabled = false; input.focus(); }
    }

    // ── Header ───────────────────────────────────────────────────────────────
    const question = document.createElement('p');
    question.style.cssText = 'margin:0 0 10px;color:var(--text);font-size:12.5px;';
    question.textContent = 'Your question refers to a tab, but no tab is in context. Which tab do you mean?';
    bubble.appendChild(question);

    // ── Fetch open tabs ───────────────────────────────────────────────────────
    let openTabs = [];
    let fetchFailed = false;
    try {
        openTabs = (await chrome.tabs.query({ windowId: await getBrowserWindowId() }))
            .filter(t => isReadableUrl(t.url));
    } catch { fetchFailed = true; }

    if (fetchFailed || !openTabs.length) {
        const msg = document.createElement('p');
        msg.style.cssText = 'font-size:12px;color:var(--text-muted);margin:0 0 10px;';
        msg.textContent = fetchFailed
            ? 'Could not read the list of open tabs. Make sure Stella has tab permissions.'
            : 'No readable tabs are currently open in Chrome. Open a web page and try again.';
        bubble.appendChild(msg);
    } else {
        const hdr = document.createElement('p');
        hdr.style.cssText = 'font-size:11px;color:var(--text-muted);margin:0 0 5px;';
        hdr.textContent = 'Select a tab to add to context:';
        bubble.appendChild(hdr);

        const pickerWrap = document.createElement('div');
        pickerWrap.className = 'sp-tab-disambig-picker';

        for (const tab of openTabs) {
            const item = document.createElement('button');
            item.className = 'sp-tab-disambig-open-item';
            let hostname = '';
            try { hostname = new URL(tab.url).hostname.replace(/^www\./, ''); } catch {}
            item.innerHTML = `<span class="sp-tab-disambig-open-title">${escHtml(_clampStr(tab.title || hostname, 40))}</span>`
                           + `<span class="sp-tab-disambig-open-host">${escHtml(hostname)}</span>`;
            item.addEventListener('click', () => proceedWithTab(tab.id, tab.title, item));
            pickerWrap.appendChild(item);
        }
        bubble.appendChild(pickerWrap);
    }

    // ── Cancel ───────────────────────────────────────────────────────────────
    const footRow = document.createElement('div');
    footRow.className = 'sp-tab-disambig-row';
    footRow.style.marginTop = '10px';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'sp-tab-disambig-btn cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => {
        wrap.remove();
        const sb = $('chat-send-btn'), inp = $('chat-input');
        if (sb)  sb.disabled  = !inp?.value.trim();
        if (inp) { inp.disabled = false; inp.focus(); }
    });
    footRow.appendChild(cancelBtn);
    bubble.appendChild(footRow);

    wrap.appendChild(bubble);
    msgList.appendChild(wrap);
    msgList.scrollTop = msgList.scrollHeight;
}

// ── Tab ambiguity dialog ──────────────────────────────────────────────────────
// Shown when the routing would auto-inject context tab(s) (Rules A/D) so the
// user can confirm they mean the tab in context, or switch to a different tab.
async function showTabAmbiguityDialog(originalText, sess) {
    const msgList = $('chat-messages');
    const empty   = $('chat-empty');
    if (empty) empty.style.display = 'none';

    const wrap   = document.createElement('div');
    wrap.className = 'chat-msg assistant';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble sp-tab-disambig';
    bubble.style.cssText = 'border-color:rgba(66,133,244,0.3);';

    // ── shared proceed helper ────────────────────────────────────────────────
    const proceed = async (specificTabsChoice) => {
        wrap.remove();
        const sendBtn = $('chat-send-btn');
        const input   = $('chat-input');
        if (sendBtn) sendBtn.disabled = true;
        if (input)   input.disabled  = true;
        const currentSess = getActiveSession() || sess;
        if (multiAgentEnabled && selectedAgents.size >= 2) {
            await _sendMultiAgent(currentSess, originalText, true, specificTabsChoice);
        } else {
            await _sendSingle(currentSess, originalText, true, specificTabsChoice);
        }
        updateStatsBar(currentSess);
        saveSessions();
        if (sendBtn) sendBtn.disabled = !$('chat-input')?.value.trim();
        if (input)   { input.disabled = false; input.focus(); }
    };

    // ── Question ─────────────────────────────────────────────────────────────
    const question = document.createElement('p');
    question.style.cssText = 'margin:0 0 10px;color:var(--text);font-size:12.5px;';
    const ctxCount  = tabContexts.length;
    const firstName = ctxCount === 1 ? _clampStr(tabContexts[0].title || tabContexts[0].url, 45) : null;
    question.textContent = firstName
        ? `Your question mentions a tab. Did you mean "${firstName}"?`
        : `Your question mentions a tab. Which of your ${ctxCount} context tabs did you mean?`;
    bubble.appendChild(question);

    // ── Buttons row ──────────────────────────────────────────────────────────
    const row = document.createElement('div');
    row.className = 'sp-tab-disambig-row';
    bubble.appendChild(row);

    const tabIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
    const tabsIcon = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>`;

    // One button per context tab
    for (const ctx of tabContexts) {
        const btn = document.createElement('button');
        btn.className = 'sp-tab-disambig-btn ctx';
        btn.title = ctx.url || '';
        btn.innerHTML = `${tabIcon} ${escHtml(_clampStr(ctx.title || ctx.url || 'Tab', 32))}`;
        btn.addEventListener('click', () => proceed([ctx]));
        row.appendChild(btn);
    }

    // "Different tab" picker button
    const pickBtn = document.createElement('button');
    pickBtn.className = 'sp-tab-disambig-btn pick';
    pickBtn.innerHTML = `${tabsIcon} Different tab`;
    row.appendChild(pickBtn);

    // Cancel
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'sp-tab-disambig-btn cancel';
    cancelBtn.textContent = 'Cancel';
    row.appendChild(cancelBtn);

    // ── Open-tabs picker (revealed on "Different tab") ────────────────────
    const pickerWrap = document.createElement('div');
    pickerWrap.className = 'sp-tab-disambig-picker hidden';
    bubble.appendChild(pickerWrap);

    pickBtn.addEventListener('click', async () => {
        if (!pickerWrap.classList.contains('hidden')) return;
        pickBtn.disabled    = true;
        pickBtn.textContent = 'Loading\u2026';
        let openTabs = [];
        try {
            openTabs = (await chrome.tabs.query({ windowId: await getBrowserWindowId() }))
                .filter(t => isReadableUrl(t.url));
        } catch { /* extension API unavailable */ }
        pickBtn.disabled = false;
        pickBtn.innerHTML = `${tabsIcon} Different tab`;

        pickerWrap.innerHTML = '';
        if (!openTabs.length) {
            const none = document.createElement('p');
            none.style.cssText = 'font-size:11.5px;color:var(--text-muted);margin:8px 0 0;';
            none.textContent = 'No other readable tabs open.';
            pickerWrap.appendChild(none);
            pickerWrap.classList.remove('hidden');
            msgList.scrollTop = msgList.scrollHeight;
            return;
        }

        const hdr = document.createElement('p');
        hdr.style.cssText = 'font-size:11px;color:var(--text-muted);margin:8px 0 4px;';
        hdr.textContent = 'Select a tab to use:';
        pickerWrap.appendChild(hdr);

        for (const tab of openTabs) {
            const item = document.createElement('button');
            item.className = 'sp-tab-disambig-open-item';
            let hostname = '';
            try { hostname = new URL(tab.url).hostname.replace(/^www\./, ''); } catch {}
            item.innerHTML = `<span class="sp-tab-disambig-open-title">${escHtml(_clampStr(tab.title || hostname, 40))}</span>`
                           + `<span class="sp-tab-disambig-open-host">${escHtml(hostname)}</span>`;

            item.addEventListener('click', async () => {
                pickerWrap.querySelectorAll('button').forEach(b => { b.disabled = true; });
                item.textContent = 'Reading\u2026';
                const alreadyCtx = tabContexts.find(c => c.tabId === tab.id);
                if (alreadyCtx) { await proceed([alreadyCtx]); return; }
                const loadingEl = createReadingBubble();
                try {
                    const data = await bgReadTab(tab.id);
                    addTabToContext(tab.id, data);
                    loadingEl.remove();
                    const ctx = tabContexts.find(c => c.tabId === tab.id);
                    await proceed(ctx ? [ctx] : null);
                } catch (e) {
                    loadingEl.remove();
                    appendErrorBubble(`Could not read "${tab.title}": ${e.message}`);
                    wrap.remove();
                    const sb = $('chat-send-btn'), inp = $('chat-input');
                    if (sb)  sb.disabled  = !inp?.value.trim();
                    if (inp) { inp.disabled = false; inp.focus(); }
                }
            });
            pickerWrap.appendChild(item);
        }
        pickerWrap.classList.remove('hidden');
        msgList.scrollTop = msgList.scrollHeight;
    });

    cancelBtn.addEventListener('click', () => {
        wrap.remove();
        appendConfirmBubble('Cancelled.');
        const sb = $('chat-send-btn'), inp = $('chat-input');
        if (sb)  sb.disabled  = !inp?.value.trim();
        if (inp) { inp.disabled = false; inp.focus(); }
    });

    wrap.appendChild(bubble);
    msgList.appendChild(wrap);
    msgList.scrollTop = msgList.scrollHeight;
}

// Clamp a string to maxLen chars with an ellipsis.
function _clampStr(str, maxLen) {
    if (!str) return '';
    return str.length > maxLen ? str.slice(0, maxLen - 1) + '\u2026' : str;
}

// ── Permission bubble — ask user before reading a tab ────────────────────────
async function askTabReadPermission(originalText, sess) {
    // Resolve current tab NOW and lock it in — do not re-query on button click.
    // This prevents the tabId from changing between when the bubble is shown
    // and when the user clicks "Read".
    let lockedTabId  = null;
    let lockedTabUrl = null;
    try {
        const info = await Promise.race([
            chrome.runtime.sendMessage({ type: 'getActiveTabId' }),
            new Promise((_, rej) => setTimeout(() => rej(), 1500)),
        ]).catch(() => null);
        if (info?.tabId && isReadableUrl(info?.tabUrl)) {
            lockedTabId  = info.tabId;
            lockedTabUrl = info.tabUrl;
        }
    } catch { /* ignore */ }

    const hasCurrentTab  = !!lockedTabId;
    const hasContextTabs = tabContexts.length > 0;

    const msgList = $('chat-messages');
    const empty   = $('chat-empty');
    if (empty) empty.style.display = 'none';

    const div = document.createElement('div');
    div.className = 'chat-msg assistant sp-perm-bubble';

    let hostnameDisplay = '';
    if (hasCurrentTab) {
        try { hostnameDisplay = new URL(lockedTabUrl).hostname; } catch { hostnameDisplay = lockedTabUrl; }
    }

    let buttonsHtml = '';
    if (hasCurrentTab) {
        buttonsHtml += `<button class="sp-perm-yes" style="background:rgba(66,133,244,0.15);border:1px solid rgba(66,133,244,0.35);border-radius:7px;padding:5px 12px;cursor:pointer;color:#7aadff;font-size:12px;">
            Read <strong>${escHtml(hostnameDisplay)}</strong>
        </button>`;
    }
    if (hasContextTabs) {
        buttonsHtml += `<button class="sp-perm-use-ctx" style="background:rgba(76,175,80,0.12);border:1px solid rgba(76,175,80,0.3);border-radius:7px;padding:5px 12px;cursor:pointer;color:#81c784;font-size:12px;">
            Use ${tabContexts.length} tab${tabContexts.length > 1 ? 's' : ''} already in context
        </button>`;
    }
    buttonsHtml += `<button class="sp-perm-no" style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:7px;padding:5px 12px;cursor:pointer;color:var(--text-muted);font-size:12px;">Cancel</button>`;

    const question = hasCurrentTab
        ? `To summarize, I need to read a tab. Current tab: <strong>${escHtml(hostnameDisplay)}</strong>`
        : `No readable tab found. Open a web page and try again, or use the Tabs panel (\u229e) to add tabs to context.`;

    div.innerHTML = `
        <div class="chat-bubble" style="border-color:rgba(66,133,244,0.25);">
            <p style="margin:0 0 10px;color:var(--text);">${question}</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">${buttonsHtml}</div>
        </div>`;
    msgList.appendChild(div);
    msgList.scrollTop = msgList.scrollHeight;

    const proceed = async () => {
        div.remove();
        const sendBtn = $('chat-send-btn');
        const input   = $('chat-input');
        if (sendBtn) sendBtn.disabled = true;
        if (input)   input.disabled  = true;
        const currentSess = getActiveSession() || sess;
        // User has explicitly consented → always inject SOURCE blocks
        if (multiAgentEnabled && selectedAgents.size >= 2) {
            await _sendMultiAgent(currentSess, originalText, true);
        } else {
            await _sendSingle(currentSess, originalText, true);
        }
        updateStatsBar(currentSess);
        saveSessions();
        if (sendBtn) sendBtn.disabled = !input?.value.trim();
        if (input)   { input.disabled = false; input.focus(); }
    };

    div.querySelector('.sp-perm-yes')?.addEventListener('click', async () => {
        const btn = div.querySelector('.sp-perm-yes');
        btn.disabled = true;
        btn.textContent = 'Reading…';
        // Use the LOCKED tabId — not a fresh query — so we always read the tab
        // that was shown to the user in this bubble.
        const loadingEl = createReadingBubble();
        try {
            const data = await bgReadTab(lockedTabId);
            addTabToContext(lockedTabId, data);
            loadingEl.remove();
            await proceed();
        } catch (e) {
            loadingEl.remove();
            appendErrorBubble(`Tab read failed: ${e.message}`);
            div.remove();
        }
    });

    div.querySelector('.sp-perm-use-ctx')?.addEventListener('click', proceed);

    div.querySelector('.sp-perm-no')?.addEventListener('click', () => {
        div.remove();
        appendConfirmBubble('Cancelled. Add a tab via the Tabs panel (\u229e) first.');
    });
}

// ── Send message ──────────────────────────────────────────────────────────────
async function sendMessage(text) {
    if (!text.trim()) return;
    const sess = ensureSession();

    const userMsg = {
        id:      `m_${Date.now()}`,
        role:    'user',
        content: text.trim(),
        ts:      Date.now(),
    };
    sess.messages.push(userMsg);
    appendMessage(userMsg);
    if (!sess.title) sess.title = text.trim().slice(0, 60);

    const sendBtn = $('chat-send-btn');
    const input   = $('chat-input');
    if (sendBtn) sendBtn.disabled = true;
    if (input)   input.disabled  = true;

    // ── Step 1: intercept hard tab commands (open, close, list) ─────────────
    const intent = await interceptTabIntent(text);

    if (intent.action === 'cancelled') {
        saveSessions();
        if (sendBtn) sendBtn.disabled = !input?.value.trim();
        if (input)   { input.disabled = false; input.focus(); }
        return;
    }
    if (intent.action === 'listTabs') {
        // Tab list has already been added to tabListContext; show a brief
        // confirmation then fall through so the AI answers the original message.
        appendConfirmBubble(`${intent.count} tab${intent.count !== 1 ? 's' : ''} shared with AI as context.`);
    }
    if (intent.action === 'openTab') {
        appendConfirmBubble(`Opened new tab: ${intent.url}`);
        saveSessions();
        if (sendBtn) sendBtn.disabled = !input?.value.trim();
        if (input)   { input.disabled = false; input.focus(); }
        return;
    }
    if (intent.action === 'closeTab') {
        appendConfirmBubble(`Closed tab: "${intent.title}"`);
        saveSessions();
        if (sendBtn) sendBtn.disabled = !input?.value.trim();
        if (input)   { input.disabled = false; input.focus(); }
        return;
    }
    if (intent.action === 'closeTabError') {
        appendErrorBubble(`Could not close tab: ${intent.error}`);
        if (sendBtn) sendBtn.disabled = !input?.value.trim();
        if (input)   { input.disabled = false; input.focus(); }
        return;
    }
    if (intent.action === 'readTabFailed') {
        saveSessions();
        if (sendBtn) sendBtn.disabled = !input?.value.trim();
        if (input)   { input.disabled = false; input.focus(); }
        return;
    }

    // ── Step 2: determine whether and what tab content to inject ────────────
    //
    // Rule A — "Summarize this tab" with tabs already in context → inject all context tabs.
    // Rule B — "Summarize this tab" with NO context             → ask permission first.
    // Rule C — User mentions a SPECIFIC tab by name             → auto-read it if needed,
    //           then inject only the referenced tab(s).
    // Rule D — Generic content query ("key points", "what does this page say")
    //           with tabs already in context                    → inject all context tabs.
    // Rule E — General question (capital of France, etc.)       → no SOURCE injection;
    //           answer from model's own knowledge.
    // Rule F — Generic content query with NO context tab        → force tab selection;
    //           the model NEVER answers a tab question without real tab content.
    //
    let injectTabContent = false;
    let specificTabs     = null;  // null = use all tabContexts; array = use only these

    if (intent.action === 'awaitPermission') {
        // Rule B — show consent bubble; _sendSingle will be called from proceed()
        // with injectTabContent=true once the user clicks "Read".
        askTabReadPermission(text, sess);
        saveSessions();
        if (sendBtn) sendBtn.disabled = !input?.value.trim();
        if (input)   { input.disabled = false; input.focus(); }
        return;
    }

    if (intent.action === 'readTab') {
        // Rule A — tabs are in context, message is a summarize/read command
        injectTabContent = true;
    } else {
        // Rules C / D / E — determine based on what the message references

        // Rule C: does the message name a specific tab (by hostname or title word)?
        const referencedOpen = await findOpenTabsReferencedInText(text);
        if (referencedOpen.length > 0) {
            // Auto-read any referenced tab not yet in the context pills
            for (const openTab of referencedOpen) {
                const alreadyAdded = tabContexts.some(c => c.tabId === openTab.id);
                if (!alreadyAdded) {
                    const loadingEl = createReadingBubble();
                    try {
                        const data = await bgReadTab(openTab.id);
                        addTabToContext(openTab.id, data);
                        loadingEl.remove();
                    } catch (e) {
                        loadingEl.remove();
                        appendErrorBubble(`Could not read "${openTab.title}": ${e.message}`);
                    }
                }
            }
            // Build specificTabs from the context pills that correspond to referenced tabs
            specificTabs = referencedOpen
                .map(t => tabContexts.find(c => c.tabId === t.id))
                .filter(Boolean);
            if (specificTabs.length > 0) injectTabContent = true;
        } else if (isTabContentQuery(text) && tabContexts.length > 0) {
            // Rule D — generic content question with tabs in context
            injectTabContent = true;
        } else if (isTabContentQuery(text)) {
            // Rule F — tab-referencing query but NO context tab → force the user to
            // pick which tab they mean before any AI call is made (prevents hallucination).
            showNoContextTabPicker(text.trim(), sess);
            saveSessions();
            if (sendBtn) sendBtn.disabled = !input?.value.trim();
            if (input)   { input.disabled = false; input.focus(); }
            return;
        }
        // else Rule E — general question, injectTabContent stays false
    }

    // ── Step 3: send to AI ──────────────────────────────────────────────────
    // When Rules A or D would auto-inject the context tab(s) (specificTabs is
    // still null — user has not explicitly named a different tab via Rule C),
    // ask which tab they mean before proceeding.
    if (injectTabContent && specificTabs === null) {
        showTabAmbiguityDialog(text.trim(), sess);
        saveSessions();
        if (sendBtn) sendBtn.disabled = !input?.value.trim();
        if (input)   { input.disabled = false; input.focus(); }
        return;
    }

    if (multiAgentEnabled && selectedAgents.size >= 2) {
        await _sendMultiAgent(sess, text.trim(), injectTabContent, specificTabs);
    } else {
        await _sendSingle(sess, text.trim(), injectTabContent, specificTabs);
    }
    updateStatsBar(sess);
    saveSessions();

    if (sendBtn) sendBtn.disabled = !input?.value.trim();
    if (input)   { input.disabled = false; input.focus(); }
}

// ── Stream state helpers ──────────────────────────────────────────────────────
function setStreaming(on) {
    const send = $('chat-send-btn');
    const stop = $('chat-stop-btn');
    if (!send || !stop) return;
    if (on) {
        send.classList.add('hidden');
        stop.classList.remove('hidden');
    } else {
        stop.classList.add('hidden');
        send.classList.remove('hidden');
    }
}

// ── Single-model send ─────────────────────────────────────────────────────────
async function _sendSingle(sess, text, injectTabContent = false, specificTabs = null) {
    const key = apiKeys[activeProvider];
    if (!key) {
        appendErrorBubble(
            `No API key for ${AI_PROVIDERS[activeProvider]?.label || activeProvider}. Add one in Settings.`,
            activeProvider
        );
        return;
    }

    // If we're supposed to inject tab content but none of the relevant tabs have
    // extractable text, refuse rather than letting the model hallucinate.
    const ctxToUse = specificTabs ?? tabContexts;
    if (injectTabContent && ctxToUse.length > 0 && ctxToUse.every(c => !c.text?.trim())) {
        appendErrorBubble(
            `No readable text was extracted from ${ctxToUse.length === 1 ? 'the tab' : 'any tab'} in context. ` +
            `Try removing the tab (×) and re-reading it, or check that the page has finished loading.`
        );
        return;
    }

    const messages   = buildMessages(sess, injectTabContent, specificTabs);
    // Diagnostic: print the full message array to DevTools console so the
    // exact content sent to the LLM is always inspectable.
    console.log('[Tabaisco] sending to', activeProvider, activeModelId,
        '| injectTabContent:', injectTabContent,
        '| contexts:', (specificTabs ?? tabContexts).map(c => ({ id: c.tabId, title: c.title, chars: c.text?.length })),
        '| messages:', messages);

    // Tag the last user message with the tab IDs being injected so that
    // removing a tab from context can prune the messages that used it.
    if (injectTabContent && ctxToUse.length > 0) {
        const injectedIds = ctxToUse.map(c => c.tabId);
        const lastUser = [...sess.messages].reverse().find(m => m.role === 'user');
        if (lastUser) lastUser._tabIds = injectedIds;
    }
    const typingEl   = createTypingIndicator(activeProvider);
    abortController  = new AbortController();
    setStreaming(true);
    const t0         = Date.now();
    let fullText      = '';
    let thinkingText  = '';
    let reasoningEl   = null;
    let reasoningBody = null;
    let reasoningLoader = null;
    const contentEl  = document.createElement('div');
    contentEl.className = 'chat-content';
    let firstChunk   = true;

    await streamChat(activeProvider, activeModelId, key, messages, {
        signal:    abortController.signal,
        reasoning: reasoningEnabled,
        onThinking(chunk) {
            thinkingText += chunk;
            if (!reasoningEl) {
                reasoningEl = document.createElement('div');
                reasoningEl.className = 'chat-reasoning chat-reasoning--live';

                // Header row: loader word + label
                const header = document.createElement('div');
                header.className = 'chat-reasoning-header';

                reasoningLoader = document.createElement('span');
                reasoningLoader.className = 'chat-reasoning-loader';
                reasoningLoader.textContent = 'Thinking';

                const label = document.createElement('span');
                label.className = 'chat-reasoning-label';
                label.textContent = 'Reasoning…';

                header.appendChild(reasoningLoader);
                header.appendChild(label);

                reasoningBody = document.createElement('div');
                reasoningBody.className = 'chat-reasoning-body';

                reasoningEl.appendChild(header);
                reasoningEl.appendChild(reasoningBody);

                const msgList = $('chat-messages');
                msgList.insertBefore(reasoningEl, typingEl);
            }
            reasoningBody.textContent = thinkingText;
            scrollToBottom();
        },
        onChunk(chunk) {
            // Hide reasoning card as soon as first response token arrives
            if (reasoningEl && reasoningEl.classList.contains('chat-reasoning--live')) {
                reasoningEl.classList.remove('chat-reasoning--live');
                reasoningEl.classList.add('chat-reasoning--done');
                // Fade it out then remove
                reasoningEl.addEventListener('animationend', () => reasoningEl.remove(), { once: true });
            }
            fullText += chunk;
            if (firstChunk) {
                firstChunk = false;
                typingEl.replaceWith((() => {
                    const wrap = document.createElement('div');
                    wrap.className = 'chat-msg assistant chat-streaming-wrap';
                    const header = document.createElement('div');
                    header.className = 'chat-msg-header';
                    const avatar = document.createElement('span');
                    avatar.className = 'chat-msg-avatar';
                    avatar.dataset.provider = activeProvider;
                    header.appendChild(avatar);
                    header.appendChild(Object.assign(document.createElement('span'), {
                        textContent: AI_PROVIDERS[activeProvider]?.label || 'AI',
                    }));
                    const bubble = document.createElement('div');
                    bubble.className = 'chat-bubble';
                    bubble.appendChild(contentEl);
                    wrap.appendChild(header);
                    wrap.appendChild(bubble);
                    return wrap;
                })());
            }
            contentEl.innerHTML = renderMarkdown(fullText);
            scrollToBottom();
        },
        onDone(usage) {
            setStreaming(false);
            const ms        = Date.now() - t0;
            const cost      = estimateCost(activeProvider, activeModelId, usage.in, usage.out);
            const modelInfo = AI_PROVIDERS[activeProvider]?.models.find(m => m.id === activeModelId);
            // Remove reasoning card if still visible (e.g. model didn't emit chunks)
            if (reasoningEl) reasoningEl.remove();
            const msg = {
                id:         `m_${Date.now()}`,
                role:       'assistant',
                content:    fullText,
                provider:   activeProvider,
                modelId:    activeModelId,
                modelLabel: modelInfo?.label || activeModelId,
                tokensIn:   usage.in,
                tokensOut:  usage.out,
                cost, ms,
                ts:         Date.now(),
            };
            // Mirror the tab tag so pruning removes this response alongside its question.
            if (injectTabContent && ctxToUse.length > 0) {
                msg._tabIds = ctxToUse.map(c => c.tabId);
            }
            sess.messages.push(msg);
            sess.tokensIn  += usage.in  || 0;
            sess.tokensOut += usage.out || 0;
            const streamWrap = document.querySelector('.chat-streaming-wrap');
            if (streamWrap) {
                streamWrap.classList.remove('chat-streaming-wrap');
                const footer = document.createElement('div');
                footer.className = 'chat-msg-footer';
                footer.textContent = `${formatTokens(usage.in)} in · ${formatTokens(usage.out)} out${cost ? ' · ' + cost : ''} · ${(ms/1000).toFixed(1)}s`;
                streamWrap.appendChild(footer);
            }
        },
        onError(err) {
            setStreaming(false);
            if (reasoningEl) reasoningEl.remove();
            typingEl.remove();
            appendErrorBubble(`Error: ${err}`);
        },
    });
}

// ── Multi-agent parallel send ─────────────────────────────────────────────────
async function _sendMultiAgent(sess, text, injectTabContent = false, specificTabs = null) {
    const agents = [...selectedAgents].map(key => {
        const [provider, modelId] = key.split('/');
        return { provider, modelId };
    });

    const missing = agents.filter(a => !apiKeys[a.provider]);
    if (missing.length) {
        const names = missing.map(a => AI_PROVIDERS[a.provider]?.label || a.provider).join(', ');
        appendErrorBubble(
            `Missing API keys for: ${names}. Add them in Settings.`,
            missing[0].provider
        );
        return;
    }

    const ctxToUse = specificTabs ?? tabContexts;
    if (injectTabContent && ctxToUse.length > 0 && ctxToUse.every(c => !c.text?.trim())) {
        appendErrorBubble(
            `No readable text was extracted from ${ctxToUse.length === 1 ? 'the tab' : 'any tab'} in context. ` +
            `Try removing the tab (×) and re-reading it, or check that the page has finished loading.`
        );
        return;
    }

    const messages    = buildMessages(sess, injectTabContent, specificTabs);

    // Tag the last user message with injected tab IDs (same as _sendSingle).
    if (injectTabContent && ctxToUse.length > 0) {
        const injectedIds = ctxToUse.map(c => c.tabId);
        const lastUser = [...sess.messages].reverse().find(m => m.role === 'user');
        if (lastUser) lastUser._tabIds = injectedIds;
    }

    const compareRow  = document.createElement('div');
    compareRow.className = 'chat-compare-row';
    const msgList = $('chat-messages');
    const empty   = $('chat-empty');
    if (empty) empty.style.display = 'none';
    msgList.appendChild(compareRow);
    msgList.scrollTop = msgList.scrollHeight;

    const promises = agents.map(({ provider, modelId }) => {
        const modelInfo = AI_PROVIDERS[provider]?.models.find(m => m.id === modelId);

        const col = document.createElement('div');
        col.className = 'chat-compare-col';

        const colHeader = document.createElement('div');
        colHeader.className = 'chat-compare-col-header';
        const dot = document.createElement('span');
        dot.className = 'chat-provider-dot';
        dot.dataset.provider = provider;
        colHeader.appendChild(dot);
        colHeader.appendChild(Object.assign(document.createElement('span'), {
            textContent: modelInfo?.label || modelId,
        }));

        const colBody = document.createElement('div');
        colBody.className = 'chat-compare-col-body';
        colBody.innerHTML = '<span class="chat-typing"><span></span><span></span><span></span></span>';

        const colFooter = document.createElement('div');
        colFooter.className = 'chat-compare-col-footer';

        col.appendChild(colHeader);
        col.appendChild(colBody);
        col.appendChild(colFooter);
        compareRow.appendChild(col);

        let fullText  = '';
        let firstChunk = true;
        const t0 = Date.now();

        return streamChat(provider, modelId, apiKeys[provider], messages, {
            onChunk(chunk) {
                fullText += chunk;
                if (firstChunk) { firstChunk = false; colBody.innerHTML = ''; }
                colBody.innerHTML = renderMarkdown(fullText);
                msgList.scrollTop = msgList.scrollHeight;
            },
            onDone(usage) {
                const ms   = Date.now() - t0;
                const cost = estimateCost(provider, modelId, usage.in, usage.out);
                colFooter.textContent = `${formatTokens(usage.in)} in · ${formatTokens(usage.out)} out${cost ? ' · ' + cost : ''} · ${(ms/1000).toFixed(1)}s`;
                const assistantMsg = {
                    id:         `m_${Date.now()}_${provider}`,
                    role:       'assistant',
                    content:    fullText,
                    provider,
                    modelId,
                    modelLabel: modelInfo?.label || modelId,
                    tokensIn:   usage.in  || 0,
                    tokensOut:  usage.out || 0,
                    cost, ms,
                    ts:         Date.now(),
                };
                if (injectTabContent && ctxToUse.length > 0) {
                    assistantMsg._tabIds = ctxToUse.map(c => c.tabId);
                }
                sess.messages.push(assistantMsg);
                sess.tokensIn  += usage.in  || 0;
                sess.tokensOut += usage.out || 0;
            },
            onError(err) {
                colBody.textContent = `Error: ${err}`;
                colBody.style.color = 'var(--accent)';
            },
        });
    });

    await Promise.allSettled(promises);
}

// ── Build messages array ──────────────────────────────────────────────────────
// injectTabContent — whether to inject SOURCE blocks (only when msg is about the page).
// specificTabs    — if provided, use only those tab contexts instead of all tabContexts.
function buildMessages(sess, injectTabContent = false, specificTabs = null) {
    const msgs = [];

    const contexts     = specificTabs ?? tabContexts;
    const hasTabContent = injectTabContent && contexts.length > 0;

    if (hasTabContent) {
        // ── STRICT RAG MODE ─────────────────────────────────────────────────────
        // We use a SHORT system prompt and embed the page content INSIDE the user
        // message. All major LLMs (GPT-4o, Claude, Gemini) are far more reliable
        // about using content in the user turn than content in system messages.
        msgs.push({
            role: 'system',
            content:
`You are Tabaisco, a browser reading assistant. The user has pulled page content from their
browser tabs and will paste it into their message. Your job is to answer their question
using only that provided content — not your training data.`,
        });

    } else {
        // ── GENERAL MODE (no tabs in context) ────────────────────────────────────
        msgs.push({
            role: 'system',
            content:
`You are Tabaisco AI, a browser-aware AI companion built into a Chrome extension.
- Tab actions (open, close) are already executed before this message. Do not say you will do them.
- Never claim you cannot access the browser.`,
        });

        // Tab list only makes sense in general mode (no page content loaded)
        if (tabListContext?.length) {
            const lines = tabListContext.map((t, i) =>
                `${i + 1}. ${t.title || '(no title)'} — ${t.url}${t.active ? ' [active]' : ''} (id:${t.id})`
            ).join('\n');
            msgs.push({
                role: 'system',
                content: `The user's open browser tabs:\n${lines}`,
            });
        }
    }

    // ── Conversation history ─────────────────────────────────────────────────
    // In RAG mode the LAST user turn is rewritten to embed all page content
    // directly inline. Putting the document content in the user message is the
    // most reliable cross-model technique: GPT-4o, Claude, Gemini all attend to
    // it consistently, unlike long system-prompt blocks which models can ignore.
    const history = sess.messages.slice(-20).filter(m => m.role === 'user' || m.role === 'assistant');
    history.forEach((m, idx) => {
        if (hasTabContent && m.role === 'user' && idx === history.length - 1) {
            // Build the inline document section
            const docSection = contexts.map((ctx, i) => {
                const heading = contexts.length > 1
                    ? `--- PAGE ${i + 1} OF ${contexts.length} ---`
                    : '--- PAGE CONTENT ---';
                const lines = [
                    heading,
                    `Title: ${ctx.title}`,
                    `URL:   ${ctx.url}`,
                ];
                if (ctx.meta?.trim()) lines.push(`Meta:  ${ctx.meta}`);
                if (ctx.text?.trim()) {
                    lines.push('', ctx.text);
                } else {
                    lines.push('', '(No readable body text was extracted from this page. Answer using the title and meta description only.)');
                }
                return lines.join('\n');
            }).join('\n\n');

            msgs.push({
                role: 'user',
                content:
`Here is the web page content I loaded in my browser:\n\n${docSection}\n\n--- END OF PAGE CONTENT ---\n\nUsing ONLY the page content above (not your training data), please: ${m.content}`,
            });
        } else {
            msgs.push({ role: m.role, content: m.content });
        }
    });

    return msgs;
}

// ── Error bubble ──────────────────────────────────────────────────────────────
// Pass an optional `actionProvider` to render a clickable "Add key →" button
// that opens Settings and scrolls to that provider's key input.
function appendErrorBubble(text, actionProvider) {
    const msg   = $('chat-messages');
    const empty = $('chat-empty');
    if (empty) empty.style.display = 'none';
    const div = document.createElement('div');
    div.className = 'chat-msg assistant';
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.style.cssText = 'color:var(--accent);border-color:rgba(232,66,66,0.3);';
    bubble.textContent = text;
    if (actionProvider) {
        const btn = document.createElement('button');
        btn.className = 'chat-error-settings-btn';
        btn.textContent = 'Add key \u2192';
        btn.addEventListener('click', () => {
            openSettingsPanel();
            focusProviderKey(actionProvider);
        });
        bubble.appendChild(btn);
    }
    div.appendChild(bubble);
    msg.appendChild(div);
    msg.scrollTop = msg.scrollHeight;
}

// ── Stats bar ─────────────────────────────────────────────────────────────────
function updateStatsBar(sess) {
    const bar = $('chat-stats-bar');
    if (!bar || !sess) return;
    if (!sess.tokensIn && !sess.tokensOut) { bar.textContent = ''; return; }
    const cost = estimateCost(sess.provider, sess.modelId, sess.tokensIn, sess.tokensOut);
    bar.textContent = `Session: ${formatTokens(sess.tokensIn)} in · ${formatTokens(sess.tokensOut)} out${cost ? ' · ~' + cost : ''}`;
}

// ── Model selector ────────────────────────────────────────────────────────────
function buildModelDropdown() {
    const dropdown = $('chat-model-dropdown');
    dropdown.innerHTML = '';
    for (const [provKey, prov] of Object.entries(AI_PROVIDERS)) {
        const hdr = Object.assign(document.createElement('div'), {
            className: 'chat-model-group-header',
            textContent: prov.label,
        });
        dropdown.appendChild(hdr);
        for (const model of prov.models) {
            const row = document.createElement('div');
            row.className = 'chat-model-option';
            row.setAttribute('role', 'option');
            const hasKey = !!apiKeys[provKey];
            if (!hasKey) row.classList.add('no-key');
            if (provKey === activeProvider && model.id === activeModelId) row.classList.add('selected');

            const dot = document.createElement('span');
            dot.className = 'chat-provider-dot';
            dot.dataset.provider = provKey;

            const label = Object.assign(document.createElement('span'), { textContent: model.label });

            const ctx = document.createElement('span');
            ctx.className = 'chat-ctx-badge';
            ctx.textContent = model.ctx;

            row.appendChild(dot);
            row.appendChild(label);
            row.appendChild(ctx);

            row.addEventListener('click', () => {
                if (!hasKey) {
                    // Pre-select this model so when the key is saved it activates
                    activeProvider = provKey;
                    activeModelId  = model.id;
                    closeModelDropdown();
                    openSettingsPanel();
                    focusProviderKey(provKey);
                    return;
                }
                activeProvider = provKey;
                activeModelId  = model.id;
                updateModelPill();
                closeModelDropdown();
                if (multiAgentEnabled) buildMultiAgentBar();
            });
            dropdown.appendChild(row);
        }
    }
}

function updateModelPill() {
    const pill    = $('chat-model-btn');
    const iconEl  = $('chat-model-icon');
    const labelEl = $('chat-model-label');
    const hasKey  = !!apiKeys[activeProvider];
    if (pill)    pill.classList.toggle('no-key', !hasKey);
    if (iconEl)  iconEl.dataset.provider = hasKey ? activeProvider : 'none';
    if (labelEl) {
        if (!hasKey) {
            labelEl.textContent = 'Select model';
        } else {
            const modelInfo = AI_PROVIDERS[activeProvider]?.models.find(m => m.id === activeModelId);
            labelEl.textContent = modelInfo?.label || activeModelId;
        }
    }
}

function openModelDropdown() {
    buildModelDropdown();
    $('chat-model-dropdown').classList.remove('hidden');
    $('chat-model-btn').setAttribute('aria-expanded', 'true');
}

function closeModelDropdown() {
    $('chat-model-dropdown').classList.add('hidden');
    $('chat-model-btn').setAttribute('aria-expanded', 'false');
}

function rebuildDropdownIfOpen() {
    const dd = $('chat-model-dropdown');
    if (dd && !dd.classList.contains('hidden')) buildModelDropdown();
}

// ── Multi-agent bar ───────────────────────────────────────────────────────────
function buildMultiAgentBar() {
    const bar = $('chat-multi-agent-bar');
    bar.innerHTML = '<span style="font-size:11px;color:var(--text-muted);padding:4px 6px;flex-shrink:0;">Compare:</span>';
    for (const [provKey, prov] of Object.entries(AI_PROVIDERS)) {
        for (const model of prov.models) {
            const key    = `${provKey}/${model.id}`;
            const hasKey = !!apiKeys[provKey];
            const chip   = document.createElement('button');
            chip.className = 'chat-agent-chip' +
                (selectedAgents.has(key) ? ' selected' : '') +
                (!hasKey ? ' disabled' : '');
            chip.style.opacity = hasKey ? '1' : '0.4';
            chip.disabled = !hasKey;

            const dot = document.createElement('span');
            dot.className = 'chat-provider-dot';
            dot.dataset.provider = provKey;
            chip.appendChild(dot);
            chip.appendChild(Object.assign(document.createElement('span'), { textContent: model.label }));

            chip.addEventListener('click', () => {
                if (selectedAgents.has(key)) selectedAgents.delete(key);
                else selectedAgents.add(key);
                chip.classList.toggle('selected');
            });
            bar.appendChild(chip);
        }
    }
}

// ── History panel ─────────────────────────────────────────────────────────────
function openHistoryPanel() {
    renderHistoryList();
    $('chat-history-panel').classList.remove('hidden');
    $('chat-settings-panel').classList.add('hidden');
    $('sp-tabs-panel').classList.add('hidden');
}

function closeHistoryPanel() {
    $('chat-history-panel').classList.add('hidden');
}

function renderHistoryList() {
    const list = $('chat-history-list');
    list.innerHTML = '';
    if (!chatSessions.length) {
        list.innerHTML = '<p style="font-size:12.5px;color:var(--text-muted);padding:16px;text-align:center;">No chat history yet.</p>';
        return;
    }
    for (const sess of chatSessions) {
        const item = document.createElement('div');
        item.className = 'chat-history-item' + (sess.id === activeSdession ? ' active' : '');

        const dot = document.createElement('span');
        dot.className = 'chat-history-item-dot chat-provider-dot';
        dot.dataset.provider = sess.provider;

        const title = document.createElement('span');
        title.className = 'chat-history-item-title';
        title.textContent = sess.title || 'Untitled chat';
        title.title = sess.title || '';
        title.addEventListener('dblclick', () => startRenameSession(sess, title));

        const meta = document.createElement('span');
        meta.className = 'chat-history-item-meta';
        meta.textContent = formatRelativeDate(sess.createdAt);

        const del = document.createElement('button');
        del.className = 'chat-history-item-del';
        del.textContent = '×';
        del.title = 'Delete session';
        del.addEventListener('click', e => {
            e.stopPropagation();
            deleteSession(sess.id);
        });

        item.appendChild(dot);
        item.appendChild(title);
        item.appendChild(meta);
        item.appendChild(del);
        item.addEventListener('click', e => {
            if (e.target === del) return;
            loadSession(sess.id);
            closeHistoryPanel();
        });
        list.appendChild(item);
    }
}

function startRenameSession(sess, titleEl) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = sess.title;
    input.className = 'chat-key-input';
    input.style.cssText = 'padding:2px 6px;font-size:13px;';
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = () => {
        sess.title = input.value.trim() || sess.title;
        saveSessions();
        const newTitle = document.createElement('span');
        newTitle.className = 'chat-history-item-title';
        newTitle.textContent = sess.title || 'Untitled chat';
        newTitle.addEventListener('dblclick', () => startRenameSession(sess, newTitle));
        input.replaceWith(newTitle);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter')  input.blur();
        if (e.key === 'Escape') { input.value = sess.title; input.blur(); }
    });
}

function loadSession(id) {
    const sess = chatSessions.find(s => s.id === id);
    if (!sess) return;
    activeSdession = id;
    activeProvider = sess.provider || activeProvider;
    activeModelId  = sess.modelId  || activeModelId;
    updateModelPill();
    renderSessionMessages(sess);
    updateStatsBar(sess);
}

function renderSessionMessages(sess) {
    const list  = $('chat-messages');
    const empty = $('chat-empty');
    list.innerHTML = '';
    if (!sess.messages.length) {
        if (empty) empty.style.display = '';
        return;
    }
    if (empty) empty.style.display = 'none';
    for (const msg of sess.messages) {
        if (msg.role === 'user' || msg.role === 'assistant') {
            list.appendChild(renderMessage(msg));
        }
    }
    list.scrollTop = list.scrollHeight;
}

function deleteSession(id) {
    chatSessions = chatSessions.filter(s => s.id !== id);
    if (activeSdession === id) {
        activeSdession = null;
        $('chat-messages').innerHTML = '';
        const empty = $('chat-empty');
        if (empty) empty.style.display = '';
    }
    saveSessions();
    renderHistoryList();
}

function exportHistory() {
    if (!chatSessions.length) return;
    const json = JSON.stringify(chatSessions, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
        href:     url,
        download: `tabaisco-chat-history-${Date.now()}.json`,
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ── Settings panel ────────────────────────────────────────────────────────────
function openSettingsPanel() {
    buildSettingsBody();
    $('chat-settings-panel').classList.remove('hidden');
    $('chat-history-panel').classList.add('hidden');
    $('sp-tabs-panel').classList.add('hidden');
}

function closeSettingsPanel() {
    $('chat-settings-panel').classList.add('hidden');
}

// Scroll to and highlight the API key input for a given provider inside settings.
function focusProviderKey(provKey) {
    requestAnimationFrame(() => {
        const body = $('chat-settings-body');
        if (!body) return;
        const row = body.querySelector(`.chat-key-row[data-provider="${provKey}"]`);
        if (!row) return;
        row.classList.add('highlight');
        row.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const input = row.querySelector('.chat-key-input');
        if (input) { input.focus(); input.select(); }
        setTimeout(() => row.classList.remove('highlight'), 1600);
    });
}

function buildSettingsBody() {
    const body = $('chat-settings-body');
    body.innerHTML = '';

    // ── Appearance group ──
    const appearGroup = document.createElement('div');
    appearGroup.className = 'chat-settings-group';
    appearGroup.appendChild(Object.assign(document.createElement('div'), {
        className: 'chat-settings-group-title',
        textContent: 'Appearance',
    }));

    const swatchRow = document.createElement('div');
    swatchRow.className = 'theme-swatch-row';

    const activeTheme = document.documentElement.dataset.theme || 'blue';
    THEMES.forEach(t => {
        const btn = document.createElement('button');
        btn.className = 'theme-swatch';
        btn.dataset.themeId = t.id;
        btn.title = t.label;
        btn.setAttribute('aria-label', `${t.label} theme`);
        btn.setAttribute('aria-pressed', t.id === activeTheme ? 'true' : 'false');
        if (t.color) btn.style.background = t.color; // system swatch color handled by CSS
        btn.addEventListener('click', () => applyTheme(t.id));
        swatchRow.appendChild(btn);
    });

    appearGroup.appendChild(swatchRow);
    body.appendChild(appearGroup);

    // ── API Keys group ──
    const keysGroup = document.createElement('div');
    keysGroup.className = 'chat-settings-group';
    const keysTitle = Object.assign(document.createElement('div'), {
        className: 'chat-settings-group-title',
        textContent: 'API Keys',
    });
    keysGroup.appendChild(keysTitle);

    for (const [provKey, prov] of Object.entries(AI_PROVIDERS)) {
        const row = document.createElement('div');
        row.className = 'chat-key-row';
        row.dataset.provider = provKey;

        const label = document.createElement('div');
        label.className = 'chat-key-label';
        const dot = document.createElement('span');
        dot.className = 'chat-provider-dot';
        dot.dataset.provider = provKey;
        label.appendChild(dot);
        label.appendChild(Object.assign(document.createElement('span'), { textContent: prov.label }));

        const input = document.createElement('input');
        input.type = 'password';
        input.className = 'chat-key-input';
        input.placeholder = 'Paste API key…';
        input.value = apiKeys[provKey] || '';
        input.autocomplete = 'off';
        input.spellcheck = false;

        const status = document.createElement('span');
        status.className = 'chat-key-status';
        if (apiKeys[provKey]) { status.textContent = '✓'; status.classList.add('ok'); }

        const actions = document.createElement('div');
        actions.className = 'chat-key-actions';

        const showBtn = document.createElement('button');
        showBtn.className = 'chat-key-btn';
        showBtn.textContent = 'Show';
        showBtn.addEventListener('click', () => {
            input.type = input.type === 'password' ? 'text' : 'password';
            showBtn.textContent = input.type === 'password' ? 'Show' : 'Hide';
        });

        const validateBtn = document.createElement('button');
        validateBtn.className = 'chat-key-btn';
        validateBtn.textContent = 'Validate';
        validateBtn.addEventListener('click', async () => {
            const key = input.value.trim();
            if (!key) return;
            status.textContent = '…';
            status.className = 'chat-key-status busy';
            const result = await validateKey(provKey, key);
            if (result.ok) {
                status.textContent = '✓';
                status.className = 'chat-key-status ok';
                const hadKey = !!apiKeys[activeProvider];
                apiKeys[provKey] = key;
                saveApiKeys(apiKeys);
                if (!hadKey && provKey !== activeProvider) {
                    activeProvider = provKey;
                    activeModelId  = AI_PROVIDERS[provKey].models[0].id;
                }
                updateModelPill();
                rebuildDropdownIfOpen();
            } else {
                status.textContent = '✗';
                status.title = result.error || 'Invalid';
                status.className = 'chat-key-status err';
            }
        });

        const saveBtn = document.createElement('button');
        saveBtn.className = 'chat-key-btn';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', () => {
            const key = input.value.trim();
            const hadKey = !!apiKeys[activeProvider];
            if (key) apiKeys[provKey] = key;
            else delete apiKeys[provKey];
            saveApiKeys(apiKeys);
            status.textContent = key ? '✓' : '';
            status.className = key ? 'chat-key-status ok' : 'chat-key-status';
            if (key && !hadKey && provKey !== activeProvider) {
                activeProvider = provKey;
                activeModelId  = AI_PROVIDERS[provKey].models[0].id;
            }
            updateModelPill();
            rebuildDropdownIfOpen();
        });

        actions.appendChild(showBtn);
        actions.appendChild(validateBtn);
        actions.appendChild(saveBtn);
        row.appendChild(label);
        row.appendChild(input);
        row.appendChild(actions);
        row.appendChild(status);
        keysGroup.appendChild(row);
    }
    body.appendChild(keysGroup);

    // ── Data group ──
    const dataGroup = document.createElement('div');
    dataGroup.className = 'chat-settings-group';
    dataGroup.appendChild(Object.assign(document.createElement('div'), {
        className: 'chat-settings-group-title',
        textContent: 'Data',
    }));

    const clearRow = document.createElement('div');
    clearRow.style.cssText = 'display:flex;gap:8px;padding:8px 4px;';

    const exportBtn = document.createElement('button');
    exportBtn.className = 'chat-action-btn';
    exportBtn.textContent = 'Export all sessions';
    exportBtn.addEventListener('click', exportHistory);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'chat-action-btn danger';
    clearBtn.textContent = 'Clear all sessions';
    clearBtn.addEventListener('click', () => {
        if (!confirm('Delete all chat history? This cannot be undone.')) return;
        chatSessions = [];
        activeSdession = null;
        saveSessions();
        $('chat-messages').innerHTML = '';
        const empty = $('chat-empty');
        if (empty) empty.style.display = '';
        updateStatsBar(null);
        closeSettingsPanel();
    });

    clearRow.appendChild(exportBtn);
    clearRow.appendChild(clearBtn);
    dataGroup.appendChild(clearRow);
    body.appendChild(dataGroup);
}

// ── Tab management ────────────────────────────────────────────────────────────
const BLOCKED_URLS = [
    'chrome://', 'chrome-extension://', 'about:',
    'edge://', 'moz-extension://',
    'https://chromewebstore.google.com',
    'https://chrome.google.com/webstore',
];

function isReadableUrl(url) {
    return url && url.startsWith('http') && !BLOCKED_URLS.some(b => url.startsWith(b));
}

/**
 * Returns the windowId of the last-focused normal browser window.
 * Using chrome.windows.getLastFocused({ windowTypes: ['normal'] }) is the only
 * reliable way to resolve the user's browser window from a side panel context,
 * because lastFocusedWindow:true in tabs.query can resolve to the side panel's
 * own chrome window (which contains zero tabs).
 */
async function getBrowserWindowId() {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    return win?.id;
}

/** Ask background to executeScript on a specific tabId. Returns data or throws. */
async function bgReadTab(tabId) {
    const resp = await Promise.race([
        chrome.runtime.sendMessage({ type: 'readTabContent', tabId }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Background read timed out')), 8000)),
    ]);
    if (!resp?.ok) throw new Error(resp?.error || 'Unknown error from background');
    if (!resp.data) throw new Error('No content returned');
    return resp.data; // { title, url, meta, text }
}

/** Read the currently active tab (tracked by background) and add to context. */
async function readActiveTab(loadingEl) {
    try {
        // Get the tab info from background (persisted via onActivated/onUpdated)
        const info = await Promise.race([
            chrome.runtime.sendMessage({ type: 'getActiveTabId' }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
        ]).catch(() => null);

        const tabId  = info?.tabId;
        const tabUrl = info?.tabUrl;

        if (!tabId || !isReadableUrl(tabUrl)) {
            if (loadingEl) loadingEl.remove();
            appendErrorBubble('Cannot read this tab \u2014 navigate to a regular web page first.');
            return false;
        }

        // Show resolved hostname in loading bubble
        if (loadingEl) {
            const span = loadingEl.querySelector('span:last-child');
            if (span) {
                try { span.textContent = `Reading ${new URL(tabUrl).hostname}\u2026`; }
                catch { span.textContent = 'Reading tab\u2026'; }
            }
        }

        const data = await bgReadTab(tabId);
        addTabToContext(tabId, data);
        if (loadingEl) loadingEl.remove();
        return true;
    } catch (e) {
        if (loadingEl) loadingEl.remove();
        appendErrorBubble(`Tab read failed: ${e.message}`);
        return false;
    }
}

/** Read a specific tab by id (called from tabs panel "Read" button). */
async function readTabById(tabId, tabTitle) {
    try {
        const data = await bgReadTab(tabId);
        addTabToContext(tabId, data);
        // Diagnostic: show how many chars were extracted so extraction failures are obvious
        const chars = data.text?.trim().length ?? 0;
        console.log('[Tabaisco] addTabToContext', {
            tabId,
            title:   data.title,
            url:     data.url,
            chars,
            preview: data.text?.slice(0, 300),
        });
        const panel = $('sp-tabs-panel');
        if (panel && !panel.classList.contains('hidden')) await refreshTabsList();
        appendConfirmBubble(
            `Added to context: \u201c${data.title || tabTitle}\u201d` +
            (chars > 0
                ? ` \u00b7 ${chars.toLocaleString()} chars extracted`
                : ' \u00b7 \u26a0\ufe0f no text extracted \u2014 check the page is loaded')
        );
    } catch (e) {
        appendErrorBubble(`Could not read \u201c${tabTitle}\u201d: ${e.message}`);
    }
}

/** Fetch all open tabs and show them in the tab panel. */
async function openTabsPanel() {
    $('sp-tabs-panel').classList.remove('hidden');
    $('chat-history-panel').classList.add('hidden');
    $('chat-settings-panel').classList.add('hidden');
    await refreshTabsList();
}

async function refreshTabsList() {
    const tabs = await chrome.tabs.query({ windowId: await getBrowserWindowId() });
    const list = $('sp-tabs-list');
    list.innerHTML = '';

    for (const tab of tabs) {
        const isInCtx = tabContexts.some(c => c.tabId === tab.id);
        const row = document.createElement('div');
        row.className = 'sp-tab-row' +
            (tab.active  ? ' active-tab'    : '') +
            (isInCtx     ? ' sp-in-context' : '');

        // Favicon
        let faviconEl;
        if (tab.favIconUrl && !tab.favIconUrl.startsWith('chrome://')) {
            faviconEl = document.createElement('img');
            faviconEl.className = 'sp-tab-favicon';
            faviconEl.src = tab.favIconUrl;
            faviconEl.alt = '';
            faviconEl.onerror = () => { faviconEl.style.display = 'none'; };
        } else {
            faviconEl = document.createElement('div');
            faviconEl.className = 'sp-tab-favicon-placeholder';
            faviconEl.textContent = '🌐';
        }

        const info = document.createElement('div');
        info.className = 'sp-tab-info';

        const titleEl = document.createElement('div');
        titleEl.className = 'sp-tab-title';
        titleEl.textContent = tab.title || '(no title)';
        titleEl.title = tab.title || '';

        const urlEl = document.createElement('div');
        urlEl.className = 'sp-tab-url';
        try { urlEl.textContent = new URL(tab.url || '').hostname || tab.url; }
        catch { urlEl.textContent = tab.url || ''; }

        info.appendChild(titleEl);
        info.appendChild(urlEl);

        const actions = document.createElement('div');
        actions.className = 'sp-tab-actions';

        let readBtn = null;
        if (isReadableUrl(tab.url)) {
            readBtn = document.createElement('button');
            readBtn.className = 'sp-tab-btn read' + (isInCtx ? ' sp-active' : '');
            readBtn.textContent = isInCtx ? '✓ In context' : 'Read';
            readBtn.title = isInCtx ? 'Re-read to refresh context' : 'Read and add to chat context';
            readBtn.addEventListener('click', () => readTabById(tab.id, tab.title));
            actions.appendChild(readBtn);
        }

        // × removes from context only — never closes the browser tab
        const removeBtn = document.createElement('button');
        removeBtn.className = 'sp-tab-btn close' + (isInCtx ? '' : ' sp-dimmed');
        removeBtn.textContent = '×';
        removeBtn.disabled = !isInCtx;
        removeBtn.title = isInCtx ? 'Remove from chat context' : 'Not in context';
        removeBtn.addEventListener('click', () => {
            removeTabFromContext(tab.id);
            row.classList.remove('sp-in-context');
            removeBtn.disabled = true;
            removeBtn.classList.add('sp-dimmed');
            if (readBtn) { readBtn.textContent = 'Read'; readBtn.classList.remove('sp-active'); }
        });
        actions.appendChild(removeBtn);

        row.appendChild(faviconEl);
        row.appendChild(info);
        row.appendChild(actions);
        list.appendChild(row);
    }
}

/** Open a new tab at the given URL. */
async function openNewTab(url) {
    if (!url.trim()) return;
    let normalised = url.trim();
    if (!normalised.startsWith('http://') && !normalised.startsWith('https://')) {
        normalised = 'https://' + normalised;
    }
    try {
        await chrome.tabs.create({ url: normalised });
        updateTabsBadge();
    } catch (e) {
        appendErrorBubble(`Could not open tab: ${e.message}`);
    }
}

/** Refresh the tab count badge on the toolbar button. */
async function updateTabsBadge() {
    try {
        const tabs  = await chrome.tabs.query({ windowId: await getBrowserWindowId() });
        const badge = $('sp-tabs-count');
        if (badge) badge.textContent = tabs.length;
    } catch {
        // non-critical, ignore
    }
}

/** Refresh the badge and re-render tab list if the panel is open. */
async function onTabsChanged() {
    await updateTabsBadge();
    const panel = $('sp-tabs-panel');
    if (panel && !panel.classList.contains('hidden')) {
        await refreshTabsList();
    }
}

// ── Tab context pills ─────────────────────────────────────────────────────────
function updateContextPill() {
    const pill  = $('chat-tab-ctx');
    const label = $('chat-tab-ctx-title');
    if (!pill || !label) return;
    if (tabContexts.length === 0) {
        pill.classList.add('hidden');
    } else if (tabContexts.length === 1) {
        label.textContent = tabContexts[0].title || tabContexts[0].url;
        pill.classList.remove('hidden');
    } else {
        label.textContent = `${tabContexts.length} tabs in context`;
        pill.classList.remove('hidden');
    }
}

// Keep showTabContextPill for any legacy callers
function showTabContextPill(title) { updateContextPill(); }

function clearTabContext() {
    tabContexts = [];
    // Remove all tab-scoped messages from the active session so the model
    // no longer has those exchanges in its context window.
    const sess = getActiveSession();
    if (sess && sess.messages.some(m => m._tabIds?.length)) {
        sess.messages = sess.messages.filter(m => !m._tabIds?.length);
        renderSessionMessages(sess);
        saveSessions();
    }
    updateContextPill();
}

function removeTabFromContext(tabId) {
    tabContexts = tabContexts.filter(c => c.tabId !== tabId);
    // Remove any message pairs that were generated using this tab's content.
    const sess = getActiveSession();
    if (sess && sess.messages.some(m => m._tabIds?.includes(tabId))) {
        sess.messages = sess.messages.filter(m => !m._tabIds?.includes(tabId));
        renderSessionMessages(sess);
        saveSessions();
    }
    updateContextPill();
}

function addTabToContext(tabId, data) {
    // Replace if already present, otherwise append
    tabContexts = tabContexts.filter(c => c.tabId !== tabId);
    tabContexts.push({ tabId, ...data });
    updateContextPill();
}

function setTabListContext(tabs) {
    tabListContext = tabs.map(t => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
    const pill  = $('sp-tablist-ctx');
    const label = $('sp-tablist-ctx-label');
    if (pill)  pill.classList.remove('hidden');
    if (label) label.textContent = `${tabs.length} tabs in context`;
}

function clearTabListContext() {
    tabListContext = null;
    const pill = $('sp-tablist-ctx');
    if (pill) pill.classList.add('hidden');
}

// ── Input auto-grow ───────────────────────────────────────────────────────────
function autoGrowTextarea(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
}

// ── New session ───────────────────────────────────────────────────────────────
function startNewSession() {
    activeSdession = null;
    tabContexts = [];
    updateContextPill();
    $('chat-messages').innerHTML = '';
    const empty = $('chat-empty');
    if (empty) empty.style.display = '';
    updateStatsBar(null);
    const input = $('chat-input');
    if (input) { input.value = ''; autoGrowTextarea(input); input.focus(); }
    const sendBtn = $('chat-send-btn');
    if (sendBtn) sendBtn.disabled = true;
}

// ── Wire up event listeners ───────────────────────────────────────────────────
function initChat() {
    // Populate About panel from STELLA_CONFIG / manifest
    const version = (typeof chrome !== 'undefined' && chrome.runtime?.getManifest)
        ? chrome.runtime.getManifest().version
        : '—';
    const el = id => document.getElementById(id);
    if (el('about-version'))      el('about-version').textContent       = version;
    if (el('about-author-link'))  { el('about-author-link').href = STELLA_CONFIG.author.github; el('about-author-link').textContent = STELLA_CONFIG.author.name; }
    if (el('about-donate-link'))  el('about-donate-link').href          = STELLA_CONFIG.links.paypal;
    if (el('about-privacy-link')) el('about-privacy-link').href         = STELLA_CONFIG.links.privacyPolicy;
    if (el('about-source-link'))  el('about-source-link').href          = STELLA_CONFIG.links.repo;

    // Load API keys
    loadApiKeys(keys => {
        apiKeys = keys;
        if (!apiKeys[activeProvider]) {
            const first = Object.keys(AI_PROVIDERS).find(p => apiKeys[p]);
            if (first) {
                activeProvider = first;
                activeModelId  = AI_PROVIDERS[first].models[0].id;
            }
        }
        updateModelPill();
    });

    // Restore saved theme — default to 'system' on very first run
    chatStore.get(['stellaTheme'], data => {
        if (data.stellaTheme) {
            applyTheme(data.stellaTheme);
        } else {
            // First run: default to system theme so it matches the OS out of the box
            applyTheme('system');
        }
    });

    // Load sessions and restore last active
    loadSessions(sessions => {
        if (sessions.length) {
            chatStore.get(['lastActiveSdession'], data => {
                const lastId = data.lastActiveSdession;
                const found  = lastId && sessions.find(s => s.id === lastId);
                if (found) loadSession(found.id);
            });
        }
    });

    // Initial tab badge
    updateTabsBadge();

    // Track the last tab the user was on so readActiveTab always targets the
    // correct tab, regardless of how focus shifts when the side panel is used.
    //
    // Three events cover all cases:
    //  1. onActivated   — user clicks a different tab in the same window
    //  2. onFocusChanged — user switches to a different browser window
    //     (the previously active tab in that window doesn't re-fire onActivated)
    //  3. onUpdated(complete) — user navigates within the same tab
    //     (tab id stays the same but the page changes; seed it so
    //      we know it's fresh)

    const seedActiveTab = (winId) => {
        if (!winId || winId === chrome.windows?.WINDOW_ID_NONE) return;
        chrome.tabs.query({ active: true, windowId: winId }, ([tab]) => {
            if (tab?.id && isReadableUrl(tab.url)) lastActiveTabId = tab.id;
            else if (tab?.id) lastActiveTabId = tab.id; // track even non-readable, readActiveTab will reject
        });
    };

    if (chrome.tabs?.onActivated) {
        chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
            lastActiveTabId = tabId;
        });
    }

    if (chrome.windows?.onFocusChanged) {
        chrome.windows.onFocusChanged.addListener(windowId => {
            if (windowId === chrome.windows.WINDOW_ID_NONE) return;
            seedActiveTab(windowId);
        });
    }

    if (chrome.tabs?.onUpdated) {
        chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
            // Only update when this tab finishes loading AND it's currently active
            if (changeInfo.status !== 'complete') return;
            chrome.tabs.get(tabId, tab => {
                if (chrome.runtime.lastError) return;
                if (tab?.active) lastActiveTabId = tabId;
            });
        });
    }

    // Seed immediately on panel open
    getBrowserWindowId().then(winId => seedActiveTab(winId)).catch(() => {});

    // Listen for tab changes so badge and panel stay in sync
    if (chrome.tabs?.onCreated)   chrome.tabs.onCreated.addListener(onTabsChanged);
    if (chrome.tabs?.onRemoved)   chrome.tabs.onRemoved.addListener(onTabsChanged);
    if (chrome.tabs?.onUpdated)   chrome.tabs.onUpdated.addListener(onTabsChanged);
    if (chrome.tabs?.onActivated) chrome.tabs.onActivated.addListener(onTabsChanged);

    // ── Input ──
    const input   = $('chat-input');
    const sendBtn = $('chat-send-btn');

    input.addEventListener('input', () => {
        autoGrowTextarea(input);
        const val = input.value;
        sendBtn.disabled = !val.trim();

        // ── Slash command popup ──
        if (val.startsWith('/') && !val.includes(' ')) {
            showSlashPopup(val.length === 1 ? '/' : val);
        } else {
            hideSlashPopup();
        }

        // ── @tab picker popup ──
        const atIdx = val.lastIndexOf('@');
        if (atIdx !== -1) {
            const afterAt = val.slice(atIdx + 1);
            if (!afterAt.includes(' ') && !afterAt.includes('\n')) {
                showTabPickerPopup(afterAt);
                return;
            }
        }
        hideTabPickerPopup();
    });

    input.addEventListener('keydown', e => {
        // ── Popup navigation (slash commands or @tab picker) ──
        const slashPopup = $('slash-cmd-popup');
        const tabPopup   = $('tab-picker-popup');
        const slashOpen  = !slashPopup.classList.contains('hidden');
        const tabOpen    = !tabPopup.classList.contains('hidden');

        if (slashOpen || tabOpen) {
            const activePopup = slashOpen ? slashPopup : tabPopup;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                _navigatePopup(activePopup, 1);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                _navigatePopup(activePopup, -1);
                return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                const activeItem = activePopup.querySelector('.sp-popup-item.active');
                if (activeItem) {
                    activeItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                }
                return;
            }
            if (e.key === 'Escape') {
                hideSlashPopup();
                hideTabPickerPopup();
                return;
            }
        }

        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const text = input.value.trim();
            if (!text) return;
            input.value = '';
            autoGrowTextarea(input);
            sendBtn.disabled = true;
            sendMessage(text);
        }
    });

    sendBtn.addEventListener('click', () => {
        const text = input.value.trim();
        if (!text) return;
        hideSlashPopup();
        hideTabPickerPopup();
        input.value = '';
        autoGrowTextarea(input);
        sendBtn.disabled = true;
        sendMessage(text);
    });

    // ── Model selector ──
    $('chat-model-btn').addEventListener('click', e => {
        e.stopPropagation();
        const dd = $('chat-model-dropdown');
        dd.classList.contains('hidden') ? openModelDropdown() : closeModelDropdown();
    });

    document.addEventListener('click', e => {
        const btn = $('chat-model-btn');
        const dd  = $('chat-model-dropdown');
        if (dd && !dd.classList.contains('hidden') &&
            !btn?.contains(e.target) && !dd.contains(e.target)) {
            closeModelDropdown();
        }
    });

    // ── Multi-agent toggle ──
    $('chat-multi-btn').addEventListener('click', () => {
        multiAgentEnabled = !multiAgentEnabled;
        $('chat-multi-btn').classList.toggle('active', multiAgentEnabled);
        $('chat-multi-btn').setAttribute('aria-pressed', String(multiAgentEnabled));
        const bar = $('chat-multi-agent-bar');
        if (multiAgentEnabled) {
            buildMultiAgentBar();
            bar.classList.remove('hidden');
        } else {
            bar.classList.add('hidden');
            selectedAgents.clear();
        }
    });

    // ── History ──
    $('chat-history-btn').addEventListener('click', e => {
        e.stopPropagation();
        const panel = $('chat-history-panel');
        panel.classList.contains('hidden') ? openHistoryPanel() : closeHistoryPanel();
    });
    $('chat-history-close').addEventListener('click', closeHistoryPanel);
    $('chat-export-btn').addEventListener('click', exportHistory);
    $('chat-clear-history-btn').addEventListener('click', () => {
        if (!confirm('Delete all chat history? This cannot be undone.')) return;
        chatSessions = [];
        activeSdession = null;
        saveSessions();
        $('chat-messages').innerHTML = '';
        const empty = $('chat-empty');
        if (empty) empty.style.display = '';
        updateStatsBar(null);
        closeHistoryPanel();
    });

    // ── About ──
    $('chat-about-btn').addEventListener('click', e => {
        e.stopPropagation();
        const panel = $('chat-about-panel');
        if (panel.classList.contains('hidden')) {
            closeHistoryPanel();
            closeSettingsPanel();
            panel.classList.remove('hidden');
            $('chat-about-btn').classList.add('active');
        } else {
            panel.classList.add('hidden');
            $('chat-about-btn').classList.remove('active');
        }
    });
    $('chat-about-close').addEventListener('click', () => {
        $('chat-about-panel').classList.add('hidden');
        $('chat-about-btn').classList.remove('active');
    });

    // ── Settings ──
    $('chat-settings-btn').addEventListener('click', e => {
        e.stopPropagation();
        const panel = $('chat-settings-panel');
        panel.classList.contains('hidden') ? openSettingsPanel() : closeSettingsPanel();
    });
    $('chat-settings-close').addEventListener('click', closeSettingsPanel);

    // ── New chat ──
    $('chat-new-btn').addEventListener('click', () => {
        startNewSession();
        saveSessions();
    });

    // ── Tab context pill removal ──
    $('chat-tab-ctx-remove').addEventListener('click', clearTabContext);
    $('sp-tablist-ctx-remove').addEventListener('click', clearTabListContext);

    // ── Reasoning toggle ──
    $('chat-reasoning-btn').addEventListener('click', () => {
        reasoningEnabled = !reasoningEnabled;
        $('chat-reasoning-btn').setAttribute('aria-pressed', String(reasoningEnabled));
    });

    // ── Stop generation ──
    $('chat-stop-btn').addEventListener('click', () => {
        if (abortController) {
            abortController.abort();
            abortController = null;
        }
        setStreaming(false);
    });

    // ── Tabs panel ──
    $('sp-tabs-btn').addEventListener('click', () => {
        const panel = $('sp-tabs-panel');
        panel.classList.contains('hidden') ? openTabsPanel() : panel.classList.add('hidden');
    });

    $('sp-tabs-close').addEventListener('click', () => {
        $('sp-tabs-panel').classList.add('hidden');
    });

    // "Send to AI" — injects all current tabs as context
    $('sp-tabs-inject-btn').addEventListener('click', async () => {
        const tabs = await chrome.tabs.query({ windowId: await getBrowserWindowId() });
        setTabListContext(tabs);
        $('sp-tabs-panel').classList.add('hidden');
    });

    // Open new tab from URL input
    const urlInput  = $('sp-tabs-url-input');
    const openBtn   = $('sp-tabs-open-btn');

    openBtn.addEventListener('click', async () => {
        await openNewTab(urlInput.value);
        urlInput.value = '';
    });
    urlInput.addEventListener('keydown', async e => {
        if (e.key === 'Enter') {
            await openNewTab(urlInput.value);
            urlInput.value = '';
        }
    });

    // Phase 4: Persist panel-open state so background.js can restore it in new windows
    chatStore.set({ stellaPanelOpen: true });
    document.addEventListener('visibilitychange', () => {
        if (activeSdession) chatStore.set({ lastActiveSdession: activeSdession });
        // Update open state — false when panel tab is hidden (panel closed/minimised)
        chatStore.set({ stellaPanelOpen: document.visibilityState === 'visible' });
    });

    // Phase 5: Consume any pending context-menu prompt from background.js
    const sessionStore = (typeof chrome !== 'undefined' && chrome.storage?.session)
        ? chrome.storage.session
        : { get: (_k, cb) => cb({}), remove: () => {} };

    sessionStore.get(['stellaPendingPrompt'], data => {
        const p = data?.stellaPendingPrompt;
        if (!p) return;
        // Clear immediately so it doesn't fire again on next load
        sessionStore.remove('stellaPendingPrompt');

        const input = $('chat-input');
        if (!input) return;

        if (p.type === 'selection' && p.text) {
            input.value = p.text;
        } else if (p.type === 'page' && p.tabId) {
            // Pre-fill a ready-to-send prompt referencing the page
            input.value = `Summarise this page for me.`;
            // Also auto-load the tab as context if the tab tracker is ready
            if (p.tabId && typeof readTabContent === 'function') {
                readTabContent(p.tabId).catch(() => {});
            }
        }
        autoGrowTextarea(input);
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        const sendBtn = $('chat-send-btn');
        if (sendBtn && input.value.trim()) sendBtn.disabled = false;
    });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChat);
} else {
    initChat();
}
