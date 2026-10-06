# Task 3 Report — Frontend favorites, cycle shortcut, and macOS tray mode title

## Status

Completed.

## Commits

- `6912ffd` — `feat: add favorite polish profile controls`
- The report itself is stored in a separate documentation commit created after this file was written.

## Changed files

- `src/types.ts`
  - Added the serialized frontend fields `Settings.polish_shortcut`, `PolishSettings.favorite_profile_ids`, and the three `polish_hotkey_*` snapshot fields.
- `src/backend.ts`
  - Added the `cyclePolishProfile()` wrapper for the backend `cycle_polish_profile` command.
- `src/backend.test.ts`
  - Covered the exact `cycle_polish_profile` command name.
- `src/utils.ts`
  - Added polish-shortcut normalization, validation, and equality.
  - Preserved favorite IDs during normalization.
  - Added favorite existence and duplicate validation.
  - Added favorite-array value/order comparison.
- `src/utils.test.ts`
  - Covered polish-shortcut normalization/equality and favorite normalization, validation, and equality.
- `src/testFixtures.ts`
  - Updated frontend snapshots with the already-implemented backend fields and defaults.
- `src/App.tsx`
  - Added the editable “Сочетание клавиш переключения обработки” field.
  - Displays the macOS default hint as `Ctrl+Cmd+\` while storing `Control+Super+Backslash`.
  - Consumes polish hotkey availability/message/command snapshot fields in the system-hotkey UI.
- `src/PolishSettingsFields.tsx`
  - Added an accessible compact favorite checkbox/star row for every built-in and custom profile.
  - Added cycle behavior guidance.
  - Removes a deleted custom profile ID from favorites in the same draft update.
- `src/styles.css`
  - Added compact favorite-list styling.
- `src/App.test.tsx`
  - Covered independent built-in/custom favorites, explanatory copy, macOS shortcut display, busy locking, and deletion cleanup.
- `src-tauri/src/tray.rs`
  - Added macOS tray titles `Off`, `Fix`, `MD`, `Dev`, or a Unicode-safe custom name bounded to 12 characters (11 plus `…` when truncated).
  - Missing selected IDs safely fall back to `Off`.
  - Tray tooltip now includes the full active profile name while retaining the phase text.
  - Linux tray-title behavior remains unchanged.
  - Added pure unit tests for all tray title cases.

## UX behavior

- Every built-in and custom polish profile has its own accessible favorite checkbox with a visible `☆`/`★` state.
- “Выключено” is documented as always participating in the cycle.
- A single favorite is documented as a toggle between that profile and “Выключено”.
- Favorite controls and the cycle shortcut field inherit the settings fieldset lock in all busy phases.
- Deleting a custom profile also removes its ID from `favorite_profile_ids`; changes are still persisted only through “Сохранить настройки”.
- The cycle shortcut is editable and defaults to the backend value `Control+Super+Backslash`; on macOS the example is rendered as `Ctrl+Cmd+\`.
- On macOS, the tray title shows the current mode without replacing the phase-colored icon. Custom titles are bounded; the tooltip retains the full profile name and phase.
- Linux does not receive a tray title because desktop-environment support is inconsistent.

## TDD and validation

### Red phase

- `npm test -- src/utils.test.ts src/App.test.tsx`
  - Expected failure confirmed before implementation.
  - Result: 2 test files failed; 10 tests failed and 145 passed.
  - Failures covered missing polish-shortcut/favorite normalization, equality, validation, favorite controls, shortcut UI, locking, and deletion cleanup.
- Initial `cargo test --manifest-path src-tauri/Cargo.toml tray::tests::tray_mode_labels_are_compact_and_safe`
  - Could not start because `cargo` was not on `PATH` (`sh: cargo: command not found`).
  - The installed toolchain was then invoked explicitly via `/Users/sergey.mamykin/.cargo/bin/cargo`.

### Final results

- `npm test`
  - Passed: 5 test files, 169 tests; 0 failures.
- `npm run build`
  - Passed: `tsc -b` and Vite production build; 24 modules transformed.
- `/Users/sergey.mamykin/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml tray::tests`
  - Passed: 3 tray tests; 0 failures; 54 filtered out.
- `/Users/sergey.mamykin/.cargo/bin/cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
  - Passed after applying `cargo fmt`.
- `git diff --check`
  - Passed with no whitespace errors.
- Editor diagnostics for `src/App.tsx`, `src/PolishSettingsFields.tsx`, `src/utils.ts`, and `src-tauri/src/tray.rs`
  - No errors or warnings.

## Self-review

- Confirmed field names exactly match backend snake_case serialization.
- Confirmed favorites retain deterministic profile-list order; UI toggling does not reorder profiles.
- Confirmed custom tray truncation is character-based rather than byte-based.
- Confirmed built-in tooltip names come from `stt-core`, avoiding duplicated display names.
- Confirmed macOS-only `set_title` guards preserve Linux behavior.
- Confirmed the pre-existing untracked `docs/superpowers/` directory was not modified or staged.

## Concerns

- No known implementation concerns.
- The tray title behavior was unit-tested and compiled on macOS, but no manual visual tray inspection was performed in this non-interactive test run.
