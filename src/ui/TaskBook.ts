import type { WeatherKind } from '../audio/AudioEngine';
import { TASKS } from '../tasks/tasks';
import type { TaskAction, TaskState, TaskStepDef } from '../tasks/tasks';

export interface TaskBookCallbacks {
  onAction: (action: TaskAction) => void;
  onToggleManual: (key: string) => void;
  onReset: () => void;
  onClose: () => void;
  /** 「边玩边看」：把某个任务收起为紧凑提示条 */
  onPin: (taskId: string) => void;
  /** 紧凑条上的「展开」：回到任务册并展开被收起的任务 */
  onExpand: () => void;
  /** 紧凑条上的「✕」：彻底收起（取消边玩边看） */
  onUnpin: () => void;
}

export class TaskBook {
  private root: HTMLElement;
  private list: HTMLElement;
  private progressEl: HTMLElement;
  private allDoneEl: HTMLElement;
  private resetBtn: HTMLButtonElement;
  private expanded: string | null = TASKS[0].id;
  /** 边玩边看收起的任务 id；非空时紧凑提示条显示在河面上 */
  private pinnedId: string | null = null;
  private resetArmed = false;
  private resetTimer: number | null = null;

  // 紧凑提示条
  private bar: HTMLElement;
  private barMain: HTMLButtonElement;
  private barIcon: HTMLElement;
  private barTitle: HTMLElement;
  private barStep: HTMLElement;
  private barProgress: HTMLElement;
  private barStamp: HTMLButtonElement;
  private barAction: HTMLButtonElement;

  constructor(private cb: TaskBookCallbacks) {
    const el = <T extends HTMLElement>(id: string): T => {
      const node = document.getElementById(id);
      if (!node) throw new Error(`#${id} missing`);
      return node as T;
    };
    this.root = el('taskBook');
    this.list = el('taskBookList');
    this.progressEl = el('taskBookProgress');
    this.allDoneEl = el('taskBookAllDone');

    el<HTMLButtonElement>('taskBookClose').addEventListener('click', () => this.cb.onClose());
    this.resetBtn = el<HTMLButtonElement>('taskBookReset');
    this.resetBtn.addEventListener('click', () => {
      if (!this.resetArmed) {
        this.resetArmed = true;
        this.resetBtn.textContent = '再点一次确认清空';
        this.resetBtn.classList.add('confirm');
        this.resetTimer = window.setTimeout(() => this.disarmReset(), 3000);
        return;
      }
      this.disarmReset();
      this.cb.onReset();
    });
    this.root.addEventListener('click', (e) => {
      // 点手册外的暗背景收起（家长腾出手调河里的东西）
      if (e.target === this.root) this.cb.onClose();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || this.root.classList.contains('hidden')) return;
      // 命名框（z-index 更高）打开时，Esc 只归命名框处理，避免一次按键连关两层
      const songDialog = document.getElementById('songDialog');
      if (songDialog && !songDialog.classList.contains('hidden')) return;
      this.cb.onClose();
    });

    this.bar = el('taskBar');
    this.barMain = el('taskBarMain');
    this.barIcon = el('taskBarIcon');
    this.barTitle = el('taskBarTitle');
    this.barStep = el('taskBarStep');
    this.barProgress = el('taskBarProgress');
    this.barStamp = el('taskBarStamp');
    this.barAction = el('taskBarAction');
    // 点提示条主体（图标/标题/指引区域）等同于展开，方便家长一键回到手册
    this.barMain.addEventListener('click', () => this.cb.onExpand());
    el<HTMLButtonElement>('taskBarExpand').addEventListener('click', () => this.cb.onExpand());
    el<HTMLButtonElement>('taskBarClose').addEventListener('click', () => this.cb.onUnpin());
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  /** 边玩边看提示条是否正在河面上显示 */
  get pinned(): boolean {
    return this.pinnedId !== null;
  }

  show(states: TaskState[]): void {
    this.root.classList.remove('hidden');
    // 手册打开时河面提示条绝不并列显示（暗背景已盖住，这里顺手隐藏避免动画穿透）
    this.bar.classList.add('hidden');
    // 打开时若当前展开的任务已全部完成，自动展开下一个未完成的任务
    const current = states.find((t) => t.id === this.expanded);
    if (!current || current.done) {
      this.expanded = states.find((t) => !t.done)?.id ?? TASKS[0].id;
    }
    this.render(states);
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  render(states: TaskState[]): void {
    const doneCount = states.filter((t) => t.done).length;
    const totalSteps = TASKS.reduce((n, t) => n + t.steps.length, 0);
    const doneSteps = states.reduce(
      (n, t) => n + t.steps.filter((s) => s.done).length,
      0
    );
    this.progressEl.textContent = `已完成 ${doneCount}/${TASKS.length} 个任务 · ${doneSteps}/${totalSteps} 个小印章`;
    this.allDoneEl.hidden = doneCount !== TASKS.length;

    this.list.replaceChildren(...TASKS.map((def) => this.renderTask(def, states)));

    // 手册打开时不渲染河面提示条（show 时已隐藏），同一指引不出现两遍
    if (!this.visible) this.renderBar(states);
  }

  /** 收起某个任务为紧凑提示条（「边玩边看」） */
  pinTask(taskId: string, states: TaskState[]): void {
    this.pinnedId = taskId;
    this.expanded = taskId;
    this.hide();
    this.renderBar(states);
  }

  /**
   * 收起的任务完成后，自动带家长去下一个未完成任务；
   * 全部完成时取消边玩边看。返回是否仍在边玩边看。
   * 只改 pinnedId，不直接操作 DOM，渲染统一由 render/renderBar 负责。
   */
  advancePinned(states: TaskState[]): boolean {
    if (this.pinnedId === null) return false;
    const current = states.find((t) => t.id === this.pinnedId);
    if (current && !current.done) return true;
    const next = states.find((t) => !t.done);
    if (next) {
      this.pinnedId = next.id;
      this.expanded = next.id;
      return true;
    }
    this.pinnedId = null;
    return false;
  }

  /** 取消边玩边看，提示条消失 */
  unpin(): void {
    this.pinnedId = null;
    this.bar.classList.add('hidden');
  }

  /**
   * 紧凑条上的「展开」：打开手册并展开收起中的任务。
   * 展开即退出边玩边看模式——清空固定标识，否则关闭手册后提示条会自己弹回来、
   * 卡片按钮也会残留「正在边玩边看」的状态；需要时再点一次卡片里的入口即可。
   */
  expandFromBar(states: TaskState[]): void {
    if (this.pinnedId !== null) {
      this.expanded = this.pinnedId;
      this.pinnedId = null;
    }
    this.show(states);
  }

  private renderBar(states: TaskState[]): void {
    if (this.pinnedId === null) {
      this.bar.classList.add('hidden');
      return;
    }
    const def = TASKS.find((t) => t.id === this.pinnedId);
    const state = states.find((t) => t.id === this.pinnedId);
    // 任务定义或状态异常（理论上不会发生）时退化为直接收起
    if (!def || !state) {
      this.unpin();
      return;
    }

    const doneSteps = state.steps.filter((s) => s.done).length;
    this.barIcon.textContent = state.done ? '⭐' : def.icon;
    this.barTitle.textContent = def.title;
    this.barProgress.textContent = `${doneSteps}/${def.steps.length}`;
    this.barMain.setAttribute(
      'aria-label',
      `${def.title}，${doneSteps}/${def.steps.length} 步，点这里展开任务册`
    );
    this.barMain.setAttribute('aria-expanded', 'false');

    // 盖章小圆圈 + 快捷动作：只服务“当前第一个未完成步骤”
    const firstOpenIdx = state.steps.findIndex((s) => !s.done);
    const stepDef: TaskStepDef | undefined =
      firstOpenIdx >= 0 ? def.steps[firstOpenIdx] : undefined;
    const stepState = firstOpenIdx >= 0 ? state.steps[firstOpenIdx] : undefined;

    if (state.done || !stepDef || !stepState) {
      this.barStep.textContent = '全部完成，点我展开看看下一个任务 →';
      this.barStamp.hidden = true;
      this.barAction.hidden = true;
    } else {
      const tagText = stepState.locked ? '自动' : '盖章';
      this.barStep.textContent = `下一步（${tagText}）：${stepDef.text}`;
      // 手动（未锁定）步骤：提示条上直接盖章，家长不用展开手册
      const manual = !stepState.locked;
      this.barStamp.hidden = !manual;
      if (manual) {
        this.barStamp.textContent = '✓';
        this.barStamp.title = '聊完后点这里盖章';
        this.barStamp.setAttribute('aria-label', `给「${stepDef.text}」盖章`);
        this.barStamp.onclick = () => this.cb.onToggleManual(`${def.id}:${stepDef.id}`);
      }
      if (stepDef.action) {
        const action = stepDef.action;
        this.barAction.hidden = false;
        this.barAction.textContent = action.label;
        this.barAction.onclick = () => this.cb.onAction(action);
      } else {
        this.barAction.hidden = true;
      }
    }

    this.bar.classList.remove('hidden');
  }

  private renderTask(
    def: (typeof TASKS)[number],
    states: TaskState[]
  ): HTMLElement {
    const state = states.find((t) => t.id === def.id);
    const done = !!state?.done;
    const open = this.expanded === def.id;
    const pinned = this.pinnedId === def.id;

    const card = document.createElement('section');
    card.className = 'tb-card' + (done ? ' done' : '') + (open ? ' open' : '');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'tb-head';
    head.setAttribute('aria-expanded', String(open));
    const headTop = document.createElement('span');
    headTop.className = 'tb-head-main';
    const icon = document.createElement('span');
    icon.className = 'tb-icon';
    icon.textContent = done ? '⭐' : def.icon;
    icon.setAttribute('aria-hidden', 'true');
    const titles = document.createElement('span');
    titles.className = 'tb-titles';
    const title = document.createElement('span');
    title.className = 'tb-title';
    title.textContent = def.title;
    const goal = document.createElement('span');
    goal.className = 'tb-goal';
    goal.textContent = def.goal;
    titles.append(title, goal);
    const stepDots = document.createElement('span');
    stepDots.className = 'tb-dots';
    stepDots.setAttribute('aria-label', `完成 ${state?.steps.filter((s) => s.done).length ?? 0}/${def.steps.length} 步`);
    def.steps.forEach((step) => {
      const dot = document.createElement('span');
      dot.className = 'tb-dot' + (state?.steps.find((s) => s.id === step.id)?.done ? ' on' : '');
      stepDots.append(dot);
    });
    headTop.append(icon, titles, stepDots);
    head.append(headTop);
    head.addEventListener('click', () => {
      this.expanded = open ? null : def.id;
      this.list.replaceChildren(...TASKS.map((d) => this.renderTask(d, states)));
    });

    card.append(head);

    if (open) {
      const body = document.createElement('div');
      body.className = 'tb-body';
      def.steps.forEach((step, i) => {
        const stepState = state?.steps[i];
        const stepDone = !!stepState?.done;
        // 被探索事实锁定的章（自动步，或事实达成的可跳过步）不能手动取消
        const locked = !!stepState?.locked;
        const row = document.createElement('div');
        row.className = 'tb-step' + (stepDone ? ' done' : '');

        const stamp = document.createElement('button');
        stamp.type = 'button';
        stamp.className = 'tb-stamp' + (locked && stepDone ? ' locked' : '');
        stamp.setAttribute('aria-pressed', String(stepDone));
        if (locked) {
          stamp.disabled = true;
          stamp.setAttribute('aria-label', `第 ${i + 1} 步已自动完成`);
          stamp.title = '已由探索完成，自动盖章';
        } else {
          stamp.setAttribute(
            'aria-label',
            stepDone ? `取消第 ${i + 1} 步的印章` : `给第 ${i + 1} 步盖章`
          );
          stamp.title = '聊完后点这里盖章（再点可取消）';
          stamp.addEventListener('click', () => this.cb.onToggleManual(`${def.id}:${step.id}`));
        }
        stamp.textContent = stepDone ? '✓' : String(i + 1);

        const texts = document.createElement('div');
        texts.className = 'tb-step-text';
        const main = document.createElement('p');
        main.className = 'tb-step-main';
        const tag = document.createElement('span');
        // 事实达成的可跳过步也呈现为「自动」，让家长一眼明白这个章不能取消
        tag.className = 'tb-tag ' + (locked ? 'auto' : step.kind);
        tag.textContent = locked ? '自动' : '盖章';
        main.append(tag, document.createTextNode(step.text));
        texts.append(main);
        if (step.hint) {
          const hint = document.createElement('p');
          hint.className = 'tb-hint';
          hint.textContent = `💬 家长提示：${step.hint}`;
          texts.append(hint);
        }
        if (step.action && !stepDone) {
          const actBtn = document.createElement('button');
          actBtn.type = 'button';
          actBtn.className = 'tb-action';
          actBtn.textContent = step.action.label;
          actBtn.addEventListener('click', () => {
            this.cb.onAction(step.action!);
            // 天气/水位等切换立即生效，但判定事实要等下一次刷新
          });
          texts.append(actBtn);
        }
        row.append(stamp, texts);
        body.append(row);
      });

      // 边玩边看入口：把这个任务收成河面上的紧凑提示条，孩子操作时指引不离开视线
      if (!done) {
        const pinBtn = document.createElement('button');
        pinBtn.type = 'button';
        pinBtn.className = 'tb-pin' + (pinned ? ' pinned' : '');
        pinBtn.textContent = pinned ? '📌 正在边玩边看（点提示条可展开）' : '👀 边玩边看（收成小提示条）';
        pinBtn.title = '任务册收起，河面上保留一条当前步骤小提示';
        pinBtn.addEventListener('click', () => this.cb.onPin(def.id));
        body.append(pinBtn);
      } else {
        // 已完成的任务若仍处于边玩边看，提示家长提示条会指向下一个任务
        const doneNote = document.createElement('p');
        doneNote.className = 'tb-pin-note';
        doneNote.textContent = pinned
          ? '⭐ 这个任务已盖满章，河面上的小提示条会带你去下一个任务。'
          : '⭐ 这个任务已经盖满章啦。';
        body.append(doneNote);
      }

      card.append(body);
    }

    return card;
  }

  private disarmReset(): void {
    this.resetArmed = false;
    this.resetBtn.classList.remove('confirm');
    this.resetBtn.textContent = '🧽 清空任务册（重新开始）';
    if (this.resetTimer !== null) {
      window.clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }
}

/** 把任务册动作翻译成人话的操作提示（供 Game 弹 toast） */
export function describeAction(action: TaskAction): string {
  switch (action.kind) {
    case 'weather': {
      const name: Record<WeatherKind, string> = { sunny: '晴天 ☀️', rain: '雨天 🌧️', wind: '风天 💨' };
      return `已切到${name[action.weather ?? 'sunny']}，和孩子一起听 10 秒吧`;
    }
    case 'setLevel':
      return '水位调高啦，去河里找发光的 ♪ 吧 💧';
    case 'setFlow':
      return '水流变快啦，听听歌是不是也跑起来了 🌊';
    case 'mic':
      return '准备录音：点一下「🎙️ 录一段声音」开始（再点停止）';
    case 'save':
      return '打开了家长面板：给歌起个名字，点「💾 保存这首歌」';
  }
}
