const TARGET_RATE = 16_000;
const SPEECH_START_RMS = 0.012;
const BARGE_START_RMS = 0.03;
const SPEECH_CONTINUE_RMS = 0.006;
const SILENCE_MS = 800;
const MIN_SPEECH_MS = 280;
const MIN_VOICED_MS = 100;
const MAX_UTTERANCE_MS = 40_000;
const PREROLL_MS = 480;
const CHECK_MS = 24;
const WINDOW_MS = 32;
const FLOOR_MIN = 0.0015;
const FLOOR_MAX = 0.08;
const LEVEL_EVERY_MS = 50;
const FFT_SIZE = 512;
const ANALYSIS_RATE = 16_000;
const HARM_MIN = 4;
const CV_MOVING = 0.2;
const CV_STEADY = 0.17;
const DIST_SPEECH = 0.08;
const VOICE_HANG_MS = 420;

type SpeechHandler = (wav: Uint8Array) => void;

export type MicSensitivity = "low" | "normal" | "high";

export type MicLevel = {
  /** 0 to 1, how far above the room noise the microphone currently is. */
  level: number;
  /** True while the sound has the shape of a voice. */
  voiced: boolean;
  /** True while an utterance is being recorded. */
  capturing: boolean;
};

export type LevelHandler = (level: MicLevel) => void;

export type AudioDevice = {
  id: string;
  label: string;
};

export type AudioDevices = {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
  /** False until the browser has granted microphone access once, so names are hidden. */
  named: boolean;
};

export type SpeechCaptureOptions = {
  deviceId?: string;
  sensitivity?: MicSensitivity;
};

type Tuning = {
  /** Multiplier on every loudness threshold. Below 1 hears quieter voices. */
  loudness: number;
  /** How voice-like a sound must be before it counts, 0 to 1. */
  voiceScore: number;
  bargeScore: number;
  /** Voiced evidence needed before an utterance starts. */
  startMs: number;
  bargeMs: number;
};

const TUNINGS: Record<MicSensitivity, Tuning> = {
  low: { loudness: 1.6, voiceScore: 0.46, bargeScore: 0.52, startMs: 180, bargeMs: 280 },
  normal: { loudness: 1, voiceScore: 0.38, bargeScore: 0.45, startMs: 120, bargeMs: 200 },
  high: { loudness: 0.6, voiceScore: 0.3, bargeScore: 0.4, startMs: 90, bargeMs: 160 },
};

export function normalizeSensitivity(value: string | undefined): MicSensitivity {
  return value === "low" || value === "high" ? value : "normal";
}

/**
 * The room behind the speaker: a level, and the spectrum of whatever has been droning.
 * A fan is loud and may even have a pitch, but it does not change. Speech does.
 * The level only rises toward a steady drone, never toward a voice, so a long turn
 * cannot push the gate up until the next sentence is missed.
 */
class RoomSound {
  private value = 0.006;
  private levels: number[] = [];
  private stationaryMs = 0;
  private noise = new Float64Array(FFT_SIZE / 2);
  private smooth = new Float64Array(FFT_SIZE / 2);
  private noiseN = 0;
  private smoothN = 0;
  moving = false;
  distance = 0;

  get floor(): number {
    return this.value;
  }

  /** Call once per check, before deciding whether this window is speech. */
  prepare(rms: number, mag: Float64Array | null, frameMs: number): void {
    if (!Number.isFinite(rms)) {
      return;
    }
    this.levels.push(rms);
    if (this.levels.length > 16) {
      this.levels.shift();
    }
    const mean = this.levels.reduce((sum, level) => sum + level, 0) / this.levels.length;
    const variance = this.levels.reduce((sum, level) => sum + (level - mean) ** 2, 0) / this.levels.length;
    const cv = Math.sqrt(variance) / Math.max(1e-9, mean);
    const ready = this.levels.length >= 12;
    this.moving = ready && cv >= CV_MOVING;
    this.stationaryMs = ready && cv < CV_STEADY ? this.stationaryMs + frameMs : 0;
    if (mag) {
      const rate = this.smoothN === 0 ? 1 : 0.35;
      for (let index = 0; index < mag.length; index += 1) {
        this.smooth[index] = (this.smooth[index] ?? 0) * (1 - rate) + (mag[index] ?? 0) * rate;
      }
      this.smoothN += 1;
    }
    this.distance = 0;
    if (mag && this.noiseN >= 8) {
      let dot = 0;
      let left = 0;
      let right = 0;
      for (let index = 4; index < 200; index += 1) {
        const current = Math.log((this.smooth[index] ?? 0) + 1e-6);
        const room = Math.log((this.noise[index] ?? 0) + 1e-6);
        dot += current * room;
        left += current * current;
        right += room * room;
      }
      this.distance = 1 - dot / Math.max(1e-9, Math.sqrt(left * right));
    }
  }

  /** Call after the voice decision. A steady fan becomes the room. Speech does not. */
  commit(rms: number, mag: Float64Array | null, speaking: boolean, voiced: boolean): void {
    if (!Number.isFinite(rms)) {
      return;
    }
    const steady = this.stationaryMs > 400;
    if (!speaking && mag && steady && !voiced) {
      const rate = 0.15;
      for (let index = 0; index < mag.length; index += 1) {
        this.noise[index] = (this.noise[index] ?? 0) * (1 - rate) + (mag[index] ?? 0) * rate;
      }
      this.noiseN += 1;
      this.value = this.value * 0.75 + rms * 0.25;
    } else if (rms < this.value) {
      this.value = this.value * 0.8 + rms * 0.2;
    }
    this.value = Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, this.value));
  }

  startThreshold(loudness: number): number {
    return Math.max(SPEECH_START_RMS, this.value * 1.22) * loudness;
  }

  bargeThreshold(loudness: number): number {
    return Math.max(BARGE_START_RMS, this.value * 2.2) * loudness;
  }

  continueThreshold(loudness: number): number {
    return Math.max(SPEECH_CONTINUE_RMS * Math.min(1, loudness), this.value * 1.12);
  }
}

function baseConstraints(deviceId: string | undefined): MediaTrackConstraints {
  // The browser's own noise suppressor and gain control learn the user's voice and,
  // after a long turn, turn that voice down. Tolly judges the room itself instead.
  const audio: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: false,
    autoGainControl: false,
  };
  if (deviceId) {
    audio.deviceId = { exact: deviceId };
  }
  return audio;
}

async function openMicrophone(deviceId: string | undefined): Promise<MediaStream> {
  const attempts: MediaTrackConstraints[] = [baseConstraints(deviceId)];
  if (deviceId) {
    // The chosen microphone may be unplugged. Fall back to the system default.
    attempts.push(baseConstraints(undefined));
  }
  let failure: unknown = null;
  for (const audio of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (error: unknown) {
      failure = error;
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        throw error;
      }
    }
  }
  throw failure instanceof Error ? failure : new Error("The microphone could not be opened.");
}

export function supportsOutputSelection(): boolean {
  return typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
}

/**
 * Lists microphones and speakers. Names appear only after the browser has granted microphone access,
 * so `requestNames` opens the default microphone for a moment when needed.
 */
export async function listAudioDevices(requestNames = false): Promise<AudioDevices> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { inputs: [], outputs: [], named: false };
  }
  let devices = await navigator.mediaDevices.enumerateDevices();
  let named = devices.some((device) => device.kind === "audioinput" && device.label.length > 0);
  if (!named && requestNames) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.getTracks().forEach((track) => track.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
      named = devices.some((device) => device.kind === "audioinput" && device.label.length > 0);
    } catch {
      // Permission was refused. The list stays unnamed.
    }
  }
  const describe = (device: MediaDeviceInfo, kind: string, index: number): AudioDevice => ({
    id: device.deviceId,
    label: device.label || `${kind} ${index + 1}`,
  });
  const inputs = devices
    .filter((device) => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default" && device.deviceId !== "communications")
    .map((device, index) => describe(device, "Microphone", index));
  const outputs = supportsOutputSelection()
    ? devices
        .filter((device) => device.kind === "audiooutput" && device.deviceId && device.deviceId !== "default" && device.deviceId !== "communications")
        .map((device, index) => describe(device, "Speaker", index))
    : [];
  return { inputs, outputs, named };
}

type Shape = {
  rms: number;
  /** 0 to 1, how strongly the window repeats at a speaking pitch. */
  voice: number;
  /** How many harmonics of that pitch stand above their neighbors. */
  harmonics: number;
  mag: Float64Array | null;
};

function describeWindow(samples: Float32Array, sampleRate: number): Shape {
  const length = samples.length;
  if (length < sampleRate * 0.02) {
    return { rms: 0, voice: 0, harmonics: 0, mag: null };
  }
  let sum = 0;
  let energy = 0;
  let motion = 0;
  let crossings = 0;
  let previous = samples[0] ?? 0;
  for (let index = 0; index < length; index += 1) {
    const sample = samples[index] ?? 0;
    sum += sample;
    energy += sample * sample;
    if (index > 0) {
      const step = sample - previous;
      motion += step * step;
      if ((sample >= 0) !== (previous >= 0)) {
        crossings += 1;
      }
    }
    previous = sample;
  }
  const rms = Math.sqrt(energy / length);
  const mag = energy >= 1e-9 ? analysisMagnitudes(samples, sampleRate) : null;
  if (energy < 1e-9) {
    return { rms, voice: 0, harmonics: 0, mag };
  }
  const zeroCrossingRate = crossings / Math.max(1, length - 1);
  // Hiss and clicks cross zero very often. A hum barely crosses at all.
  if (zeroCrossingRate > 0.22 || zeroCrossingRate < 0.004) {
    return { rms, voice: 0, harmonics: 0, mag };
  }
  // Speech carries most of its energy in the harmonics above 300 Hz. Mains hum, a fridge, and
  // traffic rumble sit below that, so the signal barely moves from one sample to the next.
  const tilt = motion / energy;
  const lowest = Math.pow((2 * Math.PI * 300) / sampleRate, 2);
  if (tilt < lowest) {
    return { rms, voice: 0, harmonics: 0, mag };
  }
  const pitched = pitchScore(samples, length, sampleRate, sum / length);
  const harmonics = mag && pitched.lag > 0 ? countHarmonics(mag, sampleRate / pitched.lag) : 0;
  return { rms, voice: pitched.score, harmonics, mag };
}

/**
 * Normalized autocorrelation at speaking pitches, 80 to 400 Hz.
 * Voiced speech repeats strongly at its pitch period and scores well above 0.5.
 * Breath, hiss, and keyboard clicks score near zero.
 */
function pitchScore(samples: Float32Array, length: number, sampleRate: number, mean: number): { score: number; lag: number } {
  const minLag = Math.max(2, Math.floor(sampleRate / 400));
  const maxLag = Math.min(length - 2, Math.floor(sampleRate / 80));
  if (maxLag <= minLag) {
    return { score: 0, lag: 0 };
  }
  const centered = new Float32Array(length);
  const prefix = new Float64Array(length + 1);
  for (let index = 0; index < length; index += 1) {
    const sample = (samples[index] ?? 0) - mean;
    centered[index] = sample;
    prefix[index + 1] = (prefix[index] ?? 0) + sample * sample;
  }
  const total = prefix[length] ?? 0;
  if (total < 1e-8) {
    return { score: 0, lag: 0 };
  }
  let best = 0;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag += 2) {
    const limit = length - lag;
    let correlation = 0;
    for (let index = 0; index < limit; index += 2) {
      correlation += (centered[index] ?? 0) * (centered[index + lag] ?? 0);
    }
    if (correlation <= 0) {
      continue;
    }
    // Compare like with like: the energy of the two overlapping stretches, sampled the same way.
    const head = (prefix[limit] ?? 0) / 2;
    const tail = (total - (prefix[lag] ?? 0)) / 2;
    const normalized = correlation / Math.max(1e-9, Math.sqrt(head * tail));
    if (normalized > best) {
      best = normalized;
      bestLag = lag;
    }
  }
  return { score: Math.min(1, best), lag: bestLag };
}

function transform(real: Float64Array, imag: Float64Array): void {
  const size = real.length;
  for (let index = 1, swap = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; swap & bit; bit >>= 1) {
      swap ^= bit;
    }
    swap ^= bit;
    if (index < swap) {
      const realSwap = real[index] ?? 0;
      const imagSwap = imag[index] ?? 0;
      real[index] = real[swap] ?? 0;
      imag[index] = imag[swap] ?? 0;
      real[swap] = realSwap;
      imag[swap] = imagSwap;
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1;
      let twiddleImag = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const evenReal = real[start + offset] ?? 0;
        const evenImag = imag[start + offset] ?? 0;
        const oddIndex = start + offset + length / 2;
        const oddReal = (real[oddIndex] ?? 0) * twiddleReal - (imag[oddIndex] ?? 0) * twiddleImag;
        const oddImag = (real[oddIndex] ?? 0) * twiddleImag + (imag[oddIndex] ?? 0) * twiddleReal;
        real[start + offset] = evenReal + oddReal;
        imag[start + offset] = evenImag + oddImag;
        real[oddIndex] = evenReal - oddReal;
        imag[oddIndex] = evenImag - oddImag;
        const nextReal = twiddleReal * stepReal - twiddleImag * stepImag;
        twiddleImag = twiddleReal * stepImag + twiddleImag * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

/** 512 magnitudes from 0 to 8 kHz, so a fan tone and a vowel can be compared. */
function analysisMagnitudes(samples: Float32Array, sampleRate: number): Float64Array | null {
  const step = sampleRate / ANALYSIS_RATE;
  const needed = Math.floor(step * FFT_SIZE);
  if (samples.length < needed || needed < 64) {
    return null;
  }
  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);
  const offset = samples.length - needed;
  for (let index = 0; index < FFT_SIZE; index += 1) {
    const position = offset + index * step;
    const at = Math.floor(position);
    const fraction = position - at;
    const left = samples[at] ?? 0;
    const right = samples[Math.min(samples.length - 1, at + 1)] ?? left;
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (FFT_SIZE - 1));
    real[index] = (left + (right - left) * fraction) * window;
  }
  transform(real, imag);
  const mag = new Float64Array(FFT_SIZE / 2);
  for (let index = 0; index < mag.length; index += 1) {
    mag[index] = Math.hypot(real[index] ?? 0, imag[index] ?? 0);
  }
  return mag;
}

function countHarmonics(mag: Float64Array, fundamental: number): number {
  if (fundamental < 70 || fundamental > 500) {
    return 0;
  }
  const binHz = ANALYSIS_RATE / FFT_SIZE;
  let count = 0;
  for (let harmonic = 1; harmonic <= 8; harmonic += 1) {
    const frequency = fundamental * harmonic;
    if (frequency > 4500) {
      break;
    }
    const bin = Math.round(frequency / binHz);
    if (bin < 2 || bin >= mag.length - 2) {
      break;
    }
    const peak = mag[bin] ?? 0;
    const neighbors = ((mag[bin - 2] ?? 0) + (mag[bin + 2] ?? 0)) / 2;
    if (peak > neighbors * 1.7) {
      count += 1;
    }
  }
  return count;
}

export class SpeechCapture {
  readonly deviceId: string;
  private tuning: Tuning;
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private paused = false;
  private holding = false;
  private bargeIn = false;
  private speaking = false;
  private silenceMs = 0;
  private speechMs = 0;
  private prerollMs = 0;
  private preroll: Float32Array[] = [];
  private utterance: Float32Array[] = [];
  private recent: Float32Array[] = [];
  private recentSamples = 0;
  private sinceCheckMs = 0;
  private evidenceMs = 0;
  private voicedMs = 0;
  private sinceLevelMs = 0;
  private lastVoiced = false;
  private sinceVoiceMs = 1_000;
  private room = new RoomSound();
  private onUtterance: SpeechHandler;
  private onSpeechStart: () => void;
  private onLevel: LevelHandler;

  constructor(
    onUtterance: SpeechHandler,
    onSpeechStart: () => void = () => undefined,
    onLevel: LevelHandler = () => undefined,
    options: SpeechCaptureOptions = {},
  ) {
    this.onUtterance = onUtterance;
    this.onSpeechStart = onSpeechStart;
    this.onLevel = onLevel;
    this.deviceId = options.deviceId ?? "";
    this.tuning = TUNINGS[normalizeSensitivity(options.sensitivity)];
  }

  setSensitivity(sensitivity: MicSensitivity): void {
    this.tuning = TUNINGS[normalizeSensitivity(sensitivity)];
  }

  async start(): Promise<void> {
    this.stream = await openMicrophone(this.deviceId || undefined);
    this.context = new AudioContext();
    await this.context.audioWorklet.addModule("/vad-worklet.js");
    this.source = this.context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.context, "vad-processor");
    this.worklet.port.onmessage = (event: MessageEvent<{ rms: number; samples: Float32Array }>) => {
      this.consume(event.data.rms, event.data.samples);
    };
    this.source.connect(this.worklet);
  }

  setBargeIn(enabled: boolean): void {
    this.bargeIn = enabled;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.holding = false;
      this.resetBuffers();
    }
  }

  beginHold(): void {
    this.holding = true;
    this.paused = false;
    this.bargeIn = false;
    this.resetBuffers();
    this.holding = true;
  }

  endHold(): boolean {
    if (!this.holding) {
      return false;
    }
    this.holding = false;
    const sampleRate = this.context?.sampleRate ?? 48_000;
    const speechMs = this.speechMs;
    const captured = concatFloats(this.utterance);
    this.resetBuffers();
    if (speechMs < MIN_SPEECH_MS || captured.length === 0) {
      return false;
    }
    this.onUtterance(encodeWav(downsample(captured, sampleRate, TARGET_RATE), TARGET_RATE));
    return true;
  }

  async stop(): Promise<void> {
    this.worklet?.port.close();
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.context && this.context.state !== "closed") {
      await this.context.close();
    }
    this.worklet = null;
    this.source = null;
    this.stream = null;
    this.context = null;
    this.resetBuffers();
    this.onLevel({ level: 0, voiced: false, capturing: false });
  }

  private report(rms: number, frameMs: number, voiced: boolean): void {
    this.sinceLevelMs += frameMs;
    if (voiced) {
      this.lastVoiced = true;
    }
    if (this.sinceLevelMs < LEVEL_EVERY_MS) {
      return;
    }
    this.sinceLevelMs = 0;
    const floor = this.room.floor;
    const span = Math.max(0.03, this.room.startThreshold(this.tuning.loudness) * 3);
    const level = Math.min(1, Math.max(0, (rms - floor) / span));
    this.onLevel({
      level: Math.sqrt(level),
      voiced: this.lastVoiced,
      capturing: this.speaking || this.holding,
    });
    this.lastVoiced = false;
  }

  private resetBuffers(): void {
    this.speaking = false;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.prerollMs = 0;
    this.evidenceMs = 0;
    this.voicedMs = 0;
    this.sinceVoiceMs = 1_000;
    this.sinceCheckMs = 0;
    this.preroll = [];
    this.utterance = [];
    this.recent = [];
    this.recentSamples = 0;
  }

  private remember(samples: Float32Array): void {
    this.recent.push(samples);
    this.recentSamples += samples.length;
    const sampleRate = this.context?.sampleRate ?? 48_000;
    const maxSamples = Math.floor(sampleRate * (WINDOW_MS / 1000));
    while (this.recentSamples > maxSamples && this.recent.length > 1) {
      const removed = this.recent.shift();
      if (removed) {
        this.recentSamples -= removed.length;
      }
    }
  }

  private copyWindow(): Float32Array {
    const window = new Float32Array(this.recentSamples);
    let offset = 0;
    for (const chunk of this.recent) {
      window.set(chunk, offset);
      offset += chunk.length;
    }
    return window;
  }

  private consume(rms: number, samples: Float32Array): void {
    const sampleRate = this.context?.sampleRate ?? 48_000;
    const frameMs = (samples.length / sampleRate) * 1000;
    if (this.paused) {
      return;
    }

    const { loudness } = this.tuning;

    if (this.holding) {
      this.utterance.push(samples);
      this.speechMs += frameMs;
      this.report(rms, frameMs, rms >= this.room.continueThreshold(loudness));
      if (this.speechMs >= MAX_UTTERANCE_MS) {
        this.endHold();
      }
      return;
    }

    this.remember(samples);
    this.sinceCheckMs += frameMs;
    const ready = this.sinceCheckMs >= CHECK_MS && this.recentSamples >= sampleRate * 0.02;
    let heardVoice = false;
    let checkedMs = 0;
    if (ready) {
      checkedMs = this.sinceCheckMs;
      this.sinceCheckMs = 0;
      const shape = describeWindow(this.copyWindow(), sampleRate);
      this.room.prepare(shape.rms, shape.mag, checkedMs);
      const minRms = this.bargeIn
        ? this.room.bargeThreshold(loudness)
        : this.speaking
          ? this.room.continueThreshold(loudness)
          : this.room.startThreshold(loudness);
      const minScore = this.bargeIn ? this.tuning.bargeScore : this.tuning.voiceScore;
      // A loud voice at the microphone can smear its pitch. It still needs a stack of
      // harmonics, and it still has to be moving: a fan tone is steady and does not count.
      const pitchOk = shape.voice >= minScore || (shape.rms >= minRms * 2.5 && shape.voice >= minScore * 0.6);
      const tonal = shape.harmonics >= HARM_MIN && pitchOk;
      heardVoice = shape.rms >= minRms && tonal && (this.speaking ? this.room.moving || this.room.distance >= DIST_SPEECH : this.room.moving);
      this.room.commit(shape.rms, shape.mag, this.speaking, heardVoice);
    }
    if (heardVoice) {
      this.sinceVoiceMs = 0;
    } else if (ready) {
      this.sinceVoiceMs += checkedMs;
    }
    this.report(rms, frameMs, heardVoice);

    if (!this.speaking) {
      this.preroll.push(samples);
      this.prerollMs += frameMs;
      while (this.prerollMs > PREROLL_MS && this.preroll.length > 1) {
        const removed = this.preroll.shift();
        if (removed) {
          this.prerollMs -= (removed.length / sampleRate) * 1000;
        }
      }
      if (!ready) {
        return;
      }
      // Evidence builds while a voice is heard and fades during the short gaps inside words,
      // so a consonant or a breath does not throw away what was already heard.
      if (heardVoice) {
        this.evidenceMs += checkedMs;
      } else {
        this.evidenceMs = Math.max(0, this.evidenceMs - checkedMs * 0.6);
      }
      const need = this.bargeIn ? this.tuning.bargeMs : this.tuning.startMs;
      if (this.evidenceMs < need) {
        return;
      }
      if (this.bargeIn) {
        this.bargeIn = false;
        this.onSpeechStart();
      }
      this.speaking = true;
      this.utterance = this.preroll.splice(0);
      this.speechMs = this.prerollMs;
      this.voicedMs = this.evidenceMs;
      this.evidenceMs = 0;
      this.preroll = [];
      this.prerollMs = 0;
      this.silenceMs = 0;
      return;
    }

    this.utterance.push(samples);
    this.speechMs += frameMs;
    if (heardVoice) {
      this.voicedMs += checkedMs;
    }
    // A fan stays loud after the person stops. Energy alone must not keep the turn open.
    // A consonant still counts, for a short hang after the last real voice.
    const hanging = this.sinceVoiceMs < VOICE_HANG_MS && rms >= this.room.continueThreshold(loudness);
    if (heardVoice || hanging) {
      this.silenceMs = 0;
    } else {
      this.silenceMs += frameMs;
    }

    const finished = this.silenceMs >= SILENCE_MS || this.speechMs >= MAX_UTTERANCE_MS;
    if (!finished) {
      return;
    }

    const heardEnough = this.speechMs - this.silenceMs >= MIN_SPEECH_MS && this.voicedMs >= MIN_VOICED_MS;
    const captured = concatFloats(this.utterance);
    this.resetBuffers();
    if (!heardEnough) {
      return;
    }
    const downsampled = downsample(captured, sampleRate, TARGET_RATE);
    this.onUtterance(encodeWav(downsampled, TARGET_RATE));
  }
}

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

export class PcmPlayer {
  private context: AudioContext | null = null;
  private nextTime = 0;
  private nodes: AudioBufferSourceNode[] = [];
  private gain = 1;
  private sink = "";

  setVolume(level: number): void {
    const clamped = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 1;
    this.gain = clamped * clamped;
  }

  /** Routes playback to a speaker by device id. An empty id means the system default. */
  setOutput(deviceId: string): void {
    const next = deviceId ?? "";
    if (next === this.sink && this.context) {
      return;
    }
    this.sink = next;
    this.applySink();
  }

  private applySink(): void {
    const context = this.context as SinkContext | null;
    if (!context || typeof context.setSinkId !== "function") {
      return;
    }
    context.setSinkId(this.sink).catch(() => {
      // The speaker may be gone. Playback stays on the system default.
    });
  }

  resume(): void {
    if (!this.context || this.context.state === "closed") {
      this.context = new AudioContext();
      this.applySink();
    }
    void this.context.resume();
  }

  stop(): void {
    for (const node of this.nodes) {
      try {
        node.stop();
      } catch {
        // The buffer may already have ended.
      }
    }
    this.nodes = [];
    this.nextTime = 0;
  }

  enqueue(pcm: Uint8Array, sampleRate: number): void {
    if (!this.context) {
      this.context = new AudioContext();
      this.applySink();
    }
    const context = this.context;
    const usable = pcm.byteLength - (pcm.byteLength % 2);
    if (usable < 2) {
      return;
    }
    const view = new DataView(pcm.buffer, pcm.byteOffset, usable);
    const frames = usable / 2;
    const buffer = context.createBuffer(1, frames, sampleRate);
    const channel = buffer.getChannelData(0);
    const gain = this.gain;
    for (let index = 0; index < frames; index += 1) {
      channel[index] = (view.getInt16(index * 2, true) / 32768) * gain;
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime + 0.03, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
    this.nodes.push(source);
    source.onended = () => {
      this.nodes = this.nodes.filter((node) => node !== source);
    };
  }

  async waitUntilDone(): Promise<void> {
    if (!this.context) {
      return;
    }
    const remaining = this.nextTime - this.context.currentTime;
    if (remaining <= 0) {
      return;
    }
    await new Promise((resolve) => {
      window.setTimeout(resolve, remaining * 1000 + 40);
    });
  }
}

export function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function concatFloats(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function downsample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate) {
    return input;
  }
  const ratio = inRate / outRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((index + 1) * ratio)));
    let sum = 0;
    for (let sample = start; sample < end; sample += 1) {
      sum += input[sample] ?? 0;
    }
    output[index] = sum / (end - start);
  }
  return output;
}

function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
