# Local Profile Affixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Allow a custom text-processing profile to add an exact fixed prefix and/or suffix either directly to the raw transcript without an additional OpenAI request or after successful LLM polishing.

**Architecture:** Extend `PolishProfile` with a backward-compatible `mode`, `prefix`, and `suffix`. The Tauri state layer will distinguish immediate local output from LLM polishing, while `OpenAiClient::polish` will append affixes only after a successful API response so retries reuse the captured profile and cancellation still publishes the undecorated raw transcript.

**Tech Stack:** Rust, serde, Tokio, Tauri 2, React, TypeScript, Vitest.

## Global Constraints

- Existing saved profiles without the new fields deserialize as `mode: "llm"`, empty prefix, and empty suffix.
- `mode: "local"` never calls the OpenAI Responses API.
- Affixes are applied after all optional LLM processing and preserve user-entered whitespace exactly.
- A local profile must contain a non-whitespace prefix or suffix; each affix is limited to 8000 characters.
- Cancelling LLM polishing publishes the original raw transcript without affixes and without automatic paste.
- Existing built-in profiles remain immutable LLM profiles with empty affixes.
- macOS is the manually verified platform; Linux runtime remains unverified.

---

### Task 1: Core profile model and transformation

**Files:**
- Modify: `crates/stt-core/src/polish.rs`
- Modify: `crates/stt-core/src/client.rs`

**Interfaces:**
- Produces: `PolishMode::{Llm, Local}`, `PolishProfile::apply_affixes(&self, text: &str) -> String`, and backward-compatible serde defaults.
- Consumes: Existing `PolishSettings::selected_profile()` and `OpenAiClient::polish()` flows.

- [x] **Step 1: Add failing core tests**

Add tests proving legacy JSON defaults to LLM with empty affixes, local profiles require an affix, affix whitespace is preserved, and successful LLM output receives affixes.

- [x] **Step 2: Run the targeted core tests and confirm failure**

Run:

```sh
cargo test -p stt-core polish --locked
```

Expected: compilation or assertions fail because `mode`, `prefix`, and `suffix` do not exist.

- [x] **Step 3: Implement the profile fields and validation**

Add a snake-case serde enum whose default is `Llm`, add defaulted `prefix` and `suffix` strings, validate the mode-dependent instruction/affix requirements, and implement exact concatenation:

```rust
pub fn apply_affixes(&self, text: &str) -> String {
    format!("{}{}{}", self.prefix, text, self.suffix)
}
```

Update built-ins to use the defaults. Apply affixes to the extracted API result inside `OpenAiClient::polish`; local profiles return decorated input without creating an HTTP request as a defensive core behavior.

- [x] **Step 4: Run targeted core tests**

Run the same command and expect all tests to pass.

### Task 2: Tauri processing state and cancellation semantics

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: a typed result from `Data::accept_transcript` distinguishing immediate publication from LLM polishing.
- Consumes: `PolishMode`, `PolishProfile::apply_affixes`, processing generation, retry, and cancellation logic.

- [x] **Step 1: Add failing state tests**

Add tests proving an off profile publishes raw text, a local profile publishes decorated text without entering `Phase::Polishing` or creating a retry job, an LLM profile still enters polishing, and cancellation of LLM+affixes returns undecorated raw text.

- [x] **Step 2: Run targeted Tauri library tests and confirm failure**

Run:

```sh
cargo test -p stt-simple --lib state::tests --locked
```

Expected: compilation or assertions fail until local processing is represented.

- [x] **Step 3: Implement immediate versus LLM processing**

Replace the boolean result of `accept_transcript` with an enum equivalent to:

```rust
pub enum TranscriptProcessing {
    Publish(String),
    Polish,
}
```

For no selected profile publish raw text; for a local profile publish `profile.apply_affixes(&raw)`; for an LLM profile capture settings, enter `Phase::Polishing`, and invoke `OpenAiClient::polish`. Keep retry limited to captured failed LLM jobs.

- [x] **Step 4: Run targeted Tauri tests**

Run the same command and expect all tests to pass.

### Task 3: Profile editor and frontend validation

**Files:**
- Modify: `src/types.ts`
- Modify: `src/PolishSettingsFields.tsx`
- Modify: `src/utils.ts`
- Modify: `src/testFixtures.ts`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/utils.test.ts`

**Interfaces:**
- Produces: editable `mode`, `prefix`, and `suffix` fields on custom profiles with normalized names/instructions but exact affix content.
- Consumes: Rust snapshot JSON using snake-case mode values `llm` and `local`.

- [x] **Step 1: Add failing component and utility tests**

Cover legacy/default fixtures, creating and duplicating profiles, switching a custom profile between OpenAI and local processing, exact preservation of affix whitespace, local validation, dirty-state comparison, and explanatory paid-request copy.

- [x] **Step 2: Run frontend tests and confirm failure**

Run:

```sh
npm test
```

Expected: type errors or failed assertions for the missing fields and controls.

- [x] **Step 3: Implement the editor**

Use this TypeScript shape:

```ts
export interface PolishProfile {
  id: string;
  name: string;
  mode: 'llm' | 'local';
  instruction: string;
  prefix: string;
  suffix: string;
}
```

For custom profiles render a processing-method select, conditionally render the LLM instruction, and render prefix/suffix textareas for both modes. Preserve prefix/suffix exactly in `normalizeSettings`; keep model/effort global and explain that local profiles skip the additional request.

- [x] **Step 4: Run frontend tests**

Run `npm test` and expect all tests to pass.

### Task 4: Documentation and full validation

**Files:**
- Modify: `README.md`
- Modify: `docs/requirements.md`
- Modify: `docs/implementation.md`

**Interfaces:**
- Consumes: final user-visible and runtime behavior from Tasks 1–3.
- Produces: documented behavior and a macOS manual checklist.

- [x] **Step 1: Document profile modes and edge cases**

Document local versus LLM processing, final-stage affixes, exact whitespace, retry/cancellation behavior, favorite cycling, backwards compatibility, and Linux runtime status.

- [x] **Step 2: Run all automated checks**

Run:

```sh
cargo test -p stt-core --locked
cargo test -p stt-simple --lib --locked
npm test
npm run build
cargo fmt --all --check
git diff --check
cargo clippy -p stt-simple --lib --locked
```

Expected: all tests/build/format/diff checks pass; only previously known core Clippy warnings are acceptable.

- [x] **Step 3: Build the macOS debug application**

Run the repository's Tauri debug build with the configured NVM and Cargo paths. Expect `target/debug/bundle/macos/STT Simple.app` to be produced.

- [x] **Step 4: Report manual verification separately**

Do not claim macOS interaction or Linux runtime verification unless actually performed. Provide the user with a short manual scenario covering Off → built-in LLM → local suffix through the favorite-profile hotkey.
