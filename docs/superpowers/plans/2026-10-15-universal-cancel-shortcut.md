# Universal Cancel Shortcut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Execute inline without subagents, per user instructions.

**Goal:** Add a configurable global `Control+Shift+Escape` shortcut cancelling dictation, processing, synthesis, or playback.

**Architecture:** Reuse existing generation-scoped processing cancellation and acknowledged TTS stop. Register cancellation independently at startup so an occupied cancellation shortcut cannot disable the existing actions; replace all four shortcuts transactionally on settings saves. Expose registration status and settings in the frontend. On Wayland expose a manual `--cancel` command, like TTS.

**Tech Stack:** Rust, Tauri 2 global-shortcut, React, TypeScript, Vitest.

## Global Constraints

- No new dependencies or changes to output/statistics semantics.
- Idle cancellation is a no-op; cancellation must never start TTS.
- Preserve existing settings; migrate an omitted cancellation shortcut around existing assignments.
- Existing cancellation semantics retain raw text on polish cancellation, without automatic paste.
- Keep resource-release acknowledgements and stale-generation protection.
- Create a feature branch and PR as requested; do not modify main directly.

---

### Task 1: Settings and migration

**Files:** `crates/stt-core/src/lib.rs`, `crates/stt-core/src/persistence.rs`.

- [x] Add regression tests for the default, validation, aliases, omitted-field migration, explicit conflicts, and roundtrip.
- [x] Add `cancel_shortcut: String`, default `Control+Shift+Escape`, and conflict checks against the three existing actions. Treat `Esc` and `Escape` as equivalent.
- [x] For omitted settings choose the first free value among `Control+Shift+Escape`, `Control+Super+7`, `Control+Super+8`, `Control+Super+9`; never rewrite explicit values.
- [x] Run `cargo test -p stt-core`.

### Task 2: Runtime and global registration

**Files:** `src-tauri/src/lib.rs`, `src-tauri/src/state.rs`, `src-tauri/src/shortcuts.rs`, `src-tauri/src/tray.rs`.

- [x] Test parsing and routing `Control+Shift+Escape`, `--cancel`, independent startup registration failure, and four-way replacement using the existing fake registration backend.
- [x] Add cancellation registration status to Data/Snapshot and all constructors.
- [x] Register cancellation independently at startup; include it in transactional settings replacement and held-edge retention.
- [x] Route cancel events through `spawn_cancel`; extend cancellation to generation-scoped TTS stop without toggling speech. Extend tray cancellation labels to TTS.
- [x] Expose manual Wayland cancellation command; do not change GNOME automatic bindings.
- [x] Run `cargo test --workspace` and `cargo fmt --all -- --check`.

### Task 3: UI, documentation, and PR

**Files:** `src/types.ts`, `src/utils.ts`, `src/testFixtures.ts`, `src/App.tsx`, frontend tests, `README.md`, `docs/requirements.md`, `docs/implementation.md`.

- [x] Add the setting, normalization/equality/validation, registration diagnostics, shortcut hint, and Wayland instructions.
- [x] Test cancellation field editing/saving, alias conflicts, and unavailable registration rendering.
- [x] Update requirements and manual checks for recording/transcribing/polishing/synthesizing/playing, idle no-op, held keys, occupied binding, and release acknowledgement.
- [x] Run `npm test`, `npm run build`, and `git diff --check`; review diff.
- [ ] Commit the focused changes, push the feature branch, and create a PR with validation results and remaining manual checks.
