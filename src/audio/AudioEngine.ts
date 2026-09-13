export type Timbre = 'sine' | 'triangle' | 'square' | 'sample';
export type WeatherKind = 'sunny' | 'rain' | 'wind';

export interface StepVoice {
  freq: number;
  timbre: Timbre;
  buffer?: AudioBuffer | null;
}

const FANFARE_RUN = [261.63, 329.63, 392.0, 440.0, 523.25, 659.25, 783.99, 1046.5];

/**
 * 所有声音均由 Web Audio 实时合成，无外部音频资源。
 * - 6 步循环音序器：孩子放进格子的碎片按顺序发声
 * - 水流速度映射 BPM 与滤波器亮度（声音“随水流变化”）
 * - 水/雨/风三层环境声随天气与水位渐变
 */
export class AudioEngine {
  onStep: (step: number) => void = () => undefined;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** 主音量之前的完整混音总线：内置音符、录音碎片、示范音与环境声都先汇到这里 */
  private mix: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private soloBus: GainNode | null = null;
  private waterFilter: BiquadFilterNode | null = null;
  private waterGain: GainNode | null = null;
  private rainGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;

  private flow = 0.4;
  private level = 0.5;
  private weather: WeatherKind = 'sunny';
  private muted = false;
  private bpm = 100;
  private step = 0;
  private readonly steps = 6;
  private nextTime = 0;
  private timer: number | null = null;
  private rainTimer: number | null = null;
  private sequencerPaused = false;
  private activeMusicSources = new Set<AudioScheduledSourceNode>();
  private activeDemoSources = new Map<number, AudioScheduledSourceNode>();
  private demoToken = 0;
  private voiceProvider: (step: number) => StepVoice | null = () => null;

  /** 必须在用户手势中调用（移动端限制） */
  async unlock(): Promise<void> {
    if (!this.ctx) this.build();
    if (this.ctx && this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch {
        /* 忽略：下一次手势会再试 */
      }
    }
  }

  setVoiceProvider(fn: (step: number) => StepVoice | null): void {
    this.voiceProvider = fn;
  }

  setFlow(v: number): void {
    this.flow = v;
    this.bpm = 70 + v * 80;
    if (!this.ctx || !this.waterFilter || !this.waterGain) return;
    const t = this.ctx.currentTime;
    this.waterFilter.frequency.setTargetAtTime(250 + v * 900, t, 0.2);
    this.waterGain.gain.setTargetAtTime(0.035 + v * 0.1 + this.level * 0.03, t, 0.2);
  }

  setLevel(v: number): void {
    this.level = v;
    if (!this.ctx || !this.waterGain) return;
    this.waterGain.gain.setTargetAtTime(0.035 + this.flow * 0.1 + v * 0.03, this.ctx.currentTime, 0.3);
  }

  setWeather(w: WeatherKind): void {
    this.weather = w;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.rainGain?.gain.setTargetAtTime(w === 'rain' ? 0.06 : 0, t, 0.6);
    this.windGain?.gain.setTargetAtTime(w === 'wind' ? 0.085 : 0, t, 0.8);
    if (w === 'rain' && this.rainTimer === null) {
      this.rainTimer = window.setInterval(() => this.plink(), 420);
    } else if (w !== 'rain' && this.rainTimer !== null) {
      window.clearInterval(this.rainTimer);
      this.rainTimer = null;
    }
  }

  setMuted(m: boolean): void {
    // 在 AudioContext 建图之前也可能被调用（家长先静音、孩子再触发音频初始化），
    // 因此先记住状态，建图时一并应用
    this.muted = m;
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }

  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    await this.unlock();
    return this.ctx!.decodeAudioData(data);
  }

  /**
   * 引出“完整演奏混音”用于录下演奏：取自主音量/静音之前的混音总线，
   * 因此即便家长为了不外放而静音，内置音符、录音碎片与水/雨/风环境声
   * 仍全部进入录音。返回的 node 需要由调用方在用完后 disconnect。
   */
  openPerformanceTap(): { stream: MediaStream; node: MediaStreamAudioDestinationNode } {
    if (!this.ctx || !this.mix) throw new Error('audio not unlocked');
    const node = this.ctx.createMediaStreamDestination();
    this.mix.connect(node);
    return { stream: node.stream, node };
  }

  /** 暂停/恢复顶部 6 步循环；暂停时取消已排上队列的循环音，避免与示范重叠 */
  setSequencerPaused(paused: boolean): void {
    if (!this.ctx) {
      this.sequencerPaused = paused;
      return;
    }
    if (this.sequencerPaused === paused) return;
    this.sequencerPaused = paused;
    const t = this.ctx.currentTime;
    if (paused) {
      this.stopActiveMusicSources();
      this.musicBus?.gain.setTargetAtTime(0, t, 0.025);
    } else {
      this.step = 0;
      this.nextTime = t + 0.08;
      this.musicBus?.gain.setTargetAtTime(0.8, t, 0.06);
    }
  }

  /** 顺序播放一段短旋律；重听或退出时旧示范会被取消 */
  playMelody(
    voices: StepVoice[],
    onStep: (i: number) => void,
    onDone: () => void,
    gap = 0.5
  ): void {
    if (!this.ctx) return;
    this.cancelMelody();
    const token = ++this.demoToken;
    const ctx = this.ctx;
    const startTime = ctx.currentTime + 0.18;
    voices.forEach((voice, i) => {
      const at = startTime + i * gap;
      window.setTimeout(() => {
        if (token === this.demoToken) onStep(i);
      }, Math.max(0, (at - ctx.currentTime) * 1000));
      this.playDemoVoice(voice, at, i, token);
    });
    window.setTimeout(() => {
      if (token === this.demoToken) onDone();
    }, (startTime - ctx.currentTime + voices.length * gap + 0.22) * 1000);
  }

  cancelMelody(): void {
    this.demoToken++;
    for (const src of this.activeDemoSources.values()) {
      try {
        src.stop();
      } catch {
        /* 可能已经自然结束 */
      }
    }
    this.activeDemoSources.clear();
  }

  /** 碎片放入格子时的即时反馈音 */
  pluckNow(freq: number): void {
    if (!this.ctx) return;
    this.pluck(freq, 'triangle', this.ctx.currentTime, 0.5, 0.25);
  }

  /** 收集到水下音符的风铃声 */
  chime(freq: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.pluck(freq, 'sine', t, 1.1, 0.3);
    this.pluck(freq * 1.5, 'sine', t + 0.1, 1.0, 0.18);
    this.pluck(freq * 2, 'sine', t + 0.2, 1.2, 0.12);
  }

  /** 集齐全部音符的庆祝音阶 */
  fanfare(): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    FANFARE_RUN.forEach((f, i) => this.pluck(f, 'triangle', t + i * 0.13, 0.9, 0.28));
  }

  private build(): void {
    const AC: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(ctx.destination);

    // 完整混音先汇入 mix，再接主音量：录音从 mix 引出，不受静音影响
    this.mix = ctx.createGain();
    this.mix.gain.value = 1;
    this.mix.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0.8;
    this.musicBus.connect(this.mix);

    // 听音挑战示范走独立总线，循环音乐静音时仍能清晰播放
    this.soloBus = ctx.createGain();
    this.soloBus.gain.value = 0.9;
    this.soloBus.connect(this.mix);

    // 河流底噪：粉噪 → 低通，流速越快越响越亮
    const water = this.noiseSource();
    this.waterFilter = ctx.createBiquadFilter();
    this.waterFilter.type = 'lowpass';
    this.waterFilter.frequency.value = 250 + this.flow * 900;
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0.05;
    water.connect(this.waterFilter);
    this.waterFilter.connect(this.waterGain);
    this.waterGain.connect(this.mix);
    water.start();

    // 雨：粉噪 → 高通
    const rain = this.noiseSource();
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1600;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rain.connect(hp);
    hp.connect(this.rainGain);
    this.rainGain.connect(this.mix);
    rain.start();

    // 风：粉噪 → 带通，LFO 缓慢摆动中心频率
    const wind = this.noiseSource();
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 480;
    this.windFilter.Q.value = 1.1;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain);
    lfoGain.connect(this.windFilter.frequency);
    wind.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.mix);
    wind.start();
    lfo.start();

    // 同步在建图之前设置过的状态
    this.setMuted(this.muted);
    this.setWeather(this.weather);
    this.setFlow(this.flow);
    this.setLevel(this.level);

    this.nextTime = ctx.currentTime + 0.1;
    this.step = 0;
    this.timer = window.setInterval(() => this.tick(), 30);
  }

  private noiseSource(): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.2;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    return src;
  }

  private tick(): void {
    const ctx = this.ctx;
    if (!ctx || this.sequencerPaused) return;
    while (this.nextTime < ctx.currentTime + 0.15) {
      const s = this.step;
      const voice = this.voiceProvider(s);
      if (voice) this.playVoice(voice, this.nextTime);
      const delay = Math.max(0, (this.nextTime - ctx.currentTime) * 1000);
      window.setTimeout(() => this.onStep(s), delay);
      this.nextTime += 60 / this.bpm / 2;
      this.step = (this.step + 1) % this.steps;
    }
  }

  private playVoice(v: StepVoice, t: number): void {
    if (v.timbre === 'sample' && v.buffer) {
      const ctx = this.ctx!;
      const src = ctx.createBufferSource();
      src.buffer = v.buffer;
      src.playbackRate.value = v.freq / 261.63;
      const g = ctx.createGain();
      const dur = Math.min(v.buffer.duration, 1.4);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.7, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(g);
      g.connect(this.musicBus!);
      this.trackMusicSource(src);
      src.start(t);
      src.stop(t + dur + 0.1);
    } else {
      this.pluck(v.freq, v.timbre === 'sample' ? 'triangle' : v.timbre, t, 0.9, 0.4);
    }
  }

  private playDemoVoice(v: StepVoice, t: number, id: number, token: number): void {
    if (v.timbre === 'sample' && v.buffer) {
      const ctx = this.ctx!;
      const src = ctx.createBufferSource();
      src.buffer = v.buffer;
      src.playbackRate.value = v.freq / 261.63;
      const g = ctx.createGain();
      const dur = Math.min(v.buffer.duration, 1.15);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.75, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(g);
      g.connect(this.soloBus!);
      this.trackDemoSource(src, id, token);
      src.start(t);
      src.stop(t + dur + 0.1);
    } else {
      this.pluck(
        v.freq,
        v.timbre === 'sample' ? 'triangle' : v.timbre,
        t,
        0.72,
        0.42,
        this.soloBus!,
        false,
        { id, token }
      );
    }
  }

  private trackMusicSource(src: AudioScheduledSourceNode): void {
    this.activeMusicSources.add(src);
    src.onended = () => this.activeMusicSources.delete(src);
  }

  private trackDemoSource(src: AudioScheduledSourceNode, id: number, token: number): void {
    const old = this.activeDemoSources.get(id);
    if (old) {
      try {
        old.stop();
      } catch {
        /* 忽略已结束的音源 */
      }
    }
    this.activeDemoSources.set(id, src);
    src.onended = () => {
      if (this.activeDemoSources.get(id) === src) this.activeDemoSources.delete(id);
    };
    if (token !== this.demoToken) {
      try {
        src.stop();
      } catch {
        /* 忽略 */
      }
    }
  }

  private stopActiveMusicSources(): void {
    for (const src of this.activeMusicSources) {
      try {
        src.stop();
      } catch {
        /* 已排上但可能尚未开始或已结束，均可忽略 */
      }
    }
    this.activeMusicSources.clear();
  }

  private pluck(
    freq: number,
    type: OscillatorType,
    t: number,
    dur: number,
    vol: number,
    bus: GainNode = this.musicBus!,
    trackAsLoop = true,
    demoTrack: { id: number; token: number } | null = null
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 500 + this.flow * 2600; // 水流越急，音色越亮
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(filter);
    filter.connect(g);
    g.connect(bus);
    if (demoTrack) this.trackDemoSource(osc, demoTrack.id, demoTrack.token);
    else if (bus === this.musicBus && trackAsLoop) this.trackMusicSource(osc);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** 雨天随机的水滴声 */
  private plink(): void {
    if (this.weather !== 'rain' || !this.ctx || !this.master) return;
    if (Math.random() < 0.4) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1600 + Math.random() * 2200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.035, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.09);
    osc.connect(g);
    g.connect(this.mix ?? this.master);
    osc.start(t);
    osc.stop(t + 0.12);
  }
}
