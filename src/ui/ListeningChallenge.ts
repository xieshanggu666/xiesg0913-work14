export interface ListeningChallengeCallbacks {
  onReplay: () => void;
  onHint: () => void;
  onSubmit: () => void;
  onExit: () => void;
  onNext: () => void;
}

export type ChallengePhase = 'demo' | 'answer' | 'levelComplete' | 'finished';

const LEVEL_LENGTHS = [3, 4, 5];

/** 听音挑战的 HTML 控制条与三关固定状态 */
export class ListeningChallenge {
  readonly levels = LEVEL_LENGTHS.length;
  level = 0;
  phase: ChallengePhase = 'demo';
  demoStep = -1;
  wrongSlot = -1;
  hintSlot = -1;

  private bar: HTMLElement;
  private status: HTMLElement;
  private replayBtn: HTMLButtonElement;
  private hintBtn: HTMLButtonElement;
  private submitBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private exitBtn: HTMLButtonElement;

  constructor(private cb: ListeningChallengeCallbacks) {
    const el = <T extends HTMLElement>(id: string): T => {
      const node = document.getElementById(id);
      if (!node) throw new Error(`#${id} missing`);
      return node as T;
    };

    this.bar = el('challengeBar');
    this.status = el('challengeStatus');
    this.replayBtn = el('challengeReplay');
    this.hintBtn = el('challengeHint');
    this.submitBtn = el('challengeSubmit');
    this.nextBtn = el('challengeNext');
    this.exitBtn = el('challengeExit');

    this.replayBtn.addEventListener('click', () => this.cb.onReplay());
    this.hintBtn.addEventListener('click', () => this.cb.onHint());
    this.submitBtn.addEventListener('click', () => this.cb.onSubmit());
    this.nextBtn.addEventListener('click', () => this.cb.onNext());
    this.exitBtn.addEventListener('click', () => this.cb.onExit());
  }

  get levelLength(): number {
    return LEVEL_LENGTHS[this.level] ?? LEVEL_LENGTHS[0];
  }

  get active(): boolean {
    return !this.bar.classList.contains('hidden');
  }

  show(level = 0): void {
    this.level = level;
    this.phase = 'demo';
    this.wrongSlot = -1;
    this.hintSlot = -1;
    this.demoStep = -1;
    this.bar.classList.remove('hidden');
    this.sync();
  }

  hide(): void {
    this.bar.classList.add('hidden');
    this.phase = 'answer';
    this.demoStep = -1;
    this.wrongSlot = -1;
    this.hintSlot = -1;
  }

  startLevel(level: number): void {
    this.level = level;
    this.phase = 'demo';
    this.demoStep = -1;
    this.wrongSlot = -1;
    this.hintSlot = -1;
    this.sync();
  }

  beginDemo(): void {
    this.phase = 'demo';
    this.demoStep = -1;
    this.wrongSlot = -1;
    this.hintSlot = -1;
    this.sync();
  }

  setDemoStep(step: number): void {
    this.demoStep = step;
  }

  beginAnswer(): void {
    if (this.phase !== 'demo') return;
    this.phase = 'answer';
    this.demoStep = -1;
    this.sync();
  }

  answerChanged(): void {
    if (this.phase !== 'answer') return;
    this.wrongSlot = -1;
    this.hintSlot = -1;
    this.sync();
  }

  showWrong(slot: number, message: string): void {
    this.phase = 'answer';
    this.wrongSlot = slot;
    this.hintSlot = -1;
    this.demoStep = -1;
    this.status.textContent = message;
    this.status.classList.remove('good');
    this.status.classList.add('bad');
    this.syncButtons();
  }

  showHint(slot: number, label: string): void {
    if (this.phase !== 'answer') return;
    this.hintSlot = slot;
    this.wrongSlot = -1;
    this.status.textContent = `💡 第 ${slot + 1} 个圆圈放「${label}」`;
    this.status.classList.add('good');
    this.syncButtons();
  }

  levelComplete(last: boolean): void {
    this.phase = last ? 'finished' : 'levelComplete';
    this.demoStep = -1;
    this.wrongSlot = -1;
    this.hintSlot = -1;
    this.status.textContent = last ? '🏆 三关全部完成，真会听！' : `🎉 第 ${this.level + 1} 关完成！`;
    this.status.classList.add('good');
    this.syncButtons();
  }

  private sync(): void {
    this.syncStatusClass();
    this.syncButtons();
  }

  private syncStatusClass(): void {
    if (this.phase === 'demo') {
      this.status.textContent = `🎧 第 ${this.level + 1}/${this.levels} 关 · ${this.levelLength} 个音，请认真听`;
    } else if (this.phase === 'answer') {
      this.status.textContent = `🎧 第 ${this.level + 1}/${this.levels} 关 · 按听到的顺序放 ${this.levelLength} 块碎片`;
    }
    this.status.classList.toggle(
      'good',
      this.phase === 'levelComplete' || this.phase === 'finished'
    );
    this.status.classList.remove('bad');
  }

  private syncButtons(): void {
    const demo = this.phase === 'demo';
    const answering = this.phase === 'answer';
    const complete = this.phase === 'levelComplete';
    const finished = this.phase === 'finished';

    this.replayBtn.hidden = complete || finished;
    this.hintBtn.hidden = !answering;
    this.submitBtn.hidden = !answering;
    this.nextBtn.hidden = !complete && !finished;
    this.nextBtn.textContent = finished ? '🔁 再从第一关开始' : '➡️ 下一关';

    this.replayBtn.disabled = demo;
    this.hintBtn.disabled = demo;
    this.submitBtn.disabled = demo;
    this.exitBtn.disabled = false;
    this.status.setAttribute('aria-live', 'polite');
  }
}
