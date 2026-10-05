use crate::{validate_model, validate_voice, MAX_AUDIO_BYTES, MAX_TTS_INPUT_CHARS};
use reqwest::header::{HeaderValue, AUTHORIZATION};
use reqwest::multipart::{Form, Part};
use reqwest::{Client, Response, StatusCode};
use serde::Deserialize;
use std::time::Duration;

const TRANSCRIPTIONS_ENDPOINT: &str = "https://api.openai.com/v1/audio/transcriptions";
const SPEECH_ENDPOINT: &str = "https://api.openai.com/v1/audio/speech";
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_TTS_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const TIMEOUT_ERROR: &str =
    "OpenAI не ответил вовремя. Проверьте соединение и повторите попытку; при необходимости сократите запись.";

pub struct OpenAiClient {
    client: Client,
    #[cfg(test)]
    transcriptions_endpoint: String,
    #[cfg(test)]
    speech_endpoint: String,
    #[cfg(test)]
    tts_response_limit: usize,
}

impl OpenAiClient {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            client: build_client(Duration::from_secs(120))?,
            #[cfg(test)]
            transcriptions_endpoint: TRANSCRIPTIONS_ENDPOINT.into(),
            #[cfg(test)]
            speech_endpoint: SPEECH_ENDPOINT.into(),
            #[cfg(test)]
            tts_response_limit: MAX_TTS_RESPONSE_BYTES,
        })
    }

    #[cfg(test)]
    fn with_test_endpoint(endpoint: String, timeout: Duration) -> Self {
        Self::with_test_endpoints(endpoint.clone(), endpoint, timeout)
    }

    #[cfg(test)]
    fn with_test_endpoints(
        transcriptions_endpoint: String,
        speech_endpoint: String,
        timeout: Duration,
    ) -> Self {
        Self::with_test_endpoints_and_tts_response_limit(
            transcriptions_endpoint,
            speech_endpoint,
            timeout,
            MAX_TTS_RESPONSE_BYTES,
        )
    }

    #[cfg(test)]
    fn with_test_endpoints_and_tts_response_limit(
        transcriptions_endpoint: String,
        speech_endpoint: String,
        timeout: Duration,
        tts_response_limit: usize,
    ) -> Self {
        Self {
            client: Client::builder()
                .timeout(timeout)
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .build()
                .unwrap(),
            transcriptions_endpoint,
            speech_endpoint,
            tts_response_limit,
        }
    }

    pub async fn transcribe(
        &self,
        api_key: &str,
        model: &str,
        audio: Vec<u8>,
    ) -> Result<String, String> {
        validate_model(model)?;
        let api_key = api_key.trim();
        if api_key.is_empty() {
            return Err("Добавьте API-ключ OpenAI в настройках.".into());
        }
        let mut authorization =
            HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|_| {
                "Недопустимый формат API-ключа. Проверьте ключ в настройках.".to_owned()
            })?;
        authorization.set_sensitive(true);
        if audio.is_empty() {
            return Err("Запись пуста. Проверьте микрофон и повторите запись.".into());
        }
        if audio.len() > MAX_AUDIO_BYTES {
            return Err("Запись превышает 25 МБ. Сократите запись и повторите попытку.".into());
        }
        let part = Part::bytes(audio)
            .file_name("recording.wav")
            .mime_str("audio/wav")
            .map_err(|_| "Не удалось подготовить WAV к отправке.".to_owned())?;
        let mut form = Form::new()
            .part("file", part)
            .text("model", model.to_owned())
            .text("response_format", "json");
        if model == "gpt-4o-transcribe-diarize" || model.starts_with("gpt-4o-transcribe-diarize-") {
            // Required by the diarization model for recordings longer than 30 seconds.
            form = form.text("chunking_strategy", "auto");
        }
        #[cfg(test)]
        let endpoint = self.transcriptions_endpoint.as_str();
        #[cfg(not(test))]
        let endpoint = TRANSCRIPTIONS_ENDPOINT;
        let response = self
            .client
            .post(endpoint)
            .header(AUTHORIZATION, authorization)
            .multipart(form)
            .send()
            .await
            .map_err(request_error)?;
        let status = response.status();
        if status == StatusCode::TOO_MANY_REQUESTS {
            let body = read_body(
                response,
                MAX_RESPONSE_BYTES,
                "Ответ OpenAI слишком большой. Сократите запись и повторите попытку.",
            )
            .await?;
            // Only this documented code is inspected; API messages are never surfaced.
            let quota = serde_json::from_slice::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| {
                    value
                        .get("error")?
                        .get("code")?
                        .as_str()
                        .map(|code| code == "insufficient_quota")
                })
                .unwrap_or(false);
            return Err(if quota {
                "Исчерпана квота OpenAI. Проверьте баланс и лимиты API в аккаунте OpenAI."
            } else {
                "Слишком много запросов к OpenAI. Подождите немного и повторите попытку."
            }
            .into());
        }
        if !status.is_success() {
            return Err(status_error(status));
        }
        let body = read_body(
            response,
            MAX_RESPONSE_BYTES,
            "Ответ OpenAI слишком большой. Сократите запись и повторите попытку.",
        )
        .await?;
        let transcription: Transcription = serde_json::from_slice(&body)
            .map_err(|_| "OpenAI вернул некорректный ответ. Повторите попытку.".to_owned())?;
        let text = transcription.text.trim();
        if text.is_empty() {
            return Err("Речь не распознана. Проверьте микрофон и повторите запись.".into());
        }
        Ok(text.to_owned())
    }

    pub async fn synthesize(
        &self,
        api_key: &str,
        model: &str,
        voice: &str,
        input: &str,
    ) -> Result<Vec<u8>, String> {
        validate_model(model).map_err(|_| {
            "Некорректный идентификатор TTS-модели. Проверьте настройки озвучивания.".to_owned()
        })?;
        validate_voice(voice)?;
        if input.trim().is_empty() {
            return Err("Текст для озвучивания пуст. Введите текст и повторите попытку.".into());
        }
        if input.chars().count() > MAX_TTS_INPUT_CHARS {
            return Err(
                "Текст для озвучивания превышает 4096 символов. Сократите его и повторите попытку."
                    .into(),
            );
        }
        let api_key = api_key.trim();
        if api_key.is_empty() {
            return Err("Добавьте API-ключ OpenAI в настройках.".into());
        }
        let mut authorization =
            HeaderValue::from_str(&format!("Bearer {api_key}")).map_err(|_| {
                "Недопустимый формат API-ключа. Проверьте ключ в настройках.".to_owned()
            })?;
        authorization.set_sensitive(true);
        #[cfg(test)]
        let endpoint = self.speech_endpoint.as_str();
        #[cfg(not(test))]
        let endpoint = SPEECH_ENDPOINT;
        let response = self
            .client
            .post(endpoint)
            .header(AUTHORIZATION, authorization)
            .json(&serde_json::json!({
                "model": model,
                "voice": voice,
                "input": input,
                "response_format": "wav",
            }))
            .send()
            .await
            .map_err(request_error)?;
        let status = response.status();
        if status == StatusCode::TOO_MANY_REQUESTS {
            let body = read_body(
                response,
                MAX_RESPONSE_BYTES,
                "Ответ OpenAI слишком большой.",
            )
            .await?;
            let quota = serde_json::from_slice::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| {
                    value
                        .get("error")?
                        .get("code")?
                        .as_str()
                        .map(|code| code == "insufficient_quota")
                })
                .unwrap_or(false);
            return Err(if quota {
                "Исчерпана квота OpenAI для озвучивания. Проверьте баланс и лимиты API в аккаунте OpenAI."
            } else {
                "Слишком много запросов к OpenAI для озвучивания. Подождите немного и повторите попытку."
            }
            .into());
        }
        if !status.is_success() {
            return Err(synthesis_status_error(status));
        }
        #[cfg(test)]
        let tts_response_limit = self.tts_response_limit;
        #[cfg(not(test))]
        let tts_response_limit = MAX_TTS_RESPONSE_BYTES;
        read_body(
            response,
            tts_response_limit,
            "WAV-ответ OpenAI слишком большой для озвучивания. Сократите текст и повторите попытку.",
        )
        .await
    }
}

fn build_client(timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Не удалось создать клиент OpenAI. Проверьте сетевые настройки.".to_owned())
}

#[derive(Deserialize)]
struct Transcription {
    text: String,
}

async fn read_body(
    mut response: Response,
    max_bytes: usize,
    too_large_error: &str,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(request_error)? {
        if chunk.len() > max_bytes - bytes.len() {
            return Err(too_large_error.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn request_error(error: reqwest::Error) -> String {
    // Formatting reqwest errors could expose URLs or sensitive request details.
    if error.is_timeout() {
        TIMEOUT_ERROR.into()
    } else {
        "Не удалось связаться с OpenAI. Проверьте подключение к интернету и сетевые настройки, затем повторите попытку.".into()
    }
}

fn synthesis_status_error(status: StatusCode) -> String {
    match status.as_u16() {
        401 => "OpenAI отклонил API-ключ. Проверьте ключ в настройках и его действительность.",
        403 => "Нет доступа к OpenAI. Проверьте права API-ключа и доступность сервиса для вашего аккаунта.",
        404 => "Модель или голос для озвучивания недоступны или не найдены. Проверьте настройки и доступ к ним в OpenAI.",
        408 | 504 => TIMEOUT_ERROR,
        400 | 415 | 422 => "OpenAI не принял запрос озвучивания. Проверьте модель, голос и текст, затем повторите попытку.",
        500..=599 => "OpenAI временно недоступен. Подождите немного и повторите попытку.",
        300..=399 => "OpenAI вернул перенаправление. Запрос не перенаправлен для защиты API-ключа; проверьте сетевые настройки.",
        _ => "OpenAI не смог озвучить текст. Проверьте настройки и повторите попытку.",
    }
    .into()
}

fn status_error(status: StatusCode) -> String {
    match status.as_u16() {
        401 => "OpenAI отклонил API-ключ. Проверьте ключ в настройках и его действительность.",
        403 => "Нет доступа к OpenAI. Проверьте права API-ключа и доступность сервиса для вашего аккаунта.",
        404 => "Модель недоступна или не найдена. Проверьте идентификатор модели, доступ к ней и поддержку распознавания файлов через OpenAI.",
        413 => "Запись слишком большая для OpenAI. Сократите её до размера менее 25 МБ.",
        408 | 504 => TIMEOUT_ERROR,
        400 | 415 | 422 => "OpenAI не принял запись. Проверьте модель и формат WAV, затем повторите запись.",
        500..=599 => "OpenAI временно недоступен. Подождите немного и повторите попытку.",
        300..=399 => "OpenAI вернул перенаправление. Запрос не перенаправлен для защиты API-ключа; проверьте сетевые настройки.",
        _ => "OpenAI не смог распознать запись. Проверьте настройки и повторите попытку.",
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread::{self, JoinHandle};
    use std::time::Instant;

    const SECRET: &str = "sk-private-test-key";
    const PRIVATE_AUDIO: &[u8] = b"RIFF-private-audio-data";
    const PRIVATE_TEXT: &str = "private-transcript";

    struct MockServer {
        endpoint: String,
        handle: JoinHandle<Vec<u8>>,
    }

    impl MockServer {
        fn start(status: u16, body: &str) -> Self {
            Self::with_options(status, body, "", Duration::ZERO)
        }

        fn start_speech(status: u16, body: &str) -> Self {
            Self::with_options_at("/v1/audio/speech", status, body, "", Duration::ZERO)
        }

        fn with_options(status: u16, body: &str, headers: &str, delay: Duration) -> Self {
            Self::with_options_at("/v1/audio/transcriptions", status, body, headers, delay)
        }

        fn with_options_at(
            path: &str,
            status: u16,
            body: &str,
            headers: &str,
            delay: Duration,
        ) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let endpoint = format!("http://{}{}", listener.local_addr().unwrap(), path);
            let response = format!(
                "HTTP/1.1 {status} Mock\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
                body.len()
            );
            let handle = thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            stream.set_nonblocking(false).unwrap();
                            break stream;
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "mock HTTP request timed out");
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("mock accept failed: {error}"),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let request = read_request(&mut stream);
                thread::sleep(delay);
                // A timeout test intentionally closes the connection before this write.
                let _ = stream.write_all(response.as_bytes());
                request
            });
            Self { endpoint, handle }
        }

        fn client(&self) -> OpenAiClient {
            OpenAiClient::with_test_endpoint(self.endpoint.clone(), Duration::from_secs(2))
        }

        fn finish(self) -> Vec<u8> {
            self.handle.join().unwrap()
        }
    }

    fn read_request(stream: &mut TcpStream) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut buffer = [0; 4096];
        let mut expected_length = None;
        loop {
            let length = stream.read(&mut buffer).unwrap();
            assert_ne!(length, 0, "incomplete mock HTTP request");
            bytes.extend_from_slice(&buffer[..length]);
            if expected_length.is_none() {
                if let Some(end) = bytes.windows(4).position(|chunk| chunk == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    let content_length: usize = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .expect("multipart must have a content length")
                        .trim()
                        .parse()
                        .unwrap();
                    expected_length = Some(end + 4 + content_length);
                }
            }
            if expected_length.map_or(false, |expected| bytes.len() >= expected) {
                return bytes;
            }
        }
    }

    fn assert_private(error: &str) {
        assert!(!error.contains(SECRET));
        assert!(!error.contains("private-audio-data"));
        assert!(!error.contains(PRIVATE_TEXT));
        assert!(!error.contains("raw-api-error"));
    }

    #[tokio::test]
    async fn posts_correct_multipart_and_returns_plain_trimmed_transcription() {
        let server = MockServer::start(
            200,
            r#"{"text":"  Привет.\nБез изменений!  ","languages":[{"code":"ru"}]}"#,
        );
        let text = server
            .client()
            .transcribe(SECRET, "gpt-transcribe", PRIVATE_AUDIO.to_vec())
            .await
            .unwrap();
        assert_eq!(text, "Привет.\nБез изменений!");
        let request = server.finish();
        let request = String::from_utf8_lossy(&request);
        assert!(request.starts_with("POST /v1/audio/transcriptions HTTP/1.1\r\n"));
        assert!(request
            .to_lowercase()
            .contains(&format!("authorization: bearer {SECRET}")));
        assert!(request
            .to_lowercase()
            .contains("content-type: multipart/form-data; boundary="));
        assert!(request.contains("name=\"file\"; filename=\"recording.wav\""));
        assert!(request.contains("Content-Type: audio/wav"));
        assert!(request.contains("RIFF-private-audio-data"));
        assert!(request.contains("name=\"model\"\r\n\r\ngpt-transcribe\r\n"));
        assert!(request.contains("name=\"response_format\"\r\n\r\njson"));
        assert!(!request.contains("name=\"prompt\""));
        assert!(!request.contains("name=\"language\""));
        assert!(!request.contains("name=\"chunking_strategy\""));
    }

    #[tokio::test]
    async fn forwards_snapshot_and_custom_ids_without_diarization_parameters() {
        for model in [
            "gpt-4o-mini-transcribe",
            "gpt-4o-transcribe",
            "whisper-1",
            "gpt-4o-mini-transcribe-2025-12-15",
            "gpt-transcribe-2026-01-01",
            "future-ASR_v2.1:stable",
            "gpt-4o-transcribe-diarizeCustom",
            "custom-gpt-4o-transcribe-diarize-2026-01-01",
        ] {
            let server = MockServer::start(200, r#"{"text":"  Plain text!  "}"#);
            let text = server
                .client()
                .transcribe(SECRET, model, PRIVATE_AUDIO.to_vec())
                .await
                .unwrap();
            assert_eq!(text, "Plain text!");
            let request = server.finish();
            let request = String::from_utf8_lossy(&request);
            assert!(request.starts_with("POST /v1/audio/transcriptions HTTP/1.1\r\n"));
            assert!(request.contains(&format!("name=\"model\"\r\n\r\n{model}\r\n")));
            assert!(request.contains("name=\"response_format\"\r\n\r\njson\r\n"));
            assert!(!request.contains("name=\"chunking_strategy\""));
        }
    }

    #[tokio::test]
    async fn diarization_alias_and_dated_ids_use_auto_chunking_with_plain_json_text() {
        for model in [
            "gpt-4o-transcribe-diarize",
            "gpt-4o-transcribe-diarize-2026-01-01",
        ] {
            let server =
                MockServer::start(200, r#"{"text":"  First speaker.\nSecond speaker!  "}"#);
            let text = server
                .client()
                .transcribe(SECRET, model, PRIVATE_AUDIO.to_vec())
                .await
                .unwrap();
            assert_eq!(text, "First speaker.\nSecond speaker!");
            let request = server.finish();
            let request = String::from_utf8_lossy(&request);
            assert!(request.starts_with("POST /v1/audio/transcriptions HTTP/1.1\r\n"));
            assert!(request.contains(&format!("name=\"model\"\r\n\r\n{model}\r\n")));
            assert!(request.contains("name=\"response_format\"\r\n\r\njson\r\n"));
            assert!(request.contains("name=\"chunking_strategy\"\r\n\r\nauto\r\n"));
            assert_eq!(request.matches("name=\"chunking_strategy\"").count(), 1);
            assert!(!request.contains("name=\"prompt\""));
        }
    }

    #[tokio::test]
    async fn http_errors_are_actionable_and_never_expose_response_data() {
        for (status, expected) in [
            (401, "API-ключ"),
            (403, "прав"),
            (404, "Модель недоступна или не найдена"),
            (413, "25 МБ"),
            (400, "формат WAV"),
            (500, "временно недоступен"),
            (504, "вовремя"),
        ] {
            let body = format!(
                r#"{{"error":{{"message":"raw-api-error {SECRET} private-audio-data {PRIVATE_TEXT}"}}}}"#
            );
            let server = MockServer::start(status, &body);
            let error = server
                .client()
                .transcribe(SECRET, "whisper-1", PRIVATE_AUDIO.to_vec())
                .await
                .unwrap_err();
            server.finish();
            assert!(error.contains(expected), "{error}");
            assert_private(&error);
        }
    }

    #[tokio::test]
    async fn distinguishes_quota_from_rate_limit_using_only_whitelisted_code() {
        for (body, expected) in [
            (
                r#"{"error":{"code":"insufficient_quota","message":"raw-api-error"}}"#,
                "квота",
            ),
            (
                r#"{"error":{"code":"rate_limit_exceeded","message":"insufficient_quota"}}"#,
                "Подождите",
            ),
            (r#"{"error":{"message":"insufficient_quota"}}"#, "Подождите"),
            ("raw-api-error", "Подождите"),
        ] {
            let server = MockServer::start(429, body);
            let error = server
                .client()
                .transcribe(SECRET, "gpt-4o-transcribe", PRIVATE_AUDIO.to_vec())
                .await
                .unwrap_err();
            server.finish();
            assert!(error.contains(expected), "{error}");
            assert_private(&error);
        }
    }

    #[tokio::test]
    async fn rejects_empty_malformed_and_excessive_success_responses() {
        for body in [
            r#"{"text":" \n\t "}"#.to_owned(),
            r#"{"text":42}"#.to_owned(),
            r#"{"unexpected":"private-transcript"}"#.to_owned(),
            "raw-api-error".to_owned(),
            "x".repeat(MAX_RESPONSE_BYTES + 1),
        ] {
            let server = MockServer::start(200, &body);
            let error = server
                .client()
                .transcribe(SECRET, "whisper-1", PRIVATE_AUDIO.to_vec())
                .await
                .unwrap_err();
            server.finish();
            assert_private(&error);
        }
    }

    #[tokio::test]
    async fn does_not_follow_redirects() {
        let server = MockServer::with_options(
            307,
            "raw-api-error",
            "Location: http://127.0.0.1:1/do-not-send-key\r\n",
            Duration::ZERO,
        );
        let error = server
            .client()
            .transcribe(SECRET, "whisper-1", PRIVATE_AUDIO.to_vec())
            .await
            .unwrap_err();
        server.finish();
        assert!(error.contains("перенаправление"));
        assert_private(&error);
    }

    #[tokio::test]
    async fn timeout_error_is_safe_and_actionable() {
        let server =
            MockServer::with_options(200, r#"{"text":"ignored"}"#, "", Duration::from_millis(300));
        let client =
            OpenAiClient::with_test_endpoint(server.endpoint.clone(), Duration::from_millis(100));
        let error = client
            .transcribe(SECRET, "whisper-1", PRIVATE_AUDIO.to_vec())
            .await
            .unwrap_err();
        server.finish();
        assert!(error.contains("вовремя"));
        assert_private(&error);
    }

    #[tokio::test]
    async fn synthesize_posts_json_and_returns_wav_bytes() {
        let wav = "RIFF-private-wav-data";
        let server = MockServer::start_speech(200, wav);
        let client = OpenAiClient::with_test_endpoints(
            "http://127.0.0.1:1/v1/audio/transcriptions".into(),
            server.endpoint.clone(),
            Duration::from_secs(2),
        );
        let output = client
            .synthesize(SECRET, "gpt-4o-mini-tts", "marin", "  private-transcript  ")
            .await
            .unwrap();
        assert_eq!(output, wav.as_bytes());
        let request = server.finish();
        let header_end = request
            .windows(4)
            .position(|chunk| chunk == b"\r\n\r\n")
            .unwrap();
        let headers = String::from_utf8_lossy(&request[..header_end]);
        assert!(headers.starts_with("POST /v1/audio/speech HTTP/1.1\r\n"));
        assert!(headers
            .to_lowercase()
            .contains(&format!("authorization: bearer {SECRET}")));
        assert!(headers
            .to_lowercase()
            .contains("content-type: application/json"));
        let json: serde_json::Value = serde_json::from_slice(&request[header_end + 4..]).unwrap();
        assert_eq!(json["model"], "gpt-4o-mini-tts");
        assert_eq!(json["voice"], "marin");
        assert_eq!(json["input"], "  private-transcript  ");
        assert_eq!(json["response_format"], "wav");
    }

    #[tokio::test]
    async fn synthesize_rejects_invalid_input_and_oversized_wav_safely() {
        let client = OpenAiClient::with_test_endpoint(
            "http://127.0.0.1:1/unreachable".into(),
            Duration::from_secs(1),
        );
        for (model, voice, input, expected) in [
            ("gpt-4o-mini-tts", "marin", " \t", "пуст"),
            ("invalid/model", "marin", "text", "TTS-модели"),
            ("gpt-4o-mini-tts", "bad voice", "text", "голоса"),
        ] {
            let error = client
                .synthesize(SECRET, model, voice, input)
                .await
                .unwrap_err();
            assert!(error.contains(expected), "{error}");
            assert_private(&error);
        }
        let oversized_input = "я".repeat(MAX_TTS_INPUT_CHARS + 1);
        let error = client
            .synthesize(SECRET, "gpt-4o-mini-tts", "marin", &oversized_input)
            .await
            .unwrap_err();
        assert!(error.contains("4096"));
        assert_private(&error);

        let server = MockServer::start_speech(200, "xxxxx");
        let client = OpenAiClient::with_test_endpoints_and_tts_response_limit(
            "http://127.0.0.1:1/v1/audio/transcriptions".into(),
            server.endpoint.clone(),
            Duration::from_secs(2),
            4,
        );
        let error = client
            .synthesize(SECRET, "gpt-4o-mini-tts", "marin", "text")
            .await
            .unwrap_err();
        server.finish();
        assert!(error.contains("WAV-ответ"));
        assert_private(&error);
    }

    #[tokio::test]
    async fn synthesis_errors_are_specific_and_do_not_expose_response_data() {
        for (status, expected) in [(400, "озвучивания"), (404, "Модель или голос")]
        {
            let body = format!(
                r#"{{"error":{{"message":"raw-api-error {SECRET} private-audio-data {PRIVATE_TEXT}"}}}}"#
            );
            let server = MockServer::start_speech(status, &body);
            let error = server
                .client()
                .synthesize(SECRET, "gpt-4o-mini-tts", "marin", "text")
                .await
                .unwrap_err();
            server.finish();
            assert!(error.contains(expected), "{error}");
            assert_private(&error);
        }
    }

    #[tokio::test]
    async fn rejects_invalid_inputs_before_network_access() {
        let client = OpenAiClient::with_test_endpoint(
            "http://127.0.0.1:1/unreachable".into(),
            Duration::from_secs(1),
        );
        for (key, model, audio, expected) in [
            ("", "whisper-1", vec![1], "API-ключ"),
            ("bad\nkey", "whisper-1", vec![1], "формат API-ключа"),
            (SECRET, "invalid/model", vec![1], "идентификатор модели"),
            (SECRET, "", vec![1], "идентификатор модели"),
            (SECRET, "gpt-transcribe\n", vec![1], "идентификатор модели"),
            (SECRET, "whisper-1", vec![], "пуста"),
            (SECRET, "whisper-1", vec![0; MAX_AUDIO_BYTES + 1], "25 МБ"),
        ] {
            let error = client.transcribe(key, model, audio).await.unwrap_err();
            assert!(error.contains(expected), "{error}");
            assert_private(&error);
        }
    }
}
