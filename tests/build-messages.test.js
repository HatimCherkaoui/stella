'use strict';
/**
 * build-messages.test.js
 *
 * Tests for buildMessages() — the function that assembles the prompt payload
 * sent to the AI, handling:
 *
 *   • No context  → general mode system prompt
 *   • Single tab context  → RAG mode prompt with page content in user turn
 *   • Multi-tab context   → RAG mode with multiple PAGE sections
 *   • Tab list context    → general mode + open-tabs system block
 *   • Empty / missing page text  → graceful fallback message
 */

const {
    buildMessages,
    newSession,
    addTabToContext,
    clearTabContext,
    setTabListContext,
    clearTabListContext,
    __sandbox,
} = require('./helpers');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a session with a single user message already appended. */
function sessionWithMessage(text) {
    const sess = newSession();
    sess.messages.push({ id: 'm1', role: 'user', content: text, ts: Date.now() });
    return sess;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. No context — general AI prompt (Rule E)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildMessages — no context (general mode)', () => {
    beforeEach(() => {
        clearTabContext();
        clearTabListContext();
    });

    test('first message is a system prompt', () => {
        const sess = sessionWithMessage('What is the capital of France?');
        const msgs = buildMessages(sess, false);
        expect(msgs[0].role).toBe('system');
    });

    test('system prompt references the general-mode persona', () => {
        const sess = sessionWithMessage('Explain recursion');
        const msgs = buildMessages(sess, false);
        expect(msgs[0].content).toMatch(/Tabaisco AI/i);
    });

    test('user message is included verbatim', () => {
        const question = 'What is 2 + 2?';
        const sess = sessionWithMessage(question);
        const msgs = buildMessages(sess, false);
        const userMsg = msgs.find(m => m.role === 'user');
        expect(userMsg).toBeDefined();
        expect(userMsg.content).toBe(question);
    });

    test('no page-content section is injected', () => {
        const sess = sessionWithMessage('Tell me about AI');
        const msgs = buildMessages(sess, false);
        const allContent = msgs.map(m => m.content).join('\n');
        expect(allContent).not.toMatch(/PAGE CONTENT/i);
        expect(allContent).not.toMatch(/Here is the web page content/i);
    });

    test('no open-tabs block when tabListContext is null', () => {
        const sess = sessionWithMessage('Hello');
        const msgs = buildMessages(sess, false);
        const allContent = msgs.map(m => m.content).join('\n');
        expect(allContent).not.toMatch(/open browser tabs/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Tab list context — general mode, AI is aware of open tabs
// ─────────────────────────────────────────────────────────────────────────────

describe('buildMessages — tab list context (general mode + tab awareness)', () => {
    const fakeTabs = [
        { id: 1, title: 'GitHub',   url: 'https://github.com',             active: false },
        { id: 2, title: 'Hacker News', url: 'https://news.ycombinator.com', active: true  },
    ];

    beforeEach(() => {
        clearTabContext();
        setTabListContext(fakeTabs);
    });

    afterEach(() => clearTabListContext());

    test('system prompt switches to general mode (no RAG)', () => {
        const sess = sessionWithMessage('What tabs are open?');
        const msgs = buildMessages(sess, false);
        expect(msgs[0].content).toMatch(/Tabaisco AI/i);
    });

    test('a second system message lists the open tabs', () => {
        const sess = sessionWithMessage('What tabs are open?');
        const msgs = buildMessages(sess, false);
        const systemMsgs = msgs.filter(m => m.role === 'system');
        expect(systemMsgs.length).toBeGreaterThanOrEqual(2);
        const tabsBlock = systemMsgs.find(m => m.content.includes('open browser tabs'));
        expect(tabsBlock).toBeDefined();
    });

    test('tab list block contains tab titles and URLs', () => {
        const sess = sessionWithMessage('List tabs');
        const msgs = buildMessages(sess, false);
        const allContent = msgs.map(m => m.content).join('\n');
        expect(allContent).toMatch(/GitHub/);
        expect(allContent).toMatch(/github\.com/);
        expect(allContent).toMatch(/Hacker News/);
    });

    test('active tab is marked [active]', () => {
        const sess = sessionWithMessage('Which tab is active?');
        const msgs = buildMessages(sess, false);
        const allContent = msgs.map(m => m.content).join('\n');
        expect(allContent).toMatch(/\[active\]/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Single tab context — RAG mode (Rule A / Rule D)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildMessages — single tab context (RAG mode)', () => {
    const fakeTab = {
        tabId: 10,
        title: 'OpenAI Blog',
        url:   'https://openai.com/blog/gpt-4',
        meta:  'Announcing GPT-4',
        text:  'GPT-4 is a large multimodal model that can solve difficult problems.',
    };

    beforeEach(() => {
        clearTabContext();
        clearTabListContext();
        addTabToContext(fakeTab.tabId, fakeTab);
    });

    afterEach(() => clearTabContext());

    test('system prompt mentions reading assistant persona (RAG mode)', () => {
        const sess = sessionWithMessage('Summarize this page');
        const msgs = buildMessages(sess, true); // injectTabContent = true
        expect(msgs[0].content).toMatch(/reading assistant/i);
    });

    test('last user message includes the page content section header', () => {
        const sess = sessionWithMessage('Summarize this page');
        const msgs = buildMessages(sess, true);
        const userMsg = msgs[msgs.length - 1];
        expect(userMsg.role).toBe('user');
        expect(userMsg.content).toMatch(/Here is the web page content/i);
    });

    test('page text appears in the user message', () => {
        const sess = sessionWithMessage('Key points?');
        const msgs = buildMessages(sess, true);
        const userMsg = msgs[msgs.length - 1];
        expect(userMsg.content).toContain(fakeTab.text);
    });

    test('page title and URL appear in the user message', () => {
        const sess = sessionWithMessage('What is this page about?');
        const msgs = buildMessages(sess, true);
        const userMsg = msgs[msgs.length - 1];
        expect(userMsg.content).toContain(fakeTab.title);
        expect(userMsg.content).toContain(fakeTab.url);
    });

    test('user question is appended after page content', () => {
        const question = 'What does this page say about GPT-4?';
        const sess = sessionWithMessage(question);
        const msgs = buildMessages(sess, true);
        const userMsg = msgs[msgs.length - 1];
        expect(userMsg.content).toContain(question);
    });

    test('tab list is NOT injected in RAG mode (even if tabListContext is set)', () => {
        setTabListContext([{ id: 1, title: 'X', url: 'https://x.com', active: false }]);
        const sess = sessionWithMessage('Summarize this page');
        const msgs = buildMessages(sess, true);
        const allContent = msgs.map(m => m.content).join('\n');
        expect(allContent).not.toMatch(/open browser tabs/i);
        clearTabListContext();
    });

    test('no injection when injectTabContent=false (Rule E fallback)', () => {
        const sess = sessionWithMessage('Who created GPT-4?');
        const msgs = buildMessages(sess, false); // explicit: do NOT inject
        const allContent = msgs.map(m => m.content).join('\n');
        expect(allContent).not.toMatch(/Here is the web page content/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Multi-tab context — RAG mode with multiple pages (Rule A / multi-context)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildMessages — multi-tab context (RAG mode, multiple pages)', () => {
    const tabs = [
        {
            tabId: 20,
            title: 'MDN: Array',
            url:   'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array',
            meta:  'Array documentation',
            text:  'The Array object enables storing a collection of multiple items.',
        },
        {
            tabId: 21,
            title: 'MDN: Map',
            url:   'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map',
            meta:  'Map documentation',
            text:  'The Map object holds key-value pairs and remembers insertion order.',
        },
    ];

    beforeEach(() => {
        clearTabContext();
        clearTabListContext();
        for (const t of tabs) addTabToContext(t.tabId, t);
    });

    afterEach(() => clearTabContext());

    test('page content section is present when multi-tab injected', () => {
        const sess = sessionWithMessage('Compare these two pages');
        const msgs = buildMessages(sess, true);
        const userMsg = msgs[msgs.length - 1];
        expect(userMsg.content).toMatch(/Here is the web page content/i);
    });

    test('all tabs are included (PAGE 1 OF 2 / PAGE 2 OF 2)', () => {
        const sess = sessionWithMessage('Compare these two pages');
        const msgs = buildMessages(sess, true);
        const userMsg = msgs[msgs.length - 1];
        expect(userMsg.content).toMatch(/PAGE 1 OF 2/);
        expect(userMsg.content).toMatch(/PAGE 2 OF 2/);
    });

    test('both page texts appear in the combined user message', () => {
        const sess = sessionWithMessage('What do these pages cover?');
        const msgs = buildMessages(sess, true);
        const userMsg = msgs[msgs.length - 1];
        expect(userMsg.content).toContain(tabs[0].text);
        expect(userMsg.content).toContain(tabs[1].text);
    });

    test('specificTabs param limits injection to given tabs only', () => {
        const sess = sessionWithMessage('Summarize just the Array page');
        const msgs = buildMessages(sess, true, [tabs[0]]); // only first
        const userMsg = msgs[msgs.length - 1];
        expect(userMsg.content).toContain(tabs[0].title);
        expect(userMsg.content).not.toContain(tabs[1].title);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Empty / missing page text — graceful fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('buildMessages — empty page text graceful fallback', () => {
    beforeEach(() => {
        clearTabContext();
        clearTabListContext();
        addTabToContext(99, {
            tabId: 99,
            title: 'Login Page',
            url:   'https://example.com/login',
            meta:  '',
            text:  '',    // no readable body text
        });
    });

    afterEach(() => clearTabContext());

    test('fallback message appears when text is empty', () => {
        const sess = sessionWithMessage('Summarize this page');
        const msgs = buildMessages(sess, true);
        const userMsg = msgs[msgs.length - 1];
        expect(userMsg.content).toMatch(/No readable body text/i);
    });

    test('page is still identified (title + URL present)', () => {
        const sess = sessionWithMessage('What is this page?');
        const msgs = buildMessages(sess, true);
        const userMsg = msgs[msgs.length - 1];
        expect(userMsg.content).toContain('Login Page');
        expect(userMsg.content).toContain('https://example.com/login');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Conversation history is preserved
// ─────────────────────────────────────────────────────────────────────────────

describe('buildMessages — conversation history', () => {
    beforeEach(() => {
        clearTabContext();
        clearTabListContext();
    });

    test('prior assistant messages are included in order', () => {
        const sess = newSession();
        sess.messages.push({ id: 'm1', role: 'user',      content: 'Hello', ts: 1 });
        sess.messages.push({ id: 'm2', role: 'assistant', content: 'Hi!',   ts: 2 });
        sess.messages.push({ id: 'm3', role: 'user',      content: 'How are you?', ts: 3 });

        const msgs = buildMessages(sess, false);
        const roles = msgs.filter(m => m.role !== 'system').map(m => m.role);
        expect(roles).toEqual(['user', 'assistant', 'user']);
    });

    test('capped at last 20 conversation turns', () => {
        const sess = newSession();
        for (let i = 0; i < 30; i++) {
            sess.messages.push({ id: `m${i}`, role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}`, ts: i });
        }
        const msgs = buildMessages(sess, false);
        const convoMsgs = msgs.filter(m => m.role !== 'system');
        expect(convoMsgs.length).toBeLessThanOrEqual(20);
    });
});
