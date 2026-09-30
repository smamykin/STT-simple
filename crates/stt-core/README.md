# stt-core

Independent Rust library (`stt_core`), edition 2021, declared minimum Rust
version 1.77.2. No Tauri, UI, microphone capture, key storage, or text rewriting.

## Public API

- `Settings { shortcut, model, input_device }` and `Settings::validate()`.
  Defaults: `Super+R` on Linux (`Control+Super+R` on macOS),
  `gpt-4o-mini-transcribe`, no selected input device. Allowed models:
  `gpt-4o-mini-transcribe`, `gpt-4o-transcribe`, `whisper-1`.
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
  timeout and never follow redirects. The returned transcript is only trimmed
  at its boundaries: no translation, polish, prompts, or additional model calls.
  Audio and the bearer key are sent directly to OpenAI; this requires internet
  access and an API key. Russian errors do not echo response bodies, keys,
  audio, or transcripts. Only `error.code == "insufficient_quota"` selects the
  quota-specific HTTP 429 message; other 429 responses use rate-limit guidance.

## Validation

From this directory:

```sh
cargo fmt --check
cargo test
```

Tests cover defaults and validation, statistical accumulation and bounds,
persistence roundtrip/corruption/forward-compatible defaults/failed writes,
normal save outcomes and committed saves with simulated directory-sync warnings,
WAV sample sanitization and resampling, and local TCP HTTP mocks for multipart
authentication, plain transcription, status errors, quota/rate-limit errors,
redirect refusal, timeouts, invalid input, and malformed/oversized responses.
No real API key or external HTTP service is needed for tests. Dependency
resolution still needs downloaded crates, and building requires a compatible
Rust toolchain and platform linker.
