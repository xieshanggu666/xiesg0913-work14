import type p5 from 'p5';

export interface NoteDot {
  rx: number;
  ry: number;
  x: number;
  y: number;
  freq: number;
  collected: boolean;
  phase: number;
}

interface Bubble {
  x: number;
  y: number;
  r: number;
  vy: number;
}

/**
 * 河床上的音符：只有被水淹没（水面高于音符）时才发光、冒泡、可以被点到。
 * 家长调节水位 → 不同高度的音符轮流“显形”。
 */
export class NoteField {
  notes: NoteDot[] = [];
  private bubbles: Bubble[] = [];

  constructor(
    private count: number,
    private scale: number[]
  ) {}

  layout(w: number, h: number): void {
    this.notes = [];
    for (let i = 0; i < this.count; i++) {
      const rx = 0.1 + (0.8 * (i + 0.5)) / this.count + (Math.random() - 0.5) * 0.05;
      const ry = 0.68 + Math.random() * 0.22;
      this.notes.push({
        rx,
        ry,
        x: rx * w,
        y: ry * h,
        freq: this.scale[i % this.scale.length] * (Math.random() < 0.5 ? 1 : 2),
        collected: false,
        phase: Math.random() * Math.PI * 2,
      });
    }
  }

  resize(w: number, h: number): void {
    for (const n of this.notes) {
      n.x = n.rx * w;
      n.y = n.ry * h;
    }
  }

  hit(x: number, y: number, surfaceY: number): NoteDot | null {
    for (const n of this.notes) {
      if (n.collected) continue;
      if (surfaceY >= n.y - 4) continue; // 没被淹没时点不到
      const dx = x - n.x;
      const dy = y - n.y;
      if (dx * dx + dy * dy < 38 * 38) return n;
    }
    return null;
  }

  update(dt: number, surfaceY: number): void {
    for (const n of this.notes) {
      if (!n.collected && surfaceY < n.y - 4 && Math.random() < 0.02) {
        this.bubbles.push({
          x: n.x + (Math.random() - 0.5) * 16,
          y: n.y - 10,
          r: 2 + Math.random() * 3,
          vy: 0.04 + Math.random() * 0.05,
        });
      }
    }
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.y -= b.vy * dt;
      if (b.y < surfaceY + 4) this.bubbles.splice(i, 1);
    }
  }

  draw(p: p5, surfaceY: number, t: number): void {
    for (const n of this.notes) {
      if (n.collected) continue;
      const submerged = surfaceY < n.y - 4;
      p.push();
      p.translate(n.x, n.y + (submerged ? Math.sin(t * 0.003 + n.phase) * 4 : 0));
      p.noStroke();
      if (submerged) {
        const glow = 50 + 35 * Math.sin(t * 0.005 + n.phase);
        p.fill(255, 232, 130, glow);
        p.circle(0, 0, 56);
        p.fill(255, 244, 180, 230);
        p.circle(0, 0, 34);
        p.fill(120, 80, 10);
        p.textSize(20);
        p.text('♪', 0, 1);
      } else {
        // 未被淹没时只剩一个几乎看不见的影子
        p.fill(255, 255, 255, 14);
        p.circle(0, 0, 22);
      }
      p.pop();
    }
    p.noStroke();
    p.fill(255, 255, 255, 130);
    for (const b of this.bubbles) p.circle(b.x, b.y, b.r * 2);
  }
}
