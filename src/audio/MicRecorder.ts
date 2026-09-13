/**
 * 手机麦克风录音入口：MediaRecorder → Blob，
 * 由 AudioEngine.decode 解码成 AudioBuffer 后变成河里的新碎片。
 */
export class MicRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];

  get recording(): boolean {
    return this.recorder?.state === 'recording';
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', ''].find(
      (m) => m === '' || MediaRecorder.isTypeSupported(m)
    );
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.recorder.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    });
    this.recorder.start();
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      const rec = this.recorder;
      if (!rec || rec.state !== 'recording') {
        resolve(new Blob());
        return;
      }
      rec.addEventListener('stop', () => {
        const blob = new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' });
        this.stream?.getTracks().forEach((t) => t.stop());
        this.stream = null;
        resolve(blob);
      });
      rec.stop();
    });
  }
}
