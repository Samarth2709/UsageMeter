// Shared lighting and direct rotation of the actual UI surfaces.
// Input coordinates come from the untransformed stage, so the target cannot
// chase its own transformed bounds. Idle views do not run a render loop.
const stage = document.querySelector(".spatial-stage");
const chassis = document.querySelector(".spatial-chassis");
const history = document.querySelector(".history-body");
const surface = chassis || history;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
document.documentElement.classList.toggle("page-hidden", document.hidden);
let target = [0, 0];
let current = [0, 0];
let frame = 0;
let last = 0;
let holding = false;
let keyboard = false;
let activePanel = null;
let orientation = [0, 0, 0];
let rotation = null;
let spin = null;
const orientationKey = "usage-meter-orientation-v1";
const edges = [];
const wrapAngle = (angle) => ((angle + 180) % 360 + 360) % 360 - 180;

// The native process watches the real screen edge even while this page is hidden.
// Keep slide translation outside the chassis so rotation and projection stay intact.
if (stage && window.rateLimitAPI?.getDockState) {
  let dockEventReceived = false;
  let dockRevision = 0;
  const applyDockState = (expanded) => {
    const revision = ++dockRevision;
    stage.inert = !expanded;
    if (!expanded) {
      stage.classList.add("is-docked");
      if (spin) resetOrientation();
      target = current = [0, 0];
      paint();
    } else {
      // Flush the tucked pose before the first visible frame after native show.
      getComputedStyle(stage).transform;
      requestAnimationFrame(() => {
        if (revision === dockRevision) stage.classList.remove("is-docked");
      });
    }
  };
  window.rateLimitAPI.onDockState((expanded) => {
    dockEventReceived = true;
    applyDockState(expanded);
  });
  window.rateLimitAPI.getDockState().then((expanded) => {
    if (!dockEventReceived) applyDockState(expanded);
  });
  const interaction = (kind) => window.rateLimitAPI.setDockInteraction(kind);
  stage.addEventListener("pointerdown", () => interaction("pointer-start"), { capture: true });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
    window.addEventListener(name, () => interaction("pointer-end"));
  }
  document.addEventListener("keydown", () => interaction("keyboard"));
  window.addEventListener("blur", () => interaction("blur"));
} else {
  stage?.classList.remove("dock-enabled", "is-docked");
}


if (chassis) {
  try {
    const saved = JSON.parse(localStorage.getItem(orientationKey));
    if (Array.isArray(saved) && saved.length === 3 && saved.every(Number.isFinite)) {
      orientation = saved.map(wrapAngle);
    }
  } catch { /* Rotation still works when local storage is unavailable. */ }

  const volume = chassis.querySelector(".chassis-volume");
  const radius = 23;
  // A closed rounded slab: four straight walls and eight facets per corner.
  for (const [side, nx, ny] of [["top", 0, -1], ["right", 1, 0], ["bottom", 0, 1], ["left", -1, 0]]) {
    const face = document.createElement("span");
    face.className = `chassis-edge chassis-edge-${side}`;
    volume.append(face);
    edges.push({ face, nx, ny });
  }
  for (const [cx, cy, start] of [["23px", "23px", 180], ["100% - 23px", "23px", 270],
    ["100% - 23px", "100% - 23px", 0], ["23px", "100% - 23px", 90]]) {
    for (let segment = 0; segment < 8; segment++) {
      const angle = start + (segment + 0.5) * 11.25;
      const radians = angle * Math.PI / 180;
      const nx = Math.cos(radians), ny = Math.sin(radians);
      const distance = radius * Math.cos(Math.PI / 32);
      const face = document.createElement("span");
      face.className = "chassis-edge chassis-edge-corner";
      face.style.left = `calc(${cx} + ${distance * nx}px)`;
      face.style.top = `calc(${cy} + ${distance * ny}px)`;
      face.style.width = `${2 * radius * Math.sin(Math.PI / 32) + 0.2}px`;
      face.style.transform = `translate(-50%, -50%) translateZ(-7px) rotateZ(${angle + 90}deg) rotateX(90deg)`;
      volume.append(face);
      edges.push({ face, nx, ny });
    }
  }
}

function saveOrientation() {
  orientation = orientation.map(wrapAngle);
  try { localStorage.setItem(orientationKey, JSON.stringify(orientation)); } catch { /* Optional persistence. */ }
}

function resetOrientation() {
  spin = null;
  orientation = [0, 0, 0];
  target = current = [0, 0];
  saveOrientation();
  paint();
}

function stopSpin() {
  if (!spin) return;
  spin = null;
  saveOrientation();
}

function startSpin(velocity) {
  if (reduced.matches || document.hidden || Math.hypot(...velocity) < 120) return false;
  spin = {
    started: performance.now(),
    axes: orientation.map((angle, i) => {
      const speed = velocity[i];
      let end = Math.round(angle / 360) * 360;
      let duration = 1.2;
      if (Math.abs(speed) >= 50) {
        // Land on a forward-facing full turn in the direction of the flick.
        end = Math.round((angle + speed * 1.1) / 360) * 360;
        if ((end - angle) * Math.sign(speed) < 90) end += Math.sign(speed) * 360;
        duration = Math.max(1, Math.min(6, 3 * Math.abs((end - angle) / speed)));
      }
      return { start: angle, end, duration };
    })
  };
  // Relaunching mid-flight should open the usable front, not a frozen back.
  try { localStorage.setItem(orientationKey, "[0,0,0]"); } catch { /* Optional persistence. */ }
  target = current = [0, 0];
  last = 0;
  aim();
  return true;
}

function paintChassis(pitch, yaw, roll) {
  const matrix = new DOMMatrix().rotateAxisAngle(1, 0, 0, pitch)
    .rotateAxisAngle(0, 1, 0, yaw).rotateAxisAngle(0, 0, 1, roll);
  const halfWidth = chassis.offsetWidth / 2, halfHeight = chassis.offsetHeight / 2;
  let fit = 1;
  // Project every corner of the volume, including raised controls. Solve the
  // scale that keeps them inside the fixed native window at every orientation.
  for (const x of [-halfWidth, halfWidth]) for (const y of [-halfHeight, halfHeight]) for (const z of [-14, 18]) {
    const point = new DOMPoint(x, y, z).matrixTransform(matrix);
    for (const [extent, coordinate] of [[halfWidth, point.x], [halfHeight, point.y]]) {
      const denominator = 1100 * Math.abs(coordinate) + extent * point.z;
      if (denominator > 0) fit = Math.min(fit, extent * 1118 / denominator);
    }
  }
  chassis.style.setProperty("--fit", Math.max(0.1, fit).toFixed(5));
  chassis.style.setProperty("--pitch", `${pitch.toFixed(3)}deg`);
  chassis.style.setProperty("--yaw", `${yaw.toFixed(3)}deg`);
  chassis.style.setProperty("--roll", `${roll.toFixed(3)}deg`);
  const backFacing = matrix.m33 < 0;
  chassis.classList.toggle("is-back-facing", backFacing);
  // Hidden back-facing controls must not remain in the keyboard tab order.
  chassis.querySelector(".widget-shell").inert = backFacing;
  for (const { face, nx, ny } of edges) {
    const light = -0.3 * (matrix.m11 * nx + matrix.m21 * ny)
      - 0.5 * (matrix.m12 * nx + matrix.m22 * ny) + 0.8 * (matrix.m13 * nx + matrix.m23 * ny);
    face.style.setProperty("--edge-light", `${14 + Math.max(0, light) * 25}%`);
  }
}

function paint() {
  if (!surface) return;
  const [x, y] = current;
  surface.style.setProperty("--light-x", `${(38 + x * 28).toFixed(2)}%`);
  surface.style.setProperty("--light-y", `${(16 + y * 30).toFixed(2)}%`);
  if (chassis) {
    paintChassis(orientation[0] - (reduced.matches ? 0 : y * 10),
      orientation[1] + (reduced.matches ? 0 : x * 12), orientation[2]);
  }
  if (activePanel) {
    activePanel.style.setProperty("--panel-pitch", `${(reduced.matches ? 0 : -y * 1.2).toFixed(3)}deg`);
    activePanel.style.setProperty("--panel-yaw", `${(reduced.matches ? 0 : x * 1.2).toFixed(3)}deg`);
  }
}

function tick(now) {
  frame = 0;
  if (document.hidden || !surface) return;
  if (spin && reduced.matches) resetOrientation();
  const dt = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60;
  last = now;
  const mix = 1 - Math.exp(-dt * 12);
  current = current.map((value, i) => value + (target[i] - value) * mix);
  const settled = current.every((value, i) => Math.abs(value - target[i]) < 0.001);
  if (settled) current = [...target];
  if (spin) {
    const elapsed = (now - spin.started) / 1000;
    // Cubic ease-out has continuously decreasing speed and zero end velocity.
    orientation = spin.axes.map(({ start, end, duration }) => {
      const progress = Math.max(0, Math.min(1, elapsed / duration));
      return end - (end - start) * (1 - progress) ** 3;
    });
    if (spin.axes.every(axis => elapsed >= axis.duration)) {
      spin = null;
      orientation = [0, 0, 0];
      saveOrientation();
    }
  }
  paint();
  if (!settled || spin) frame = requestAnimationFrame(tick);
  else last = 0;
}

function aim(x = 0, y = 0) {
  target = reduced.matches ? [0, 0] : [x, y];
  if (document.hidden) return;
  if (reduced.matches) {
    if (spin) resetOrientation();
    cancelAnimationFrame(frame);
    frame = 0;
    current = [0, 0];
    paint();
  } else if (!frame) frame = requestAnimationFrame(tick);
}

function resetPanel() {
  activePanel?.style.removeProperty("--panel-pitch");
  activePanel?.style.removeProperty("--panel-yaw");
  activePanel = null;
}

surface?.addEventListener("pointermove", (event) => {
  if (holding || spin || event.buttons || reduced.matches) return;
  keyboard = false;
  let bounds = (stage || document.documentElement).getBoundingClientRect();
  if (history) {
    const panel = event.target.closest(".panel, .stat");
    if (panel !== activePanel) { resetPanel(); activePanel = panel; }
    // Client coordinates need the viewport, not the document's scroll offset.
    bounds = { left: 0, top: 0, width: innerWidth, height: innerHeight };
  }
  const clamp = (value) => Math.max(-1, Math.min(1, value));
  aim(clamp((event.clientX - bounds.left) / bounds.width * 2 - 1),
    clamp((event.clientY - bounds.top) / bounds.height * 2 - 1));
});

surface?.addEventListener("pointerleave", () => {
  if (!holding) { resetPanel(); aim(); }
});

// Keep physical controls and the native drag origin steady while pressed.
surface?.addEventListener("pointerdown", () => { holding = true; target = [...current]; });
for (const name of ["pointerup", "pointercancel"]) {
  window.addEventListener(name, () => { holding = false; aim(); });
}

document.addEventListener("keydown", (event) => {
  if (stage && event.key === "Escape") { event.preventDefault(); resetOrientation(); }
  if (event.key === "Tab") { if (spin) resetOrientation(); keyboard = true; resetPanel(); aim(); }
});
document.addEventListener("focusin", () => { if (keyboard) aim(); });
window.addEventListener("blur", () => { holding = false; resetPanel(); aim(); });
window.addEventListener("resize", () => aim());
document.addEventListener("visibilitychange", () => {
  document.documentElement.classList.toggle("page-hidden", document.hidden);
  if (document.hidden && spin) resetOrientation();
  cancelAnimationFrame(frame);
  frame = 0;
  last = 0;
  holding = false;
  resetPanel();
  target = current = [0, 0];
  if (!document.hidden) paint();
});
reduced.addEventListener("change", () => { if (reduced.matches && spin) resetOrientation(); resetPanel(); aim(); });
paint();

if (stage) {
  stage.addEventListener("pointerdown", stopSpin, { capture: true });
  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest("[data-resize-edge]")) return;
    if (event.target.closest("button")) return;
    event.preventDefault();
    const pose = [orientation[0] - current[1] * 10, orientation[1] + current[0] * 12, orientation[2]];
    rotation = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false,
      spin: event.shiftKey, pose, samples: [{ time: event.timeStamp, pose }] };
    holding = true;
    target = [...current];
    stage.classList.add("is-rotating");
    stage.setPointerCapture(event.pointerId);
  });
  stage.addEventListener("pointermove", (event) => {
    if (!rotation || event.pointerId !== rotation.id) return;
    const dx = event.clientX - rotation.x, dy = event.clientY - rotation.y;
    if (!rotation.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    rotation.moved = true;
    orientation = rotation.spin
      ? [rotation.pose[0], rotation.pose[1], rotation.pose[2] + dx * 0.8]
      : [rotation.pose[0] - dy * 0.8, rotation.pose[1] + dx * 0.8, rotation.pose[2]];
    rotation.samples.push({ time: event.timeStamp, pose: [...orientation] });
    while (rotation.samples.length > 1 && rotation.samples[0].time < event.timeStamp - 100) rotation.samples.shift();
    target = current = [0, 0];
    paint();
  });
  const endRotation = (event) => {
    if (!rotation) return;
    const { id, moved, samples } = rotation;
    rotation = null;
    holding = false;
    stage.classList.remove("is-rotating");
    if (stage.hasPointerCapture(id)) stage.releasePointerCapture(id);
    if (moved) {
      const first = samples[0], latest = samples.at(-1);
      const seconds = (latest.time - first.time) / 1000;
      let velocity = [0, 0, 0];
      if (event?.type === "pointerup" && event.timeStamp - latest.time <= 100 && seconds >= 0.004) {
        velocity = latest.pose.map((angle, i) => (angle - first.pose[i]) / seconds);
        const scale = Math.min(1, 1440 / Math.hypot(...velocity));
        velocity = velocity.map(value => value * scale);
      }
      if (!startSpin(velocity)) saveOrientation();
    }
    aim();
  };
  stage.addEventListener("pointerup", endRotation);
  stage.addEventListener("pointercancel", endRotation);
  stage.addEventListener("lostpointercapture", endRotation);
  window.addEventListener("blur", endRotation);
  document.addEventListener("visibilitychange", () => { if (document.hidden) endRotation(); });
  stage.addEventListener("dblclick", (event) => {
    if (event.target.closest("[data-resize-edge]")) return;
    if (event.target.closest("button")) return;
    resetOrientation();
  });
  stage.addEventListener("keydown", (event) => {
    if (event.target !== stage) return;
    const delta = { ArrowLeft: [0, -10, 0], ArrowRight: [0, 10, 0], ArrowUp: [10, 0, 0], ArrowDown: [-10, 0, 0] }[event.key];
    if (["Enter", " ", "Home"].includes(event.key)) {
      event.preventDefault(); resetOrientation();
    } else if (delta) {
      event.preventDefault();
      stopSpin();
      orientation = orientation.map((angle, i) => angle + (event.shiftKey ? (i === 2 ? delta[0] + delta[1] : 0) : delta[i]));
      target = current = [0, 0];
      saveOrientation(); paint();
    }
  });
}

// Transparent macOS windows use custom edge handles. Absolute screen deltas
// keep resizing stable when the left/top edge moves under the cursor.
if (stage && window.rateLimitAPI?.resizePopover) {
  stage.classList.add("can-resize");
  let resize = null;
  for (const handle of stage.querySelectorAll("[data-resize-edge]")) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      resize = { edge: handle.dataset.resizeEdge, x: event.screenX, y: event.screenY,
        width: innerWidth, height: innerHeight };
      holding = true;
      target = [...current];
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!resize || !handle.hasPointerCapture(event.pointerId)) return;
      const { edge, x, y, width, height } = resize;
      const dx = event.screenX - x;
      const dy = event.screenY - y;
      window.rateLimitAPI.resizePopover(
        width + (edge.includes("w") ? -dx : edge.includes("e") ? dx : 0),
        height + (edge.includes("n") ? -dy : edge.includes("s") ? dy : 0), edge);
    });
    const endResize = (event) => {
      resize = null;
      holding = false;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      aim();
    };
    handle.addEventListener("pointerup", endResize);
    handle.addEventListener("pointercancel", endResize);
    handle.addEventListener("lostpointercapture", endResize);
    handle.addEventListener("keydown", (event) => {
      const delta = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[event.key];
      if (!delta) return;
      event.preventDefault();
      window.rateLimitAPI.resizePopover(innerWidth + delta[0], innerHeight + delta[1], "se");
    });
  }
}
