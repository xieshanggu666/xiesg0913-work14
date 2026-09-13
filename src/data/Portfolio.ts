import type { Timbre, WeatherKind } from '../audio/AudioEngine';

/** 格子数量（与 Game.SLOT_COUNT 对应，存档独立保存以校验） */
export interface SongDoc {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  flow: number; // 流速 0~1
  level: number; // 水位 0~1
  weather: WeatherKind;
  slotCount: number;
  /** 格子顺序：每格放的是哪块碎片，null 表示空格 */
  slots: (string | null)[];
  /** 河里所有碎片（不在格子里的也保存，避免丢失录音） */
  fragments: FragmentDoc[];
  version: 1;
}

export interface FragmentDoc {
  id: string;
  kind: 'tone' | 'voice';
  freq: number;
  timbre: Timbre;
  color: string;
  label: string;
  /** tone 碎片在固定音阶中的序号，重新打开时据此恢复波形；voice 为 -1 */
  toneIndex: number;
  /** 仅 voice：原始录音的 base64（webm/opus 或 mp4），声音波形也从中恢复 */
  audio?: string;
  audioMime?: string;
}

export interface SongSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  weather: WeatherKind;
  voiceCount: number;
}

const STORAGE_KEY = 'river-songs-v1';
const DOC_VERSION = 1 as const;
/**
 * localStorage 常见每源上限约 5MB，留余量给其它数据。
 * 注意单位是 UTF-8 字节，不是字符串的 length（UTF-16 码元数）：
 * 作品名里的中文每字占 3 字节、emoji 占 4 字节，按 length 估算会偏小。
 */
const MAX_TOTAL_BYTES = 4_500_000;

const utf8Encoder = new TextEncoder();

/** 字符串写入 localStorage 后占用的实际字节数（按 UTF-8 编码） */
export function utf8ByteSize(s: string): number {
  return utf8Encoder.encode(s).length;
}

/* ---------- base64：二进制录音 ↔ 字符串（DataURL 拆包，不走 atob 的中文坑） ---------- */

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- 存档读取与校验 ----------
 * localStorage 可能被旧版本、手动编辑、写入中断等污染：顶层不是数组、
 * 条目缺字段、fragments 缺失/不是数组/混入 null、时间戳是字符串等。
 * 必须在读取边界逐条规范化，否则 list() 里 d.fragments.filter(...) 会抛
 * TypeError，而列表在应用启动（p5 setup）时就要渲染，整个装置会白屏崩溃。
 */

const WEATHERS: readonly WeatherKind[] = ['sunny', 'rain', 'wind'];
const TIMBRES: readonly Timbre[] = ['sine', 'triangle', 'square', 'sample'];
const TONE_COUNT = 8; // Game 中固定音阶长度
const MAX_SLOT_COUNT = 64;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asNum = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** 0~1 的滑块值：越界截断，非数字用默认值 */
const asUnit = (v: unknown, fallback: number): number => {
  const n = asNum(v, fallback);
  return n < 0 ? 0 : n > 1 ? 1 : n;
};

/** 时间戳：必须是正数，无法解析时回落到当前时间，保证排序不出 NaN */
const asTimestamp = (v: unknown): number => {
  const n = asNum(v, NaN);
  return n > 0 ? n : Date.now();
};

const normalizeFragment = (raw: unknown): FragmentDoc | null => {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;

  const kind = raw.kind === 'voice' ? 'voice' : raw.kind === 'tone' ? 'tone' : null;
  if (!kind) return null;

  const toneIndex = asNum(raw.toneIndex, -1);
  // 内置音符若音阶序号越界则丢弃（恢复时会按音阶表自动补齐）
  if (kind === 'tone' && (toneIndex < 0 || toneIndex >= TONE_COUNT)) return null;
  // 录音碎片若音频载荷不是非空字符串，没有任何可恢复内容，丢弃
  if (kind === 'voice' && !(typeof raw.audio === 'string' && raw.audio.length > 0)) return null;

  const timbreRaw = raw.timbre;
  const timbre: Timbre = TIMBRES.includes(timbreRaw as Timbre)
    ? (timbreRaw as Timbre)
    : kind === 'voice'
      ? 'sample'
      : 'sine';

  return {
    id: raw.id,
    kind,
    freq: asNum(raw.freq, 261.63),
    timbre,
    color: typeof raw.color === 'string' ? raw.color : '',
    label: typeof raw.label === 'string' ? raw.label : '',
    toneIndex,
    ...(kind === 'voice'
      ? { audio: raw.audio as string, audioMime: typeof raw.audioMime === 'string' ? raw.audioMime : 'audio/webm' }
      : {}),
  };
};

const normalizeDoc = (raw: unknown): SongDoc | null => {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  if (typeof raw.name !== 'string' || raw.name.trim() === '') return null;

  const fragsRaw = Array.isArray(raw.fragments) ? raw.fragments : [];
  const fragments = fragsRaw.map(normalizeFragment).filter((f): f is FragmentDoc => f !== null);

  const slotsRaw = Array.isArray(raw.slots) ? raw.slots : [];
  const slots: (string | null)[] = slotsRaw.map((s) =>
    typeof s === 'string' && s !== '' ? s : null
  );

  const slotCountRaw = asNum(raw.slotCount, slots.length);
  const slotCount = Math.max(0, Math.min(MAX_SLOT_COUNT, Math.round(slotCountRaw)));
  if (slots.length < slotCount) slots.push(...Array(slotCount - slots.length).fill(null));
  else if (slots.length > slotCount) slots.length = slotCount;

  const weatherRaw = raw.weather;
  const weather: WeatherKind = WEATHERS.includes(weatherRaw as WeatherKind)
    ? (weatherRaw as WeatherKind)
    : 'sunny';

  return {
    id: raw.id,
    name: raw.name,
    createdAt: asTimestamp(raw.createdAt),
    updatedAt: asTimestamp(raw.updatedAt),
    flow: asUnit(raw.flow, 0.4),
    level: asUnit(raw.level, 0.5),
    weather,
    slotCount,
    slots,
    fragments,
    version: 1,
  };
};

/* ---------- 导入备份的严格校验 ----------
 * 与 normalizeDoc 相反：备份文件由 exportSong 机器生成，本就该完整自洽。
 * 字段缺失、类型/取值越界、格子引用悬空都说明它不是（或已损坏的）备份，
 * 必须整体拒绝——若沿用读取本地存档的宽容补缺逻辑，任何只含 id 和 name
 * 的普通 JSON 都会被补成空歌收进作品集。
 * 校验的是「exportSong 确实会写出的不变量」，不禁止多余的未知字段（向前兼容）。
 */

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 0~1 的滑块值（严格版：越界即无效，不截断） */
const isUnitNum = (v: unknown): v is number => isFiniteNum(v) && v >= 0 && v <= 1;

/** 正数时间戳（严格版：不合法即无效，不回落到当前时间） */
const isPositiveTs = (v: unknown): v is number => isFiniteNum(v) && v > 0;

/** bytesToBase64 产出的标准 base64（含结尾 padding），用于发现截断/手改过的录音 */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const strictFragment = (raw: unknown): FragmentDoc | null => {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;

  const kind = raw.kind === 'voice' ? 'voice' : raw.kind === 'tone' ? 'tone' : null;
  if (!kind) return null;

  if (!isFiniteNum(raw.freq) || raw.freq <= 0) return null;
  if (!TIMBRES.includes(raw.timbre as Timbre)) return null;
  if (typeof raw.color !== 'string' || typeof raw.label !== 'string') return null;
  if (typeof raw.toneIndex !== 'number' || !Number.isInteger(raw.toneIndex)) return null;

  if (kind === 'tone') {
    if (raw.toneIndex < 0 || raw.toneIndex >= TONE_COUNT) return null;
    return {
      id: raw.id,
      kind,
      freq: raw.freq,
      timbre: raw.timbre as Timbre,
      color: raw.color,
      label: raw.label,
      toneIndex: raw.toneIndex,
    };
  }

  // voice：录音是备份的核心内容，必须存在且是形态合法的 base64
  if (raw.toneIndex !== -1) return null;
  if (typeof raw.audio !== 'string' || raw.audio.length === 0) return null;
  if (raw.audio.length % 4 !== 0 || !BASE64_RE.test(raw.audio)) return null;
  if (typeof raw.audioMime !== 'string' || raw.audioMime === '') return null;
  return {
    id: raw.id,
    kind,
    freq: raw.freq,
    timbre: raw.timbre as Timbre,
    color: raw.color,
    label: raw.label,
    toneIndex: -1,
    audio: raw.audio,
    audioMime: raw.audioMime,
  };
};

/** 严格解析备份文件：任何一项不满足都返回 null，由调用方统一报错 */
const parseBackupDoc = (raw: unknown): SongDoc | null => {
  if (!isRecord(raw)) return null;
  // 版本标识是备份文件的格式声明；不是本应用写出的 version: 1 一律不认
  if (raw.version !== DOC_VERSION) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  if (typeof raw.name !== 'string' || raw.name.trim() === '') return null;
  if (!isPositiveTs(raw.createdAt) || !isPositiveTs(raw.updatedAt)) return null;
  if (!isUnitNum(raw.flow) || !isUnitNum(raw.level)) return null;
  if (!WEATHERS.includes(raw.weather as WeatherKind)) return null;
  if (
    typeof raw.slotCount !== 'number' ||
    !Number.isInteger(raw.slotCount) ||
    raw.slotCount < 1 ||
    raw.slotCount > MAX_SLOT_COUNT
  ) {
    return null;
  }
  // 格子编排是歌曲数据本体：必须存在、长度与 slotCount 一致、每项是空格或碎片 id
  if (!Array.isArray(raw.slots) || raw.slots.length !== raw.slotCount) return null;
  if (!raw.slots.every((s) => s === null || (typeof s === 'string' && s !== ''))) return null;
  // 碎片列表必须非空（河里始终有 8 块内置音符，真备份不可能为空）且逐块严格有效
  if (!Array.isArray(raw.fragments) || raw.fragments.length === 0) return null;

  const fragments: FragmentDoc[] = [];
  const fragIds = new Set<string>();
  for (const f of raw.fragments) {
    const frag = strictFragment(f);
    if (!frag || fragIds.has(frag.id)) return null;
    fragIds.add(frag.id);
    fragments.push(frag);
  }
  // 格子引用的碎片必须真实存在（导出文件的基本不变量）
  for (const s of raw.slots) {
    if (s !== null && !fragIds.has(s)) return null;
  }

  return {
    id: raw.id,
    name: raw.name,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    flow: raw.flow,
    level: raw.level,
    weather: raw.weather as WeatherKind,
    slotCount: raw.slotCount,
    slots: raw.slots.map((s): string | null => (s === null ? null : String(s))),
    fragments,
    version: DOC_VERSION,
  };
};

function readStore(): SongDoc[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 逐条校验：单条损坏只丢该条，不影响其余作品，更不能让整站启动失败
    return parsed.map(normalizeDoc).filter((d): d is SongDoc => d !== null);
  } catch {
    return [];
  }
}

function writeStore(docs: SongDoc[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(docs));
}

/** 配额预检 + 写入（save 与 importSong 共用，保证两处行为一致） */
function persistStore(docs: SongDoc[]): void {
  const json = JSON.stringify(docs);
  // 浏览器按 UTF-8 字节计算 localStorage 配额，不能用 json.length（UTF-16 码元）：
  // 中文名/emoji 与接近上限的录音会让实际占用明显大于字符数，预检会误放行。
  const bytes = utf8ByteSize(json);
  if (bytes > MAX_TOTAL_BYTES) {
    throw new QuotaError(`作品集空间快满了（约 ${(bytes / 1_000_000).toFixed(1)}MB），先删掉一些旧作品再存`);
  }
  try {
    writeStore(docs);
  } catch (e) {
    // 预检通过仍可能失败：这台设备/浏览器的实际配额更小，或已被同域其它数据占用
    throw new QuotaError('存不下啦：录音太多，浏览器本地空间不足', e);
  }
}

export class Portfolio {
  /** 作品集列表（按最近修改倒序） */
  list(): SongSummary[] {
    return readStore()
      .map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        weather: d.weather,
        voiceCount: d.fragments.filter((f) => f.kind === 'voice').length,
      }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  get(id: string): SongDoc | null {
    return readStore().find((d) => d.id === id) ?? null;
  }

  /** 新建或覆盖同名 id 的作品；空间不足时抛 QuotaError */
  save(doc: Omit<SongDoc, 'version'>): SongDoc {
    const full: SongDoc = { ...doc, version: DOC_VERSION };
    const docs = readStore();
    const i = docs.findIndex((d) => d.id === full.id);
    if (i >= 0) docs[i] = full;
    else docs.unshift(full);
    persistStore(docs);
    return full;
  }

  /** 导出单首作品为 JSON 文本（即存档结构本身），不存在时返回 null */
  exportSong(id: string): { name: string; json: string } | null {
    const doc = this.get(id);
    if (!doc) return null;
    return { name: doc.name, json: JSON.stringify(doc) };
  }

  /**
   * 从 JSON 文本导入单首作品（exportSong 的逆操作，复用同一存档结构）。
   * 与读取本地存档不同，这里用严格校验：备份必须完整自洽，缺字段/越界/
   * 引用悬空的文件整体拒绝，不做补缺修复。
   * id 与本机已有作品冲突时生成新 id 存为副本，绝不静默覆盖本机作品。
   * 文件无法识别时抛 ImportError，空间不足时抛 QuotaError。
   */
  importSong(text: string): { doc: SongDoc; copied: boolean } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ImportError('这个文件不是有效的作品备份');
    }
    const doc = parseBackupDoc(parsed);
    if (!doc) throw new ImportError('文件里没有完整的河流之歌，可能不是作品备份');

    const docs = readStore();
    let copied = false;
    if (docs.some((d) => d.id === doc.id)) {
      doc.id = Portfolio.newId();
      copied = true;
    }
    docs.unshift(doc);
    persistStore(docs);
    return { doc, copied };
  }

  remove(id: string): void {
    writeStore(readStore().filter((d) => d.id !== id));
  }

  /** 新建作品的唯一 id（时间戳 + 随机串，不依赖 crypto） */
  static newId(): string {
    return `song-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/** 本地空间不足（或浏览器拒绝写入），供 UI 给出明确提示 */
export class QuotaError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'QuotaError';
  }
}

/** 导入的文件不是可识别的作品备份（非 JSON，或缺少存档必需字段） */
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}
