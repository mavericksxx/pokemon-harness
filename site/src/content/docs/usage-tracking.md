---
title: Usage tracking
order: 10
---

Opt-in and off by default. Turning on "show provider usage limits" (Settings
→ usage) lets the app read the credential your Claude Code or Codex CLI
already has stored and ask the provider's own usage endpoint for your
rolling 5-hour and 7-day rate-limit windows. It's read-only — nothing is
stored, polled on any schedule beyond what you trigger, or sent anywhere but
that one documented endpoint — and flipping the setting off tears the whole
thing down immediately, with zero credential access while it's off. The
first read triggers a one-time macOS keychain permission prompt.

Once on, a topbar chip shows mini-gauges for whichever provider is set as
the "main usage provider" (or an automatic pick, defaulting to Claude when
it has usable data). Per-provider include/exclude and the main-provider
choice both live in the same settings section — an excluded provider is
never polled at all. Clicking a session's roster card opens its trainer-card
popover with the fuller per-provider breakdown, including reset countdowns.
