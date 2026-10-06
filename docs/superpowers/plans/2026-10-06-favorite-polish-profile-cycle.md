# Favorite Polish Profile Cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable global hotkey that cycles post-processing through Off and user-selected favorite profiles, while showing the active mode beside the macOS tray icon.

**Architecture:** Persist the cycle shortcut on `Settings` and favorite profile IDs on `PolishSettings`, with core helpers defining deterministic `Off → favorites → Off` behavior. Extend the existing transactional shortcut registration from two to three actions, expose one backend cycle operation used by native shortcuts, CLI/single-instance dispatch, and tests, then add favorite controls and shortcut editing to the React settings UI. The macOS tray title displays a compact active-profile label; Linux behavior compiles and is tested but remains manually unverified.

**Tech Stack:** Rust, Tauri 2, `tauri-plugin-global-shortcut`, React, TypeScript, Vitest.

## Global Constraints

- Default macOS-visible cycle shortcut is `Ctrl+Cmd+\\`, persisted internally as `Control+Super+Backslash`.
- Off is always the first implicit cycle entry and cannot be removed.
- Only favorite existing profiles participate; built-ins precede custom profiles in display order.
- One favorite makes the hotkey an `Off ↔ profile` toggle; no favorites keeps the mode Off.
- A currently selected non-favorite profile cycles to Off.
- Mode changes are allowed only while the application is idle and apply to the next recording.
- Existing STT, TTS, color-state tray icon, profile editing, and auto-paste behavior must remain unchanged.
- Linux support must compile and receive automated coverage, but must be described as not manually verified.

---

### Task 1: Persist favorites and define cycle semantics

**Files:**
- Modify: `crates/stt-core/src/lib.rs`
- Modify: `crates/stt-core/src/polish.rs`
- Modify: `crates/stt-core/src/persistence.rs`

**Interfaces:**
- Produces: `Settings::polish_shortcut: String` with default `Control+Super+Backslash`.
- Produces: `PolishSettings::favorite_profile_ids: Vec<String>`.
- Produces: `PolishSettings::cycle_profile(&mut self) -> Option<String>`, returning the new active profile ID or `None` for Off.

- [ ] **Step 1: Write failing Rust tests for defaults, migration, favorite validation, and cycle ordering**

Cover old JSON defaulting to an empty favorite list and the new shortcut, duplicate/missing favorite IDs being rejected, built-ins before customs regardless of favorite selection order, one-favorite toggling, no-favorite Off behavior, and non-favorite current selection returning to Off.

- [ ] **Step 2: Run the focused core tests and verify failure**

Run: `cargo test -p stt-core polish --locked`
Expected: compilation/test failures because the new fields and helper do not exist.

- [ ] **Step 3: Implement the settings fields, validation, defaults, and deterministic cycle helper**

Build the ordered candidates from `builtin_polish_profiles()` followed by `custom_profiles`, filtered through the favorite-ID set. Treat `None` as Off; find the current favorite and advance, or return Off after the last/current non-favorite. Validate favorites as unique IDs that resolve to an existing built-in or custom profile.

- [ ] **Step 4: Run core tests**

Run: `cargo test -p stt-core --locked`
Expected: all core tests pass.

### Task 2: Register and execute the third global action

**Files:**
- Modify: `src-tauri/src/shortcuts.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/state.rs`

**Interfaces:**
- Consumes: `Settings::polish_shortcut` and `PolishSettings::cycle_profile()`.
- Produces: Tauri command `cycle_polish_profile(app: AppHandle) -> Result<Snapshot, String>`.
- Produces: startup action `--cycle-polish` for single-instance and Wayland/manual system shortcut use.
- Produces: snapshot fields describing availability/command/message for the cycle hotkey.

- [ ] **Step 1: Extend shortcut tests from a pair to three unique registrations**

Test conflicts among all three actions, transactional rollback when the third registration fails, pressed-key retention, native dispatch, and `--cycle-polish` startup parsing.

- [ ] **Step 2: Add failing state/command tests for idle-only atomic cycling**

Verify the command persists the updated profile before publishing it, returns Off when no favorites exist, rejects busy phases without changing disk or memory, and preserves prior settings after persistence failure.

- [ ] **Step 3: Run focused backend tests and verify failure**

Run: `cargo test -p stt-simple --lib --locked shortcuts`
Expected: failures until three-action registration is implemented.

- [ ] **Step 4: Implement registration, dispatch, persistence, and snapshot status**

Generalize native registration to a three-shortcut collection. Add native dispatch and `--cycle-polish`; on Wayland expose the command for manual assignment and mark it unverified. Serialize cycle changes with `runtime.control`, require `Phase::Idle`, save a cloned candidate first, then commit it to in-memory state and publish.

- [ ] **Step 5: Run backend tests**

Run: `cargo test -p stt-simple --lib --locked`
Expected: all backend unit tests pass.

### Task 3: Show mode in tray and edit favorites in the UI

**Files:**
- Modify: `src-tauri/src/tray.rs`
- Modify: `src/types.ts`
- Modify: `src/backend.ts`
- Modify: `src/utils.ts`
- Modify: `src/App.tsx`
- Modify: `src/PolishSettingsFields.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/utils.test.ts`
- Modify: `src/styles.css` if layout styling is required

**Interfaces:**
- Consumes: new settings/snapshot fields and `cycle_polish_profile` command.
- Produces: favorites checkboxes/star toggles for every built-in/custom profile.
- Produces: editable “Сочетание клавиш переключения обработки” field.
- Produces: macOS tray titles `Off`, `Fix`, `MD`, `Dev`, or a bounded custom-profile label.

- [ ] **Step 1: Add failing frontend tests for normalization, validation, equality, and deletion cleanup**

Verify favorite IDs survive normalization, participate in equality, must reference existing profiles without duplicates, and are removed when a custom profile is deleted.

- [ ] **Step 2: Add failing component tests for favorite controls and cycle shortcut UI**

Verify all profiles can be independently starred, Off is documented as always in the cycle, one favorite is described as a toggle, the shortcut defaults/displays as `Ctrl+Cmd+\\` on macOS, and busy phases lock controls.

- [ ] **Step 3: Add failing tray label unit tests**

Verify stable compact labels for Off, each built-in, bounded custom names, and missing selected IDs falling back safely to Off.

- [ ] **Step 4: Implement TypeScript settings support and profile favorite controls**

Add `polish_shortcut` and `favorite_profile_ids` to types, draft defaults, normalization, validation, and equality. Render accessible favorite checkboxes next to profile names in a separate compact list because native `<option>` elements cannot contain interactive controls. Remove deleted custom IDs from favorites.

- [ ] **Step 5: Implement tray mode title and tooltip**

On macOS call `tray.set_title(Some(label))` while retaining the phase-colored icon. Include the full active profile in the tooltip. Keep Linux tray-title behavior unchanged due desktop-environment inconsistency.

- [ ] **Step 6: Run frontend tests and build**

Run: `npm test`
Expected: all tests pass.

Run: `npm run build`
Expected: TypeScript and Vite build pass.

### Task 4: Full regression and macOS bundle verification

**Files:**
- Modify: `README.md` only if existing shortcut documentation requires synchronization.

**Interfaces:**
- Consumes: completed core, backend, tray, and frontend implementation.
- Produces: a debug macOS application ready for manual hotkey verification.

- [ ] **Step 1: Run formatting and all focused automated checks**

Run: `cargo fmt --all --check`
Run: `cargo test -p stt-core --locked`
Run: `cargo test -p stt-simple --lib --locked`
Run: `cargo check -p stt-simple --locked`
Run: `npm test`
Run: `npm run build`
Expected: all commands pass.

- [ ] **Step 2: Build the macOS debug bundle**

Run with Cargo, NVM Node, Homebrew, and system binaries in `PATH`: `npm run tauri -- build --debug`
Expected: `target/debug/bundle/macos/STT Simple.app` is produced.

- [ ] **Step 3: Verify repository cleanliness and diagnostics**

Run: `git diff --check`
Run project diagnostics.
Expected: no whitespace errors or diagnostics introduced by the feature.

- [ ] **Step 4: Report manual verification steps without performing paid API calls**

Quit the old tray process, open the rebuilt bundle, star one profile and verify `Off ↔ profile`, star multiple profiles and verify ordered cycling, verify tray title changes, and confirm the selected mode is used on the next user-initiated dictation. Do not trigger paid OpenAI requests automatically.
