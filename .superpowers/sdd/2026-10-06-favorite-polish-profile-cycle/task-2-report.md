# Task 2 Report: Register and execute the third global action

## Status

Completed.

## Changed files

- `src-tauri/src/shortcuts.rs`
  - Generalized shortcut validation, registration replacement, rollback, and pressed-key retention from two shortcuts to three.
  - Added conflict validation across STT, TTS, and polish profile cycling shortcuts.
  - Added the Wayland/manual command ending in `--cycle-polish` and unverified availability/message status.
  - Added tests for third-registration rollback, three-way conflicts, pressed-key retention, and distinct Wayland commands.
- `src-tauri/src/lib.rs`
  - Added `StartupAction::CyclePolish`, `--cycle-polish` parsing, native dispatch, single-instance dispatch, and command registration.
  - Added `cycle_polish_profile(app: AppHandle) -> Result<Snapshot, String>`.
  - Serialized cycling with `runtime.control`, required `Phase::Idle`, saved a cloned candidate before committing memory, and published only after success.
  - Added tests for native dispatch, startup parsing, persistence-before-commit, Off behavior, busy-state rejection, and persistence failure rollback.
- `src-tauri/src/state.rs`
  - Added `polish_hotkey_available`, `polish_hotkey_command`, and `polish_hotkey_message` to runtime data and snapshots.

## Behavior

- Native platforms register three unique global shortcuts transactionally.
- Pressing the configured polish shortcut dispatches profile cycling once per pressed edge.
- `--cycle-polish` invokes the same action for startup, single-instance, and manual system shortcut usage.
- On Wayland, the snapshot exposes a manual `--cycle-polish` command, reports the native hotkey unavailable, and marks the action unverified.
- Cycling is rejected unless the runtime is idle and the control lock is immediately available.
- The candidate settings are persisted before in-memory state changes. Save failure preserves prior in-memory settings and does not publish a new snapshot.
- No favorites, or cycling past the last favorite, leaves polish selection Off (`profile_id: None`).

## TDD and test commands/results

1. Required red command as written:
   - Command: `cargo test -p stt-simple --lib --locked shortcuts`
   - Result: failed before execution with exit code 127 because `cargo` was not on the tool shell's `PATH` (`sh: cargo: command not found`).
2. Red command using the installed Cargo executable:
   - Command: `/Users/sergey.mamykin/.cargo/bin/cargo test -p stt-simple --lib --locked shortcuts`
   - Result: failed with exit code 101 as expected; compilation reported the missing three-shortcut registration shape and missing `StartupAction::CyclePolish`.
3. Focused green command:
   - Command: `/Users/sergey.mamykin/.cargo/bin/cargo test -p stt-simple --lib --locked shortcuts`
   - Result: passed, 10 passed; 0 failed; 45 filtered out.
4. Required full backend command (using explicit Cargo path because of the shell `PATH`):
   - Command: `/Users/sergey.mamykin/.cargo/bin/cargo test -p stt-simple --lib --locked`
   - Result: passed, 55 passed; 0 failed; 0 ignored; 0 filtered out.
5. Formatting:
   - Command: `/Users/sergey.mamykin/.cargo/bin/cargo fmt --all`
   - Result: passed.
6. Diff validation:
   - Command: `git --no-pager diff --check`
   - Result: passed with no whitespace errors before the implementation commit.

## Commit

- Implementation commit: `17cec6b` (`feat(tauri): cycle favorite polish profiles`)

## Self-review

- Confirmed all three shortcuts participate in conflict detection and transactional registration rollback.
- Confirmed settings saves retain pressed edges only for shortcuts still configured.
- Confirmed native dispatch recognizes all three actions and unknown shortcuts are ignored.
- Confirmed disk persistence occurs before the in-memory commit and busy/error paths leave memory unchanged.
- Confirmed the pre-existing untracked `docs/superpowers/` directory was not modified or committed.

## Concerns

- The tool shell does not include Cargo on `PATH`; tests required `/Users/sergey.mamykin/.cargo/bin/cargo` explicitly. This does not affect application behavior.
- Wayland polish cycling is intentionally exposed as a manual command and marked unverified, as required.
