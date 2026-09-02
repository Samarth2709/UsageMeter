// The popover meter is a body of liquid, drawn on a canvas rather than with CSS
// keyframes. Two things need that. The surface is evaluated from a continuous
// wave field every frame, so the motion never interpolates between sampled
// shapes and never repeats. And a row with two allowance windows is one
// connected mass with a step in its level — a single surface that runs from the
// top of the row to the bottom and turns a rounded elbow between the bands —
// rather than two bars that happen to sit on top of each other.

const TAU = Math.PI * 2;

// Surface swell. Components travel in both directions with unrelated periods,
// so their sum never visibly repeats. `len` is the wavelength in px down the
// row, `period` the seconds per cycle, `swell` the seconds per amplitude cycle
// so crests build and fade unevenly. The whole sum stays inside about two
// pixels: at this size a calm surface reads as water and a big one as a blob.
const SWELL = [
  { amp: 0.62, len: 118, period: 11.3, dir: -1, phase: 1.2, swell: 23, swellPhase: 0.4 },
  { amp: 0.5, len: 43, period: 6.1, dir: 1, phase: 0.0, swell: 17, swellPhase: 2.7 },
  { amp: 0.4, len: 26, period: 4.3, dir: -1, phase: 2.4, swell: 13, swellPhase: 5.1 },
  { amp: 0.26, len: 16, period: 3.1, dir: 1, phase: 4.1, swell: 11, swellPhase: 1.6 },
  { amp: 0.15, len: 9.5, period: 2.2, dir: -1, phase: 5.5, swell: 7, swellPhase: 3.9 }
];

// Light inside the body: broad veils of light and shade that drift across the
// row at their own pace. They are kept wide and very faint — a veil narrow
// enough to show an edge reads as a seam in the paint, not as moving water.
const VEILS = [
  { period: 19, phase: 0.0, width: 0.95, alpha: 0.028, light: true },
  { period: 27, phase: 2.2, width: 1.15, alpha: 0.022, light: false },
  { period: 14.5, phase: 4.4, width: 0.8, alpha: 0.022, light: true }
];

// The surface itself: the body gathers weight just behind the edge, then the
// meniscus catches the light in a hairline. Every pass strokes the same
// contour at a different width — offset copies of it read as onion rings
// rather than as water.
const SURFACE = [
  { width: 46, alpha: 0.022, light: false },
  { width: 14, alpha: 0.018, light: false },
  { width: 1.4, alpha: 0.13, light: true },
  { width: 0.7, alpha: 0.32, light: true }
];

const SAMPLE = 1; // px between surface samples
const SHEEN_PERIOD = 11; // seconds for the specular band to cross the row
const FRAME_INTERVAL_MS = 1000 / 30;
const MAX_DPR = 1.5;

const live = new Set();
let raf = 0;
let lastNow = 0;
let reduced = false;

if (typeof matchMedia === "function") {
  const query = matchMedia("(prefers-reduced-motion: reduce)");
  reduced = query.matches;
  query.addEventListener("change", (event) => {
    reduced = event.matches;
    for (const inst of live) inst.invalidate();
  });
}

/* ---------- colour ---------- */

// Custom properties resolve to plain literals (`#d9734c`, `rgba(…)`) because
// the stylesheet keeps colour-mixing out of them: the shading is mixed here so
// every layer of one row comes from a single tone.
function parseColor(value) {
  const text = String(value).trim();
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    const wide = hex.length > 4;
    const step = wide ? 2 : 1;
    const part = (i) => {
      const chunk = hex.substr(i * step, step);
      const n = parseInt(wide ? chunk : chunk + chunk, 16);
      return Number.isNaN(n) ? 0 : n;
    };
    return [part(0), part(1), part(2), hex.length === 4 || hex.length === 8 ? part(3) / 255 : 1];
  }
  const nums = text.match(/[-\d.]+(?:e[-+]?\d+)?/gi);
  if (!nums || nums.length < 3) return [0, 0, 0, 1];
  return [Number(nums[0]), Number(nums[1]), Number(nums[2]), nums.length > 3 ? Number(nums[3]) : 1];
}

// srgb mix with premultiplied alpha, matching CSS color-mix().
function mix(a, b, amount) {
  const wa = a[3] * amount;
  const wb = b[3] * (1 - amount);
  const alpha = wa + wb;
  if (alpha <= 0) return [0, 0, 0, 0];
  return [
    (a[0] * wa + b[0] * wb) / alpha,
    (a[1] * wa + b[1] * wb) / alpha,
    (a[2] * wa + b[2] * wb) / alpha,
    alpha
  ];
}

function css(color) {
  return `rgba(${color[0].toFixed(1)}, ${color[1].toFixed(1)}, ${color[2].toFixed(1)}, ${color[3].toFixed(3)})`;
}

/* ---------- the wave field ---------- */

// One field for the whole row: both chambers read the same displacement at the
// same height, so their surfaces belong to the same body of water.
function swellAt(y, t, gain) {
  let sum = 0;
  for (const w of SWELL) {
    const breath = 0.62 + 0.38 * Math.sin((TAU * t) / w.swell + w.swellPhase);
    sum += w.amp * breath * Math.sin(TAU * (y / w.len + (w.dir * t) / w.period) + w.phase);
  }
  return sum * gain;
}

/* ---------- one row ---------- */

class Liquid {
  constructor(row) {
    this.row = row;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "row-liquid";
    this.canvas.setAttribute("aria-hidden", "true");
    this.ctx = this.canvas.getContext("2d");
    row.prepend(this.canvas);

    // Chamber levels are sprung, not tweened: a changed allowance arrives with
    // a little overshoot and the surface leans while it travels.
    this.chambers = [
      { target: 0, w: 0, v: 0 },
      { target: 0, w: 0, v: 0 }
    ];
    this.count = 0;
    this.still = false;
    this.width = 0;
    this.height = 0;
    this.split = 0;
    this.dpr = 0;
    this.energy = 0;
    this.fillA = [0, 0, 0, 0];
    this.fillB = [0, 0, 0, 0];
    this.dirty = true;

    this.observer = new ResizeObserver(() => this.sync());
    this.observer.observe(row);
    this.mutations = new MutationObserver(() => this.sync());
    this.mutations.observe(row, { attributes: true, attributeFilter: ["class", "style", "data-bands", "data-thin-top"] });
    this.sync();
    live.add(this);
    start();
  }

  destroy() {
    live.delete(this);
    this.observer.disconnect();
    this.mutations.disconnect();
    this.canvas.remove();
    if (!live.size) stop();
  }

  // Reads the row's geometry and tone. Called whenever the row resizes or its
  // attributes change, never per frame.
  sync() {
    const rect = this.row.getBoundingClientRect();
    const style = getComputedStyle(this.row);
    // Retina 2x quadruples the transparent canvas work for no meaningful gain
    // at this size. The DOM text stays native-resolution; only the soft liquid
    // surface is capped.
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);

    if (width !== this.width || height !== this.height || dpr !== this.dpr) {
      // Levels are held in px; a resized row keeps its share of the new width.
      if (this.width && width !== this.width) {
        const scale = width / this.width;
        for (const c of this.chambers) {
          c.w *= scale;
          c.v *= scale;
          c.target *= scale;
        }
      }
      this.width = width;
      this.height = height;
      this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(width * dpr));
      this.canvas.height = Math.max(1, Math.round(height * dpr));
    }

    const band = parseFloat(style.getPropertyValue("--band")) || 40;
    const thin = this.row.dataset.thinTop === "1";
    this.count = Number(this.row.dataset.bands) || 0;
    this.split = this.count > 1 ? (thin ? band / 2 : band) : height;

    const tone = parseColor(style.getPropertyValue("--tone"));
    const material = parseColor(style.getPropertyValue("--material"));
    // A narrow spread: the body should read as one colour with the light
    // moving through it, not as a gradient.
    this.fillA = mix(tone, material, 0.82);
    this.fillB = mix(tone, material, 0.95);
    this.still = this.row.classList.contains("is-stale");

    for (let i = 0; i < 2; i++) {
      const share = parseFloat(style.getPropertyValue(`--r${i + 1}`)) || 0;
      const target = i < this.count ? (share / 100) * width : 0;
      const chamber = this.chambers[i];
      if (Math.abs(target - chamber.target) > 0.5) {
        // A moving level carries some energy into the surface.
        this.energy = Math.min(1.6, this.energy + Math.min(1, Math.abs(target - chamber.target) / 90));
      }
      chamber.target = target;
    }

    this.invalidate();
  }

  invalidate() {
    this.dirty = true;
    start();
  }

  needsAnimation() {
    return !reduced && !this.still && this.count > 0 && this.width > 0 && this.height > 0;
  }

  step(dt) {
    if (reduced || this.still) {
      // Reduced-motion and cached rows are static. Snap their levels as well as
      // freezing the wave field so no JavaScript motion remains.
      for (const c of this.chambers) {
        c.w = c.target;
        c.v = 0;
      }
      this.energy = 0;
      return;
    }
    // Critically-ish damped spring: settles in about a second with a hint of
    // overshoot, the way a filling vessel does.
    for (let i = 0; i < this.count; i++) {
      const c = this.chambers[i];
      c.v += (c.target - c.w) * 30 * dt - c.v * 8.5 * dt;
      c.w += c.v * dt;
    }
    this.energy *= Math.exp(-dt / 1.6);
  }

  // x of the surface at height y for one chamber. `lean` tilts the surface
  // while the level travels.
  surfaceX(chamber, y, t, gain) {
    const lean = Math.max(-7, Math.min(7, chamber.v * 0.035)) * (y / Math.max(1, this.height) - 0.5);
    return chamber.w + swellAt(y, t, gain) + lean;
  }

  // Traces the leading contour from the top of the row to the bottom. With two
  // chambers the step between levels is a rounded elbow with a gently waving
  // ledge, so the surface stays one unbroken line.
  trace(path, t, gain) {
    const h = this.height;
    const [a, b] = this.chambers;
    const single = this.count < 2;
    const yStep = SAMPLE;

    if (single) {
      path.moveTo(this.surfaceX(a, 0, t, gain), 0);
      for (let y = yStep; y < h; y += yStep) path.lineTo(this.surfaceX(a, y, t, gain), y);
      path.lineTo(this.surfaceX(a, h, t, gain), h);
      return;
    }

    const split = this.split;
    const xa = this.surfaceX(a, split, t, gain);
    const xb = this.surfaceX(b, split, t, gain);
    const gap = Math.abs(xa - xb);

    if (gap < 1.4) {
      // The two levels have met: draw one straight surface through the split.
      path.moveTo(this.surfaceX(a, 0, t, gain), 0);
      for (let y = yStep; y < h; y += yStep) {
        path.lineTo(this.surfaceX(y < split ? a : b, y, t, gain), y);
      }
      path.lineTo(this.surfaceX(b, h, t, gain), h);
      return;
    }

    const dir = xb > xa ? 1 : -1;
    const r = Math.min(7, gap / 2.2, split * 0.45, (h - split) * 0.35);

    path.moveTo(this.surfaceX(a, 0, t, gain), 0);
    for (let y = yStep; y < split - r; y += yStep) path.lineTo(this.surfaceX(a, y, t, gain), y);

    // The liquid's own corner, rounded from inside.
    const cax = xa + dir * r;
    const cay = split - r;
    const from = dir < 0 ? 0 : Math.PI;
    for (let i = 0; i <= 6; i++) {
      const th = from + ((Math.PI / 2 - from) * i) / 6;
      path.lineTo(cax + r * Math.cos(th), cay + r * Math.sin(th));
    }

    // The ledge between the levels, given a little sag that fades out at both
    // ends so it meets the arcs cleanly.
    const x0 = cax;
    const x1 = xb - dir * r;
    const steps = Math.max(2, Math.round(Math.abs(x1 - x0) / 6));
    for (let i = 1; i <= steps; i++) {
      const u = i / steps;
      const x = x0 + (x1 - x0) * u;
      const ripple = 0.75 * gain * Math.sin(TAU * (x / 56 - t / 5.3) + 1.1) * Math.sin(Math.PI * u);
      path.lineTo(x, split + ripple);
    }

    // The corner the liquid runs into, filleted from outside.
    const cbx = xb - dir * r;
    const cby = split + r;
    const to = dir < 0 ? -Math.PI : 0;
    for (let i = 0; i <= 6; i++) {
      const th = -Math.PI / 2 + ((to + Math.PI / 2) * i) / 6;
      path.lineTo(cbx + r * Math.cos(th), cby + r * Math.sin(th));
    }

    for (let y = split + r + yStep; y < h; y += yStep) path.lineTo(this.surfaceX(b, y, t, gain), y);
    path.lineTo(this.surfaceX(b, h, t, gain), h);
  }

  bodyPath(t, gain) {
    const path = new Path2D();
    this.trace(path, t, gain);
    path.lineTo(-2, this.height);
    path.lineTo(-2, 0);
    path.closePath();
    return path;
  }

  render(t, dt) {
    const { ctx } = this;
    if (!ctx || !this.width || !this.height) return;
    this.step(dt);

    const w = this.width;
    const h = this.height;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.count) return;

    const time = this.still ? 0 : t;
    const gain = this.still ? 0.12 : 1 + this.energy * 0.7;
    const body = this.bodyPath(time, gain);

    ctx.save();
    ctx.clip(body);

    // The tint runs across the whole row, not across each level, so both
    // chambers are the same colour at the same x.
    const across = ctx.createLinearGradient(0, 0, w, 0);
    across.addColorStop(0, css(this.fillA));
    across.addColorStop(1, css(this.fillB));
    ctx.fillStyle = across;
    ctx.fillRect(0, 0, w, h);

    // Volume: light gathers at the top of the body and settles out at the foot.
    const depth = ctx.createLinearGradient(0, 0, 0, h);
    depth.addColorStop(0, "rgba(255, 255, 255, 0.08)");
    depth.addColorStop(0.45, "rgba(255, 255, 255, 0)");
    depth.addColorStop(1, "rgba(0, 0, 0, 0.04)");
    ctx.fillStyle = depth;
    ctx.fillRect(0, 0, w, h);

    if (!this.still) {
      this.paintVeils(ctx, t, w, h);
      this.paintSheen(ctx, t, w, h);
    }

    // The surface. Clipped to the body, so its glow stays in the water.
    const edge = new Path2D();
    this.trace(edge, time, gain);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const pass of SURFACE) {
      ctx.strokeStyle = `rgba(${pass.light ? "255, 255, 255" : "0, 0, 0"}, ${pass.alpha})`;
      ctx.lineWidth = pass.width;
      ctx.stroke(edge);
    }

    ctx.restore();
  }

  // Broad, low-contrast light and shade drifting through the body at their own
  // speeds. They read as the water moving rather than as a gradient sliding.
  paintVeils(ctx, t, w, h) {
    for (const veil of VEILS) {
      const centre = w * (0.5 + 0.62 * Math.sin((TAU * t) / veil.period + veil.phase));
      const span = w * veil.width;
      const grad = ctx.createLinearGradient(centre - span, 0, centre + span, 0);
      const tone = veil.light ? "255, 255, 255" : "0, 0, 0";
      grad.addColorStop(0, `rgba(${tone}, 0)`);
      grad.addColorStop(0.5, `rgba(${tone}, ${veil.alpha})`);
      grad.addColorStop(1, `rgba(${tone}, 0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }
  }

  // A single specular band crossing the row in one direction, forever. It is
  // wide and dim: a tight bright core would draw a seam down the fill.
  paintSheen(ctx, t, w, h) {
    const travel = ((t / SHEEN_PERIOD) % 1) * (w + h * 1.4 + 400) - 320;
    const grad = ctx.createLinearGradient(travel - 160, 0, travel + 160, h);
    grad.addColorStop(0, "rgba(255, 255, 255, 0)");
    grad.addColorStop(0.35, "rgba(255, 255, 255, 0.025)");
    grad.addColorStop(0.5, "rgba(255, 255, 255, 0.06)");
    grad.addColorStop(0.65, "rgba(255, 255, 255, 0.025)");
    grad.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
}

/* ---------- the shared frame loop ---------- */

function frame(now) {
  raf = 0;
  const elapsedMs = lastNow ? now - lastNow : FRAME_INTERVAL_MS;
  const paintAnimated = elapsedMs >= FRAME_INTERVAL_MS;
  const dt = Math.min(0.05, elapsedMs / 1000);
  const t = reduced ? 0 : now / 1000;
  let keepAnimating = false;

  for (const inst of live) {
    const animated = inst.needsAnimation();
    if (inst.dirty || (animated && paintAnimated)) {
      inst.render(t, reduced ? 0.05 : dt);
      inst.dirty = false;
    }
    keepAnimating ||= animated;
  }

  if (paintAnimated) {
    // Retain the fractional remainder so a 60 Hz display produces an even
    // 30-ish paint cadence instead of drifting down to every third frame.
    lastNow = now - (elapsedMs % FRAME_INTERVAL_MS);
  }

  if (keepAnimating && !document.hidden) {
    raf = requestAnimationFrame(frame);
  } else {
    lastNow = 0;
  }
}

function start() {
  if (raf || !live.size || document.hidden) return;
  lastNow = 0;
  raf = requestAnimationFrame(frame);
}

function stop() {
  if (!raf) return;
  cancelAnimationFrame(raf);
  raf = 0;
}

document.addEventListener("visibilitychange", () => {
  lastNow = 0;
  if (document.hidden) stop();
  else {
    for (const inst of live) inst.invalidate();
  }
});

// Attaches the liquid to a row, or refreshes the one already there.
export function mountLiquid(row) {
  if (!row) return null;
  if (row.__liquid) {
    row.__liquid.sync();
    return row.__liquid;
  }
  row.__liquid = new Liquid(row);
  return row.__liquid;
}

export function unmountLiquid(row) {
  if (!row?.__liquid) return;
  row.__liquid.destroy();
  delete row.__liquid;
}
