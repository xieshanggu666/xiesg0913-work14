import type { WeatherKind } from '../audio/AudioEngine';

/**
 * 声音探索任务册：把音符碎片、录音碎片、天气环境声与水位探索
 * 组织成 5 个适合亲子共读的引导式创作任务。
 *
 * 进度分两类：
 * - facts：装置可自动感知的“探索事实”（听过哪种天气、收集过几个音符…），只增不减，跨会话持久化
 * - manual：需要家长陪伴确认的讨论/表达步骤（checkbox），可勾选也可取消
 */

export interface TaskFacts {
  /** 切换（或待机轮换）到过的天气 */
  weathersSeen: WeatherKind[];
  /** 水位曾被调到 75cm 以上 */
  highWater: boolean;
  /** 水流曾被调到 0.7 以上 */
  flowFast: boolean;
  /** 曾把一块内置音符拖进圆圈（挑战模式除外） */
  tonePlaced: boolean;
  /** 圆圈历史上最多同时放了几块碎片 */
  maxSlotsFilled: number;
  /** 曾把孩子的录音碎片放进过圆圈 */
  voiceInSlotEver: boolean;
  /** 累计收集过的水下音符数（6 封顶，集齐一轮即满分） */
  notesCollectedEver: number;
  /** 成功录成过几段声音碎片 */
  micRecordings: number;
  /** 曾成功保存过一首作品集歌曲 */
  songSaved: boolean;
}

/** 无法持久化、只反映当前画面的状态 */
export interface TaskLive {
  slotsFilled: number;
}

export interface TaskSnap {
  facts: TaskFacts;
  manual: Record<string, boolean>;
  live: TaskLive;
}

export interface TaskAction {
  kind: 'weather' | 'setLevel' | 'setFlow' | 'mic' | 'save';
  weather?: WeatherKind;
  value?: number;
  label: string;
}

export interface TaskStepDef {
  id: string;
  /** 给孩子看的引导语 */
  text: string;
  /** 给家长的陪伴提示 */
  hint?: string;
  /** auto：装置自动判定；manual：家长和孩子聊完后手动盖章 */
  kind: 'auto' | 'manual';
  done: (snap: TaskSnap) => boolean;
  /**
   * 仅用于「可跳过的引导步」：手动步骤若另有事实达成条件（如录音已进过圆圈），
   * 事实达成时按自动章锁定、不可取消；事实未达成时仍可手动盖「跳过章」。
   * 返回 true 表示当前是被事实锁定的状态。
   */
  locked?: (snap: TaskSnap) => boolean;
  /** 未完成时展示的快捷操作（调天气/水位/录音/保存） */
  action?: TaskAction;
}

export interface TaskDef {
  id: string;
  icon: string;
  title: string;
  goal: string;
  steps: TaskStepDef[];
}

export interface StepState {
  id: string;
  done: boolean;
  /** true：由探索事实锁定的自动章，印章不可点；false/undefined：手动盖的章，可取消 */
  locked: boolean;
}

export interface TaskState {
  id: string;
  done: boolean;
  steps: StepState[];
}

export const TASK_COUNT = 5;
const NOTES_GOAL = 6;

export function defaultFacts(): TaskFacts {
  return {
    weathersSeen: [],
    highWater: false,
    flowFast: false,
    tonePlaced: false,
    maxSlotsFilled: 0,
    voiceInSlotEver: false,
    notesCollectedEver: 0,
    micRecordings: 0,
    songSaved: false,
  };
}

export const TASKS: readonly TaskDef[] = [
  {
    id: 'weather-ears',
    icon: '🌦️',
    title: '天气小耳朵',
    goal: '听一听三种天气里的河流，说说声音哪里不一样。',
    steps: [
      {
        id: 'sun',
        kind: 'auto',
        text: '切到 ☀️ 晴天，和孩子安静听 10 秒波光里的水声',
        hint: '家长先别说话，让孩子用小手指一指：声音是从河的哪里来的？',
        done: (s) => s.facts.weathersSeen.includes('sunny'),
        action: { kind: 'weather', weather: 'sunny', label: '切到晴天' },
      },
      {
        id: 'rain',
        kind: 'auto',
        text: '切到 🌧️ 雨天，一起数数雨滴掉进河里的「叮咚」声',
        hint: '可以让孩子猜：雨是落在河面上，还是藏在河底？',
        done: (s) => s.facts.weathersSeen.includes('rain'),
        action: { kind: 'weather', weather: 'rain', label: '切到雨天' },
      },
      {
        id: 'wind',
        kind: 'auto',
        text: '切到 💨 风天，看看阵风怎样推着碎片往前跑',
        hint: '问孩子：风来的时候，碎片是快跑还是慢跑？声音也变急了吗？',
        done: (s) => s.facts.weathersSeen.includes('wind'),
        action: { kind: 'weather', weather: 'wind', label: '切到风天' },
      },
      {
        id: 'talk',
        kind: 'manual',
        text: '轮流说一说：三种天气里，你最喜欢哪一种声音？为什么？',
        hint: '没有标准答案，「雨是滴答滴答的」就是最好的回答。',
        done: (s) => !!s.manual['weather-ears:talk'],
      },
    ],
  },
  {
    id: 'tone-friends',
    icon: '🎵',
    title: '音符碰碰乐',
    goal: '把河里漂着的音符拖进圆圈，拼出第一条会循环的小河旋律。',
    steps: [
      {
        id: 'place-one',
        kind: 'auto',
        text: '从河里拖 1 块音符碎片，放进最前面的圆圈',
        hint: '孩子若抓不稳，家长可以扶着小手一起拖；松手听见「叮」就是放好啦。',
        done: (s) => s.facts.tonePlaced,
      },
      {
        id: 'place-three',
        kind: 'auto',
        text: '再拖 2 块不一样的音符，让 3 个圆圈一起唱歌',
        hint: '停下来一起听：多了一块碎片，循环有什么变化？',
        done: (s) => s.facts.maxSlotsFilled >= 3,
      },
      {
        id: 'fast-flow',
        kind: 'auto',
        text: '把水流调快，听听歌是不是也跟着跑起来了？',
        hint: '让孩子一边拖「水流速度」滑杆，一边盯住碎片漂的速度。',
        done: (s) => s.facts.flowFast,
        action: { kind: 'setFlow', value: 0.85, label: '帮我调快水流' },
      },
      {
        id: 'favorite',
        kind: 'manual',
        text: '选出孩子最喜欢的一块碎片，问问它像什么声音',
        hint: '像小鸟？像门铃？鼓励孩子给这块碎片取个小名。',
        done: (s) => !!s.manual['tone-friends:favorite'],
      },
    ],
  },
  {
    id: 'underwater-notes',
    icon: '💧',
    title: '潜水找音符',
    goal: '调高水位，寻找被淹没后发光冒泡的 ♪。',
    steps: [
      {
        id: 'raise-water',
        kind: 'auto',
        text: '请家长把「水位高低」调到 75cm 以上',
        hint: '水位升高后，河床上的音符会发光冒泡——孩子马上就能发现。',
        done: (s) => s.facts.highWater,
        action: { kind: 'setLevel', value: 0.85, label: '帮我调高水位' },
      },
      {
        id: 'find-one',
        kind: 'auto',
        text: '点一碰一个发光的水下音符，把它收集起来',
        hint: '左上角会显示收集进度；不同音符藏在不同水深，调调水位找找看。',
        done: (s) => s.facts.notesCollectedEver >= 1,
      },
      {
        id: 'find-six',
        kind: 'auto',
        text: '集齐 6 个水下音符，听河神唱的庆祝音阶',
        hint: '集齐后会自动刷新一轮，新音符又藏起来啦。',
        done: (s) => s.facts.notesCollectedEver >= NOTES_GOAL,
      },
      {
        id: 'where-hide',
        kind: 'manual',
        text: '问问孩子：水位低的时候，音符为什么不发光了？',
        hint: '让孩子自己说「因为音符没有被水淹没」，比直接告诉答案更好。',
        done: (s) => !!s.manual['underwater-notes:where-hide'],
      },
    ],
  },
  {
    id: 'voice-fish',
    icon: '🎙️',
    title: '我的声音游进河',
    goal: '录下孩子的声音，让它变成一块橙色碎片游进河里。',
    steps: [
      {
        id: 'record-one',
        kind: 'auto',
        text: '点「录一段声音」，对麦克风唱一句或学一声小动物（4 秒）',
        hint: '首次录音需要允许麦克风权限；录完橙色碎片会自己游进河里。',
        done: (s) => s.facts.micRecordings >= 1,
        action: { kind: 'mic', label: '开始录音' },
      },
      {
        id: 'record-two',
        kind: 'auto',
        text: '再录一段不一样的声音：拍手、跺脚、或哈哈大笑',
        hint: '对比两块橙色碎片上的波形：不一样的声音，长得也不一样。',
        done: (s) => s.facts.micRecordings >= 2,
        action: { kind: 'mic', label: '再录一段' },
      },
      {
        id: 'voice-in-song',
        kind: 'auto',
        text: '把橙色录音碎片拖进圆圈，听听自己的声音在歌里循环',
        hint: '自己的声音和音符混在一起，是这台装置最特别的一刻。',
        done: (s) => s.facts.voiceInSlotEver,
      },
      {
        id: 'what-fish',
        kind: 'manual',
        text: '一起猜一猜：这段声音游起来，像一条什么鱼？',
        hint: '孩子说「像咕嘟咕嘟的泡泡鱼」时，记得认真点头：就是它！',
        done: (s) => !!s.manual['voice-fish:what-fish'],
      },
    ],
  },
  {
    id: 'river-song',
    icon: '🏆',
    title: '我们的河流之歌',
    goal: '把音符和录音编成一首完整作品，起名字、保存、鼓掌。',
    steps: [
      {
        id: 'fill-four',
        kind: 'auto',
        text: '在至少 4 个圆圈里放进碎片，拼一首完整的歌',
        hint: '空格也是创作：留一个空圆圈，歌里就有了一次「呼吸」。',
        done: (s) => s.facts.maxSlotsFilled >= 4,
      },
      {
        id: 'add-voice',
        kind: 'manual',
        text: '试着把一块橙色录音碎片也放进歌里；没有录音也没关系，可以先盖章跳过',
        hint: '这一步不强制：每个家庭的河流之歌，都允许不一样。放进录音后会变成自动章，盖过的「跳过章」不能取消也无需取消。',
        done: (s) => !!s.manual['river-song:add-voice'] || s.facts.voiceInSlotEver,
        locked: (s) => s.facts.voiceInSlotEver,
      },
      {
        id: 'name-it',
        kind: 'manual',
        text: '给这首歌起一个名字，再一起完整听一遍',
        hint: '名字由孩子定：「下雨的早上」「爸爸打呼噜」都很好。',
        done: (s) => !!s.manual['river-song:name-it'],
      },
      {
        id: 'save-it',
        kind: 'auto',
        text: '点「💾 保存这首歌」，把它收进作品集',
        hint: '保存后随时能重新打开，也可以导出备份发到另一台设备。',
        done: (s) => s.facts.songSaved,
        action: { kind: 'save', label: '去保存这首歌' },
      },
    ],
  },
];

export function evaluateTasks(snap: TaskSnap): TaskState[] {
  return TASKS.map((def) => {
    const steps = def.steps.map((step) => {
      // 纯自动步一律锁定；手动步只有在事实达成（locked 谓词）时才锁定
      const locked = step.kind === 'auto' || !!step.locked?.(snap);
      return { id: step.id, done: step.done(snap), locked };
    });
    return { id: def.id, done: steps.every((s) => s.done), steps };
  });
}

// ---------- 本地持久化 ----------

const STORE_KEY = 'river-taskbook-v1';

interface StoredProgress {
  version: 1;
  facts: Partial<TaskFacts>;
  manual: Record<string, boolean>;
}

/** 任务册进度：自动事实 + 手动盖章，写入 localStorage，无后端 */
export class TaskProgress {
  facts: TaskFacts = defaultFacts();
  manual: Record<string, boolean> = {};

  constructor() {
    this.load();
  }

  snapshot(live: TaskLive): TaskSnap {
    return { facts: this.facts, manual: this.manual, live };
  }

  /** 只增地合并新的探索事实：数组取并集、数字取大、布尔为或 */
  record(patch: Partial<TaskFacts>): void {
    const f = this.facts;
    if (patch.weathersSeen) {
      for (const w of patch.weathersSeen) if (!f.weathersSeen.includes(w)) f.weathersSeen.push(w);
    }
    f.highWater = f.highWater || !!patch.highWater;
    f.flowFast = f.flowFast || !!patch.flowFast;
    f.tonePlaced = f.tonePlaced || !!patch.tonePlaced;
    f.voiceInSlotEver = f.voiceInSlotEver || !!patch.voiceInSlotEver;
    f.songSaved = f.songSaved || !!patch.songSaved;
    f.maxSlotsFilled = Math.max(f.maxSlotsFilled, patch.maxSlotsFilled ?? 0);
    f.notesCollectedEver = Math.min(NOTES_GOAL, Math.max(f.notesCollectedEver, patch.notesCollectedEver ?? 0));
    f.micRecordings = Math.max(f.micRecordings, patch.micRecordings ?? 0);
    this.save();
  }

  toggleManual(key: string): boolean {
    this.manual[key] = !this.manual[key];
    this.save();
    return this.manual[key];
  }

  reset(): void {
    this.facts = defaultFacts();
    this.manual = {};
    this.save();
  }

  private save(): void {
    try {
      const doc: StoredProgress = { version: 1, facts: this.facts, manual: this.manual };
      localStorage.setItem(STORE_KEY, JSON.stringify(doc));
    } catch {
      /* 隐私模式/存储被禁用：任务册进度只保留在本次会话 */
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const doc = JSON.parse(raw) as Partial<StoredProgress>;
      if (doc.version !== 1 || typeof doc !== 'object' || doc === null) return;
      const d = defaultFacts();
      const f = (doc.facts ?? {}) as Partial<TaskFacts>;
      if (Array.isArray(f.weathersSeen)) {
        d.weathersSeen = f.weathersSeen.filter(
          (w): w is WeatherKind => w === 'sunny' || w === 'rain' || w === 'wind'
        );
      }
      d.highWater = !!f.highWater;
      d.flowFast = !!f.flowFast;
      d.tonePlaced = !!f.tonePlaced;
      d.voiceInSlotEver = !!f.voiceInSlotEver;
      d.songSaved = !!f.songSaved;
      d.maxSlotsFilled = Math.min(6, Math.max(0, Number(f.maxSlotsFilled) || 0));
      d.notesCollectedEver = Math.min(NOTES_GOAL, Math.max(0, Number(f.notesCollectedEver) || 0));
      d.micRecordings = Math.max(0, Number(f.micRecordings) || 0);
      this.facts = d;
      if (doc.manual && typeof doc.manual === 'object') {
        this.manual = Object.fromEntries(
          Object.entries(doc.manual).filter(([k, v]) => typeof k === 'string' && typeof v === 'boolean')
        );
      }
    } catch {
      /* 损坏的存档直接忽略，从空白任务册开始 */
    }
  }
}
