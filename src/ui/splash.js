// Paint-splash theme transition.
// The main process captures the window in the OLD theme and passes it here, then switches the real
// theme underneath. This overlay shows the old picture on top, then a splash of paint spreads from the
// toggle button and erases it, revealing the new theme. Everything is drawn on one canvas.
const cv = document.getElementById('c');
const ctx = cv.getContext('2d');
const TAU = Math.PI * 2;

let W = 0;
let H = 0;
let dpr = 1;
let params = null;
let base = null; // canvas holding the old-theme picture

const load = (src) => new Promise((res) => {
  if (!src) { res(null); return; }
  const i = new Image();
  i.onload = () => res(i);
  i.onerror = () => res(null);
  i.src = src;
});

window.splash.onStart(async (d) => {
  params = d;
  W = d.W;
  H = d.H;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const c of [cv]) {
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    c.style.width = `${W}px`;
    c.style.height = `${H}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const [uiImg, tabImg] = await Promise.all([load(d.ui), d.tab ? load(d.tab.url) : null]);
  base = document.createElement('canvas');
  base.width = cv.width;
  base.height = cv.height;
  const b = base.getContext('2d');
  b.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (uiImg) b.drawImage(uiImg, 0, 0, W, H);
  if (tabImg && d.tab) b.drawImage(tabImg, d.tab.x, d.tab.y, d.tab.w, d.tab.h);

  // Show the old theme right away so nothing flickers when the real theme changes underneath.
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(base, 0, 0, W, H);
  window.splash.ready();
});

window.splash.onGo(() => run());

function run() {
  const o = params.origin && Number.isFinite(params.origin.x) ? params.origin : { x: W / 2, y: H * 0.45 };
  const dist = (x, y) => Math.hypot(x - o.x, y - o.y);
  const far = Math.max(dist(0, 0), dist(W, 0), dist(0, H), dist(W, H));
  const Rmax = far * 1.3;
  const DURATION = 1500;

  // Warm gold paint when going to light, deep indigo when going to dark.
  const paint = params.toDark ? ['#4b3bc4', '#9b7dff'] : ['#ffd978', '#ff9e66'];

  // Random character for this splash: wobble, long fingers and flying droplets.
  const waves = [[3, 0.07], [5, 0.045], [9, 0.025]].map(([f, a]) => ({ f, a, ph: Math.random() * TAU }));
  const fingers = Array.from({ length: 10 }, () => ({
    a: Math.random() * TAU, w: 0.1 + Math.random() * 0.22, amp: 0.1 + Math.random() * 0.3,
  }));
  const drops = Array.from({ length: 22 }, () => ({
    a: Math.random() * TAU, d: 1.04 + Math.random() * 0.3, r: 3 + Math.random() * 11, delay: Math.random() * 0.45,
  }));

  const rim = document.createElement('canvas');
  rim.width = cv.width;
  rim.height = cv.height;
  const rctx = rim.getContext('2d');
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const radius = (theta, R, k) => {
    let r = 0;
    for (const w of waves) r += w.a * Math.sin(w.f * theta + w.ph);
    for (const f of fingers) {
      const d = Math.atan2(Math.sin(theta - f.a), Math.cos(theta - f.a));
      r += f.amp * Math.exp(-(d * d) / (2 * f.w * f.w));
    }
    return R * (1 + r * k);
  };

  // One closed outline made of the wobbly blob plus its droplets.
  const outline = (c, R, k, p) => {
    const N = 140;
    c.beginPath();
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * TAU;
      const r = radius(th, R, k);
      const x = o.x + Math.cos(th) * r;
      const y = o.y + Math.sin(th) * r;
      if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.closePath();
    for (const d of drops) {
      const q = Math.min(1, Math.max(0, (p - d.delay) / 0.4));
      if (q <= 0 || q >= 1) continue; // droplets appear, then merge into the main splash
      const rr = d.r * Math.sin(q * Math.PI);
      const dist0 = R * d.d * (0.9 + 0.1 * q);
      c.moveTo(o.x + Math.cos(d.a) * dist0 + rr, o.y + Math.sin(d.a) * dist0);
      c.arc(o.x + Math.cos(d.a) * dist0, o.y + Math.sin(d.a) * dist0, rr, 0, TAU);
    }
  };

  const t0 = performance.now();
  const frame = (now) => {
    const t = Math.min(1, (now - t0) / DURATION);
    // ease in and out: the paint starts as a small drop, surges outward, then settles
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const R = Math.max(1, Rmax * eased);
    const k = 1 - Math.pow(t, 2) * 0.8; // outline smooths out as it grows
    const band = 5 + 26 * (1 - t); // paint lip is thick at first, thin at the end

    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(base, 0, 0, W, H);

    // 1. erase the old picture inside the splash, showing the new theme underneath
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    outline(ctx, R, k, t);
    ctx.fill();

    // 2. a lip of coloured paint just outside the edge
    rctx.globalCompositeOperation = 'source-over';
    rctx.clearRect(0, 0, W, H);
    const g = rctx.createRadialGradient(o.x, o.y, R * 0.98, o.x, o.y, R + band * 2.2);
    g.addColorStop(0, paint[0]);
    g.addColorStop(1, paint[1]);
    rctx.fillStyle = g;
    outline(rctx, R + band, k, t);
    rctx.fill();
    rctx.globalCompositeOperation = 'destination-out';
    outline(rctx, R, k, t);
    rctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = Math.min(1, 1.6 * (1 - t) + 0.25);
    ctx.drawImage(rim, 0, 0, W, H);
    ctx.globalAlpha = 1;

    if (t < 1) requestAnimationFrame(frame);
    else { ctx.clearRect(0, 0, W, H); window.splash.done(); }
  };
  requestAnimationFrame(frame);
}
