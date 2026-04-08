// Copyright © 2026 Hatim Cherkaoui. All rights reserved.
// Unauthorized copying, modification, or distribution is strictly prohibited.
// Stella — background service worker (MV3)

// Open side panel when toolbar icon is clicked
chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});

// ── Helper: open panel in the current focused window ─────────────────────────
async function openPanel() {
    try {
        const [win] = await chrome.windows.getAll({ windowTypes: ['normal'] })
            .then(wins => wins.filter(w => w.focused));
        const windowId = win?.id ?? chrome.windows.WINDOW_ID_CURRENT;
        await chrome.sidePanel.open({ windowId });
    } catch { /* ignore — may fail if no normal window is focused */ }
}

// ── Phase 1: Auto-open on first install ──────────────────────────────────────
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
    // Auto-open panel so user immediately sees Stella without hunting
    if (reason === 'install') {
        await openPanel();
    }

    // Phase 3: Register context menu entries (must be re-created after install/update)
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: 'stella-page',
            title: 'Ask Stella about this page',
            contexts: ['page'],
        });
        chrome.contextMenus.create({
            id: 'stella-selection',
            title: 'Ask Stella about "%s"',
            contexts: ['selection'],
        });
    });
});

// ── Phase 2: Keyboard shortcut (Alt+Shift+S / remappable) ────────────────────
chrome.commands.onCommand.addListener(command => {
    if (command === 'toggle-stella') openPanel();
});

// ── Phase 3: Context menu click handler ──────────────────────────────────────
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    // Store the pending prompt in session storage — sidepanel.js reads it on load/focus
    const payload = {
        type: info.menuItemId === 'stella-selection' ? 'selection' : 'page',
        text: info.selectionText || null,
        tabId: tab?.id || null,
        tabTitle: tab?.title || null,
        tabUrl: tab?.url || null,
    };
    await chrome.storage.session.set({ stellaPendingPrompt: payload });
    await openPanel();
});

// ── Phase 4: Restore panel when a new window is opened ───────────────────────
// If the panel was open when the user last closed/left, re-open it in new windows.
chrome.windows.onCreated.addListener(async win => {
    if (win.type !== 'normal') return;
    try {
        const data = await chrome.storage.local.get('stellaPanelOpen');
        if (data.stellaPanelOpen) {
            // Small delay so the window is fully ready before we open the panel
            setTimeout(() => chrome.sidePanel.open({ windowId: win.id }).catch(() => {}), 400);
        }
    } catch { /* ignore */ }
});

// ── Track last active browser tab ─────────────────────────────────────────────
// Stored in chrome.storage.session so it survives service-worker sleep/restart.

function _isBrowserTab(url) {
    if (!url) return false;
    return url.startsWith('http://') || url.startsWith('https://');
}

function _saveLastTab(tabId, url, title) {
    chrome.storage.session.set({ lastBrowserTab: { tabId, url, title } }).catch(() => {});
}

// Tab switched — only save if the tab's window is currently focused
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
    chrome.windows.get(windowId, win => {
        if (chrome.runtime.lastError) return;
        if (!win?.focused) return;
        chrome.tabs.get(tabId, tab => {
            if (chrome.runtime.lastError) return;
            if (_isBrowserTab(tab?.url)) _saveLastTab(tab.id, tab.url, tab.title);
        });
    });
});

// Tab navigated to a new URL
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    if (!tab.active) return;
    if (!_isBrowserTab(tab.url)) return;
    chrome.windows.get(tab.windowId, win => {
        if (chrome.runtime.lastError) return;
        if (win?.focused) _saveLastTab(tabId, tab.url, tab.title);
    });
});

// User switched browser windows
chrome.windows.onFocusChanged.addListener(windowId => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    chrome.tabs.query({ active: true, windowId }, tabs => {
        if (chrome.runtime.lastError) return;
        const tab = tabs[0];
        if (tab && _isBrowserTab(tab.url)) _saveLastTab(tab.id, tab.url, tab.title);
    });
});

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    if (msg.type === 'getActiveTabId') {
        (async () => {
            // Primary: return last tracked tab from session storage
            try {
                const data = await chrome.storage.session.get('lastBrowserTab');
                const saved = data?.lastBrowserTab;
                if (saved?.tabId) {
                    const tab = await chrome.tabs.get(saved.tabId).catch(() => null);
                    if (tab && _isBrowserTab(tab.url)) {
                        sendResponse({ tabId: tab.id, tabUrl: tab.url, tabTitle: tab.title });
                        return;
                    }
                }
            } catch { /* fall through */ }

            // Fallback: walk normal windows and find active readable tab
            chrome.windows.getAll({ windowTypes: ['normal'], populate: true }, wins => {
                for (const win of (wins || [])) {
                    const tab = win.tabs?.find(t => t.active && _isBrowserTab(t.url));
                    if (tab) { sendResponse({ tabId: tab.id, tabUrl: tab.url, tabTitle: tab.title }); return; }
                }
                sendResponse({ tabId: null, tabUrl: null, tabTitle: null });
            });
        })();
        return true;
    }

    // Execute content extraction on an explicit tabId
    if (msg.type === 'readTabContent') {
        (async () => {
            try {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: msg.tabId },
                    func: () => {
                        const meta = (sel) => document.querySelector(sel)?.content || '';
                        const metaText = [
                            meta('meta[name="description"]'),
                            meta('meta[property="og:description"]'),
                            meta('meta[property="og:title"]'),
                            meta('meta[name="twitter:description"]'),
                        ].filter(Boolean).join(' | ');

                        let text = '';
                        for (const sel of ['article', 'main', '[role="main"]', '.post-content', '.article-body', '#mw-content-text', '#bodyContent', '#content', '#main']) {
                            const el = document.querySelector(sel);
                            if (el?.innerText?.trim()) { text = el.innerText; break; }
                        }
                        if (!text.trim()) text = document.body.innerText;

                        return {
                            title: document.title,
                            url:   location.href,
                            meta:  metaText,
                            text:  text.slice(0, 15000),
                        };
                    },
                });
                const data = results?.[0]?.result;
                sendResponse({ ok: true, data: data || null });
            } catch (e) {
                sendResponse({ ok: false, error: e.message });
            }
        })();
        return true;
    }
});
