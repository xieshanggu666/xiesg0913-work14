import type p5 from 'p5';
import type { WeatherKind } from '../audio/AudioEngine';

interface Drop {
  x: number;
  y: number;
  vy: number;
}

interface Ripple {
  x: number;
  y: number;
  r: number;
  a: number;
}

interface Leaf {
  x: number;
  y: number;
  vx: number;
  rot: number;
  vr: number;
  size: number;
  color: string;
}

interface Sparkle {
  x: number;
  ph: number;
}

const LEAF_COLORS = ['#7bc47f', '#ffb74d', '#ba68c8'];

/** 三种天气：晴（阳光+水面波光）、雨（雨滴+涟漪）、风（落叶+阵风） */
export class Weather {
  kind: WeatherKind = 'sunny';
  private drops: Drop[] = [];
  private ripples: Ripple[] = [];
  private leaves: Leaf[] = [];
  private sparkles: Sparkle[] = [];

  setKind(k: WeatherKind): void {
    this.kind = k;
  }

  /** 物理系统读取的阵风强度（-1 ~ 1） */
  windGust(t: number): number {
    return this.kind === 'wind' ? (Math.sin(t * 0.0009) + Math.sin(t * 0.0023)) * 0.5 : 0;
  }

  skyColors(): [string, string] {
    switch (this.kind) {
      case 'rain':
        return ['#7488a0', '#c3ced8'];
      case 'wind':
        return ['#8fd0c2', '#e6f8ef'];
      default:
        return ['#7ec8ff', '#e9f9ff'];
    }
  }

  update(dt: number, flow: number, surfaceY: number, w: number, h: number, t: number): void {
    if (this.kind === 'rain') {
      const n = Math.max(1, Math.floor(dt / 8));
      for (let i = 0; i < n; i++) {
        this.drops.push({ x: Math.random() * w, y: -10, vy: 0.7 + Math.random() * 0.4 });
      }
    }
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.y += d.vy * dt;
      if (d.y >= surfaceY) {
        this.ripples.push({ x: d.x, y: surfaceY, r: 2, a: 120 });
        this.drops.splice(i, 1);
      }
    }
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.r += dt * 0.06;
      r.a -= dt * 0.25;
      if (r.a <= 0) this.ripples.splice(i, 1);
    }

    if (this.kind === 'wind' && Math.random() < dt / 600) {
      this.leaves.push({
        x: -20,
        y: Math.random() * surfaceY * 0.9,
        vx: 0.2 + Math.random() * 0.2,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.01,
        size: 6 + Math.random() * 6,
        color: LEAF_COLORS[Math.floor(Math.random() * LEAF_COLORS.length)],
      });
    }
    const gust = this.windGust(t);
    for (let i = this.leaves.length - 1; i >= 0; i--) {
      const l = this.leaves[i];
      l.x += (l.vx + gust * 0.35 + flow * 0.05) * dt;
      l.y += Math.sin(t * 0.004 + l.rot * 5) * 0.06 * dt;
      l.rot += l.vr * dt;
      if (l.x > w + 30) this.leaves.splice(i, 1);
    }

    if (this.kind === 'sunny') {
      while (this.sparkles.length < 16) {
        this.sparkles.push({ x: Math.random() * w, ph: Math.random() * Math.PI * 2 });
      }
    }
  }

  draw(p: p5, surfaceY: number, t: number): void {
    if (this.kind === 'sunny') {
      p.noStroke();
      p.fill(255, 236, 140, 220);
      p.circle(70, 70, 64);
      p.fill(255, 236, 140, 60);
      p.circle(70, 70, 92);
      for (const s of this.sparkles) {
        const a = (Math.sin(t * 0.004 + s.ph) + 1) * 0.5;
        if (a < 0.35) continue;
        const y = surfaceY + 6 + ((s.ph * 7) % 26);
        p.stroke(255, 255, 255, a * 200);
        p.strokeWeight(1.5);
        p.line(s.x - 5, y, s.x + 5, y);
        p.line(s.x, y - 5, s.x, y + 5);
      }
      p.noStroke();
    } else if (this.kind === 'rain') {
      p.stroke(200, 220, 255, 150);
      p.strokeWeight(1.5);
      for (const d of this.drops) p.line(d.x, d.y, d.x - 2, d.y + 12);
      for (const r of this.ripples) {
        p.noFill();
        p.stroke(255, 255, 255, r.a);
        p.ellipse(r.x, r.y, r.r * 2, r.r * 0.8);
      }
      p.noStroke();
    } else {
      for (const l of this.leaves) {
        p.push();
        p.translate(l.x, l.y);
        p.rotate(l.rot);
        p.noStroke();
        p.fill(l.color);
        p.ellipse(0, 0, l.size * 1.6, l.size);
        p.pop();
      }
    }
  }
}
