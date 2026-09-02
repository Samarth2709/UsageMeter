#!/usr/bin/env node
// Regenerates the `waves-a` and `waves-b` keyframes in public/styles.css.
//
// The popover's meter fills end in a "sea surface": a clip-path polygon whose
// leading edge is the sum of several small sine waves, each with its own
// wavelength, speed and direction. Sampling that surface densely in time and
// emitting one keyframe per sample keeps the CSS animation fluid. Each wave
// completes an integer number of cycles per loop, so the animation closes
// seamlessly. Edit the component tables below, then run:
//
//   node scripts/generate-waves.js
const fs = require("fs");
const path = require("path");

const STYLES = path.join(__dirname, "..", "public", "styles.css");
const STOPS = 48; // keyframes per loop
const POINTS = 33; // vertices down the leading edge

// a: amplitude (px), f: waves along the edge (kept low so only one or two
// crests show at a time), k: cycles per loop, dir: travel direction (+1 down,
// -1 up), phase: radians, mod: slow amplitude modulation { m: cycles per loop,
// depth: 0..1, phase } so crests swell and fade unevenly. base: edge inset (px).
const SEAS = {
  "waves-a": {
    base: 3.2,
    comps: [
      { a: 1.5, f: 0.55, k: 1, dir: +1, phase: 0.4, mod: { m: 2, depth: 0.35, phase: 1.1 } },
      { a: 1.1, f: 0.9, k: 3, dir: -1, phase: 2.1, mod: { m: 1, depth: 0.5, phase: 4.2 } },
      { a: 0.7, f: 1.3, k: 5, dir: +1, phase: 4.0, mod: { m: 2, depth: 0.6, phase: 2.6 } },
      { a: 0.4, f: 0.7, k: 2, dir: -1, phase: 5.5, mod: { m: 3, depth: 0.4, phase: 0.3 } }
    ]
  },
  "waves-b": {
    base: 3.0,
    comps: [
      { a: 1.4, f: 0.6, k: 1, dir: -1, phase: 1.3, mod: { m: 1, depth: 0.4, phase: 2.9 } },
      { a: 1.0, f: 1.0, k: 2, dir: +1, phase: 0.2, mod: { m: 3, depth: 0.5, phase: 0.8 } },
      { a: 0.6, f: 1.4, k: 5, dir: -1, phase: 3.3, mod: { m: 2, depth: 0.6, phase: 5.0 } },
      { a: 0.4, f: 0.8, k: 3, dir: +1, phase: 4.7, mod: { m: 1, depth: 0.4, phase: 1.9 } }
    ]
  }
};

function keyframes(name, { base, comps }) {
  const frames = [];
  for (let s = 0; s <= STOPS; s++) {
    const t = s / STOPS;
    const pts = [];
    for (let i = 0; i < POINTS; i++) {
      const y = i / (POINTS - 1);
      let off = base;
      for (const c of comps) {
        const swell = c.mod ? 1 - c.mod.depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * c.mod.m * t + c.mod.phase)) : 1;
        off += c.a * swell * Math.sin(2 * Math.PI * (c.f * y + c.dir * c.k * t) + c.phase);
      }
      pts.push(`calc(100% - ${Math.max(0.5, off).toFixed(2)}px) ${(y * 100).toFixed(2)}%`);
    }
    frames.push(`  ${(t * 100).toFixed(2)}% {\n    clip-path: polygon(0 0, ${pts.join(", ")}, 0 100%);\n  }`);
  }
  return `@keyframes ${name} {\n${frames.join("\n\n")}\n}`;
}

let css = fs.readFileSync(STYLES, "utf8");
const start = css.indexOf("@keyframes waves-a");
const end = css.indexOf("/* Layer order: shimmer, meniscus, volume, fill.");
if (start < 0 || end < 0) throw new Error("Could not find the wave keyframes block in styles.css.");
const block = Object.entries(SEAS).map(([name, sea]) => keyframes(name, sea)).join("\n\n") + "\n\n";
fs.writeFileSync(STYLES, css.slice(0, start) + block + css.slice(end));
console.log(`Rewrote ${Object.keys(SEAS).join(", ")} in ${path.relative(process.cwd(), STYLES)}`);
