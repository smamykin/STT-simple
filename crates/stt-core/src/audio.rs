use crate::{MAX_AUDIO_BYTES, MAX_RECORDING_SECONDS};
use std::io::Cursor;

const OUTPUT_SAMPLE_RATE: u32 = 16_000;
const MAX_INPUT_SAMPLE_RATE: u32 = 384_000;

/// Encodes normalized mono samples as 16 kHz PCM16 WAV.
/// Nonfinite samples become silence; amplitudes outside [-1, 1] are clamped.
/// Recording duration must be measured before resampling, using the native rate.
pub fn encode_wav(mono_samples: &[f32], sample_rate: u32) -> Result<Vec<u8>, String> {
    if mono_samples.is_empty() {
        return Err("Запись пуста. Проверьте выбранный микрофон и повторите запись.".into());
    }
    if sample_rate == 0 || sample_rate > MAX_INPUT_SAMPLE_RATE {
        return Err("Некорректная частота микрофона. Выберите частоту от 1 до 384000 Гц.".into());
    }
    if mono_samples.len() as u64 > sample_rate as u64 * MAX_RECORDING_SECONDS {
        return Err("Запись превышает 10 минут. Сократите запись и повторите попытку.".into());
    }
    let scaled_length = mono_samples.len() as u64 * OUTPUT_SAMPLE_RATE as u64;
    let output_length = scaled_length.div_ceil(sample_rate as u64);
    if output_length * 2 + 44 > MAX_AUDIO_BYTES as u64 {
        return Err("WAV превышает 25 МБ. Сократите запись и повторите попытку.".into());
    }

    let specification = hound::WavSpec {
        channels: 1,
        sample_rate: OUTPUT_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut output = Cursor::new(Vec::with_capacity((output_length * 2 + 44) as usize));
    {
        let mut writer = hound::WavWriter::new(&mut output, specification)
            .map_err(|_| "Не удалось создать WAV для распознавания.".to_owned())?;
        for index in 0..output_length {
            // Integer coordinates avoid cumulative floating-point timing drift.
            let position = index * sample_rate as u64;
            let left = (position / OUTPUT_SAMPLE_RATE as u64) as usize;
            let fraction =
                (position % OUTPUT_SAMPLE_RATE as u64) as f32 / OUTPUT_SAMPLE_RATE as f32;
            let right = (left + 1).min(mono_samples.len() - 1);
            let first = sanitize(mono_samples[left]);
            let second = sanitize(mono_samples[right]);
            let sample = first + (second - first) * fraction;
            let pcm = (sample * 32768.0)
                .round()
                .clamp(i16::MIN as f32, i16::MAX as f32) as i16;
            writer
                .write_sample(pcm)
                .map_err(|_| "Не удалось записать звук в WAV.".to_owned())?;
        }
        writer
            .finalize()
            .map_err(|_| "Не удалось завершить WAV для распознавания.".to_owned())?;
    }
    let bytes = output.into_inner();
    if bytes.len() > MAX_AUDIO_BYTES {
        return Err("WAV превышает 25 МБ. Сократите запись и повторите попытку.".into());
    }
    Ok(bytes)
}

fn sanitize(sample: f32) -> f32 {
    if sample.is_finite() {
        sample.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(bytes: Vec<u8>) -> (hound::WavSpec, Vec<i16>) {
        let mut reader = hound::WavReader::new(Cursor::new(bytes)).unwrap();
        let specification = reader.spec();
        let samples = reader.samples::<i16>().map(Result::unwrap).collect();
        (specification, samples)
    }

    #[test]
    fn mono_pcm16_at_native_16khz() {
        let (specification, samples) = decode(encode_wav(&[-1.0, 0.0, 0.5, 1.0], 16_000).unwrap());
        assert_eq!(specification.channels, 1);
        assert_eq!(specification.sample_rate, 16_000);
        assert_eq!(specification.bits_per_sample, 16);
        assert_eq!(specification.sample_format, hound::SampleFormat::Int);
        assert_eq!(samples, [-32768, 0, 16384, 32767]);
    }

    #[test]
    fn resamples_down_and_up_without_interpreting_mono_as_stereo() {
        let (_, samples) = decode(encode_wav(&[0.0, 0.25, 0.5, 0.75, 1.0, 0.5], 48_000).unwrap());
        assert_eq!(samples, [0, 24576]);
        let (_, samples) = decode(encode_wav(&[0.0, 1.0], 8_000).unwrap());
        assert_eq!(samples, [0, 16384, 32767, 32767]);
        let (_, samples) = decode(encode_wav(&vec![0.25; 44_100], 44_100).unwrap());
        assert_eq!(samples.len(), 16_000);
        assert!(samples.iter().all(|sample| *sample == 8192));
    }

    #[test]
    fn sanitizes_nonfinite_and_clips_out_of_range_samples() {
        let (_, samples) = decode(
            encode_wav(
                &[f32::NAN, f32::INFINITY, f32::NEG_INFINITY, -2.0, 2.0],
                16_000,
            )
            .unwrap(),
        );
        assert_eq!(samples, [0, 0, 0, -32768, 32767]);
        let (_, samples) = decode(encode_wav(&[f32::NAN, 1.0], 8_000).unwrap());
        assert_eq!(samples, [0, 16384, 32767, 32767]);
    }

    #[test]
    fn rejects_empty_invalid_rates_and_excessive_duration() {
        assert!(encode_wav(&[], 16_000).is_err());
        assert!(encode_wav(&[0.0], 0).is_err());
        assert!(encode_wav(&[0.0], u32::MAX).is_err());
        assert!(encode_wav(&vec![0.0; 601], 1).is_err());
    }

    #[test]
    fn accepts_ten_minutes_and_keeps_output_below_upload_limit() {
        let bytes = encode_wav(&vec![0.0; MAX_RECORDING_SECONDS as usize], 1).unwrap();
        assert!(bytes.len() < MAX_AUDIO_BYTES);
        let reader = hound::WavReader::new(Cursor::new(bytes)).unwrap();
        assert_eq!(
            reader.duration(),
            OUTPUT_SAMPLE_RATE * MAX_RECORDING_SECONDS as u32
        );
    }

    #[test]
    fn very_short_recording_retains_a_sample() {
        let (_, samples) = decode(encode_wav(&[0.5], 48_000).unwrap());
        assert_eq!(samples, [16384]);
    }
}
