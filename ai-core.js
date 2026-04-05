'use strict';
/* ── ai-core.js ───────────────────────────────────────────────────────────────
   Provider config, API key storage, validation, and streaming adapters.
   Loaded before newtab.js and chat.js.
   ─────────────────────────────────────────────────────────────────────────── */

// ── Provider / model catalogue ────────────────────────────────────────────────
const AI_PROVIDERS = {
    openai: {
        label:    'OpenAI',
        color:    '#10a37f',
        endpoint: 'https://api.openai.com/v1/chat/completions',
        models: [
            { id: 'gpt-4o',       label: 'GPT-4o',       ctx: '128k',  costIn: 0.005,  costOut: 0.015  },
            { id: 'gpt-4o-mini',  label: 'GPT-4o mini',  ctx: '128k',  costIn: 0.00015,costOut: 0.0006  },
            { id: 'o3-mini',      label: 'o3-mini',       ctx: '200k',  costIn: 0.0011, costOut: 0.0044  },
        ],
    },
    anthropic: {
        label:    'Anthropic',
        color:    '#c96442',
        endpoint: 'https://api.anthropic.com/v1/messages',
        models: [
            { id: 'claude-opus-4-5',   label: 'Claude Opus 4.5',   ctx: '200k', costIn: 0.015, costOut: 0.075 },
            { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', ctx: '200k', costIn: 0.003, costOut: 0.015 },
            { id: 'claude-haiku-3-5',  label: 'Claude Haiku 3.5',  ctx: '200k', costIn: 0.0008,costOut: 0.004  },
        ],
    },
    google: {
        label:    'Google',
        color:    '#4285f4',
        endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
        models: [
            { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash',      ctx: '1M',  costIn: 0.0001,  costOut: 0.0004 },
            { id: 'gemini-2.5-flash-lite',  label: 'Gemini 2.5 Flash Lite', ctx: '1M',  costIn: 0.000075,costOut: 0.0003 },
            { id: 'gemini-2.5-pro',         label: 'Gemini 2.5 Pro',        ctx: '1M',  costIn: 0.00125, costOut: 0.01   },
            { id: 'gemini-2.0-flash',       label: 'Gemini 2.0 Flash',      ctx: '1M',  costIn: 0.0001,  costOut: 0.0004 },
            { id: 'gemini-2.0-flash-lite',  label: 'Gemini 2.0 Flash Lite', ctx: '1M',  costIn: 0.000075,costOut: 0.0003 },
        ],
    },
    mistral: {
        label:    'Mistral',
        color:    '#f4a932',
        endpoint: 'https://api.mistral.ai/v1/chat/completions',
        models: [
            { id: 'mistral-large-latest',  label: 'Mistral Large',  ctx: '128k', costIn: 0.002, costOut: 0.006  },
            { id: 'mistral-small-latest',  label: 'Mistral Small',  ctx: '32k',  costIn: 0.0002,costOut: 0.0006 },
        ],
    },
};

// Flat list used by UI (provider key + model record merged)
const AI_MODEL_LIST = Object.entries(AI_PROVIDERS).flatMap(([providerKey, p]) =>
    p.models.map(m => ({ ...m, provider: providerKey, providerLabel: p.label, color: p.color }))
);

// ── Default model preference ──────────────────────────────────────────────────
const AI_DEFAULT_MODEL = { provider: 'openai', modelId: 'gpt-4o-mini' };

// ── API key storage (chrome.storage.local only — never sync) ──────────────────
function loadApiKeys(cb) {
    const aiLocalStore = (typeof chrome !== 'undefined' && chrome.storage?.local)
        ? chrome.storage.local
        : { get: (_k, cb) => cb({}), set: () => {} };
    aiLocalStore.get(['aiApiKeys'], data => cb(data.aiApiKeys || {}));
}

function saveApiKeys(keys) {
    const aiLocalStore = (typeof chrome !== 'undefined' && chrome.storage?.local)
        ? chrome.storage.local
        : { get: (_k, cb) => cb({}), set: () => {} };
    aiLocalStore.set({ aiApiKeys: keys });
}

// ── Key validation (cheapest per-provider ping) ───────────────────────────────
async function validateKey(provider, key) {
    try {
        const p = AI_PROVIDERS[provider];
        if (!p) return { ok: false, error: 'Unknown provider' };

        if (provider === 'openai' || provider === 'mistral') {
            const cheapestModel = p.models[p.models.length - 1].id;
            const res = await fetch(p.endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${key}`,
                    ...(provider === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
                },
                body: JSON.stringify({
                    model: cheapestModel,
                    messages: [{ role: 'user', content: 'hi' }],
                    max_tokens: 1,
                }),
            });
            if (res.status === 401) return { ok: false, error: 'Invalid key' };
            if (res.status === 429) return { ok: true, error: null }; // rate-limited but key is valid
            if (!res.ok) {
                const j = await res.json().catch(() => ({}));
                return { ok: false, error: j?.error?.message || `HTTP ${res.status}` };
            }
            return { ok: true, error: null };
        }

        if (provider === 'anthropic') {
            const cheapestModel = p.models[p.models.length - 1].id;
            const res = await fetch(p.endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model: cheapestModel,
                    messages: [{ role: 'user', content: 'hi' }],
                    max_tokens: 1,
                }),
            });
            if (res.status === 401) return { ok: false, error: 'Invalid key' };
            if (res.status === 429) return { ok: true, error: null };
            if (!res.ok) {
                const j = await res.json().catch(() => ({}));
                return { ok: false, error: j?.error?.message || `HTTP ${res.status}` };
            }
            return { ok: true, error: null };
        }

        if (provider === 'google') {
            // Use gemini-2.5-flash — confirmed available via ListModels
            const validationModel = 'gemini-2.5-flash';
            const url = `${p.endpoint}/${validationModel}:generateContent?key=${encodeURIComponent(key)}`;
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
                    generationConfig: { maxOutputTokens: 1 },
                }),
            });
            if (res.ok) return { ok: true, error: null };
            const j = await res.json().catch(() => ({}));
            const msg = j?.error?.message || '';
            // 429 / quota-exceeded = key is valid, just rate-limited or over free-tier quota
            if (res.status === 429 || msg.toLowerCase().includes('quota')) {
                return { ok: true, error: null };
            }
            // 400 with "API key" in message = genuinely bad key
            if (res.status === 400 && msg.toLowerCase().includes('api key')) {
                return { ok: false, error: 'Invalid API key' };
            }
            // 403 = key exists but access denied (billing not enabled, etc.) — still a real key
            if (res.status === 403) return { ok: true, error: null };
            return { ok: false, error: msg.split('\n')[0].trim() || `HTTP ${res.status}` };
        }

        return { ok: false, error: 'Unsupported provider' };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ── Streaming chat ────────────────────────────────────────────────────────────
// messages: [{role:'user'|'assistant'|'system', content:string}]
// opts: { onChunk(text), onDone(usage:{in,out}), onError(msg), signal }
async function streamChat(provider, modelId, apiKey, messages, opts = {}) {
    const { onChunk, onDone, onError, onThinking, signal, reasoning } = opts;
    try {
        if (provider === 'openai' || provider === 'mistral') {
            await _streamOpenAICompat(provider, modelId, apiKey, messages, { onChunk, onDone, onError, onThinking, signal, reasoning });
        } else if (provider === 'anthropic') {
            await _streamAnthropic(modelId, apiKey, messages, { onChunk, onDone, onError, onThinking, signal, reasoning });
        } else if (provider === 'google') {
            await _streamGoogle(modelId, apiKey, messages, { onChunk, onDone, onError, onThinking, signal, reasoning });
        } else {
            onError && onError(`Unknown provider: ${provider}`);
        }
    } catch (e) {
        if (e.name !== 'AbortError') {
            onError && onError(e.message);
        }
    }
}

// ── OpenAI-compatible SSE (OpenAI + Mistral) ──────────────────────────────────
async function _streamOpenAICompat(provider, modelId, apiKey, messages, { onChunk, onDone, onError, onThinking, signal, reasoning }) {
    const p = AI_PROVIDERS[provider];
    const requestBody = { model: modelId, messages, stream: true };
    // o1 / o3 reasoning models accept reasoning_effort
    if (reasoning && /^o[13]/.test(modelId)) requestBody.reasoning_effort = 'high';
    const res = await fetch(p.endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal,
    });

    if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        onError && onError(j?.error?.message || `HTTP ${res.status}`);
        return;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let tokensIn = 0;
    let tokensOut = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop(); // keep incomplete line
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6);
            if (data === '[DONE]') {
                onDone && onDone({ in: tokensIn, out: tokensOut });
                return;
            }
            try {
                const obj = JSON.parse(data);
                const delta = obj.choices?.[0]?.delta?.content;
                if (delta) {
                    tokensOut++;
                    onChunk && onChunk(delta);
                }
                const usage = obj.usage;
                if (usage) {
                    tokensIn = usage.prompt_tokens || tokensIn;
                    tokensOut = usage.completion_tokens || tokensOut;
                }
            } catch { /* malformed SSE chunk, skip */ }
        }
    }
    onDone && onDone({ in: tokensIn, out: tokensOut });
}

// ── Anthropic streaming ───────────────────────────────────────────────────────
async function _streamAnthropic(modelId, apiKey, messages, { onChunk, onDone, onError, onThinking, signal, reasoning }) {
    // Anthropic requires system message extracted from messages array
    const systemMsgs = messages.filter(m => m.role === 'system');
    const convoMsgs  = messages.filter(m => m.role !== 'system');

    const body = {
        model: modelId,
        messages: convoMsgs,
        max_tokens: reasoning ? 16000 : 4096,
        stream: true,
    };
    if (systemMsgs.length) body.system = systemMsgs.map(m => m.content).join('\n');
    if (reasoning) body.thinking = { type: 'enabled', budget_tokens: 8000 };

    const headers = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
    };
    if (reasoning) headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14';

    const res = await fetch(AI_PROVIDERS.anthropic.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
    });

    if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        onError && onError(j?.error?.message || `HTTP ${res.status}`);
        return;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let eventType = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let currentBlockType = 'text'; // 'text' | 'thinking'

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
            if (line.startsWith('event: ')) {
                eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                try {
                    const obj = JSON.parse(data);
                    if (eventType === 'content_block_start') {
                        currentBlockType = obj.content_block?.type || 'text';
                    } else if (eventType === 'content_block_delta') {
                        if (currentBlockType === 'thinking') {
                            const thinking = obj.delta?.thinking;
                            if (thinking) onThinking && onThinking(thinking);
                        } else {
                            const text = obj.delta?.text;
                            if (text) { tokensOut++; onChunk && onChunk(text); }
                        }
                    } else if (eventType === 'message_delta') {
                        const usage = obj.usage;
                        if (usage) { tokensOut = usage.output_tokens || tokensOut; }
                    } else if (eventType === 'message_start') {
                        tokensIn = obj.message?.usage?.input_tokens || tokensIn;
                    } else if (eventType === 'message_stop') {
                        onDone && onDone({ in: tokensIn, out: tokensOut });
                        return;
                    }
                } catch { /* skip */ }
            }
        }
    }
    onDone && onDone({ in: tokensIn, out: tokensOut });
}

// ── Google Gemini streaming ───────────────────────────────────────────────────
async function _streamGoogle(modelId, apiKey, messages, { onChunk, onDone, onError, onThinking, signal, reasoning }) {
    // Convert messages to Gemini contents format; system → prepend as user turn
    const contents = [];
    for (const m of messages) {
        if (m.role === 'system') continue; // folded into systemInstruction below
        contents.push({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        });
    }
    const systemMsg = messages.find(m => m.role === 'system');

    const body = { contents };
    if (systemMsg) body.systemInstruction = { parts: [{ text: systemMsg.content }] };
    // 2.5 models support extended thinking — explicit budget ensures thought parts are returned
    if (reasoning && /2\.5/.test(modelId)) {
        body.generationConfig = { thinkingConfig: { thinkingBudget: -1 } };
    }

    const url = `${AI_PROVIDERS.google.endpoint}/${modelId}:streamGenerateContent?key=${encodeURIComponent(apiKey)}&alt=sse`;

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });

    if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        const raw = j?.error?.message || `HTTP ${res.status}`;
        const firstLine = raw.split('\n')[0].trim();
        // Quota / billing issue — give a concrete action hint
        if (res.status === 429 || firstLine.toLowerCase().includes('quota')) {
            onError && onError('Google quota exceeded. Enable billing at console.cloud.google.com, or try Gemini 2.0 Flash Lite which has a larger free tier.');
        } else {
            onError && onError(firstLine);
        }
        return;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let tokensIn = 0;
    let tokensOut = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            const data = trimmed.slice(6).trim();
            try {
                const obj = JSON.parse(data);
                // Error object may arrive mid-stream (e.g. quota exceeded after first chunk)
                if (obj.error) {
                    const raw = obj.error.message || 'Unknown error';
                    onError && onError(raw.split('\n')[0].trim());
                    return;
                }
                const parts = obj.candidates?.[0]?.content?.parts;
                if (parts) {
                    for (const part of parts) {
                        if (part.thought && part.text) {
                            onThinking && onThinking(part.text);
                        } else if (part.text) {
                            tokensOut++;
                            onChunk && onChunk(part.text);
                        }
                    }
                }
                const meta = obj.usageMetadata;
                if (meta) {
                    tokensIn  = meta.promptTokenCount     || tokensIn;
                    tokensOut = meta.candidatesTokenCount || tokensOut;
                }
                if (obj.candidates?.[0]?.finishReason === 'STOP') {
                    onDone && onDone({ in: tokensIn, out: tokensOut });
                    return;
                }
            } catch { /* skip */ }
        }
    }
    onDone && onDone({ in: tokensIn, out: tokensOut });
}

// ── Cost estimate helper (USD per 1K tokens → string) ─────────────────────────
function estimateCost(provider, modelId, tokensIn, tokensOut) {
    const model = AI_PROVIDERS[provider]?.models.find(m => m.id === modelId);
    if (!model) return null;
    const cost = (tokensIn / 1000) * model.costIn + (tokensOut / 1000) * model.costOut;
    if (cost === 0) return '$0.00';
    if (cost < 0.000001) return '<$0.000001';
    return `$${cost.toFixed(6)}`;
}

// ── Simple inline markdown renderer ──────────────────────────────────────────
// No external deps. Handles: fenced code, inline code, bold, italic, newlines.
function renderMarkdown(text) {
    // Escape HTML first
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Fenced code blocks (```lang\n...\n```)
    const parts = [];
    let remaining = text;
    const fenceRe = /```(\w*)\n([\s\S]*?)```/g;
    let last = 0;
    let m;
    while ((m = fenceRe.exec(text)) !== null) {
        if (m.index > last) parts.push({ type: 'text', content: text.slice(last, m.index) });
        parts.push({ type: 'code', lang: m[1], content: m[2] });
        last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ type: 'text', content: text.slice(last) });

    return parts.map(part => {
        if (part.type === 'code') {
            return `<pre><code>${esc(part.content)}</code></pre>`;
        }
        // Inline formatting on text parts
        let s = esc(part.content);
        // Inline code
        s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
        // Bold **text**
        s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
        // Italic *text*
        s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
        // Newlines
        s = s.replace(/\n/g, '<br>');
        return s;
    }).join('');
}
