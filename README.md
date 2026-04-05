# Stella AI

**Your persistent AI sidebar companion for Chrome.**

Stella is a browser extension that embeds a full-featured AI chatbot directly in Chrome's side panel — always available, never in the way. Chat with leading AI models while you browse, inject page context, manage tabs, and run multi-model comparisons, all without leaving the current tab.

---

## Features

- **Multi-provider AI** — Switch between OpenAI (GPT-4o, GPT-4o mini), Anthropic (Claude 3.5 Sonnet / Haiku), Google (Gemini 1.5 Pro / Flash), and Mistral models
- **Persistent chat history** — Sessions are saved locally and survive browser restarts (up to 100 sessions)
- **Page context injection** — Send the content of the active tab to the AI with one click (`@` picker or tab pill)
- **Tab awareness** — Let Stella see all your open tabs so it can help you navigate and search across them
- **Multi-agent comparison** — Send the same prompt to multiple models simultaneously and compare responses side by side
- **Reasoning mode** — Enable extended thinking tokens for supported models (Claude, o1/o3)
- **Slash commands** — Type `/` for a quick-action palette (new chat, clear, export…)
- **Local API keys** — Your keys are stored in `chrome.storage.local`, never transmitted to any server other than the chosen AI provider
- **Export history** — Download your full chat history as JSON at any time

---

## Installation

### From source (developer mode)

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the project folder
5. Stella's icon appears in the toolbar — click it to open the side panel

### Building a distributable ZIP

```bash
./build.sh
```

The script bundles the extension and outputs a release-ready `.zip` in `dist/`.

---

## Setup

1. Open Stella from the Chrome side panel
2. Click the **Settings** (⚙) icon in the header
3. Enter API keys for the providers you want to use:
   - [OpenAI](https://platform.openai.com/api-keys)
   - [Anthropic](https://console.anthropic.com/settings/keys)
   - [Google AI Studio](https://aistudio.google.com/app/apikey)
   - [Mistral](https://console.mistral.ai/api-keys/)
4. Start chatting

---

## Usage

| Action              | How                                                  |
| ------------------- | ---------------------------------------------------- |
| New chat            | Click **New** or type `/new`                         |
| Attach current page | Click the tab pill or type `@`                       |
| Pick a specific tab | Type `@` and select from the list                    |
| Send all tabs to AI | Open the Tabs panel → **Send to AI**                 |
| Compare models      | Click the dual-panel icon to enable multi-agent mode |
| Enable reasoning    | Click the brain icon in the toolbar                  |
| Export history      | History panel → **Export JSON**                      |
| Clear all history   | History panel → **Clear all**                        |

---

## Privacy

Stella processes all AI requests **directly from your browser** to the chosen provider's API. No data passes through any third-party proxy. See [PRIVACY.md](PRIVACY.md) for full details.

---

## Support

If Stella saves you time or makes your browsing better, consider supporting development:

[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-blue?logo=paypal)](https://paypal.me/hatimcherkaoui)

---

## License

© 2025 Hatim Cherkaoui. All rights reserved.
