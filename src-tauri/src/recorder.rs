use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use serde::Serialize;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;

use stt_core::MAX_RECORDING_SECONDS;

#[derive(Serialize)]
pub struct InputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

pub struct RecordedAudio {
    pub mono_samples: Vec<f32>,
    pub sample_rate: u32,
}

impl RecordedAudio {
    pub fn duration(&self) -> f64 {
        self.mono_samples.len() as f64 / self.sample_rate as f64
    }
}

#[derive(Default)]
struct Capture {
    samples: Vec<f32>,
    error: Option<String>,
    limit_reached: bool,
}

enum Command {
    Finish(mpsc::Sender<Result<RecordedAudio, String>>),
    Cancel,
}

// CPAL's !Send stream is created and closed on the same owning thread.
pub struct Recorder {
    commands: mpsc::Sender<Command>,
    capture: Arc<Mutex<Capture>>,
    sample_rate: u32,
}

pub fn list_devices() -> Result<Vec<InputDevice>, String> {
    let host = cpal::default_host();
    let default = host
        .default_input_device()
        .and_then(|device| device.name().ok());
    let devices = host
        .input_devices()
        .map_err(|_| "Не удалось получить список микрофонов.".to_owned())?;
    Ok(devices
        .enumerate()
        .filter_map(|(index, device)| {
            let name = device.name().ok()?;
            Some(InputDevice {
                id: device_id(index, &name),
                is_default: default.as_ref() == Some(&name),
                name,
            })
        })
        .collect())
}

fn device_id(index: usize, name: &str) -> String {
    format!("{index}:{name}")
}

fn select_device(id: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    match id {
        None => host.default_input_device().ok_or_else(|| {
            "Микрофон по умолчанию не найден. Подключите микрофон и проверьте настройки звука."
                .into()
        }),
        Some(id) => host
            .input_devices()
            .map_err(|_| "Не удалось найти выбранный микрофон.".to_owned())?
            .enumerate()
            .find_map(|(index, device)| {
                let name = device.name().ok()?;
                (device_id(index, &name) == id).then_some(device)
            })
            .ok_or_else(|| {
                "Выбранный микрофон недоступен. Обновите список и выберите его снова.".into()
            }),
    }
}

impl Recorder {
    pub fn start(device_id: Option<String>) -> Result<Self, String> {
        let capture = Arc::new(Mutex::new(Capture::default()));
        let worker_capture = capture.clone();
        let (commands, receiver) = mpsc::channel();
        let (ready, result) = mpsc::channel();
        thread::Builder::new()
            .name("stt-microphone".into())
            .spawn(move || {
                let initialized = initialize(device_id.as_deref(), worker_capture.clone());
                let (stream, sample_rate) = match initialized {
                    Ok(result) => result,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                if ready.send(Ok(sample_rate)).is_err() {
                    return;
                }
                match receiver.recv() {
                    Ok(Command::Finish(reply)) => {
                        drop(stream);
                        let result = worker_capture
                            .lock()
                            .map_err(|_| "Не удалось завершить запись.".to_owned())
                            .and_then(|mut capture| {
                                if let Some(error) = capture.error.take() {
                                    return Err(error);
                                }
                                Ok(RecordedAudio {
                                    mono_samples: std::mem::take(&mut capture.samples),
                                    sample_rate,
                                })
                            });
                        let _ = reply.send(result);
                    }
                    Ok(Command::Cancel) | Err(_) => {
                        drop(stream);
                    }
                }
            })
            .map_err(|_| "Не удалось запустить поток записи.".to_owned())?;
        let sample_rate = result
            .recv()
            .map_err(|_| "Поток микрофона завершился во время запуска.".to_owned())??;
        Ok(Self {
            commands,
            capture,
            sample_rate,
        })
    }

    pub fn duration(&self) -> f64 {
        self.capture
            .lock()
            .map(|capture| capture.samples.len() as f64 / self.sample_rate as f64)
            .unwrap_or(0.0)
    }

    pub fn problem(&self) -> Option<String> {
        self.capture
            .lock()
            .ok()
            .and_then(|capture| capture.error.clone())
    }

    pub fn limit_reached(&self) -> bool {
        self.capture
            .lock()
            .map(|capture| capture.limit_reached)
            .unwrap_or(false)
    }

    pub fn finish(self) -> Result<RecordedAudio, String> {
        let (reply, response) = mpsc::channel();
        self.commands
            .send(Command::Finish(reply))
            .map_err(|_| "Поток записи завершился неожиданно.".to_owned())?;
        response
            .recv()
            .map_err(|_| "Поток микрофона завершился без подтверждения записи.".to_owned())?
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Cancel);
    }
}

fn initialize(
    id: Option<&str>,
    capture: Arc<Mutex<Capture>>,
) -> Result<(cpal::Stream, u32), String> {
    let device = select_device(id)?;
    let supported = device.default_input_config().map_err(|_| {
        "Не удалось определить формат микрофона. Проверьте доступ к аудиоустройству.".to_owned()
    })?;
    let sample_rate = supported.sample_rate().0;
    if !(8_000..=192_000).contains(&sample_rate) || supported.channels() == 0 {
        return Err("Микрофон использует неподдерживаемый формат записи.".into());
    }
    let config = supported.config();
    let stream = match supported.sample_format() {
        SampleFormat::I8 => build_stream::<i8>(&device, &config, capture),
        SampleFormat::I16 => build_stream::<i16>(&device, &config, capture),
        SampleFormat::I32 => build_stream::<i32>(&device, &config, capture),
        SampleFormat::I64 => build_stream::<i64>(&device, &config, capture),
        SampleFormat::U8 => build_stream::<u8>(&device, &config, capture),
        SampleFormat::U16 => build_stream::<u16>(&device, &config, capture),
        SampleFormat::U32 => build_stream::<u32>(&device, &config, capture),
        SampleFormat::U64 => build_stream::<u64>(&device, &config, capture),
        SampleFormat::F32 => build_stream::<f32>(&device, &config, capture),
        SampleFormat::F64 => build_stream::<f64>(&device, &config, capture),
        _ => return Err("Формат микрофона не поддерживается.".into()),
    }?;
    stream.play().map_err(|_| {
        "Не удалось начать запись. Проверьте разрешение на микрофон и настройки звука.".to_owned()
    })?;
    Ok((stream, sample_rate))
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    capture: Arc<Mutex<Capture>>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    let max_samples = config.sample_rate.0 as usize * MAX_RECORDING_SECONDS as usize;
    let errors = capture.clone();
    device.build_input_stream(config, move |data: &[T], _| {
        if let Ok(mut capture) = capture.lock() {
            if capture.error.is_some() || capture.limit_reached { return; }
            for frame in data.chunks_exact(channels) {
                if capture.samples.len() >= max_samples { capture.limit_reached = true; break; }
                let mono = frame.iter().map(|sample| {
                    let value: f32 = (*sample).to_sample();
                    if value.is_finite() { value } else { 0.0 }
                }).sum::<f32>() / channels as f32;
                capture.samples.push(mono);
            }
        }
    }, move |_| {
        if let Ok(mut capture) = errors.lock() {
            capture.error = Some("Запись прервана аудиоустройством. Проверьте подключение микрофона и повторите запись.".into());
        }
    }, None).map_err(|_| "Не удалось открыть микрофон. Возможно, он занят или доступ запрещен.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duration_uses_audio_frames_not_wall_clock() {
        let audio = RecordedAudio {
            mono_samples: vec![0.0; 24_000],
            sample_rate: 48_000,
        };
        assert_eq!(audio.duration(), 0.5);
    }
    #[test]
    fn duplicate_device_names_have_distinct_ids() {
        assert_ne!(device_id(0, "Microphone"), device_id(1, "Microphone"));
    }
}
