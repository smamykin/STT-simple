use rodio::{Decoder, OutputStream, Sink, StreamError};
use std::io::Cursor;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use tokio::sync::watch;

const STOP_POLL_INTERVAL: Duration = Duration::from_millis(20);
pub type Completion = watch::Receiver<Option<Result<(), String>>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Command {
    Start,
    Stop,
}

// All device resources stay on the worker. Preparation is silent until Start.
pub struct Player {
    commands: mpsc::Sender<Command>,
    completion: Completion,
}

impl Player {
    pub fn prepare(wav: Vec<u8>) -> Result<Self, String> {
        let (commands, receiver) = mpsc::channel();
        let (ready, ready_receiver) = mpsc::channel();
        let (completion, observer) = watch::channel(None);
        thread::Builder::new()
            .name("stt-playback".into())
            .spawn(move || {
                let result = prepare_and_run(wav, receiver, &ready);
                if let Err(error) = &result {
                    let _ = ready.send(Err(error.clone()));
                }
                // prepare_and_run has returned: sink, handle and stream are already dropped.
                let _ = completion.send(Some(result));
            })
            .map_err(|_| "Не удалось запустить поток воспроизведения.".to_owned())?;
        ready_receiver
            .recv()
            .map_err(|_| "Поток воспроизведения завершился во время подготовки.".to_owned())??;
        Ok(Self {
            commands,
            completion: observer,
        })
    }

    pub fn play(&self) -> Result<(), String> {
        self.commands
            .send(Command::Start)
            .map_err(|_| "Поток воспроизведения завершился до запуска.".to_owned())
    }

    pub fn completion(&self) -> Completion {
        self.completion.clone()
    }

    pub fn is_complete(&self) -> bool {
        self.completion.borrow().is_some()
    }

    #[cfg(test)]
    pub(crate) fn pending_test_proxy() -> (Self, watch::Sender<Option<Result<(), String>>>) {
        let (commands, _receiver) = mpsc::channel();
        let (sender, completion) = watch::channel(None);
        (
            Self {
                commands,
                completion,
            },
            sender,
        )
    }

    pub fn stop(&self) {
        let _ = self.commands.send(Command::Stop);
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.stop();
    }
}

pub async fn wait_for_completion(mut completion: Completion) -> Result<(), String> {
    loop {
        if let Some(result) = completion.borrow().clone() {
            return result;
        }
        completion.changed().await.map_err(|_| {
            "Поток воспроизведения завершился без подтверждения освобождения устройства.".to_owned()
        })?;
    }
}

fn prepare_and_run(
    wav: Vec<u8>,
    commands: mpsc::Receiver<Command>,
    ready: &mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    let decoder = validate_decoder(wav)?;
    let (stream, handle) = OutputStream::try_default().map_err(output_error)?;
    let sink = Sink::try_new(&handle).map_err(|_| "Не удалось инициализировать воспроизведение. Проверьте настройки устройства вывода звука.".to_owned())?;
    sink.pause();
    sink.append(decoder);
    if ready.send(Ok(())).is_err() {
        return Ok(());
    }
    command_loop(&commands, || sink.play(), || sink.empty());
    sink.stop();
    drop(sink);
    drop(handle);
    drop(stream);
    Ok(())
}

// Kept device-independent so the silent prepare / Start / Stop protocol is testable.
fn command_loop(
    commands: &mpsc::Receiver<Command>,
    mut play: impl FnMut(),
    mut empty: impl FnMut() -> bool,
) {
    let mut started = false;
    loop {
        match commands.recv_timeout(STOP_POLL_INTERVAL) {
            Ok(Command::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Ok(Command::Start) if !started => {
                play();
                started = true;
            }
            Ok(Command::Start) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if started && empty() {
            return;
        }
    }
}

fn validate_decoder(mut wav: Vec<u8>) -> Result<Decoder<Cursor<Vec<u8>>>, String> {
    normalize_streaming_wav_sizes(&mut wav);
    Decoder::new(Cursor::new(wav)).map_err(|error| {
        format!(
            "Не удалось распознать WAV-данные ({error}). Повторите попытку или выберите другую модель."
        )
    })
}

// Streaming WAV responses may use 0xFFFFFFFF for sizes that were unknown when the
// header was emitted. The complete response is already in memory here, so replace
// those placeholders before passing it to the strict hound decoder used by rodio.
fn normalize_streaming_wav_sizes(wav: &mut [u8]) {
    if wav.len() < 12 || &wav[..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return;
    }

    let Ok(riff_size) = u32::try_from(wav.len() - 8) else {
        return;
    };
    let declared_riff_size = u32::from_le_bytes(wav[4..8].try_into().unwrap());
    if declared_riff_size == u32::MAX || declared_riff_size as usize > wav.len() - 8 {
        wav[4..8].copy_from_slice(&riff_size.to_le_bytes());
    }

    let mut offset = 12;
    while offset + 8 <= wav.len() {
        let declared_chunk_size =
            u32::from_le_bytes(wav[offset + 4..offset + 8].try_into().unwrap());
        if &wav[offset..offset + 4] == b"data" {
            let Ok(data_size) = u32::try_from(wav.len() - offset - 8) else {
                return;
            };
            if declared_chunk_size == u32::MAX
                || declared_chunk_size as usize > wav.len() - offset - 8
            {
                wav[offset + 4..offset + 8].copy_from_slice(&data_size.to_le_bytes());
            }
            return;
        }

        let Ok(chunk_size) = usize::try_from(declared_chunk_size) else {
            return;
        };
        let Some(next_offset) = offset
            .checked_add(8)
            .and_then(|value| value.checked_add(chunk_size))
            .and_then(|value| value.checked_add(chunk_size % 2))
        else {
            return;
        };
        if next_offset <= offset || next_offset > wav.len() {
            return;
        }
        offset = next_offset;
    }
}

fn output_error(error: StreamError) -> String {
    match error {
        StreamError::NoDevice => "Не удалось найти устройство вывода звука. Подключите наушники или динамики и проверьте настройки звука.".to_owned(),
        _ => "Не удалось инициализировать воспроизведение. Проверьте настройки устройства вывода звука.".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prepared_drop_and_stop_never_start_audio() {
        for stop_explicitly in [false, true] {
            let (sender, receiver) = mpsc::channel();
            if stop_explicitly {
                sender.send(Command::Stop).unwrap();
            }
            drop(sender);
            let mut starts = 0;
            command_loop(&receiver, || starts += 1, || true);
            assert_eq!(starts, 0);
        }
    }

    #[test]
    fn start_is_explicit_idempotent_and_stop_terminates() {
        let (sender, receiver) = mpsc::channel();
        sender.send(Command::Start).unwrap();
        sender.send(Command::Start).unwrap();
        sender.send(Command::Stop).unwrap();
        let mut starts = 0;
        command_loop(&receiver, || starts += 1, || false);
        assert_eq!(starts, 1);
    }

    #[test]
    fn natural_completion_requires_start() {
        let (sender, receiver) = mpsc::channel();
        sender.send(Command::Start).unwrap();
        let mut starts = 0;
        command_loop(&receiver, || starts += 1, || true);
        assert_eq!(starts, 1);
    }

    #[test]
    fn completion_is_replayable_for_monitor_and_stop() {
        tauri::async_runtime::block_on(async {
            let (sender, observer) = watch::channel(None);
            let monitor = observer.clone();
            sender.send(Some(Ok(()))).unwrap();
            drop(sender);
            assert!(wait_for_completion(monitor).await.is_ok());
            assert!(wait_for_completion(observer).await.is_ok());
            let (sender, observer) = watch::channel(None);
            drop(sender);
            assert!(wait_for_completion(observer)
                .await
                .unwrap_err()
                .contains("без подтверждения"));
        });
    }

    fn minimal_wav() -> Vec<u8> {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&36_u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&16_000_u32.to_le_bytes());
        wav.extend_from_slice(&32_000_u32.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&0_u32.to_le_bytes());
        wav
    }

    #[test]
    fn validates_minimal_wav_without_output_device() {
        assert!(validate_decoder(minimal_wav()).is_ok());
    }

    #[test]
    fn accepts_streaming_wav_with_unknown_sizes() {
        let mut wav = minimal_wav();
        wav.extend_from_slice(&0_i16.to_le_bytes());
        wav[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        wav[40..44].copy_from_slice(&u32::MAX.to_le_bytes());

        assert!(validate_decoder(wav).is_ok());
    }

    #[test]
    fn leaves_non_wav_data_unchanged() {
        let mut data = b"not a wav".to_vec();
        let original = data.clone();
        normalize_streaming_wav_sizes(&mut data);
        assert_eq!(data, original);
    }

    #[test]
    fn rejects_invalid_wav_without_output_device() {
        assert!(validate_decoder(b"not a wav".to_vec()).is_err());
    }
}
