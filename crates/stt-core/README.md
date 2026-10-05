# stt-core

Independent Rust library (`stt_core`), edition 2021. The manifest still declares
`rust-version = "1.77.2"`, but strict compatibility with Rust 1.77.2 is not
claimed: the current workspace lockfile includes dependencies that require a
newer toolchain, including Edition 2024 dependencies. No Tauri, UI, microphone
capture, key storage, playback, or text rewriting.

## Public API

- `Settings { shortcut, model, tts_shortcut, tts_model, tts_voice, input_device, auto_paste }` and
  `Settings::validate()`. Defaults: `Super+R` on Linux (`Control+Super+R` on macOS),
  `gpt-transcribe` (also exported as `DEFAULT_MODEL`); `Control+Super+A` for
  text-to-speech on every platform; `gpt-4o-mini-tts` (`DEFAULT_TTS_MODEL`);
  and `marin` (`DEFAULT_TTS_VOICE`); no selected input device. Omitted TTS
  fields in existing persisted settings are serde-defaulted. If an older file
  lacks `tts_shortcut` and its STT shortcut conflicts with that default, loading
  migrates its TTS shortcut to `Control+Super+4`; an explicitly persisted
  conflict remains invalid. Both shortcuts must contain 1–128 characters.
  Trimmed-identical values always conflict. Otherwise conflict detection treats
  modifier order, ASCII case, and the aliases
  `Control`/`Ctrl`, `Alt`/`Option`, `Super`/`Meta`/`Command`/`Cmd`, and `Shift`
  as equivalent without rewriting persisted shortcuts. Malformed shortcut
  syntax and duplicate equivalent modifiers have no canonical identity, but
  trimmed-identical malformed values still conflict. TTS model IDs
  use the same format rules as transcription IDs; voice IDs use the same ASCII
  format and have separate validation errors.
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
  `transcribe(&self, api_key: &str, model: &str, audio: Vec<u8>)`, plus
  `synthesize(&self, api_key: &str, model: &str, voice: &str, input: &str)`.
  Synthesis sends JSON to `https://api.openai.com/v1/audio/speech` with
  `model`, `voice`, original (untrimmed) `input`, and `response_format="wav"`.
  Empty/whitespace input and input over `MAX_TTS_INPUT_CHARS = 4096` Unicode
  characters are rejected before network access; streamed WAV output is capped
  at 64 MiB. TTS-specific 400 and 404 errors identify the synthesis request,
  model, or voice without exposing API response data.
  Use from a Tokio runtime supplied by the application. Requests use the fixed
  transcription endpoint `https://api.openai.com/v1/audio/transcriptions` or
  speech endpoint `https://api.openai.com/v1/audio/speech`, a 120-second timeout,
  and never follow redirects. Transcription model IDs are forwarded unchanged
  with `response_format=json`. For `gpt-4o-transcribe-diarize` and IDs starting with
  `gpt-4o-transcribe-diarize-`, requests also send `chunking_strategy=auto` to
  support audio longer than 30 seconds. Other model IDs omit that parameter.
  The [official transcription API reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
  confirms the diarization model accepts `json`; speaker annotations are not
  requested. The returned `text` is only trimmed at its boundaries: no
  translation, polish, prompts, or additional model calls. No model-list API is
  called, and future model compatibility is left to OpenAI.
  Transcription sends audio and the bearer key directly to OpenAI; synthesis
  sends input text and the bearer key directly to OpenAI. This requires internet
  access and an API key. Russian errors do not echo response bodies, keys,
  audio, TTS input, or transcripts. Only `error.code == "insufficient_quota"` selects the
  quota-specific HTTP 429 message; other 429 responses use rate-limit guidance.
  HTTP 404 returns model-unavailable/not-found guidance without exposing the
  API response or model ID.

## Validation

From this directory:

```sh
cargo fmt --all --check
cargo test -p stt-core --locked
```

Tests cover defaults and backward-compatible serde for TTS fields, canonical
STT/TTS shortcut conflict detection and legacy migration, model and voice
validation, manual/snapshot model-ID validation and
preservation of persisted model IDs, statistical accumulation and bounds,
persistence roundtrip/corruption/forward-compatible defaults/failed writes,
normal save outcomes and committed saves with simulated directory-sync warnings,
WAV sample sanitization and resampling, and local TCP HTTP mocks for multipart
authentication, unchanged model forwarding, diarization-only automatic
chunking, plain JSON transcription, safe model-unavailable HTTP 404 guidance,
other status errors, quota/rate-limit errors,
redirect refusal, timeouts, invalid input, and malformed/oversized responses,
as well as local JSON/WAV synthesis requests, 4096-character input limits,
the production 64 MiB streamed WAV limit (tested with a small test-only limit),
and synthesis-safe HTTP errors.
No real API key or external HTTP service is needed for tests. Dependency
resolution still needs downloaded crates, and building requires a compatible
Rust toolchain and platform linker.
