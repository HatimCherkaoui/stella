# Privacy Policy

**Stella AI Browser Extension**
Last updated: April 2025

---

## Overview

Stella AI ("Stella", "we", "the extension") is a Chrome browser extension that acts as an AI chat interface. This policy explains what data Stella accesses, how it is used, and what is never collected.

---

## Data We Access

### API Keys

- You enter API keys for third-party AI providers (OpenAI, Anthropic, Google, Mistral).
- Keys are stored exclusively in **`chrome.storage.local`** on your device.
- Keys are **never** sent to any server other than the official API endpoint of the corresponding provider when you send a message.

### Chat History

- Conversation messages are stored locally in **`chrome.storage.local`** on your device.
- History is limited to the 100 most recent sessions.
- No chat data is transmitted to any server controlled by this extension.

### Tab Content

- When you explicitly use the `@` tab picker or the **Send to AI** button, Stella reads the title, URL, and (optionally) the text content of the selected tab(s).
- This content is sent **only to the AI provider you have selected**, as part of the prompt you initiate.
- Stella does not read tab content passively or in the background.

### Active Tab URL

- Stella tracks the last active tab so it can offer to add page context to the chat.
- This information is kept only in memory and is never persisted or transmitted.

---

## Data We Do NOT Collect

- We do not operate any backend server, database, or analytics infrastructure.
- We do not collect telemetry, crash reports, or usage statistics.
- We do not use cookies, trackers, or fingerprinting.
- We do not share any data with advertisers or third parties.
- We do not transmit your API keys, chat history, or browsing activity to anyone.

---

## Third-Party AI Providers

When you send a message, Stella forwards your prompt (and any context you have added) directly from your browser to the API endpoint of your chosen provider:

| Provider  | API Endpoint                        | Privacy Policy                                                               |
| --------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| OpenAI    | `api.openai.com`                    | [openai.com/policies/privacy](https://openai.com/policies/privacy)           |
| Anthropic | `api.anthropic.com`                 | [anthropic.com/privacy](https://www.anthropic.com/privacy)                   |
| Google    | `generativelanguage.googleapis.com` | [policies.google.com/privacy](https://policies.google.com/privacy)           |
| Mistral   | `api.mistral.ai`                    | [mistral.ai/terms/#privacy-policy](https://mistral.ai/terms/#privacy-policy) |

Please review each provider's privacy policy to understand how your prompts are processed and retained.

---

## Permissions Explained

| Permission         | Why it's needed                                                                |
| ------------------ | ------------------------------------------------------------------------------ |
| `storage`          | Save chat sessions and API keys locally on your device                         |
| `tabs`             | Read the list of open tabs so Stella can inject tab context into conversations |
| `scripting`        | Extract the text content of a page when you explicitly request it              |
| `activeTab`        | Access the currently active tab when you trigger a read action                 |
| `sidePanel`        | Display Stella's interface in Chrome's built-in side panel                     |
| `host_permissions` | Send API requests directly to the AI provider endpoints from the extension     |

---

## Children's Privacy

Stella is not directed at children under 13. We do not knowingly collect information from children.

---

## Changes to This Policy

If this policy is updated, the updated version will be committed to this repository with a new "Last updated" date. Continued use of the extension after an update constitutes acceptance of the revised policy.

---

## Contact

For privacy questions or concerns, open an issue at [github.com/HatimCherkaoui/stella](https://github.com/HatimCherkaoui/stella).
