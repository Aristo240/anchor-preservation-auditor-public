// Light effects for the v3 candidate: a short-lived light trail behind a fine pointer, a soft ripple on button
// presses, and the motion flag the stylesheet uses for the flow diagram and the result reveal. Everything is local
// and decorative: off under prefers-reduced-motion, switchable by the visitor (for this page; nothing is stored),
// paused when the tab is hidden.
(function () {
  "use strict";
  var root = document.documentElement;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  var fine = window.matchMedia && window.matchMedia("(pointer: fine)");
  var pref = null;   // the visitor's choice lasts for this page only: the site stores nothing
  function motionOK() { return !(reduce && reduce.matches) && pref !== "off"; }
  var btn = document.getElementById("fx-toggle");
  if (btn) btn.hidden = false;           // hidden in the HTML so it never shows when JavaScript is off
  function apply() {
    root.setAttribute("data-motion", motionOK() ? "on" : "off");
    if (btn) {
      var reduced = reduce && reduce.matches;
      btn.textContent = reduced ? "Light effects: off (reduced motion)" : "Light effects: " + (pref === "off" ? "off" : "on");
      btn.setAttribute("aria-pressed", motionOK() ? "true" : "false");
      btn.disabled = !!reduced;
    }
    if (!motionOK()) clear();
  }
  if (btn) btn.addEventListener("click", function () {
    pref = pref === "off" ? "on" : "off";
    apply();
  });
  if (reduce && reduce.addEventListener) reduce.addEventListener("change", apply);

  // ---------------------------------------------------------------- light trail (fine pointers only)
  var cv = document.getElementById("fx-trail"), ctx = cv && cv.getContext ? cv.getContext("2d") : null;
  var parts = [], raf = 0, dpr = 1, last = null, made = 0;
  function size() { if (!cv) return; dpr = Math.min(window.devicePixelRatio || 1, 2); cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; }
  function clear() { parts = []; if (ctx) ctx.clearRect(0, 0, cv.width, cv.height); }
  function tick(t) {
    raf = 0; if (!ctx) return;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.globalCompositeOperation = "lighter";
    parts = parts.filter(function (p) { return t - p.t0 < p.life; });
    parts.forEach(function (p) {
      var k = (t - p.t0) / p.life, a = (1 - k) * (1 - k) * .55, r = p.r * (1 - k * .6) * dpr;
      var x = (p.x + p.vx * k * 14) * dpr, y = (p.y + p.vy * k * 14) * dpr;
      var g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
      g.addColorStop(0, "rgba(" + p.c + "," + a + ")"); g.addColorStop(1, "rgba(" + p.c + ",0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 4, 0, Math.PI * 2); ctx.fill();
    });
    if (parts.length) raf = requestAnimationFrame(tick);
  }
  function move(e) {
    if (!motionOK() || e.pointerType !== "mouse" || document.hidden) return;
    var now = performance.now();
    if (last && now - last.t < 16) return;
    var dx = last ? e.clientX - last.x : 0, dy = last ? e.clientY - last.y : 0;
    last = { x: e.clientX, y: e.clientY, t: now };
    if (Math.abs(dx) + Math.abs(dy) < 3) return;
    parts.push({ x: e.clientX, y: e.clientY, vx: -dx * .05, vy: -dy * .05, r: 1.6 + Math.random() * 1.6,
                 life: 520 + Math.random() * 260, t0: now, c: (made++ % 3 === 2) ? "167,139,250" : "103,232,249" });
    if (parts.length > 48) parts.splice(0, parts.length - 48);
    if (!raf) raf = requestAnimationFrame(tick);
  }
  if (cv && ctx && fine && fine.matches) {
    size(); addEventListener("resize", size); addEventListener("pointermove", move, { passive: true });
    document.addEventListener("visibilitychange", function () { if (document.hidden) clear(); });
  } else if (cv) cv.remove();

  // ---------------------------------------------------------------- soft ripple on presses (pointer or keyboard)
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest(".btn");
    if (!b || !motionOK()) return;
    var r = b.getBoundingClientRect(), s = document.createElement("span");
    s.className = "ripple";
    var x = e.detail === 0 ? r.width / 2 : e.clientX - r.left, y = e.detail === 0 ? r.height / 2 : e.clientY - r.top;
    s.style.left = x + "px"; s.style.top = y + "px";     // CSSOM writes are allowed under style-src 'self'
    b.appendChild(s);
    setTimeout(function () { s.remove(); }, 650);
  });

  window.__fx = { count: function () { return parts.length; }, motion: motionOK };
  apply();
})();
