import type { WeatherKind } from '../audio/AudioEngine';
import { PERFORMANCE_MAX_SECONDS } from '../audio/PerformanceRecorder';
import type { SongSummary } from '../data/Portfolio';

export interface PanelCallbacks {
  onFlow: (v: number) => void;
  onLevel: (v: number) => void;
  onWeather: (w: WeatherKind) => void;
  onMic: () => void;
  onStartChallenge: () => void;
  onOpenTaskBook: () => void;
  onMute: (muted: boolean) => void;
  onAnyGesture: () => void;
  /** 保存（或覆盖）当前作品；asNew 时即使已有当前作品也新建一条 */
  onSaveSong: (name: string, asNew: boolean) => void;
  onOpenSong: (id: string) => void;
  onDeleteSong: (id: string) => void;
  /** 导出单首作品为备份文件 */
  onExportSong: (id: string) => void;
  /** 从备份文件导入一首作品 */
  onImportSong: (file: File) => void;
  /** 录下演奏：开始 / 停止（生成可试听、下载的音频）/ 取消（丢弃） */
  onPerformanceStart: () => void;
  onPerformanceStop: () => void;
  onPerformanceCancel: () => void;
}

const WEATHER_ICON: Record<WeatherKind, string> = { sunny: '☀️', rain: '🌧️', wind: '💨' };

/** 家长面板（HTML 覆盖层）：流速、水位、天气、录音、静音、本地作品集 */
export class Panel {
  private toastTimer: number | null = null;
  private muted = false;
  private micBtn: HTMLButtonElement;
  private muteBtn: HTMLButtonElement;

  private currentId: string | null = null;
  private currentName = '';
  private confirmTimer: number | null = null;
  private dialogMode: 'save' | 'saveAs' = 'save';

  private saveAsBtn: HTMLButtonElement;
  private currentSong: HTMLOutputElement;
  private songList: HTMLUListElement;
  private songListEmpty: HTMLElement;
  private importInput: HTMLInputElement;

  // ---------- 录下演奏 ----------
  private perfTime: HTMLOutputElement;
  private perfBadge: HTMLElement;
  private perfBadgeTime: HTMLElement;
  private perfIdleRow: HTMLElement;
  private perfRecordingRow: HTMLElement;
  private perfResultRow: HTMLElement;
  private perfStopBtn: HTMLButtonElement;
  private perfCancelRecBtn: HTMLButtonElement;
  private perfPreviewBtn: HTMLButtonElement;
  private perfAudio: HTMLAudioElement;
  private perfResultUrl: string | null = null;
  private perfResultBlob: Blob | null = null;
  private perfTicker: number | null = null;
  private perfState: 'idle' | 'recording' | 'stopping' | 'result' = 'idle';
  /** 每次发起试听自增，旧 Promise 的结果作废，避免与原生控件操作竞争 */
  private perfPlayToken = 0;
  /** 当前播放是否由“试听”按钮发起（决定成功后是否收回原生兜底条） */
  private perfPlaybackFromButton = false;

  private dialog: HTMLElement;
  private nameInput: HTMLInputElement;

  constructor(private cb: PanelCallbacks) {
    const el = <T extends HTMLElement>(id: string): T => {
      const n = document.getElementById(id);
      if (!n) throw new Error(`#${id} missing`);
      return n as T;
    };

    const flow = el<HTMLInputElement>('flow');
    const level = el<HTMLInputElement>('level');
    const flowVal = el<HTMLOutputElement>('flowVal');
    const levelVal = el<HTMLOutputElement>('levelVal');
    // 实时数值提示：滑杆仍是 0~100，展示换算后的物理单位
    flow.addEventListener('input', () => {
      const raw = flow.valueAsNumber;
      flowVal.textContent = `${(raw / 50).toFixed(1)} m/s`;
      cb.onFlow(raw / 100);
    });
    level.addEventListener('input', () => {
      const raw = level.valueAsNumber;
      levelVal.textContent = `${raw} cm`;
      cb.onLevel(raw / 100);
    });

    document.querySelectorAll<HTMLButtonElement>('[data-weather]').forEach((b) =>
      b.addEventListener('click', () => cb.onWeather(b.dataset.weather as WeatherKind))
    );

    this.micBtn = el<HTMLButtonElement>('mic');
    this.micBtn.addEventListener('click', () => cb.onMic());

    el<HTMLButtonElement>('challengeStart').addEventListener('click', () => cb.onStartChallenge());
    el<HTMLButtonElement>('taskBookOpen').addEventListener('click', () => cb.onOpenTaskBook());

    this.muteBtn = el<HTMLButtonElement>('mute');
    this.muteBtn.addEventListener('click', () => {
      this.muted = !this.muted;
      this.syncMute();
      cb.onMute(this.muted);
    });

    // ---------- 录下演奏 ----------
    this.perfTime = el<HTMLOutputElement>('perfTime');
    this.perfBadge = el('perfBadge');
    this.perfBadgeTime = el('perfBadgeTime');
    this.perfIdleRow = el('perfIdleRow');
    this.perfRecordingRow = el('perfRecordingRow');
    this.perfResultRow = el('perfResultRow');
    this.perfStopBtn = el<HTMLButtonElement>('perfStop');
    this.perfCancelRecBtn = el<HTMLButtonElement>('perfCancelRec');
    this.perfPreviewBtn = el<HTMLButtonElement>('perfPreview');
    this.perfAudio = el<HTMLAudioElement>('perfAudio');

    el<HTMLButtonElement>('perfStart').addEventListener('click', () => this.cb.onPerformanceStart());
    this.perfStopBtn.addEventListener('click', () => this.cb.onPerformanceStop());
    el<HTMLButtonElement>('perfCancelRec').addEventListener('click', () => this.cb.onPerformanceCancel());
    el<HTMLButtonElement>('perfDiscard').addEventListener('click', () => this.cb.onPerformanceCancel());
    this.perfPreviewBtn.addEventListener('click', () => void this.togglePerformancePreview());
    el<HTMLButtonElement>('perfDownload').addEventListener('click', () => this.downloadPerformance());
    // 播放状态同步到自定义按钮。只有“按钮发起的播放”才在成功后收回原生兜底条；
    // 家长直接操作兜底播放器时保持它可见。
    this.perfAudio.addEventListener('ended', () => {
      this.perfPreviewBtn.textContent = '▶️ 试听';
      this.perfPlayToken++;
    });
    this.perfAudio.addEventListener('pause', () => {
      if (this.perfAudio.ended) return;
      this.perfPreviewBtn.textContent = '▶️ 试听';
    });
    this.perfAudio.addEventListener('play', () => {
      this.perfPreviewBtn.textContent = '⏸️ 暂停';
      if (this.perfPlaybackFromButton) this.perfAudio.hidden = true;
    });

    const panel = el('panel');
    const toggle = el<HTMLButtonElement>('panelToggle');
    toggle.addEventListener('click', () => {
      const open = panel.classList.toggle('hidden') === false;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? '收起家长面板' : '打开家长面板');
    });

    // ---------- 作品集 ----------
    this.currentSong = el<HTMLOutputElement>('currentSong');
    this.saveAsBtn = el<HTMLButtonElement>('saveAsSong');
    this.songList = el<HTMLUListElement>('songList');
    this.songListEmpty = el('songListEmpty');

    el<HTMLButtonElement>('saveSong').addEventListener('click', () => this.openDialog('save'));
    this.saveAsBtn.addEventListener('click', () => this.openDialog('saveAs'));

    // 导入：按钮转发到隐藏的文件选择框；选完清空 value，下次选同一文件仍能触发 change
    this.importInput = el<HTMLInputElement>('importFile');
    el<HTMLButtonElement>('importSong').addEventListener('click', () => this.importInput.click());
    this.importInput.addEventListener('change', () => {
      const file = this.importInput.files?.[0] ?? null;
      this.importInput.value = '';
      if (file) this.cb.onImportSong(file);
    });

    this.dialog = el('songDialog');
    this.nameInput = el<HTMLInputElement>('songNameInput');
    const form = el<HTMLFormElement>('songDialogForm');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitDialog();
    });
    el<HTMLButtonElement>('songDialogCancel').addEventListener('click', () => this.closeDialog());
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog) this.closeDialog();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.dialog.classList.contains('hidden')) this.closeDialog();
    });

    // 第一次触摸/点击时解锁 AudioContext（移动端要求）
    document.addEventListener('pointerdown', () => cb.onAnyGesture(), { once: true });
  }

  // ---------- 滑杆同步（重新打开作品时） ----------

  setFlow(v: number): void {
    const raw = Math.round(v * 100);
    const flow = document.getElementById('flow') as HTMLInputElement;
    flow.value = String(raw);
    document.getElementById('flowVal')!.textContent = `${(raw / 50).toFixed(1)} m/s`;
  }

  setLevel(v: number): void {
    const raw = Math.round(v * 100);
    const level = document.getElementById('level') as HTMLInputElement;
    level.value = String(raw);
    document.getElementById('levelVal')!.textContent = `${raw} cm`;
  }

  private syncMute(): void {
    this.muteBtn.textContent = this.muted ? '🔇' : '🔊';
    this.muteBtn.setAttribute('aria-pressed', String(this.muted));
    this.muteBtn.setAttribute('aria-label', this.muted ? '取消静音' : '静音');
  }

  setMicRecording(on: boolean): void {
    this.micBtn.classList.toggle('recording', on);
    this.micBtn.textContent = on ? '⏺️ 停止录音' : '🎙️ 录一段声音';
    this.micBtn.setAttribute('aria-pressed', String(on));
    this.micBtn.setAttribute('aria-label', on ? '停止录音' : '录一段声音');
  }

  // ---------- 录下演奏 ----------

  get performanceRecording(): boolean {
    return this.perfState === 'recording' || this.perfState === 'stopping';
  }

  /** 开始录制：显示计时（面板内 + 收起面板时的红点），旧的试听结果会被丢弃 */
  setPerformanceRecording(on: boolean): void {
    if (on) {
      this.releasePerformanceResult();
      this.perfState = 'recording';
      this.perfIdleRow.hidden = true;
      this.perfResultRow.hidden = true;
      this.perfRecordingRow.hidden = false;
      this.perfStopBtn.disabled = false;
      this.perfCancelRecBtn.disabled = false;
      this.perfBadge.hidden = false;
      this.updatePerfTick(0);
      this.startPerfTicker();
    } else {
      this.stopPerfTicker();
      this.perfBadge.hidden = true;
    }
  }

  /** 停止处理中：禁用按钮，避免家长重复点 */
  setPerformanceStopping(): void {
    this.perfState = 'stopping';
    this.perfStopBtn.disabled = true;
    this.perfCancelRecBtn.disabled = true;
  }

  /** 停止成功：展示试听 / 下载 / 放弃（原生播放器仅在播放被拦截时才亮出） */
  setPerformanceResult(blob: Blob, seconds: number): void {
    this.stopPerfTicker();
    this.perfState = 'result';
    this.perfResultBlob = blob;
    this.perfResultUrl = URL.createObjectURL(blob);
    this.perfAudio.src = this.perfResultUrl;
    this.perfAudio.hidden = true;
    this.perfPlaybackFromButton = false;
    this.perfPreviewBtn.textContent = '▶️ 试听';
    // 不足 1 秒的短录音按一位小数展示，避免显示成 0:00
    const durLabel =
      seconds < 1 ? `${seconds.toFixed(1)} 秒` : Panel.fmtClock(seconds);
    this.perfTime.textContent = `${durLabel} / ${Panel.fmtClock(PERFORMANCE_MAX_SECONDS)}`;
    this.perfRecordingRow.hidden = true;
    this.perfIdleRow.hidden = true;
    this.perfResultRow.hidden = false;
    this.perfBadge.hidden = true;
  }

  /** 回到初始态：取消录制、放弃录音或录音失败（太短）时调用 */
  resetPerformanceUI(): void {
    this.stopPerfTicker();
    this.releasePerformanceResult();
    this.perfState = 'idle';
    this.perfRecordingRow.hidden = true;
    this.perfResultRow.hidden = true;
    this.perfIdleRow.hidden = false;
    this.perfStopBtn.disabled = false;
    this.perfCancelRecBtn.disabled = false;
    this.perfBadge.hidden = true;
    this.perfTime.textContent = `0:00 / ${Panel.fmtClock(PERFORMANCE_MAX_SECONDS)}`;
  }

  private async togglePerformancePreview(): Promise<void> {
    if (!this.perfResultUrl) return;
    // 正在播放 → 暂停（从中间位置暂停，下次从此处继续）
    if (!this.perfAudio.paused) {
      this.perfAudio.pause();
      return;
    }
    // 已播完再点：从头开始；中途暂停再点：继续播放
    if (this.perfAudio.ended || this.perfAudio.currentTime >= this.perfAudio.duration) {
      this.perfAudio.currentTime = 0;
    }
    const token = ++this.perfPlayToken;
    this.perfPlaybackFromButton = true;
    try {
      await this.perfAudio.play();
    } catch (err) {
      if (token !== this.perfPlayToken) return; // 已被后续操作取代（含 AbortError）
      // 浏览器拦截了脚本播放（自动播放策略/锁屏等）：亮出带 controls 的原生播放器，
      // 家长点它自带的播放键一定能播（属于元素上的直接用户手势）；按钮也保留可再试。
      this.perfPlaybackFromButton = false;
      this.perfAudio.hidden = false;
      this.perfPreviewBtn.textContent = '🔄 再试一次';
      const notAllowed = err instanceof DOMException && err.name === 'NotAllowedError';
      this.toast(
        notAllowed
          ? '浏览器拦住了自动试听：点下面的播放键 ▶，或点「再试一次」'
          : '暂时无法试听：可点下面的播放键 ▶，或直接下载保存'
      );
    }
  }

  private downloadPerformance(): void {
    if (!this.perfResultBlob) return;
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const a = document.createElement('a');
    a.href = this.perfResultUrl!;
    a.download = `河流之歌演奏-${stamp}.${this.performanceExt()}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  private performanceExt(): string {
    const mime = this.perfResultBlob?.type ?? '';
    if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
    if (mime.includes('ogg')) return 'ogg';
    return 'webm';
  }

  /** 放掉上一次录音：暂停试听、断开 audio.src 并回收 ObjectURL */
  private releasePerformanceResult(): void {
    this.perfPlayToken++; // 让尚未落定的 play() Promise 全部失效
    this.perfPlaybackFromButton = false;
    this.perfAudio.pause();
    this.perfAudio.removeAttribute('src');
    this.perfAudio.load();
    this.perfAudio.hidden = true;
    if (this.perfResultUrl) {
      URL.revokeObjectURL(this.perfResultUrl);
      this.perfResultUrl = null;
    }
    this.perfResultBlob = null;
  }

  private startPerfTicker(): void {
    this.stopPerfTicker();
    const start = performance.now();
    this.perfTicker = window.setInterval(() => {
      const elapsed = Math.min(PERFORMANCE_MAX_SECONDS, (performance.now() - start) / 1000);
      this.updatePerfTick(elapsed);
    }, 200);
  }

  private stopPerfTicker(): void {
    if (this.perfTicker !== null) {
      window.clearInterval(this.perfTicker);
      this.perfTicker = null;
    }
  }

  private updatePerfTick(elapsed: number): void {
    const t = Panel.fmtClock(elapsed);
    this.perfTime.textContent = `${t} / ${Panel.fmtClock(PERFORMANCE_MAX_SECONDS)}`;
    this.perfBadgeTime.textContent = t;
  }

  private static fmtClock(seconds: number): string {
    const s = Math.floor(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  setChallengeActive(active: boolean): void {
    const btn = document.getElementById('challengeStart') as HTMLButtonElement;
    btn.disabled = active;
    btn.textContent = active ? '🎧 挑战进行中' : '🎧 听音挑战';
    // 听音挑战与任务册是两种引导模式，互斥以免碎片可用性规则互相干扰
    const tb = document.getElementById('taskBookOpen') as HTMLButtonElement;
    tb.disabled = active;
  }

  /** 任务册入口上的小徽章：完成任务数；0 或全部完成后不显示数字 */
  setTaskBookBadge(done: number, total: number): void {
    const badge = document.getElementById('taskBookBadge');
    if (!badge) return;
    if (done > 0 && done < total) {
      badge.textContent = String(done);
      badge.hidden = false;
    } else {
      badge.textContent = '';
      badge.hidden = true;
    }
  }

  /** 任务册「去保存这首歌」快捷动作：直接打开命名对话框（有现名则覆盖保存） */
  openSaveDialog(): void {
    this.openDialog('save');
  }

  setWeatherActive(w: WeatherKind): void {
    document
      .querySelectorAll<HTMLButtonElement>('[data-weather]')
      .forEach((b) => {
        const active = b.dataset.weather === w;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
  }

  setNotes(n: number, total: number): void {
    document.getElementById('noteCount')!.textContent = String(n);
    document.getElementById('noteTotal')!.textContent = String(total);
  }

  // ---------- 作品集：当前作品指示 + 列表 ----------

  setSongs(songs: SongSummary[], currentId: string | null): void {
    this.currentId = currentId;
    const current = songs.find((s) => s.id === currentId) ?? null;
    this.currentName = current?.name ?? '';
    this.currentSong.hidden = !current;
    this.currentSong.textContent = current ? `正在编辑：${current.name}` : '';
    this.saveAsBtn.hidden = !current;

    this.songList.replaceChildren(...songs.map((s) => this.renderSong(s, s.id === currentId)));
    this.songListEmpty.hidden = songs.length > 0;
  }

  private renderSong(s: SongSummary, current: boolean): HTMLElement {
    const li = document.createElement('li');
    li.className = 'song-item' + (current ? ' current' : '');

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'song-open';
    openBtn.setAttribute('aria-label', `打开《${s.name}》`);
    if (current) openBtn.setAttribute('aria-current', 'true');

    const head = document.createElement('span');
    head.className = 'song-head';
    const name = document.createElement('span');
    name.className = 'song-name';
    name.textContent = (current ? '♪ ' : '') + s.name;
    const meta = document.createElement('span');
    meta.className = 'song-meta';
    const voiceTag = s.voiceCount > 0 ? ` · 🎙️${s.voiceCount}` : '';
    meta.textContent = `${WEATHER_ICON[s.weather]} ${this.fmtTime(s.updatedAt)}${voiceTag}`;
    head.append(name, meta);
    openBtn.append(head);
    openBtn.addEventListener('click', () => this.cb.onOpenSong(s.id));

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'song-export';
    exportBtn.setAttribute('aria-label', `导出《${s.name}》备份`);
    exportBtn.title = '导出为备份文件，可在另一台设备导入';
    exportBtn.textContent = '📤';
    exportBtn.addEventListener('click', () => this.cb.onExportSong(s.id));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'song-delete';
    delBtn.setAttribute('aria-label', `删除《${s.name}》`);
    delBtn.textContent = '🗑️';
    delBtn.addEventListener('click', () => {
      if (!delBtn.classList.contains('confirm')) {
        // 两步确认，避免家长误触删掉孩子的作品
        delBtn.classList.add('confirm');
        delBtn.textContent = '再点一次确认删除';
        if (this.confirmTimer !== null) window.clearTimeout(this.confirmTimer);
        this.confirmTimer = window.setTimeout(() => this.resetDeleteButtons(), 3000);
        return;
      }
      this.resetDeleteButtons();
      this.cb.onDeleteSong(s.id);
    });

    li.append(openBtn, exportBtn, delBtn);
    return li;
  }

  /** 取消所有删除按钮的“待确认”态（超时自动复位） */
  private resetDeleteButtons(): void {
    this.songList.querySelectorAll<HTMLButtonElement>('.song-delete.confirm').forEach((btn) => {
      btn.classList.remove('confirm');
      btn.textContent = '🗑️';
    });
  }

  private fmtTime(ts: number): string {
    const d = new Date(ts);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ---------- 命名对话框 ----------

  private openDialog(mode: 'save' | 'saveAs'): void {
    this.dialogMode = mode;
    // 覆盖保存时沿用现名（家长可改）；另存为新歌时留空，便于起新名字
    this.nameInput.value = mode === 'save' ? this.currentName : '';
    this.dialog.classList.remove('hidden');
    // 下一帧再聚焦，iOS Safari 对 display 切换当帧聚焦支持不好
    window.setTimeout(() => {
      this.nameInput.focus();
      this.nameInput.select();
    }, 30);
  }

  private closeDialog(): void {
    this.dialog.classList.add('hidden');
  }

  private submitDialog(): void {
    const name = this.nameInput.value.trim() || `河流之歌 ${this.fmtTime(Date.now())}`;
    this.closeDialog();
    this.cb.onSaveSong(name, this.dialogMode === 'saveAs');
  }

  toast(msg: string): void {
    const t = document.getElementById('toast')!;
    t.textContent = msg;
    t.classList.add('show');
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => t.classList.remove('show'), 2600);
  }
}
