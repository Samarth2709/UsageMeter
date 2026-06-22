// Report true content height to the embedding page so the iframe grows AND
// shrinks to fit (the page extends instead of the dashboard scrolling).
// The shared stylesheet sets `min-height: 100vh` on body, which would otherwise
// pin the reported height to the iframe's own height — neutralize it here.
document.documentElement.style.minHeight = "0";
document.body.style.minHeight = "0";
document.body.style.overflowY = "visible";

function postHeight() {
  parent.postMessage(
    { type: "um-demo-height", height: Math.ceil(document.body.scrollHeight) },
    "*"
  );
}

window.addEventListener("load", () => {
  postHeight();
  setTimeout(postHeight, 400);
});
new ResizeObserver(postHeight).observe(document.body);
