import { QuotaError, utf8ByteSize } from './Portfolio';

/** 素材库里的一段声音：亲子录下的笑声、叫声、拍手声…命名收藏后跨作品复用 */
export interface SoundClipDoc {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 录音时长（秒），仅用于列表展示 */
  duration: number;
  /** 原始录音的 base64（webm/opus 或 mp4） */
  audio: string;
  audioMime: string;
  version: 1;
}

export interface SoundClipSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  duration: number;
}

const STORAGE_KEY = 'river-sound-library-v1';
const DOC_VERSION = 1 as const;
/**
 * 与作品集共用 localStorage 同源配额（常见约 5MB）：素材库自己先卡 3MB，
 * 超出预算或浏览器实际拒绝写入时都抛 QuotaError，由 UI 提示家长清理。
 * 注意单位是 UTF-8 字节，不是字符串 length（中文名/emoji 按码元估算会偏小）。
 */
const MAX_TOTAL_BYTES = 3_000_000;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asNum = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** 时间戳：必须是正数，无法解析时回落到当前时间，保证排序不出 NaN */
const asTimestamp = (v: unknown): number => {
  const n = asNum(v, NaN);
  return n > 0 ? n : Date.now();
};

/* ---------- 读取边界规范化 ----------
 * localStorage 可能被旧版本、手动编辑、写入中断等污染：条目缺 id/名字、
 * 录音载荷缺失或不是字符串、时间戳是字符串等。缺名字或没有录音载荷的条目
 * 没有任何可播放内容，直接丢弃；其余字段尽量补缺——列表在面板打开时就要渲染，
 * 不能让单条坏数据把整个装置搞崩。
 */
const normalizeClip = (raw: unknown): SoundClipDoc | null => {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  if (typeof raw.name !== 'string' || raw.name.trim() === '') return null;
  if (typeof raw.audio !== 'string' || raw.audio.length === 0) return null;
  return {
    id: raw.id,
    name: raw.name,
    createdAt: asTimestamp(raw.createdAt),
    updatedAt: asTimestamp(raw.updatedAt),
    duration: Math.max(0, asNum(raw.duration, 0)),
    audio: raw.audio,
    audioMime:
      typeof raw.audioMime === 'string' && raw.audioMime !== '' ? raw.audioMime : 'audio/webm',
    version: DOC_VERSION,
  };
};

function readStore(): SoundClipDoc[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 逐条校验：单条损坏只丢该条，不影响其余素材
    return parsed.map(normalizeClip).filter((d): d is SoundClipDoc => d !== null);
  } catch {
    return [];
  }
}

function writeStore(docs: SoundClipDoc[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(docs));
}

/** 配额预检 + 写入（收藏与改名共用，保证两处行为一致） */
function persistStore(docs: SoundClipDoc[]): void {
  const json = JSON.stringify(docs);
  // 浏览器按 UTF-8 字节计算 localStorage 配额，不能用 json.length（UTF-16 码元）
  const bytes = utf8ByteSize(json);
  if (bytes > MAX_TOTAL_BYTES) {
    throw new QuotaError(
      `素材库空间快满了（约 ${(bytes / 1_000_000).toFixed(1)}MB），先删掉一些不常用的声音再收藏`
    );
  }
  try {
    writeStore(docs);
  } catch (e) {
    // 预检通过仍可能失败：这台设备/浏览器的实际配额更小，或已被同域其它数据占用
    throw new QuotaError('存不下啦：浏览器本地空间不足，删一些旧作品或素材再试', e);
  }
}

export class SoundLibrary {
  /** 素材列表（按收藏时间倒序，改名不改变位置，孩子熟悉的东西不会乱跑） */
  list(): SoundClipSummary[] {
    return readStore()
      .map((d) => ({
        id: d.id,
        name: d.name,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        duration: d.duration,
      }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  get(id: string): SoundClipDoc | null {
    return readStore().find((d) => d.id === id) ?? null;
  }

  /** 收藏新素材；空间不足时抛 QuotaError */
  save(doc: Omit<SoundClipDoc, 'version'>): SoundClipDoc {
    const full: SoundClipDoc = { ...doc, version: DOC_VERSION };
    const docs = readStore();
    const i = docs.findIndex((d) => d.id === full.id);
    if (i >= 0) docs[i] = full;
    else docs.unshift(full);
    persistStore(docs);
    return full;
  }

  /** 改名；空间不足时抛 QuotaError（名字变长也可能顶爆配额） */
  rename(id: string, name: string): void {
    const docs = readStore();
    const doc = docs.find((d) => d.id === id);
    if (!doc) return;
    doc.name = name;
    doc.updatedAt = Date.now();
    persistStore(docs);
  }

  remove(id: string): void {
    writeStore(readStore().filter((d) => d.id !== id));
  }

  /** 新素材的唯一 id（时间戳 + 随机串，不依赖 crypto） */
  static newId(): string {
    return `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
