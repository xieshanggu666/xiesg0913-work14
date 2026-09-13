import type { AudioEngine } from './AudioEngine';

export interface PerformanceResult {
  blob: Blob;
  /** 实际录到的秒数（不含取消） */
  seconds: number;
}

/** 最长 60 秒，到点自动停止 */
export const PERFORMANCE_MAX_SECONDS = 60;

/**
 * 录下孩子的“演奏”：不使用麦克风，而是从 AudioEngine 的内部混音总线
 * （MediaStreamAudioDestinationNode）取流，因此一条录音里同时包含
 * 内置音符、孩子的录音碎片和水/雨/风环境声。
 */
export class PerformanceRecorder {
  private recorder: MediaRecorder | null = null;
  private tap: MediaStreamAudioDestinationNode | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  /** 60 秒自动停止的兜底定时器（停止/取消时清理） */
  private maxTimer: number | null = null;

  get recording(): boolean {
    return this.recorder?.state === 'recording';
  }

  /** 剩余秒数，用于面板计时显示；未在录音时返回上限 */
  elapsedSeconds(now: number): number {
    if (!this.recording) return 0;
    return Math.min(PERFORMANCE_MAX_SECONDS, (now - this.startedAt) / 1000);
  }

  start(engine: AudioEngine): void {
    const { stream, node } = engine.openPerformanceTap();
    this.tap = node;
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', ''].find(
      (m) => m === '' || MediaRecorder.isTypeSupported(m)
    );
    this.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.recorder.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    });
    this.startedAt = performance.now();
    this.recorder.start();
  }

  /** 安排在到达 60 秒上限时自动停止并交给回调收尾（Game 负责后续 UI） */
  onMaxDuration(cb: () => void): void {
    if (this.maxTimer !== null) window.clearTimeout(this.maxTimer);
    this.maxTimer = window.setTimeout(
      () => cb(),
      PERFORMANCE_MAX_SECONDS * 1000 - (performance.now() - this.startedAt)
    );
  }

  clearMaxTimer(): void {
    if (this.maxTimer !== null) {
      window.clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
  }

  /**
   * 停止并产出录音结果。不再用墙钟时长门槛拦截短录音——
   * 是否可用由调用方（Game）用 decodeAudioData 判定：
   * 只要浏览器产出了能解码、时长大于 0 的音频，即使不足 1 秒也可以试听/下载。
   * 空块返回 null；停止后清理混音引出点。
   */
  stop(): Promise<PerformanceResult | null> {
    return new Promise((resolve, reject) => {
      const rec = this.recorder;
      if (!rec || rec.state !== 'recording') {
        this.disconnectTap();
        resolve(null);
        return;
      }
      const seconds = Math.min(
        PERFORMANCE_MAX_SECONDS,
        (performance.now() - this.startedAt) / 1000
      );
      rec.addEventListener('error', () => {
        this.disconnectTap();
        reject(new Error('recorder error'));
      });
      rec.addEventListener('stop', () => {
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        this.disconnectTap();
        if (blob.size === 0) {
          resolve(null);
          return;
        }
        resolve({ blob, seconds });
      });
      rec.stop();
    });
  }

  /** 取消：正在录则直接丢弃，不产出音频；已停止则只负责断开混音引出点 */
  cancel(): void {
    this.clearMaxTimer();
    const rec = this.recorder;
    if (rec && rec.state === 'recording') {
      try {
        rec.onstop = null;
        rec.stop();
      } catch {
        /* 可能已经停止 */
      }
    }
    this.recorder = null;
    this.chunks = [];
    this.disconnectTap();
  }

  private disconnectTap(): void {
    if (this.tap) {
      try {
        this.tap.disconnect();
      } catch {
        /* 未连接时忽略 */
      }
      this.tap = null;
    }
    this.recorder = null;
  }
}
