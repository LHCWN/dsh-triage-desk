# Coding standards (review stage)

These are judgement calls for the reviewer; mechanical checks live in
`npm run check` (ESLint, client dictionary parity, render smoke, routes, cache).

1. **User-facing behavior changes ship complete docs.** A new/removed setting or
   launch behavior updates `README.md`, `README.zh.md`, `CHANGELOG.md`, every
   affected EN/ZH dictionary, and replaces or deletes screenshots that show
   controls which no longer exist. A stale screenshot is a bug, not a note.
2. **Do not add selectable behavior modes speculatively.** Add a mode only for a
   concrete user request with an explicit acceptance case; otherwise ship one
   clear default and keep alternatives out of the UI.
3. **Memoized client components must compare every prop they read.** After a
   prop/state refactor, run `npm run smoke:render`; a component that reads a
   prop it no longer receives is a runtime failure even when `node --check` passes.
   Settings and menu changes must also pass the settings-screen and capability
   assertions in that smoke; if a state is only reachable through clicks, say so
   and verify it manually.
4. **Respect the host/client boundary.** The client only talks to the plugin's
   fenced exact routes; GitHub access, credentials, filesystem traversal, and
   terminal spawning stay on the host. Never ship secrets or account defaults.
5. **Live checks are explicit.** `smoke:host` may touch real GitHub/quota and must
   never be part of `check`/CI; new host behavior should first get a deterministic
   fixture or fake-subprocess test.
6. **Docs describe current behavior.** Remove historical statements rather than
   layering "now" on top of them; current package/name/paths are in `README.md`.
7. **Platform adapters are verified against the platform, not against our
   intent.** Before shipping shell, AppleScript, or PowerShell generation, check
   the real tool (`--help`, `sdef`, platform documentation) and record the
   verified semantics in a code comment. A unit test asserting the command we
   intended to build is not evidence that the OS behaves that way.
