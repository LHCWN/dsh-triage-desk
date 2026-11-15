# Triage Desk

- File and contract map: `docs/ARCHITECTURE.md`; local profile install and reload rules: `docs/DEV_LOCAL.md`.
- User-facing docs: `README.md` (English) and `README.zh.md` (Chinese); keep both in sync.
- Before committing: `npm run check` (offline; lint + client/render/launcher/route/cache/snapshot smokes).
- `npm run smoke:host` is a live GitHub check and spends quota; run it explicitly, not in the default check.
- DSH API facts: load the `dsh-doc` skill and query one exact service at a time with `cordis_inspect_query`. Pass `service`/`root`: the no-key catalog and unfiltered slot tree are ~50 KB each. Page `plugin_manager list_plugins` instead of assuming the target argument filters it.
- Bash: pass the command's `workdir` instead of prefixing every command with `cd <repo>`.
- Review rules: `CODING_STANDARDS.md`.

