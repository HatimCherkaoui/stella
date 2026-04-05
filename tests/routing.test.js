'use strict';
/**
 * routing.test.js
 *
 * Tests for the AI prompt routing logic:
 *   • interceptTabIntent  — detects "open/close/list tabs" intents
 *   • isTabContentQuery   — detects "summarize/explain this page" intents
 *   • findOpenTabsReferencedInText — name-based tab matching
 *
 * These are the core routing rules that decide whether a message triggers a
 * browser command, injects page content, or falls through to the AI directly.
 */

const {
    interceptTabIntent,
    isTabContentQuery,
    findOpenTabsReferencedInText,
    addTabToContext,
    clearTabContext,
    clearTabListContext,
    __sandbox,
} = require('./helpers');

// Chrome tabs stub lives inside the vm sandbox
const sandboxChrome = __sandbox.chrome;

// ─────────────────────────────────────────────────────────────────────────────
// 1. interceptTabIntent — no tab intent (pure AI prompt)
// ─────────────────────────────────────────────────────────────────────────────

describe('interceptTabIntent — no-intent (general prompts)', () => {
    const generalPrompts = [
        'What is the capital of France?',
        'Explain recursion to me.',
        'Write me a Python function to sort a list.',
        'Who wrote Hamlet?',
        'Translate "hello" to Spanish.',
        'What are the key points of AI?',          // "key points" without page noun
        'Summarize machine learning',               // no page/tab noun
        'Tell me about React hooks',
        'Can you help me debug this code?',
    ];

    for (const prompt of generalPrompts) {
        test(`"${prompt.slice(0, 50)}" → action: null`, async () => {
            const result = await interceptTabIntent(prompt);
            expect(result.action).toBeNull();
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. interceptTabIntent — read/summarize intent with NO tabs in context
//    → should return action: 'awaitPermission'
// ─────────────────────────────────────────────────────────────────────────────

describe('interceptTabIntent — read intent, no tab context → awaitPermission', () => {
    beforeEach(() => {
        clearTabContext();
    });

    const readPrompts = [
        'Summarize this page',
        'Can you summarize this tab?',
        'Read the current page',
        'Analyze this article',
        'Explain the content of this page',
        "Tell me what's on this page",
        'Describe the current site',
        // Multi-language
        'Résume cette page',                       // French (verb form, not noun — no \b issue)
        'Analiza esta página',                     // Spanish
        'Zusammenfasse diese Seite',               // German
    ];

    for (const prompt of readPrompts) {
        test(`"${prompt}" → awaitPermission`, async () => {
            const result = await interceptTabIntent(prompt);
            expect(result.action).toBe('awaitPermission');
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. interceptTabIntent — read intent WITH tabs already in context
//    → should return action: 'readTab'
// ─────────────────────────────────────────────────────────────────────────────

describe('interceptTabIntent — read intent WITH tab context → readTab', () => {
    beforeEach(() => {
        clearTabContext();
        addTabToContext(1, {
            title: 'Example',
            url:   'https://example.com',
            text:  'Some article text',
            meta:  '',
        });
    });

    afterEach(() => clearTabContext());

    const readPrompts = [
        'Summarize this page',
        'Analyze the current tab',
        'Explain this article',
    ];
    for (const prompt of readPrompts) {
        test(`"${prompt}" → readTab`, async () => {
            const result = await interceptTabIntent(prompt);
            expect(result.action).toBe('readTab');
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. interceptTabIntent — list tabs intent
//    → showConsentBubble is a DOM call (stubbed); we verify action: 'listTabs'
//    The consent bubble is stubbed to resolve false (no confirm), so interceptTabIntent
//    returns 'cancelled'; we patch showConsentBubble to force true.
// ─────────────────────────────────────────────────────────────────────────────

describe('interceptTabIntent — list tabs intent → listTabs after consent', () => {
    beforeEach(() => {
        clearTabContext();
        // Patch showConsentBubble inside the vm sandbox to always approve
        __sandbox._origShowConsentBubble = __sandbox.showConsentBubble;
        __sandbox.showConsentBubble = async () => true;
        sandboxChrome.tabs.query = async () => [
            { id: 1, title: 'GitHub', url: 'https://github.com', active: false },
            { id: 2, title: 'HN',     url: 'https://news.ycombinator.com', active: true },
        ];
        __sandbox._origGetBrowserWindowId = __sandbox.getBrowserWindowId;
        __sandbox.getBrowserWindowId = async () => 1;
    });

    afterEach(() => {
        __sandbox.showConsentBubble  = __sandbox._origShowConsentBubble;
        __sandbox.getBrowserWindowId = __sandbox._origGetBrowserWindowId;
    });

    const listPrompts = [
        'List my open tabs',
        'Show me all tabs',
        'How many tabs are open?',
        'Display my tabs',
        // French
        'Liste mes onglets',
        // Spanish
        'Listar mis pestañas',
    ];

    for (const prompt of listPrompts) {
        test(`"${prompt}" → listTabs`, async () => {
            const result = await interceptTabIntent(prompt);
            expect(result.action).toBe('listTabs');
            expect(typeof result.count).toBe('number');
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. interceptTabIntent — open tab intent
// ─────────────────────────────────────────────────────────────────────────────

describe('interceptTabIntent — open tab intent', () => {
    beforeEach(() => {
        __sandbox._origShowConsentBubble = __sandbox.showConsentBubble;
        __sandbox.showConsentBubble = async () => false; // user cancels → 'cancelled'
    });

    afterEach(() => {
        __sandbox.showConsentBubble = __sandbox._origShowConsentBubble;
    });

    test('"Open github.com" → cancelled (consent refused)', async () => {
        // consent refused → cancelled
        const result = await interceptTabIntent('Open github.com');
        expect(result.action).toBe('cancelled');
    });

    test('"Open github.com" with consent → openTab', async () => {
        __sandbox.showConsentBubble = async () => true;
        __sandbox._origOpenNewTab = __sandbox.openNewTab;
        __sandbox.openNewTab = async () => {};
        const result = await interceptTabIntent('Open github.com');
        __sandbox.openNewTab = __sandbox._origOpenNewTab;
        expect(result.action).toBe('openTab');
        expect(result.url).toBe('github.com');
    });

    test('"Navigate to https://openai.com" with consent → openTab', async () => {
        __sandbox.showConsentBubble = async () => true;
        __sandbox._origOpenNewTab = __sandbox.openNewTab;
        __sandbox.openNewTab = async () => {};
        const result = await interceptTabIntent('Navigate to https://openai.com');
        __sandbox.openNewTab = __sandbox._origOpenNewTab;
        expect(result.action).toBe('openTab');
    });

    test('"What is the weather?" (no URL) → null (not an open-tab intent)', async () => {
        __sandbox.showConsentBubble = async () => true;
        const result = await interceptTabIntent('What is the weather?');
        expect(result.action).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. isTabContentQuery — positive cases (should inject page content)
// ─────────────────────────────────────────────────────────────────────────────

describe('isTabContentQuery — positive (page content should be injected)', () => {
    const positive = [
        'Summarize this page',
        'Give me a summary of the article',
        'Key points of this article',
        'Main ideas from the page',
        'What does this page say?',
        'Explain the content of this tab',
        'Describe what this site is about',
        'What is the page about?',
        'Based on this page, what is the main argument?',
        'According to the article, who wrote it?',
        'What does this page mean?',
        'Analyze this article',
        'Review the page content',
        // French (verb forms that don't end on non-ASCII)
        'Que dit cette page?',
        // Spanish
        'Resumen de esta página',
        // German
        'Zusammenfassung dieser Seite',
        'Was steht auf der Seite?',
    ];

    for (const text of positive) {
        test(`positive: "${text.slice(0, 60)}"`, () => {
            expect(isTabContentQuery(text)).toBe(true);
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. isTabContentQuery — negative cases (general AI prompt, no page injection)
// ─────────────────────────────────────────────────────────────────────────────

describe('isTabContentQuery — negative (general prompts, no injection)', () => {
    const negative = [
        'What is recursion?',
        'Capital of France?',
        'Summarize machine learning',               // no page/tab noun
        'Key points of artificial intelligence',    // no page/tab noun
        'Explain React hooks',
        'Help me write a cover letter',
        'What are the best Python libraries?',
        'Translate "cat" into French',
        'Tell me a joke',
        "What's 2 + 2?",
        'List the planets in the solar system',
    ];

    for (const text of negative) {
        test(`negative: "${text.slice(0, 60)}"`, () => {
            expect(isTabContentQuery(text)).toBe(false);
        });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. findOpenTabsReferencedInText — tab name matching
// ─────────────────────────────────────────────────────────────────────────────

describe('findOpenTabsReferencedInText — name-based tab matching', () => {
    const mockTabs = [
        { id: 1, title: 'GitHub - HatimCherkaoui/stella', url: 'https://github.com/HatimCherkaoui/stella' },
        // Title has a 10-char word (“Documentation”) for the long-title-word test
        { id: 2, title: 'JavaScript Documentation', url: 'https://developer.mozilla.org/docs/Web/JavaScript' },
        { id: 3, title: 'OpenAI Platform', url: 'https://platform.openai.com' },
        { id: 4, title: '', url: 'chrome://newtab' },              // unreadable URL
    ];

    beforeEach(() => {
        __sandbox._origBWID = __sandbox.getBrowserWindowId;
        __sandbox.getBrowserWindowId = async () => 1;
        sandboxChrome.tabs.query = async () => mockTabs;
    });

    afterEach(() => {
        __sandbox.getBrowserWindowId = __sandbox._origBWID;
    });

    test('returns matching tab by hostname root', async () => {
        const matches = await findOpenTabsReferencedInText('Can you explain the github tab?');
        const ids = matches.map(t => t.id);
        expect(ids).toContain(1);
    });

    test('returns matching tab by long title word', async () => {
        // 'Documentation' is 13 chars, well over the 10-char threshold
        const matches = await findOpenTabsReferencedInText('Summarize the documentation tab');
        const ids = matches.map(t => t.id);
        expect(ids).toContain(2);
    });

    test('does NOT match when text has no tab/page indicator word', async () => {
        // "explain GitHub" with no "tab"/"page" etc. → no match
        const matches = await findOpenTabsReferencedInText('Explain GitHub Actions');
        expect(matches).toHaveLength(0);
    });

    test('does NOT match chrome:// URLs (unreadable)', async () => {
        const matches = await findOpenTabsReferencedInText('What is on the newtab page?');
        const ids = matches.map(t => t.id);
        expect(ids).not.toContain(4);
    });

    test('returns empty when no tabs match', async () => {
        const matches = await findOpenTabsReferencedInText('What is on the stackoverflow tab?');
        expect(matches).toHaveLength(0);
    });
});
