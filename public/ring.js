// Allowance ring shared by the menu-bar popover and the Usage History window.
// Classic script (window.UMRing) so both renderers can load it without module
// imports. Rings are built with DOM APIs, not markup, so the popover's
// style-src 'self' CSP stays intact (CSSOM writes are allowed; style attributes
// in markup are not).
(function (root) {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const SIZE = 44;
  const STROKE = 4.5;
  const GAP = 2.5;

  function radiusFor(index) {
    return SIZE / 2 - STROKE / 2 - index * (STROKE + GAP);
  }

  function clampPercent(value) {
    return Math.min(100, Math.max(0, Number(value) || 0));
  }

  function circle(className, r) {
    const node = document.createElementNS(SVG_NS, "circle");
    node.setAttribute("class", className);
    node.setAttribute("cx", SIZE / 2);
    node.setAttribute("cy", SIZE / 2);
    node.setAttribute("r", r.toFixed(2));
    return node;
  }

  function applyArc(node, arc, circumference) {
    const remaining = clampPercent(arc.remainingPercent);
    node.classList.toggle("ring-arc-low", Boolean(arc.low));
    node.style.setProperty("--ring-c", circumference.toFixed(2));
    node.style.strokeDashoffset = (circumference * (1 - remaining / 100)).toFixed(2);
  }

  // arcs: outermost first, at most two. A null entry draws the track only.
  // Re-renders into a host that already holds a ring with the same shape
  // update the existing arcs in place so the CSS transition animates the
  // change instead of replaying the entrance.
  function renderRing(host, arcs) {
    if (!host) return;
    const shape = arcs.length ? arcs.slice(0, 2) : [null, null];
    const existing = host.querySelector("svg.ring");
    const existingArcs = existing ? [...existing.querySelectorAll(".ring-arc")] : [];
    const liveArcs = shape.filter(Boolean);

    if (existing && existingArcs.length === liveArcs.length && existingArcs.length) {
      liveArcs.forEach((arc, index) => {
        const node = existingArcs[index];
        applyArc(node, arc, 2 * Math.PI * Number(node.getAttribute("r")));
      });
      return;
    }

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "ring");
    svg.setAttribute("viewBox", `0 0 ${SIZE} ${SIZE}`);
    svg.setAttribute("aria-hidden", "true");

    shape.forEach((arc, index) => {
      const r = radiusFor(index);
      svg.appendChild(circle("ring-track", r));
      if (!arc) return;
      const circumference = 2 * Math.PI * r;
      const node = circle("ring-arc", r);
      node.setAttribute("stroke-dasharray", circumference.toFixed(2));
      applyArc(node, arc, circumference);
      svg.appendChild(node);
    });

    host.replaceChildren(svg);
  }

  root.UMRing = { renderRing };
})(typeof window === "undefined" ? globalThis : window);
