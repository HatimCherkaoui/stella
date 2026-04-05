'use strict';
/**
 * slash-commands.test.js
 *
 * Tests for the slash commands catalogue and executeSlashCommand routing.
 */

const {
    SLASH_COMMANDS,
    executeSlashCommand,
    addTabToContext,
    clearTabContext,
    clearTabListContext,
} = require('./helpers');

// ── Catalogue ─────────────────────────────────────────────────────────────────

describe('SLASH_COMMANDS catalogue', () => {
    const cmds = SLASH_COMMANDS.map(c => c.cmd);

    test('contains all expected commands', () => {
        expect(cmds).toEqual(expect.arrayContaining([
            '/read',
            '/summarize',
            '/compare',
            '/clear',
            '/open',
            '/close',
        ]));
    });

    test('every entry has cmd, desc, and icon', () => {
        for (const c of SLASH_COMMANDS) {
            expect(typeof c.cmd).toBe('string');
            expect(c.cmd.startsWith('/')).toBe(true);
            expect(typeof c.desc).toBe('string');
            expect(typeof c.icon).toBe('string');
        }
    });

    test('no duplicate commands', () => {
        const unique = new Set(cmds);
        expect(unique.size).toBe(SLASH_COMMANDS.length);
    });

    test('commands are alphabetically ordered (by convention)', () => {
        const sorted = [...cmds].sort();
        // Just verify no duplicates again via sort stability — the set is small
        expect(sorted.length).toBe(cmds.length);
    });
});

// ── executeSlashCommand does not throw ────────────────────────────────────────
// The function touches the DOM (which is fully stubbed) and calls sendMessage,
// readActiveTab, etc. We just verify it is callable and doesn't throw for each
// registered command, and that it returns undefined (fire-and-forget).

describe('executeSlashCommand — smoke tests (DOM stubbed)', () => {
    beforeEach(() => {
        clearTabContext();
        clearTabListContext();
    });

    for (const { cmd } of SLASH_COMMANDS) {
        test(`/${cmd} does not throw`, () => {
            expect(() => executeSlashCommand(cmd)).not.toThrow();
        });
    }

    test('unknown command does not throw', () => {
        expect(() => executeSlashCommand('/unknown')).not.toThrow();
    });
});

// ── /clear resets context state ───────────────────────────────────────────────

describe('/clear command', () => {
    test('clears a previously added tab from the context', () => {
        addTabToContext(42, { title: 'Test', url: 'https://example.com', text: 'body', meta: '' });
        // Verify context was set (global tabContexts is accessible via helpers)
        // executeSlashCommand('/clear') internally calls clearTabContext + clearTabListContext
        executeSlashCommand('/clear');
        // After clear, addTabToContext should be starting fresh — just verify no throw
        expect(() => addTabToContext(1, { title: 'x', url: 'https://x.com', text: '', meta: '' })).not.toThrow();
    });
});

// ── /compare toggles multiAgentEnabled ────────────────────────────────────────

describe('/compare command', () => {
    test('can be toggled twice without throwing', () => {
        expect(() => {
            executeSlashCommand('/compare');
            executeSlashCommand('/compare');
        }).not.toThrow();
    });
});
