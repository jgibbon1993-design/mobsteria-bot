# Mobsteria Bot — stable Tampermonkey releases

Latest stable: **v2.3.18**.

**v2.3.18:** Bidirectional trading travel between the configured cities (default Silverton ↔ The Docks); may travel without profitable cargo, with fare and cooldown safeguards. Keeps the v2.3.17 garage repair-before-crushing workflow. Offline tested; verify behaviour on a live account before relying on unattended operation.

## Install or update once

Install the script from this direct URL:

https://raw.githubusercontent.com/jgibbon1993-design/mobsteria-bot/main/Mobsteria_Bot.user.js

Existing users who installed a downloaded ZIP or a standalone userscript without update URLs must install this hosted build **once** to subscribe to future updates. Confirm Tampermonkey's update/replacement prompt and keep existing settings when offered.

## How automatic updates work

Tampermonkey checks:

https://raw.githubusercontent.com/jgibbon1993-design/mobsteria-bot/main/Mobsteria_Bot.meta.js

If `@version` is newer, it downloads the complete userscript using `@downloadURL`. The check schedule depends on each user's Tampermonkey settings and browser activity; it is **not instant**.

## Publishing future versions

1. Test the new `Mobsteria_Bot.user.js` privately.
2. Increase the `@version` in **both** `Mobsteria_Bot.user.js` and `Mobsteria_Bot.meta.js`.
3. Commit the complete stable userscript and matching metadata to `main`.
4. Verify that both raw URLs work.

Do not publish incomplete builds to `main`. Use a separate testing branch for development. Never commit HAR captures, API keys, cookies, session tokens, or individual account data.

## Supported domains

- https://mobsteria.com/*
- https://www.mobsteria.com/*

The bot's in-game automation and accounts are not managed by GitHub. Only the userscript code is distributed here.
