import type p5 from 'p5';
import Matter from 'matter-js';
import { AudioEngine } from './audio/AudioEngine';
import type { StepVoice, WeatherKind } from './audio/AudioEngine';
import { MicRecorder } from './audio/MicRecorder';
import { PerformanceRecorder } from './audio/PerformanceRecorder';
import { Fragment } from './world/Fragment';
import type { VoiceAudio } from './world/Fragment';
import { NoteField } from './world/Notes';
import { Weather } from './world/Weather';
import { Panel } from './ui/Panel';
import { ListeningChallenge } from './ui/ListeningChallenge';
import type { ChallengePhase } from './ui/ListeningChallenge';
import { TaskBook, describeAction } from './ui/TaskBook';
import { TaskProgress, TASKS, evaluateTasks } from './tasks/tasks';
import type { TaskAction, TaskState } from './tasks/tasks';
import { Portfolio } from './data/Portfolio';
import type { FragmentDoc, SongDoc } from './data/Portfolio';
import { bytesToBase64, base64ToBytes, QuotaError, ImportError } from './data/Portfolio';
import { SoundLibrary } from './data/SoundLibrary';
import type { SoundClipDoc } from './data/SoundLibrary';

const SCALE = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];
const SOLFEGE = ['do', 're', 'mi', 'sol', 'la', 'do', 're', 'mi'];
const COLORS = ['#ff8a80', '#ffd180', '#ffff8d', '#ccff90', '#80d8ff', '#8c9eff', '#ea80fc', '#a7ffeb'];
const TIMBRES: Array<'sine' | 'triangle' | 'square'> = ['sine', 'triangle', 'square'];
const SLOT_COUNT = 6;
const VOICE_COLOR = '#ffab40';
const WEATHER_CYCLE: WeatherKind[] = ['sunny', 'rain', 'wind'];
const WEATHER_AUTO_MS = 75_000;

/** 首版三关：只取前 5 个唯一唱名，且每关内部不重复使用同一块内置碎片 */
const CHALLENGE_LEVELS: number[][] = [
  [0, 2, 1],
  [4, 3, 1, 0],
  [0, 4, 2, 3, 1],
];

interface ChallengeState {
  active: boolean;
  phase: ChallengePhase;
  demoStep: number;
  wrongSlot: number;
  hintSlot: number;
  /** 进入挑战前 6 个格子里的碎片 id，用于随时退出后恢复 */
  savedSlots: (string | null)[];
}

interface Drag {
  frag: Fragment;
  dx: number;
  dy: number;
  x: number;
  y: number;
  px: number;
  py: number;
  pt: number;
  vx: number;
  vy: number;
}

export class Game {
  private p!: p5;
  private canvasEl!: HTMLCanvasElement;
  private audio = new AudioEngine();
  private mic = new MicRecorder();
  private performance = new PerformanceRecorder();
  private panel!: Panel;
  private weather = new Weather();
  private notes = new NoteField(SLOT_COUNT, SCALE);
  private portfolio = new Portfolio();
  private soundLibrary = new SoundLibrary();
  /** 素材试听/入河共用的解码缓存（按素材 id，最多 8 段，先进先出） */
  private clipBuffers = new Map<string, AudioBuffer>();
  /**
   * 解码期间被删除的素材 id：decodeAudioData 无法中途取消，
   * 解码完成后凭此集合丢弃结果（不入缓存、不播放、不入河）。
   * 素材 id 生成后绝不复用，集合无需清理。
   */
  private cancelledClipIds = new Set<string>();
  private previewingSoundId: string | null = null;
  /** 每次发起试听自增，旧 decode 的结果作废，避免快速连点时状态错乱 */
  private previewToken = 0;
  private taskProgress = new TaskProgress();
  private taskBook: TaskBook | null = null;
  /** 进入本次会话时已经盖完章的任务：不再重复弹祝贺，之后新完成的才提示 */
  private taskCongratulated = new Set<string>();
  private allTasksCongratulated = false;
  private currentSongId: string | null = null;
  private fragments: Fragment[] = [];
  private slots: (Fragment | null)[] = Array(SLOT_COUNT).fill(null);
  private engine = Matter.Engine.create({ gravity: { x: 0, y: 0.35, scale: 0.001 } });

  private flow = 0.4;
  private level = 0.5;
  private weatherKind: WeatherKind = 'sunny';
  private lastWeatherSwitch = 0;

  private drags = new Map<number, Drag>();
  private collected = 0;
  private pulseStep = -1;
  private pulseAt = 0;
  private celebrating = false;
  private micTimer: number | null = null;
  /** 打开作品时正在异步解码录音，期间忽略重复打开/录音，避免河流状态竞争 */
  private restoring = false;
  private listeningChallenge: ListeningChallenge | null = null;
  private challenge: ChallengeState = {
    active: false,
    phase: 'answer',
    demoStep: -1,
    wrongSlot: -1,
    hintSlot: -1,
    savedSlots: [],
  };

  sketch = (p: p5): void => {
    p.setup = () => this.setup(p);
    p.draw = () => this.drawFrame();
    p.windowResized = () => this.resized();
  };

  private setup(p: p5): void {
    this.p = p;
    const renderer = p.createCanvas(p.windowWidth, p.windowHeight);
    this.canvasEl = renderer.elt as HTMLCanvasElement;
    p.textFont('system-ui, sans-serif');
    p.textAlign(p.CENTER, p.CENTER);

    for (let i = 0; i < SCALE.length; i++) {
      const frag = new Fragment(
        {
          id: this.toneId(i),
          kind: 'tone',
          toneIndex: i,
          freq: SCALE[i],
          timbre: TIMBRES[i % TIMBRES.length],
          color: COLORS[i],
          label: SOLFEGE[i],
        },
        (i + 0.5) * (p.width / SCALE.length),
        this.surfaceY() + 20
      );
      this.fragments.push(frag);
      Matter.Composite.add(this.engine.world, frag.body);
    }

    this.notes.layout(p.width, p.height);

    this.audio.setVoiceProvider((step) => this.voiceFor(step));
    this.audio.onStep = (s) => {
      this.pulseStep = s;
      this.pulseAt = p.millis();
    };
    this.audio.setFlow(this.flow);
    this.audio.setLevel(this.level);

    this.panel = new Panel({
      onFlow: (v) => {
        this.flow = v;
        this.audio.setFlow(v);
        if (v >= 0.7) {
          this.taskProgress.record({ flowFast: true });
          this.refreshTaskBook();
        }
      },
      onLevel: (v) => {
        this.level = v;
        this.audio.setLevel(v);
        if (v >= 0.75) {
          this.taskProgress.record({ highWater: true });
          this.refreshTaskBook();
        }
      },
      onWeather: (w) => {
        this.setWeather(w);
        // 只记录家长/孩子主动点的天气；待机 75 秒自动轮换不算“探索过”
        this.taskProgress.record({ weathersSeen: [w] });
        this.refreshTaskBook();
      },
      onMic: () => void this.toggleMic(),
      onStartChallenge: () => this.startChallenge(),
      onOpenTaskBook: () => this.openTaskBook(),
      onMute: (m) => this.audio.setMuted(m),
      onAnyGesture: () => void this.audio.unlock(),
      onSaveSong: (name, asNew) => this.saveSong(name, asNew),
      onOpenSong: (id) => void this.openSong(id),
      onDeleteSong: (id) => this.deleteSong(id),
      onExportSong: (id) => this.exportSong(id),
      onImportSong: (file) => void this.importSong(file),
      onPerformanceStart: () => void this.startPerformance(),
      onPerformanceStop: () => void this.stopPerformance(),
      onPerformanceCancel: () => this.cancelPerformance(),
      onSaveSoundToLibrary: (fragmentId, name) => this.saveSoundToLibrary(fragmentId, name),
      onRenameSound: (id, name) => this.renameSound(id, name),
      onDeleteSound: (id) => this.deleteSound(id),
      onToggleSoundPreview: (id) => void this.toggleSoundPreview(id),
      onAddSoundToRiver: (id) => void this.addSoundToRiver(id),
    });
    this.panel.setNotes(0, SLOT_COUNT);
    this.refreshSongList();
    this.refreshSoundLibrary();
    this.refreshRiverVoices();

    this.taskBook = new TaskBook({
      onAction: (a) => this.runTaskAction(a),
      onToggleManual: (key) => this.toggleTaskStamp(key),
      onReset: () => this.resetTaskBook(),
      onClose: () => this.closeTaskBook(),
      onPin: (id) => this.pinTaskToBar(id),
      onExpand: () => this.expandTaskBookFromBar(),
      onUnpin: () => this.unpinTaskBar(),
    });
    // 上次会话已完成的任务不弹新祝贺，只在徽章上显示数量
    const initial = evaluateTasks(this.taskProgress.snapshot(this.taskLive()));
    for (const t of initial) if (t.done) this.taskCongratulated.add(t.id);
    this.allTasksCongratulated = initial.every((t) => t.done) && initial.length > 0;
    this.refreshTaskBook();

    this.listeningChallenge = new ListeningChallenge({
      onReplay: () => this.replayChallengeDemo(),
      onHint: () => this.showChallengeHint(),
      onSubmit: () => this.submitChallengeAnswer(),
      onExit: () => this.exitChallenge(),
      onNext: () => this.goToNextChallengeLevel(),
    });

    const canvas = this.canvasEl;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));

    this.lastWeatherSwitch = p.millis();
  }

  // ---------- 主循环 ----------

  private drawFrame(): void {
    const p = this.p;
    const dt = Math.min(Math.max(p.deltaTime, 8), 33);
    const t = p.millis();

    // 装置待机时自动轮换天气（家长手动切换后重新计时）
    if (t - this.lastWeatherSwitch > WEATHER_AUTO_MS) {
      const next = WEATHER_CYCLE[(WEATHER_CYCLE.indexOf(this.weatherKind) + 1) % WEATHER_CYCLE.length];
      this.setWeather(next);
    }

    const surface = this.surfaceY();
    const gust = this.weather.windGust(t);
    const k = (dt / 16.666) ** 2;

    for (const frag of this.fragments) {
      if (frag.slotIndex !== null) continue;
      const body = frag.body;
      const drag = this.dragOf(frag);
      if (drag) {
        // 刚体在 onPointerDown 中已切为静态：直接贴住手指位置，
        // 避免快速拖拽时速度插值造成的滞后；并按指针轨迹记录甩动速度供松手时使用
        const tx = drag.x + drag.dx;
        const ty = drag.y + drag.dy;
        Matter.Body.setPosition(body, { x: tx, y: ty });
        const dms = Math.max(t - drag.pt, 1);
        drag.vx = ((tx - drag.px) / dms) * 16.666;
        drag.vy = ((ty - drag.py) / dms) * 16.666;
        drag.px = tx;
        drag.py = ty;
        drag.pt = t;
      } else {
        const depth = body.position.y - surface;
        const fx = (this.flow * 0.00015 + gust * 0.0005) * body.mass * k;
        let fy = 0;
        if (depth > 0) fy = -Math.min(depth / frag.h, 1.2) * 0.0011 * body.mass * k;
        if (this.weatherKind === 'rain') {
          fy += Math.sin(t * 0.02 + body.position.x) * 0.00006 * body.mass * k;
        }
        Matter.Body.applyForce(body, body.position, { x: fx, y: fy });
      }
    }
    Matter.Engine.update(this.engine, dt);

    // 水平环绕 + 防沉底
    for (const frag of this.fragments) {
      if (frag.slotIndex !== null || this.dragOf(frag)) continue;
      const { x, y } = frag.body.position;
      if (x < -frag.w) Matter.Body.setPosition(frag.body, { x: p.width + frag.w, y });
      else if (x > p.width + frag.w) Matter.Body.setPosition(frag.body, { x: -frag.w, y });
      if (y > p.height - frag.h / 2) {
        Matter.Body.setPosition(frag.body, { x, y: p.height - frag.h / 2 });
      }
    }

    this.weather.update(dt, this.flow, surface, p.width, p.height, t);
    if (!this.challenge.active) this.notes.update(dt, surface);

    this.drawSky();
    this.drawRiver(surface, t);
    if (!this.challenge.active) this.notes.draw(p, surface, t);
    for (const frag of this.fragments) {
      if (frag.slotIndex !== null) continue;
      const usable = !this.challenge.active || this.challengeCanUse(frag);
      frag.draw(
        p,
        frag.body.position.x,
        frag.body.position.y,
        frag.body.angle,
        usable ? 1 : 0.28
      );
    }
    this.drawSlots(t);
    this.weather.draw(p, surface, t);
    if (this.challenge.active) this.drawChallengeHintGlow(t);
  }

  // ---------- 输入 ----------

  private canvasPos(e: PointerEvent): { x: number; y: number } {
    const r = this.canvasEl.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (this.p.width / r.width),
      y: (e.clientY - r.top) * (this.p.height / r.height),
    };
  }

  private onPointerDown(e: PointerEvent): void {
    void this.audio.unlock();
    const { x, y } = this.canvasPos(e);
    if (this.challenge.active) {
      if (this.challenge.phase !== 'answer') return;
      const frag = this.fragmentAt(x, y);
      if (frag && !this.challengeCanUse(frag)) {
        this.panel.toast('这一关只用题目里的内置音符哦 🎧');
        return;
      }
    } else {
      const note = this.notes.hit(x, y, this.surfaceY());
      if (note) {
        this.collectNote(note);
        return;
      }
    }
    const frag = this.fragmentAt(x, y);
    if (frag) {
      if (frag.slotIndex !== null) this.unslot(frag);
      // 切为静态刚体：拖拽期间完全跟随手指，不参与重力/浮力模拟
      Matter.Body.setStatic(frag.body, true);
      Matter.Body.setAngle(frag.body, 0);
      this.drags.set(e.pointerId, {
        frag,
        dx: frag.body.position.x - x,
        dy: frag.body.position.y - y,
        x,
        y,
        px: frag.body.position.x,
        py: frag.body.position.y,
        pt: this.p.millis(),
        vx: 0,
        vy: 0,
      });
      // 快速拖出画布时仍能收到 pointerup/pointercancel
      try {
        this.canvasEl.setPointerCapture(e.pointerId);
      } catch {
        /* 某些环境不支持，忽略即可 */
      }
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.drags.get(e.pointerId);
    if (!d) return;
    const { x, y } = this.canvasPos(e);
    d.x = x;
    d.y = y;
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drags.get(e.pointerId);
    if (!d) return;
    this.drags.delete(e.pointerId);
    try {
      this.canvasEl.releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    this.releaseDrag(d);
  }

  private releaseDrag(d: Drag): void {
    const frag = d.frag;
    // 以手指释放位置（含抓取偏移）判定格子。快速拖拽时手指已到格子、
    // 刚体此前可能还滞后在半空，用刚体位会判定失败
    const tx = d.x + d.dx;
    const ty = d.y + d.dy;
    const slot = this.slotAt(tx, ty);
    if (slot >= 0) {
      if (this.challenge.active && (this.challenge.phase !== 'answer' || slot >= this.challengeLevelLength())) {
        this.dropFragmentBack(d, tx, ty);
        return;
      }
      if (!this.placeInSlot(frag, slot)) {
        this.dropFragmentBack(d, tx, ty);
        return;
      }
      return;
    }
    this.dropFragmentBack(d, tx, ty);
  }

  private dropFragmentBack(d: Drag, x: number, y: number): void {
    const frag = d.frag;
    Matter.Body.setStatic(frag.body, false);
    Matter.Body.setPosition(frag.body, { x, y });
    const maxV = 18;
    Matter.Body.setVelocity(frag.body, {
      x: Math.max(-maxV, Math.min(maxV, d.vx)),
      y: Math.max(-maxV, Math.min(maxV, d.vy)),
    });
    Matter.Body.setAngularVelocity(frag.body, 0);
  }

  // ---------- 格子 / 音序器 ----------

  private voiceFor(step: number): StepVoice | null {
    const frag = this.slots[step];
    if (!frag) return null;
    return { freq: frag.spec.freq, timbre: frag.spec.timbre, buffer: frag.spec.buffer ?? null };
  }

  private placeInSlot(frag: Fragment, i: number, silent = false): boolean {
    if (this.challenge.active && this.slots.some((f, slot) => slot < this.challengeLevelLength() && f?.spec.toneIndex === frag.spec.toneIndex)) {
      this.panel.toast('同一关里每块碎片只能用一次哦 ♪');
      Matter.Body.setStatic(frag.body, false);
      return false;
    }
    const occupant = this.slots[i];
    if (occupant && occupant !== frag) {
      this.unslot(occupant, frag.body.position.x, frag.body.position.y);
      // 被换出的碎片可能同样来自拖拽（静态刚体），恢复动态以便落回河里
      Matter.Body.setStatic(occupant.body, false);
      Matter.Body.setVelocity(occupant.body, { x: 0, y: 0 });
    }
    Matter.Composite.remove(this.engine.world, frag.body);
    frag.slotIndex = i;
    this.slots[i] = frag;
    if (!silent) this.audio.pluckNow(frag.spec.freq * 2);
    if (!silent && this.challenge.active) this.clearChallengeFeedback();
    if (!silent && !this.challenge.active) {
      this.taskProgress.record({
        maxSlotsFilled: this.slots.filter((f) => f !== null).length,
        tonePlaced: frag.spec.kind === 'tone',
        voiceInSlotEver: frag.spec.kind === 'voice',
      });
      this.refreshTaskBook();
    }
    return true;
  }

  private unslot(frag: Fragment, x?: number, y?: number): void {
    if (frag.slotIndex === null) return;
    const i = frag.slotIndex;
    const s = this.slotPos(i);
    this.slots[i] = null;
    frag.slotIndex = null;
    Matter.Body.setPosition(frag.body, x !== undefined ? { x, y: y! } : s);
    Matter.Body.setVelocity(frag.body, { x: 0, y: 0 });
    Matter.Composite.add(this.engine.world, frag.body);
    if (this.challenge.active && this.challenge.phase === 'answer') this.clearChallengeFeedback();
  }

  private slotSpacing(): number {
    return Math.min(this.p.width / (SLOT_COUNT + 0.5), 104);
  }

  private slotY(): number {
    return Math.max(56, this.p.height * 0.085);
  }

  private slotPos(i: number): { x: number; y: number } {
    const spacing = this.slotSpacing();
    const count = this.challenge.active ? this.challengeLevelLength() : SLOT_COUNT;
    return {
      x: this.p.width / 2 - (spacing * (count - 1)) / 2 + i * spacing,
      y: this.slotY(),
    };
  }

  private slotR(): number {
    return Math.min(this.slotSpacing() * 0.44, 38);
  }

  private slotAt(x: number, y: number): number {
    const r = this.slotR() * 1.6;
    let best = -1;
    let bestD = Infinity;
    const count = this.challenge.active ? this.challengeLevelLength() : SLOT_COUNT;
    for (let i = 0; i < count; i++) {
      const s = this.slotPos(i);
      const dx = x - s.x;
      const dy = y - s.y;
      // 精确落在圆形热区内
      if (dx * dx + dy * dy < r * r) return i;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    // 快速甩到顶部格子行附近：吸附到水平最近的格子，
    // 只要纵向在格子带内、横向不超过半个间距
    const s = this.slotPos(best);
    if (
      Math.abs(y - s.y) < this.slotR() * 2.1 &&
      Math.abs(x - s.x) < this.slotSpacing() * 0.55
    ) {
      return best;
    }
    return -1;
  }

  private fragmentAt(x: number, y: number): Fragment | null {
    const hitR = this.slotR() * 1.3;
    const count = this.challenge.active ? this.challengeLevelLength() : SLOT_COUNT;
    for (let i = 0; i < count; i++) {
      if (this.challenge.active && this.challenge.phase !== 'answer') continue;
      const frag = this.slots[i];
      if (!frag) continue;
      const s = this.slotPos(i);
      const dx = x - s.x;
      const dy = y - s.y;
      if (dx * dx + dy * dy < hitR * hitR) return frag;
    }
    for (let i = this.fragments.length - 1; i >= 0; i--) {
      const frag = this.fragments[i];
      if (frag.slotIndex !== null) continue;
      const b = frag.body.bounds;
      if (x >= b.min.x - 6 && x <= b.max.x + 6 && y >= b.min.y - 6 && y <= b.max.y + 6) return frag;
    }
    return null;
  }

  private dragOf(frag: Fragment): Drag | null {
    for (const d of this.drags.values()) if (d.frag === frag) return d;
    return null;
  }

  // ---------- 音符收集 ----------

  private collectNote(note: { freq: number; collected: boolean }): void {
    note.collected = true;
    this.collected++;
    this.panel.setNotes(this.collected, SLOT_COUNT);
    this.audio.chime(note.freq);
    this.taskProgress.record({ notesCollectedEver: this.collected });
    this.refreshTaskBook();
    if (this.collected === SLOT_COUNT && !this.celebrating) {
      this.celebrating = true;
      this.audio.fanfare();
      this.panel.toast('🎉 河流之歌完成啦！');
      window.setTimeout(() => {
        this.notes.layout(this.p.width, this.p.height);
        this.collected = 0;
        this.panel.setNotes(0, SLOT_COUNT);
        this.celebrating = false;
      }, 2200);
    }
  }

  // ---------- 听音挑战 ----------

  private challengeTones(level = this.listeningChallenge?.level ?? 0): number[] {
    return CHALLENGE_LEVELS[level] ?? CHALLENGE_LEVELS[0];
  }

  private challengeLevelLength(): number {
    return this.challengeTones().length;
  }

  private challengeCanUse(frag: Fragment): boolean {
    return frag.spec.kind === 'tone' && this.challengeTones().includes(frag.spec.toneIndex);
  }

  private clearChallengeFeedback(): void {
    this.challenge.wrongSlot = -1;
    this.challenge.hintSlot = -1;
    this.listeningChallenge?.answerChanged();
  }

  private startChallenge(): void {
    if (this.restoring) {
      this.panel.toast('正在打开作品，稍等一下再挑战 ⏳');
      return;
    }
    if (this.challenge.active) return;
    if (this.mic.recording) {
      this.panel.toast('录音结束后再开始听音挑战 🎙️');
      return;
    }
    if (this.panel.performanceRecording) {
      this.panel.toast('演奏录制结束后再开始听音挑战 🔴');
      return;
    }
    void this.audio.unlock();

    // 保留孩子原本的 6 格作品；挑战只临时借用碎片，退出后原位恢复
    this.challenge.savedSlots = this.slots.map((f) => f?.id ?? null);
    for (let i = SLOT_COUNT - 1; i >= 0; i--) {
      const frag = this.slots[i];
      if (frag) {
        this.unslot(frag, 40 + i * 18, this.surfaceY() + 18);
        Matter.Body.setStatic(frag.body, false);
      }
    }

    this.challenge.active = true;
    this.challenge.phase = 'demo';
    this.challenge.demoStep = -1;
    this.challenge.wrongSlot = -1;
    this.challenge.hintSlot = -1;
    this.panel.setChallengeActive(true);
    this.listeningChallenge!.show(0);
    document.getElementById('hud')?.classList.add('hidden');
    document.getElementById('hint')?.classList.add('hidden');
    // 边玩边看提示条与挑战互斥，先藏起来（不取消收起状态，退出挑战自动回来）
    document.getElementById('taskBar')?.classList.add('hidden');
    this.playChallengeDemo();
  }

  private playChallengeDemo(): void {
    if (!this.challenge.active) return;
    const level = this.listeningChallenge!.level;
    const tones = this.challengeTones(level);
    this.challenge.phase = 'demo';
    this.challenge.demoStep = -1;
    this.challenge.wrongSlot = -1;
    this.challenge.hintSlot = -1;
    this.pulseStep = -1;
    this.listeningChallenge!.startLevel(level);

    // 清掉上一关/上一次答案（从最后一关重玩第一关时，也要清掉多出的旧格子）
    for (let i = SLOT_COUNT - 1; i >= 0; i--) {
      const frag = this.slots[i];
      if (frag) {
        this.unslot(frag, 40 + i * 18, this.surfaceY() + 18);
        Matter.Body.setStatic(frag.body, false);
      }
    }
    this.audio.cancelMelody();
    this.audio.setSequencerPaused(true);
    const voices = tones.map((toneIndex) => ({
      freq: SCALE[toneIndex],
      timbre: TIMBRES[toneIndex % TIMBRES.length],
    }));
    this.audio.playMelody(
      voices,
      (step) => {
        this.challenge.demoStep = step;
        this.listeningChallenge?.setDemoStep(step);
        this.pulseStep = step;
        this.pulseAt = this.p.millis();
      },
      () => this.finishChallengeDemo()
    );
  }

  private replayChallengeDemo(): void {
    if (!this.challenge.active) return;
    void this.audio.unlock();
    this.playChallengeDemo();
  }

  private finishChallengeDemo(): void {
    if (!this.challenge.active || this.challenge.phase !== 'demo') return;
    this.challenge.phase = 'answer';
    this.challenge.demoStep = -1;
    this.pulseStep = -1;
    this.audio.setSequencerPaused(false);
    this.listeningChallenge?.beginAnswer();
    this.panel.toast('轮到你啦：按听到的顺序拖进圆圈 ♪');
  }

  private showChallengeHint(): void {
    if (!this.challenge.active || this.challenge.phase !== 'answer') return;
    const tones = this.challengeTones();
    let target = -1;
    for (let i = 0; i < tones.length; i++) {
      if (this.slots[i]?.spec.toneIndex !== tones[i]) {
        target = i;
        break;
      }
    }
    if (target < 0) {
      this.submitChallengeAnswer();
      return;
    }
    this.challenge.hintSlot = target;
    this.challenge.wrongSlot = -1;
    const toneIndex = tones[target];
    this.listeningChallenge?.showHint(target, SOLFEGE[toneIndex]);
  }

  private submitChallengeAnswer(): void {
    if (!this.challenge.active || this.challenge.phase !== 'answer') return;
    const tones = this.challengeTones();
    const empty = tones.findIndex((_, i) => !this.slots[i]);
    if (empty >= 0) {
      this.challenge.wrongSlot = empty;
      this.challenge.hintSlot = -1;
      this.listeningChallenge?.showWrong(empty, `还缺第 ${empty + 1} 个圆圈，先补满再提交`);
      this.panel.toast(`第 ${empty + 1} 个圆圈还空着 🎧`);
      return;
    }

    for (let i = 0; i < tones.length; i++) {
      if (this.slots[i]?.spec.toneIndex !== tones[i]) {
        this.challenge.wrongSlot = i;
        this.challenge.hintSlot = -1;
        this.listeningChallenge?.showWrong(i, `第 ${i + 1} 个音不太对，可以重听或要提示`);
        this.panel.toast(`第 ${i + 1} 个位置不太对，再听听看 🎧`);
        return;
      }
    }

    const last = this.listeningChallenge!.level >= CHALLENGE_LEVELS.length - 1;
    this.challenge.phase = last ? 'finished' : 'levelComplete';
    this.challenge.wrongSlot = -1;
    this.challenge.hintSlot = -1;
    this.listeningChallenge?.levelComplete(last);
    this.audio.fanfare();
    this.panel.toast(last ? '🏆 听音挑战全部完成！' : '🎉 答对啦！');
  }

  private goToNextChallengeLevel(): void {
    if (!this.challenge.active) return;
    const next = (this.listeningChallenge!.level + 1) % CHALLENGE_LEVELS.length;
    this.listeningChallenge?.startLevel(next);
    this.playChallengeDemo();
  }

  private exitChallenge(): void {
    if (!this.challenge.active) return;
    this.audio.cancelMelody();
    this.audio.setSequencerPaused(false);

    for (let i = SLOT_COUNT - 1; i >= 0; i--) {
      const frag = this.slots[i];
      if (frag) {
        this.unslot(frag, 40 + i * 18, this.surfaceY() + 18);
        Matter.Body.setStatic(frag.body, false);
      }
    }
    const byId = new Map(this.fragments.map((f) => [f.id, f]));
    this.challenge.active = false;
    this.challenge.phase = 'answer';
    this.challenge.demoStep = -1;
    this.challenge.wrongSlot = -1;
    this.challenge.hintSlot = -1;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const fid = this.challenge.savedSlots[i];
      const frag = fid ? byId.get(fid) : null;
      if (frag) this.placeInSlot(frag, i, true);
    }

    this.challenge.savedSlots = [];
    this.pulseStep = -1;
    this.listeningChallenge?.hide();
    this.panel.setChallengeActive(false);
    document.getElementById('hud')?.classList.remove('hidden');
    document.getElementById('hint')?.classList.remove('hidden');
    // 恢复挑战前收起的边玩边看提示条（任务可能在挑战中无变化，直接按最新状态渲染）
    this.refreshTaskBook();
    this.panel.toast('已退出挑战，回到你的河流 ♪');
  }

  // ---------- 声音探索任务册 ----------

  /** 任务册能感知的“当前画面”事实 */
  private taskLive(): { slotsFilled: number } {
    return { slotsFilled: this.slots.filter((f) => f !== null).length };
  }

  private openTaskBook(): void {
    if (this.challenge.active) {
      this.panel.toast('先退出听音挑战，再打开任务册 🎧');
      return;
    }
    void this.audio.unlock();
    // 打开时先同步一次圆圈占用峰值（家长可能刚帮孩子摆好碎片）
    this.recordSlotFacts();
    const states = evaluateTasks(this.taskProgress.snapshot(this.taskLive()));
    this.taskBook!.show(states);
    // 手机上面板是底部抽屉，会和任务册叠在一起：先替家长收起
    const panelEl = document.getElementById('panel');
    if (panelEl && !panelEl.classList.contains('hidden')) {
      panelEl.classList.add('hidden');
      document.getElementById('panelToggle')?.setAttribute('aria-expanded', 'false');
    }
  }

  private closeTaskBook(): void {
    this.taskBook?.hide();
    // 关闭手册后，若有「边玩边看」收起的任务，紧凑提示条继续留在河面上
    this.refreshTaskBook();
  }

  /** 「边玩边看」：把指定任务收成河面上的紧凑提示条 */
  private pinTaskToBar(id: string): void {
    void this.audio.unlock();
    this.recordSlotFacts();
    const states = evaluateTasks(this.taskProgress.snapshot(this.taskLive()));
    this.taskBook!.pinTask(id, states);
    this.panel.toast('任务收成小提示条啦，边玩边看 👀');
  }

  /** 紧凑提示条上的「展开」：回到任务册并展开该任务 */
  private expandTaskBookFromBar(): void {
    const states = evaluateTasks(this.taskProgress.snapshot(this.taskLive()));
    this.taskBook!.expandFromBar(states);
    // 手机上面板若是开着的会和任务册叠在一起：替家长收起
    const panelEl = document.getElementById('panel');
    if (panelEl && !panelEl.classList.contains('hidden')) {
      panelEl.classList.add('hidden');
      document.getElementById('panelToggle')?.setAttribute('aria-expanded', 'false');
    }
  }

  /** 紧凑提示条上的「✕」：取消边玩边看 */
  private unpinTaskBar(): void {
    this.taskBook?.unpin();
  }

  /** 任务册里的快捷动作：直接驱动现有装置能力，再立刻刷新盖章状态 */
  private runTaskAction(action: TaskAction): void {
    void this.audio.unlock();
    switch (action.kind) {
      case 'weather':
        if (action.weather) {
          this.setWeather(action.weather);
          this.taskProgress.record({ weathersSeen: [action.weather] });
        }
        break;
      case 'setLevel': {
        const v = action.value ?? 0.85;
        this.level = v;
        this.audio.setLevel(v);
        this.panel.setLevel(v);
        if (v >= 0.75) this.taskProgress.record({ highWater: true });
        break;
      }
      case 'setFlow': {
        const v = action.value ?? 0.85;
        this.flow = v;
        this.audio.setFlow(v);
        this.panel.setFlow(v);
        if (v >= 0.7) this.taskProgress.record({ flowFast: true });
        break;
      }
      case 'mic':
        // 复用现有录音流程（包含挑战/内录互斥与权限失败提示），其内部会自行 toast，
        // 这里不再覆盖“录音中…”提示
        void this.toggleMic();
        this.refreshTaskBook();
        return;
      case 'save':
        this.panel.openSaveDialog();
        break;
    }
    this.panel.toast(describeAction(action));
    this.refreshTaskBook();
  }

  private toggleTaskStamp(key: string): void {
    // 防御：被探索事实锁定的步骤不允许取消（UI 按钮本已禁用）
    const [taskId, stepId] = key.split(':');
    const def = TASKS.find((t) => t.id === taskId);
    const step = def?.steps.find((s) => s.id === stepId);
    const snap = this.taskProgress.snapshot(this.taskLive());
    if (step && (step.kind === 'auto' || step.locked?.(snap))) return;
    this.taskProgress.toggleManual(key);
    this.refreshTaskBook();
  }

  private resetTaskBook(): void {
    this.taskProgress.reset();
    this.taskCongratulated.clear();
    this.allTasksCongratulated = false;
    this.refreshTaskBook();
    this.panel.toast('任务册清空啦，可以陪孩子重新出发 📖');
  }

  /** 重新评估全部任务：渲染覆盖层（若开着）、更新边玩边看提示条与入口徽章、对新完成的任务祝贺 */
  private refreshTaskBook(): void {
    const states = evaluateTasks(this.taskProgress.snapshot(this.taskLive()));
    if (!this.challenge.active) {
      if (this.taskBook?.pinned) {
        // 收起中的任务刚盖满章时，提示条自动带去下一个未完成任务；全部完成则消失
        this.taskBook.advancePinned(states);
      }
      if (this.taskBook?.visible || this.taskBook?.pinned) {
        this.taskBook.render(states);
      }
    }
    const doneCount = states.filter((t) => t.done).length;
    this.panel.setTaskBookBadge(doneCount, TASKS.length);

    for (const state of states) {
      if (state.done && !this.taskCongratulated.has(state.id)) {
        this.taskCongratulated.add(state.id);
        const def = TASKS.find((t) => t.id === state.id)!;
        this.panel.toast(`⭐「${def.title}」任务完成，盖一个章！`);
        // 集齐音符的庆祝音阶正在播时不叠加，只做轻提示音
        if (!this.celebrating) this.audio.pluckNow(659.25);
      }
    }
    if (doneCount === TASKS.length && !this.allTasksCongratulated) {
      this.allTasksCongratulated = true;
      this.audio.fanfare();
      this.panel.toast('🏆 整本任务册都完成啦，小小声音探险家！');
    } else if (doneCount < TASKS.length) {
      this.allTasksCongratulated = false;
    }
  }

  /** 圆圈占用相关的两个探索事实：放进内置音符、历史最多占用格数、录音进过圆圈 */
  private recordSlotFacts(): void {
    const filled = this.slots.filter((f) => f !== null).length;
    if (filled === 0) return;
    this.taskProgress.record({
      maxSlotsFilled: filled,
      tonePlaced: this.slots.some((f) => f?.spec.kind === 'tone'),
      voiceInSlotEver: this.slots.some((f) => f?.spec.kind === 'voice'),
    });
  }

  // ---------- 录音 ----------

  private async toggleMic(): Promise<void> {
    if (this.challenge.active) {
      this.panel.toast('先退出听音挑战，再录新声音 🎧');
      return;
    }
    if (this.panel.performanceRecording) {
      this.panel.toast('先停止录下演奏，再录声音碎片 🔴');
      return;
    }
    if (this.mic.recording) {
      await this.stopMic();
      return;
    }
    if (this.restoring) {
      this.panel.toast('正在打开作品，稍等一下再录 ⏳');
      return;
    }
    try {
      await this.audio.unlock();
      await this.mic.start();
    } catch {
      this.panel.toast('打不开麦克风 😢 请检查权限');
      return;
    }
    this.panel.setMicRecording(true);
    this.panel.toast('🎙️ 录音中… 再点一下停止');
    this.micTimer = window.setTimeout(() => void this.stopMic(), 4000);
  }

  private async stopMic(): Promise<void> {
    if (this.micTimer !== null) {
      window.clearTimeout(this.micTimer);
      this.micTimer = null;
    }
    if (!this.mic.recording) return;
    const blob = await this.mic.stop();
    this.panel.setMicRecording(false);
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const buffer = await this.audio.decode(bytes.slice().buffer);
      const voice: VoiceAudio = { bytes, mime: blob.type || 'audio/webm', buffer };
      const frag = new Fragment(
        {
          id: `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          kind: 'voice',
          toneIndex: -1,
          freq: 261.63,
          timbre: 'sample',
          color: VOICE_COLOR,
          label: '🎙️',
          buffer,
          audio: voice,
        },
        this.p.width / 2,
        this.surfaceY() + 8
      );
      this.fragments.push(frag);
      Matter.Composite.add(this.engine.world, frag.body);
      this.panel.toast('你的声音游进河里啦！🐟');
      this.taskProgress.record({ micRecordings: this.taskProgress.facts.micRecordings + 1 });
      this.refreshTaskBook();
      this.refreshRiverVoices();
    } catch {
      this.panel.toast('这段声音没法用 😢');
    }
  }

  // ---------- 录下演奏 ----------

  private async startPerformance(): Promise<void> {
    if (this.challenge.active) {
      this.panel.toast('先退出听音挑战，再录下演奏 🎧');
      return;
    }
    if (this.panel.performanceRecording) return;
    if (this.mic.recording) {
      this.panel.toast('声音碎片录音结束后，再录下演奏 🎙️');
      return;
    }
    if (this.restoring) {
      this.panel.toast('正在打开作品，稍等一下再录 ⏳');
      return;
    }
    // 不使用麦克风：AudioContext 必须先建立，混音总线才有引出点
    try {
      await this.audio.unlock();
      this.performance.start(this.audio);
    } catch {
      this.panel.toast('这台设备不支持录下演奏 😢');
      this.panel.resetPerformanceUI();
      return;
    }
    this.panel.setPerformanceRecording(true);
    this.panel.toast('🔴 演奏录制中：让孩子开始拼旋律吧，最长 60 秒');
    this.performance.onMaxDuration(() => void this.stopPerformance(true));
  }

  private async stopPerformance(auto = false): Promise<void> {
    if (!this.performance.recording) return;
    this.performance.clearMaxTimer();
    this.panel.setPerformanceStopping();
    try {
      const result = await this.performance.stop();
      if (!result) {
        this.panel.resetPerformanceUI();
        this.panel.toast(auto ? '录制到 60 秒上限，但没录到声音 😢' : '没录到声音，再试一次 ♪');
        return;
      }
      // 以“能否解码 + 是否真有时长”判定有效性，而不是墙钟门槛：
      // 家长快速停止（不足 1 秒）时，只要浏览器产出了可播放音频就允许试听/下载。
      // 同时采用解码时长作为展示值，比操作计时更贴近实际音频。
      let duration = 0;
      try {
        const decoded = await this.audio.decode(await result.blob.arrayBuffer());
        duration = decoded.duration;
      } catch {
        duration = 0;
      }
      if (!(duration > 0)) {
        this.panel.resetPerformanceUI();
        this.panel.toast('这段录音还没能生成声音，再试一次 ♪');
        return;
      }
      this.panel.setPerformanceResult(result.blob, duration);
      this.panel.toast('录好啦：先试听，满意就下载 ⬇️');
    } catch {
      this.panel.resetPerformanceUI();
      this.panel.toast('录制失败了，再试一次 😢');
    }
  }

  /** 取消录制或放弃已录好的音频，不下载、不留文件 */
  private cancelPerformance(): void {
    this.performance.cancel();
    this.panel.resetPerformanceUI();
    this.panel.toast('已取消，没有保存录音 ♪');
  }

  // ---------- 天气 ----------

  private setWeather(w: WeatherKind): void {
    this.weatherKind = w;
    this.weather.setKind(w);
    this.audio.setWeather(w);
    this.panel.setWeatherActive(w);
    this.lastWeatherSwitch = this.p.millis();
  }

  // ---------- 本地作品集 ----------

  private toneId(i: number): string {
    return `tone-${i}`;
  }

  private refreshSongList(): void {
    this.panel.setSongs(this.portfolio.list(), this.currentSongId);
  }

  /** 把当前画面序列化成存档：格子顺序、空格、全部碎片（含录音）、流速、水位、天气 */
  private serializeSong(name: string, id: string, now: number): SongDoc {
    const fragments: FragmentDoc[] = this.fragments.map((f) => {
      const s = f.spec;
      const doc: FragmentDoc = {
        id: s.id,
        kind: s.kind,
        freq: s.freq,
        timbre: s.timbre,
        color: s.color,
        label: s.label,
        toneIndex: s.toneIndex,
      };
      if (s.kind === 'voice' && s.audio) {
        doc.audio = bytesToBase64(s.audio.bytes);
        doc.audioMime = s.audio.mime;
      }
      return doc;
    });
    return {
      id,
      name,
      createdAt: now,
      updatedAt: now,
      flow: this.flow,
      level: this.level,
      weather: this.weatherKind,
      slotCount: SLOT_COUNT,
      slots: this.slots.map((f) => (f ? f.id : null)),
      fragments,
      version: 1,
    };
  }

  private saveSong(name: string, asNew: boolean): void {
    if (this.challenge.active) {
      this.panel.toast('先退出听音挑战，再保存当前河流 🎧');
      return;
    }
    const now = Date.now();
    // 覆盖当前作品沿用原 id 与创建时间；另存为或首次保存则新建
    const existing = this.currentSongId && !asNew ? this.portfolio.get(this.currentSongId) : null;
    const id = existing ? existing.id : Portfolio.newId();
    const doc = this.serializeSong(name, id, now);
    if (existing) doc.createdAt = existing.createdAt;
    try {
      this.portfolio.save(doc);
      this.currentSongId = id;
      this.refreshSongList();
      this.taskProgress.record({ songSaved: true });
      this.refreshTaskBook();
      this.panel.toast(existing ? `已保存《${name}》💾` : `《${name}》收进作品集啦！📚`);
    } catch (e) {
      if (e instanceof QuotaError) this.panel.toast(e.message);
      else this.panel.toast('保存失败 😢 浏览器可能禁用了本地存储');
    }
  }

  private async openSong(id: string): Promise<void> {
    if (this.challenge.active) {
      this.panel.toast('先退出听音挑战，再打开作品 🎧');
      return;
    }
    if (this.panel.performanceRecording) {
      this.panel.toast('演奏录制结束后再打开作品 🔴');
      return;
    }
    if (this.restoring) return;
    const doc = this.portfolio.get(id);
    if (!doc) {
      this.refreshSongList();
      return;
    }
    this.restoring = true;
    // 录音是用户手势（点击）触发的：趁机解锁音频，保证 decodeAudioData 可用
    await this.audio.unlock();
    try {
      await this.restoreSong(doc);
      this.currentSongId = id;
      this.refreshSongList();
      this.panel.toast(`打开《${doc.name}》♪`);
    } catch {
      this.panel.toast('这首歌打不开了 😢（录音数据可能损坏）');
    } finally {
      this.restoring = false;
    }
  }

  private deleteSong(id: string): void {
    this.portfolio.remove(id);
    if (this.currentSongId === id) this.currentSongId = null;
    this.refreshSongList();
    this.panel.toast('已删除 🗑️');
  }

  /** 单首作品备份文件的大小上限：单首（含若干段 4 秒录音）远超此值即可判定为选错文件 */
  private static MAX_IMPORT_BYTES = 8_000_000;

  /** 导出单首作品为 .json 备份文件，家长可发到另一台设备再导入 */
  private exportSong(id: string): void {
    const exported = this.portfolio.exportSong(id);
    if (!exported) {
      this.refreshSongList();
      return;
    }
    // 文件名沿用作品名，只替换掉各平台文件系统不接受的字符
    const safe = exported.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || '河流之歌';
    const url = URL.createObjectURL(new Blob([exported.json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safe}.river-song.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 延后回收：iOS Safari 立即 revoke 会取消还没开始的下载
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    this.panel.toast(`已导出《${exported.name}》📤 发到另一台设备后点「导入作品备份」`);
  }

  /** 从备份文件导入一首作品；只进列表不自动打开，避免覆盖孩子正在玩的河流 */
  private async importSong(file: File): Promise<void> {
    if (file.size > Game.MAX_IMPORT_BYTES) {
      this.panel.toast('这个文件太大，不像是作品备份 🤔');
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      this.panel.toast('读不了这个文件 😢');
      return;
    }
    try {
      const { doc, copied } = this.portfolio.importSong(text);
      this.refreshSongList();
      this.panel.toast(
        copied
          ? `已导入《${doc.name}》：本机已有同一首，存成了新作品 📥`
          : `《${doc.name}》回到作品集啦！📥`
      );
    } catch (e) {
      if (e instanceof ImportError || e instanceof QuotaError) this.panel.toast(e.message);
      else this.panel.toast('导入失败 😢 这个文件可能不是作品备份');
    }
  }

  /** 按存档重建整条河流：还原因速/水位 → 清场 → 建碎片 → 摆格子 → 天气 */
  private async restoreSong(doc: SongDoc): Promise<void> {
    const p = this.p;
    this.drags.clear();

    // 先恢复水位（决定河面高度），碎片初始位置才会落在正确的水里
    this.flow = doc.flow;
    this.level = doc.level;
    this.audio.setFlow(this.flow);
    this.audio.setLevel(this.level);
    this.panel.setFlow(this.flow);
    this.panel.setLevel(this.level);

    // 清掉旧碎片的物理体
    for (const f of this.fragments) Matter.Composite.remove(this.engine.world, f.body);
    this.fragments = [];
    this.slots = Array(SLOT_COUNT).fill(null);

    // 解码全部录音（AudioBuffer 无法直接 JSON 化，只持久化了编码字节）
    const restored: Fragment[] = [];
    for (const fd of doc.fragments) {
      let voice: VoiceAudio | null = null;
      if (fd.kind === 'voice') {
        if (!fd.audio) continue;
        try {
          const bytes = base64ToBytes(fd.audio);
          const buffer = await this.audio.decode(bytes.slice().buffer);
          voice = { bytes, mime: fd.audioMime || 'audio/webm', buffer };
        } catch {
          // 单条录音损坏（base64/编码无法解码）只跳过它，不影响整首歌恢复
          continue;
        }
      }
      const spec =
        fd.kind === 'tone' && fd.toneIndex >= 0 && fd.toneIndex < SCALE.length
          ? {
              // 内置音符以音阶表为准，忽略存档里被改动的视觉/音高字段
              id: this.toneId(fd.toneIndex),
              kind: 'tone' as const,
              toneIndex: fd.toneIndex,
              freq: SCALE[fd.toneIndex],
              timbre: TIMBRES[fd.toneIndex % TIMBRES.length],
              color: COLORS[fd.toneIndex],
              label: SOLFEGE[fd.toneIndex],
            }
          : {
              id: fd.id,
              kind: 'voice' as const,
              toneIndex: -1,
              freq: fd.freq || 261.63,
              timbre: 'sample' as const,
              color: fd.color || VOICE_COLOR,
              label: fd.label || '🎙️',
              buffer: voice?.buffer ?? null,
              audio: voice,
            };
      // 先都放在河面，稍后把属于格子的静默移入格子
      const x = ((restored.length + 0.5) / Math.max(doc.fragments.length, 1)) * p.width;
      restored.push(new Fragment(spec, x, this.surfaceY() + 20));
    }

    // 存档若缺内置音符（旧版本/异常数据），补齐 8 块固定音阶
    for (let i = 0; i < SCALE.length; i++) {
      if (!restored.some((f) => f.id === this.toneId(i))) {
        restored.push(
          new Fragment(
            {
              id: this.toneId(i),
              kind: 'tone',
              toneIndex: i,
              freq: SCALE[i],
              timbre: TIMBRES[i % TIMBRES.length],
              color: COLORS[i],
              label: SOLFEGE[i],
            },
            (i + 0.5) * (p.width / SCALE.length),
            this.surfaceY() + 20
          )
        );
      }
    }

    for (const f of restored) Matter.Composite.add(this.engine.world, f.body);
    this.fragments = restored;
    const byId = new Map(restored.map((f) => [f.id, f]));

    // 恢复格子顺序与空格：按存档逐格摆放，引用不到的格子留空
    this.slots = Array(SLOT_COUNT).fill(null);
    const slotCount = doc.slotCount || SLOT_COUNT;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const fid = i < slotCount ? doc.slots[i] ?? null : null;
      const frag = fid ? byId.get(fid) : null;
      if (frag) this.placeInSlot(frag, i, true);
    }
    // 多块录音落在同一格等异常情况下，保证每条声音都还在河里，不会无声消失
    for (const f of restored) {
      if (f.slotIndex !== null && !this.slots.includes(f)) {
        f.slotIndex = null;
        Matter.Composite.add(this.engine.world, f.body);
      }
    }

    // 恢复天气（同步粒子、环境声与面板高亮，并重置待机轮换计时）
    this.setWeather(doc.weather);

    // 收集进度不属于某首歌：重置一轮，避免 HUD 数字与画面音符对不上
    this.collected = 0;
    this.panel.setNotes(0, SLOT_COUNT);
    this.notes.layout(p.width, p.height);
    // 河里换了一批碎片，素材库的「⭐ 收藏」列表跟着刷新
    this.refreshRiverVoices();
  }

  // ---------- 声音素材库 ----------

  private refreshSoundLibrary(): void {
    this.panel.setSoundClips(this.soundLibrary.list());
  }

  /** 河里当前可收藏的录音碎片（含格子里的），供家长挑一段命名收藏 */
  private refreshRiverVoices(): void {
    const voices = this.fragments.filter((f) => f.spec.kind === 'voice' && f.spec.audio);
    this.panel.setRiverVoices(
      voices.map((f, i) => ({
        id: f.id,
        // 从素材库入河的碎片带着名字，直接展示；新录的还是「录音 N」
        name: f.spec.label && f.spec.label !== '🎙️' ? f.spec.label : `录音 ${i + 1}`,
        duration: f.spec.audio!.buffer.duration,
      }))
    );
  }

  /**
   * 解码素材录音；AudioBuffer 无法持久化，每次会话从 base64 解码并缓存。
   * 解码期间素材被删除时返回 null：结果不入缓存，调用方也不再使用。
   */
  private async decodeClip(clip: SoundClipDoc): Promise<AudioBuffer | null> {
    const hit = this.clipBuffers.get(clip.id);
    if (hit) return hit;
    const bytes = base64ToBytes(clip.audio);
    const buffer = await this.audio.decode(bytes.slice().buffer);
    if (this.cancelledClipIds.has(clip.id)) return null;
    if (this.clipBuffers.size >= 8) {
      // Map 按插入序迭代，淘汰最早缓存的一段，避免长时间游玩后内存膨胀
      const oldest = this.clipBuffers.keys().next().value;
      if (oldest !== undefined) this.clipBuffers.delete(oldest);
    }
    this.clipBuffers.set(clip.id, buffer);
    return buffer;
  }

  /** 把河里某块录音碎片命名收藏进素材库（碎片本身留在河里，收藏是复制） */
  private saveSoundToLibrary(fragmentId: string, name: string): void {
    const frag = this.fragments.find((f) => f.id === fragmentId);
    const audio = frag?.spec.audio ?? null;
    if (!frag || !audio) {
      // 列表是旧快照（碎片已被换走）：刷新列表让家长重新选择
      this.panel.toast('这块录音碎片已经不在河里了 🤔');
      this.refreshRiverVoices();
      return;
    }
    const now = Date.now();
    try {
      this.soundLibrary.save({
        id: SoundLibrary.newId(),
        name,
        createdAt: now,
        updatedAt: now,
        duration: audio.buffer.duration,
        audio: bytesToBase64(audio.bytes),
        audioMime: audio.mime,
      });
      this.refreshSoundLibrary();
      this.panel.toast(`「${name}」收进素材库啦 ⭐`);
    } catch (e) {
      if (e instanceof QuotaError) this.panel.toast(e.message);
      else this.panel.toast('收藏失败 😢 浏览器可能禁用了本地存储');
    }
  }

  private renameSound(id: string, name: string): void {
    try {
      this.soundLibrary.rename(id, name);
      this.refreshSoundLibrary();
      this.panel.toast(`已改名为「${name}」✏️`);
    } catch (e) {
      if (e instanceof QuotaError) this.panel.toast(e.message);
      else this.panel.toast('改名失败 😢');
    }
  }

  private deleteSound(id: string): void {
    // 正在试听这一段就先停下来（onended 会复位面板的试听状态）
    if (this.previewingSoundId === id) this.audio.stopPreview();
    // 可能有尚未完成的解码（试听/加入河流刚点过）：标记取消，解码结果会被丢弃
    this.cancelledClipIds.add(id);
    this.clipBuffers.delete(id);
    this.soundLibrary.remove(id);
    this.refreshSoundLibrary();
    this.panel.toast('已删除 🗑️');
  }

  private async toggleSoundPreview(id: string): Promise<void> {
    const token = ++this.previewToken;
    // 再点同一段 = 停止试听
    if (this.previewingSoundId === id) {
      this.audio.stopPreview();
      this.previewingSoundId = null;
      this.panel.setSoundPreviewing(null);
      return;
    }
    const clip = this.soundLibrary.get(id);
    if (!clip) {
      this.refreshSoundLibrary();
      return;
    }
    try {
      await this.audio.unlock();
      const buffer = await this.decodeClip(clip);
      if (!buffer) return; // 解码期间素材被删除，丢弃结果
      if (token !== this.previewToken) return; // 等待解码时家长又点了别的
      this.audio.previewBuffer(buffer, () => {
        if (token !== this.previewToken) return;
        this.previewingSoundId = null;
        this.panel.setSoundPreviewing(null);
      });
      this.previewingSoundId = id;
      this.panel.setSoundPreviewing(id);
    } catch {
      this.panel.toast('这段声音播不出来 😢');
    }
  }

  /** 把素材变成一块新的橙色碎片放进河里；只新增，不动 6 个格子里已有的编排 */
  private async addSoundToRiver(id: string): Promise<void> {
    if (this.challenge.active) {
      this.panel.toast('先退出听音挑战，再把素材放进河里 🎧');
      return;
    }
    if (this.restoring) {
      this.panel.toast('正在打开作品，稍等一下 ⏳');
      return;
    }
    const clip = this.soundLibrary.get(id);
    if (!clip) {
      this.refreshSoundLibrary();
      return;
    }
    try {
      await this.audio.unlock();
      const buffer = await this.decodeClip(clip);
      if (!buffer) return; // 解码期间素材被删除，不再放进河里
      const bytes = base64ToBytes(clip.audio);
      const voice: VoiceAudio = { bytes, mime: clip.audioMime, buffer };
      const frag = new Fragment(
        {
          id: `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          kind: 'voice',
          toneIndex: -1,
          freq: 261.63,
          timbre: 'sample',
          color: VOICE_COLOR,
          // 碎片上最多画得下 8 个字，长名字截断展示（素材库里的全名不受影响）
          label: clip.name.length > 8 ? clip.name.slice(0, 8) : clip.name,
          buffer,
          audio: voice,
        },
        this.p.width * (0.2 + Math.random() * 0.6),
        this.surfaceY() + 8
      );
      this.fragments.push(frag);
      Matter.Composite.add(this.engine.world, frag.body);
      this.refreshRiverVoices();
      this.panel.toast(`「${clip.name}」游进河里啦，原来的编排没有变 ♪`);
    } catch {
      this.panel.toast('这段声音没法用 😢');
    }
  }

  // ---------- 渲染 ----------

  private surfaceY(): number {
    return this.p.height * (0.62 - 0.32 * this.level);
  }

  private waveY(x: number, surface: number, t: number): number {
    return (
      surface +
      Math.sin(x * 0.02 + t * 0.002 * (1 + this.flow * 3)) * 4 +
      Math.sin(x * 0.045 - t * 0.0032) * 2.5
    );
  }

  private drawSky(): void {
    const p = this.p;
    const ctx = p.drawingContext as CanvasRenderingContext2D;
    const [top, bottom] = this.weather.skyColors();
    const g = ctx.createLinearGradient(0, 0, 0, p.height);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, p.width, p.height);
  }

  private drawRiver(surface: number, t: number): void {
    const p = this.p;
    const ctx = p.drawingContext as CanvasRenderingContext2D;

    const g = ctx.createLinearGradient(0, surface, 0, p.height);
    g.addColorStop(0, 'rgba(80,170,255,0.45)');
    g.addColorStop(1, 'rgba(8,50,110,0.8)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, surface);
    for (let x = 0; x <= p.width; x += 14) ctx.lineTo(x, this.waveY(x, surface, t));
    ctx.lineTo(p.width, p.height);
    ctx.lineTo(0, p.height);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= p.width; x += 14) {
      const y = this.waveY(x, surface, t);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 随流速加快的水纹
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    const depth = p.height - surface;
    for (let i = 0; i < 10; i++) {
      const speed = 0.03 + this.flow * 0.3;
      const sx = ((i * 197 + t * speed) % (p.width + 140)) - 70;
      const sy = surface + 16 + ((i * 53) % Math.max(20, depth - 40));
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + 24 + this.flow * 50, sy);
      ctx.stroke();
    }
  }

  private drawSlots(t: number): void {
    const p = this.p;
    const y = this.slotY();
    const count = this.challenge.active ? this.challengeLevelLength() : SLOT_COUNT;

    p.stroke(255, 255, 255, this.challenge.active ? 150 : 90);
    p.strokeWeight(2);
    if (count === 1) {
      const s = this.slotPos(0);
      p.line(s.x - 24, y, s.x + 24, y);
    } else {
      p.line(this.slotPos(0).x - 24, y, this.slotPos(count - 1).x + 24, y);
    }

    for (let i = 0; i < count; i++) {
      const s = this.slotPos(i);
      const r = this.slotR();
      let pulse = 1;
      if (i === this.pulseStep) pulse = 1 + 0.22 * Math.exp(-(t - this.pulseAt) / 130);
      if (this.challenge.active && this.challenge.phase === 'demo' && i === this.challenge.demoStep) {
        pulse = 1.16;
      }

      p.push();
      p.translate(s.x, s.y);
      p.scale(pulse);
      p.noFill();
      if (this.challenge.active && i === this.challenge.wrongSlot) {
        p.stroke(255, 93, 93, 235);
        p.strokeWeight(4);
      } else if (this.challenge.active && i === this.challenge.hintSlot) {
        p.stroke(105, 240, 174, 240);
        p.strokeWeight(4);
      } else if (this.challenge.active && this.challenge.phase === 'demo' && i === this.challenge.demoStep) {
        p.stroke(129, 212, 250, 245);
        p.strokeWeight(4);
      } else {
        p.stroke(255, 255, 255, 190);
        p.strokeWeight(2);
      }
      p.drawingContext.setLineDash([5, 6]);
      p.circle(0, 0, r * 2);
      p.drawingContext.setLineDash([]);

      if (this.challenge.active && this.challenge.phase === 'demo' && i <= this.challenge.demoStep) {
        p.noStroke();
        p.fill(129, 212, 250, 170);
        p.circle(0, 0, r * 0.32);
      }
      if (
        this.challenge.active &&
        (this.challenge.phase === 'levelComplete' || this.challenge.phase === 'finished')
      ) {
        p.noStroke();
        p.fill(105, 240, 174, 210);
        p.textSize(r * 0.9);
        p.text('✓', 0, 2);
      }
      p.pop();

      const frag = this.slots[i];
      if (frag) {
        const slotAlpha = this.challenge.active && i === this.challenge.wrongSlot ? 0.82 : 1;
        frag.draw(p, s.x, s.y, 0, pulse * ((r * 1.9) / frag.w), slotAlpha);
      }
    }
  }

  private drawChallengeHintGlow(t: number): void {
    if (this.challenge.phase !== 'answer' || this.challenge.hintSlot < 0) return;
    const toneIndex = this.challengeTones()[this.challenge.hintSlot];
    const frag = this.fragments.find(
      (f) =>
        f.spec.kind === 'tone' &&
        f.spec.toneIndex === toneIndex &&
        f.slotIndex !== this.challenge.hintSlot
    );
    if (!frag) return;
    const p = this.p;
    const b = frag.body.bounds;
    const pad = 5 + 3 * Math.sin(t * 0.012);
    p.push();
    p.noFill();
    p.stroke(105, 240, 174, 210);
    p.strokeWeight(4);
    p.drawingContext.setLineDash([8, 6]);
    p.rectMode(p.CORNERS);
    p.rect(b.min.x - 8 - pad, b.min.y - 8 - pad, b.max.x + 8 + pad, b.max.y + 8 + pad);
    p.drawingContext.setLineDash([]);
    p.pop();
  }

  private resized(): void {
    this.p.resizeCanvas(this.p.windowWidth, this.p.windowHeight);
    this.notes.resize(this.p.width, this.p.height);
  }
}
