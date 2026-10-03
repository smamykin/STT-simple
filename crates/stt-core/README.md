# stt-core

Independent Rust library (`stt_core`), edition 2021, declared minimum Rust
version 1.77.2. No Tauri, UI, microphone capture, or key storage.

## Public API

- `Settings { shortcut, model, input_device, auto_paste, paste_shortcut, polish }`
  and `Settings::validate()` (including polish validation).
  Defaults: `Super+R` on Linux (`Control+Super+R` on macOS),
  `gpt-transcribe` (also exported as `DEFAULT_MODEL`), no selected input device.
  The new model default applies only to new settings or omitted model fields;
  explicitly persisted model IDs remain unchanged, including the previous
  `gpt-4o-mini-transcribe` default.
  Manual model IDs and snapshots are accepted without an allowlist: IDs must be
  1–128 ASCII bytes, begin with an ASCII letter or digit, and contain only ASCII
  letters, digits, `.`, `_`, `-`, or `:` thereafter. Whitespace, slashes, control
  characters, and non-ASCII characters are rejected; IDs are never trimmed or
  rewritten. **Format validation does not establish endpoint compatibility or
  account access**; OpenAI is authoritative. Examples of valid IDs include
  `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe-2025-12-15`, and
  future custom IDs such as `future-ASR_v2.1:stable` (availability is not implied).
  Shortcut syntax is parsed by the desktop application, not this crate.
- `Statistics { last_recording_seconds, total_recording_seconds, recordings }`
  and `Statistics::add_recording(seconds)`.
- `StoredData { settings, statistics }` and
  `load_data(path: &Path) -> Result<StoredData, String>`. Missing files and omitted
  fields default; unknown JSON fields are ignored. Corrupt or invalid files
  return errors. Only settings and statistics are persisted, never keys or
  transcripts.
- `save_data(path: &Path, data: &StoredData) -> Result<SaveOutcome, String>` and
  exported `SaveOutcome { pub durability_warning: Option<String> }`.
  Saves create parent directories and atomically replace a sibling temporary
  file after synchronizing it. **`Err` means a pre-commit failure**: the rename
  did not succeed. **`Ok` means the save committed**, even if subsequent
  directory synchronization failed. On Unix, directory open/fsync failure
  returns `Ok` with a Russian durability warning: settings are saved, but
  persistence across a power failure is not confirmed. Normal successful saves
  return `durability_warning: None`. Non-Unix platforms do not attempt directory
  synchronization. A caller must treat a warning as a committed save, not roll
  back settings or report it as a failed save.
- `MAX_RECORDING_SECONDS: u64 = 600`.
- `encode_wav(&[f32], sample_rate)` accepts **mono** normalized input at native
  rates from 1 through 384000 Hz, sanitizes nonfinite samples to silence, clamps
  amplitudes, and linearly resamples to mono PCM16 WAV at 16 kHz. The backend
  must downmix microphone input if needed and measure duration as
  `native_samples.len() as f64 / native_sample_rate as f64` before resampling.
  Recordings over 600 seconds and uploads over 25 MiB are rejected.
- `OpenAiClient::new()` and async
  `transcribe(&self, api_key: &str, model: &str, audio: Vec<u8>)`.
  Use from a Tokio runtime supplied by the application. The endpoint is fixed
  to `https://api.openai.com/v1/audio/transcriptions`; requests use a 120-second
  timeout and never follow redirects. Model IDs are forwarded unchanged with
  `response_format=json`. For `gpt-4o-transcribe-diarize` and IDs starting with
  `gpt-4o-transcribe-diarize-`, requests also send `chunking_strategy=auto` to
  support audio longer than 30 seconds. Other model IDs omit that parameter.
  The [official transcription API reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
  confirms the diarization model accepts `json`; speaker annotations are not
  requested. The returned `text` is only trimmed at its boundaries: no
  translation, polish, prompts, or additional model calls. No model-list API is
  called during transcription, and future model compatibility is left to OpenAI.
  Audio and the bearer key are sent directly to OpenAI; this requires internet
  access and an API key. Russian errors do not echo response bodies, keys,
  audio, or transcripts. Only `error.code == "insufficient_quota"` selects the
  quota-specific HTTP 429 message; other 429 responses use rate-limit guidance.
  HTTP 404 returns model-unavailable/not-found guidance without exposing the
  API response or model ID.

- Public `OpenAiModel { id: String, created: u64 }` implements `Serialize`,
  `Deserialize`, `Clone`, and `Debug`. Async
  `OpenAiClient::list_models(&self, api_key: &str) -> Result<Vec<OpenAiModel>, String>`
  calls `GET https://api.openai.com/v1/models` with the same 120-second timeout,
  1 MiB body limit, sensitive authorization header, no redirects, and sanitized
  errors. Parses the `data` array, ignoring metadata such as `object`, `owned_by`,
  and `shutdown_date`. Malformed entries and IDs unusable by Settings are rejected.
  Results sort by creation time descending then ID ascending; duplicate IDs keep
  the newest entry. An empty list is valid; listing does not imply endpoint support.
  The desktop `list_openai_models` command loads credentials only in Rust after an
  idle check under the control mutex, releasing it before HTTP; it mutates no state.

## Optional transcript polishing

- Public `PolishSettings { profile_id: Option<String>, model: String,
  effort: Option<String>, custom_profiles: Vec<PolishProfile> }` and
  `PolishProfile { id: String, name: String, instruction: String }` implement
  `Clone`, `Debug`, `PartialEq`, serde serialization/deserialization, and defaults.
  Missing `Settings.polish` or polish fields migrate using defaults: off
  (`profile_id: None`), `gpt-6-luna`, provider-default effort (`None`), no custom
  profiles. Explicit saved model IDs are preserved. Persisted custom instructions are settings, not transcript history.
- `builtin_polish_profiles() -> Vec<PolishProfile>` returns fresh copies of three
  immutable built-ins: `polish` / «Минимальная правка», `markdown` / «Структура
  Markdown», and `developer` / «Сообщение разработчика». Prompts preserve meaning,
  details, uncertainty, and technical identifiers; dictated instructions are data,
  not commands to execute. Model compliance cannot be guaranteed by prompts alone.
- `PolishSettings::validate() -> Result<(), String>` validates even when off.
  Custom IDs use the same 1–128 ASCII-byte syntax as model IDs, are case-sensitive,
  must be unique, and cannot shadow built-in IDs. Maximum 32 custom profiles;
  nonblank names up to 80 Unicode characters and nonblank instructions up to
  8,000 Unicode characters. An unknown selected ID is an error, never a silent
  fallback. `selected_profile() -> Result<Option<PolishProfile>, String>` validates
  and returns an owned profile, or `None` when off.
- Allowed effort strings: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
  Availability depends on the model and account; OpenAI is authoritative.
    The [current official model catalog](https://developers.openai.com/api/docs/models)
    lists `gpt-6-astra` and `gpt-6.1-sol` with `low`, `medium`, `high`, `xhigh`, `max`,
    and `gpt-6-luna` with those levels plus `none`. Legacy `minimal` remains accepted
    for existing settings; validation does not impose a model-specific allowlist.
  `None` omits the entire `reasoning` field; `Some("none")` explicitly requests
  `reasoning.effort: "none"` and is not equivalent to omitting it.
- Async `OpenAiClient::polish(&self, api_key: &str, settings: &PolishSettings,
  transcript: &str) -> Result<String, String>` is separate from transcription.
  When off, returns the original string unchanged without requiring a key or
  network access. When enabled, requires nonblank input of at most 1 MiB and
  sends it as user `input_text` to `https://api.openai.com/v1/responses`, with
  shared instructions plus the profile instruction and `store: false`.
  This is an additional paid OpenAI request and sends the transcript and profile
  instruction to OpenAI. `store: false` is not a guarantee of zero provider retention.
- Uses the existing 120-second timeout, 1 MiB response-body limit, and no-redirect
  policy. Only completed assistant `output_text` parts are concatenated in order
  and boundary-trimmed; reasoning summaries are excluded. Incomplete, failed,
  refused, empty, malformed, or unexpected output is rejected without returning
  partial text. Errors are sanitized and never echo keys, transcripts, profile
  instructions, or raw provider messages. Callers should retain the original
  transcript if polishing fails. No logging or persistence of API keys or
  transcripts is added.

## Validation

From this directory:

```sh
cargo fmt -p stt-core --check
cargo test -p stt-core --locked
```

Tests cover defaults, manual/snapshot model-ID validation and preservation of
persisted model IDs, statistical accumulation and bounds,
persistence roundtrip/corruption/forward-compatible defaults/failed writes,
normal save outcomes and committed saves with simulated directory-sync warnings,
WAV sample sanitization and resampling, and local TCP HTTP mocks for multipart
authentication, unchanged model forwarding, diarization-only automatic
chunking, plain JSON transcription, safe model-unavailable HTTP 404 guidance,
other status errors, quota/rate-limit errors,
redirect refusal, timeouts, invalid input, and malformed/oversized responses.
No real API key or external HTTP service is needed for tests. Dependency
resolution still needs downloaded crates, and building requires a compatible
Rust toolchain and platform linker.
