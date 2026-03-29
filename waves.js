/**
 * 3D wireframe background — shape builds edge-by-edge, then rotates.
 * Per-section channel colors (hue / bloom) via setScopeChannel from script.js.
 */
(function () {
  var canvas = document.getElementById("signalWaves");
  if (!canvas || !canvas.getContext) return;

  /* Opaque canvas composites cheaper; avoid desynchronized — uneven pacing on some GPUs. */
  var ctx = canvas.getContext("2d", { alpha: false });
  /* Cap DPR — canvas is full-window; 1× keeps GPU fill cost predictable. */
  var dpr = Math.min(window.devicePixelRatio || 1, 1);
  /** One fillRect instead of hundreds (see drawScanlines). */
  var scanlinePattern = null;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var running = true;
  var start = performance.now();
  var hiddenAt = 0;
  /**
   * Integrated rotation (rad). Using t * spin was wrong when spin lerps: a tiny Δspin
   * multiplied by large t caused huge jumps on section change.
   */
  var angleY = 0;
  var angleX = 0;
  var lastAnimTime = performance.now();
  /** Bezel is static at a given size; redraw only on resize. */
  var bezelCanvas = null;
  /** Dark CRT face (hue-independent); rebuilt on resize only. */
  var crtBaseCache = null;
  /**
   * Wireframe drawn at sub-resolution then scaled up — additive "lighter" pass is the main cost.
   */
  var WF_SCALE = 0.45;
  var wireCanvas = null;
  var wireCtx = null;
  /** Micro-parallax: pointer vs screen center, smoothed (-1..1). Disabled when reduced motion. */
  var targetParallaxX = 0;
  var targetParallaxY = 0;
  var parallaxX = 0;
  var parallaxY = 0;
  var PARALLAX_LERP = 0.06;

  var CHANNELS = [
    { hue: 118, sat: 100, bloom: [0, 95, 52], spin: 1 },
    { hue: 198, sat: 92, bloom: [0, 75, 95], spin: 1.08 },
    { hue: 48, sat: 96, bloom: [95, 78, 0], spin: 0.92 },
    { hue: 286, sat: 88, bloom: [88, 40, 120], spin: 1.05 },
    { hue: 22, sat: 94, bloom: [95, 55, 0], spin: 0.98 },
    { hue: 228, sat: 90, bloom: [35, 65, 130], spin: 1.02 },
    { hue: 152, sat: 96, bloom: [0, 110, 75], spin: 1.06 },
  ];

  var targetIndex = 0;
  var current = {
    hue: CHANNELS[0].hue,
    sat: CHANNELS[0].sat,
    bloom: CHANNELS[0].bloom.slice(),
    spin: CHANNELS[0].spin,
  };
  var LERP = reduceMotion ? 1 : 0.085;

  /** 0..1 — edges appear in order; resets on channel change */
  var buildProgress = reduceMotion ? 1 : 0;

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function lerpHue(from, to, t) {
    var d = ((to - from + 540) % 360) - 180;
    return (from + d * t + 360) % 360;
  }

  function tickChannelBlend() {
    var tgt = CHANNELS[targetIndex];
    current.hue = lerpHue(current.hue, tgt.hue, LERP);
    current.sat = lerp(current.sat, tgt.sat, LERP);
    current.bloom[0] = lerp(current.bloom[0], tgt.bloom[0], LERP);
    current.bloom[1] = lerp(current.bloom[1], tgt.bloom[1], LERP);
    current.bloom[2] = lerp(current.bloom[2], tgt.bloom[2], LERP);
    current.spin = lerp(current.spin, tgt.spin, LERP);
  }

  window.setScopeChannel = function (index) {
    var n = parseInt(index, 10);
    if (isNaN(n)) return;
    n = Math.max(0, Math.min(CHANNELS.length - 1, n));
    if (document.body) {
      document.body.setAttribute("data-scope-active", String(n));
    }
    if (n === targetIndex) return;
    targetIndex = n;
    if (!reduceMotion) {
      buildProgress = 0;
    }
    document.dispatchEvent(
      new CustomEvent("scope:channel", {
        detail: { index: targetIndex },
      })
    );
  };

  var PHOS = { lightCore: 76, lightGlow: 52 };

  function strokeLine(c, x0, y0, x1, y1, ox, oy) {
    c.beginPath();
    c.moveTo(x0 + ox, y0 + oy);
    c.lineTo(x1 + ox, y1 + oy);
    c.stroke();
  }

  var fuzzScratch = { x: 0, y: 0 };
  /** Lighter trig than before — same vibe, less work per edge. */
  function digitalFuzzOffset(ei, k, t) {
    fuzzScratch.x =
      Math.sin(ei * 2.2 + k * 0.8 + t * 0.004) * 2.9 + Math.sin(ei * 5.3 + t * 0.09) * 0.6;
    fuzzScratch.y =
      Math.cos(ei * 1.9 + k * 0.65 + t * 0.0038) * 2.9 + Math.cos(ei * 4.1 + t * 0.088) * 0.6;
    return fuzzScratch;
  }

  /* ——— Geometry: cube + octahedron (dual shapes) ——— */
  var CUBE = [
    [-1, -1, -1],
    [1, -1, -1],
    [1, 1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [1, 1, 1],
    [-1, 1, 1],
  ];
  var CUBE_EDGES = [
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 0],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];

  var OCT = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  var OCT_EDGES = [
    [0, 2],
    [0, 3],
    [0, 4],
    [0, 5],
    [1, 2],
    [1, 3],
    [1, 4],
    [1, 5],
    [2, 4],
    [2, 5],
    [3, 4],
    [3, 5],
  ];

  var ALL_EDGES = [];
  function pushShape(verts, edges, scale) {
    var i;
    for (i = 0; i < edges.length; i++) {
      ALL_EDGES.push({
        a: verts[edges[i][0]],
        b: verts[edges[i][1]],
        scale: scale,
      });
    }
  }
  pushShape(CUBE, CUBE_EDGES, 1);
  pushShape(OCT, OCT_EDGES, 0.52);

  var TOTAL_EDGES = ALL_EDGES.length;
  var projectedScratch = [];

  function rotateY(p, a) {
    var c = Math.cos(a);
    var s = Math.sin(a);
    return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
  }

  function rotateX(p, a) {
    var c = Math.cos(a);
    var s = Math.sin(a);
    return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
  }

  function transformPoint(p, scale, angX, angY, tz) {
    var x = p[0] * scale;
    var y = p[1] * scale;
    var z = p[2] * scale;
    var q = rotateY([x, y, z], angY);
    q = rotateX(q, angX);
    return [q[0], q[1], q[2] + tz];
  }

  /** Clip to z >= minZ before divide; cull only if both endpoints are behind the eye (z <= 0). */
  function clipEdgeToNearPlane(a, b, minZ) {
    var za = a[2];
    var zb = b[2];
    if (za <= 0 && zb <= 0) return null;
    if (za >= minZ && zb >= minZ) return [a, b];
    var denom = zb - za;
    if (Math.abs(denom) < 1e-9) return null;
    var t = (minZ - za) / denom;
    if (t < 0 || t > 1) return null;
    var nx = a[0] + t * (b[0] - a[0]);
    var ny = a[1] + t * (b[1] - a[1]);
    var npt = [nx, ny, minZ];
    if (za < minZ) return [npt, b];
    return [a, npt];
  }

  function project(p, W, H, focal, ox, oy) {
    ox = ox || 0;
    oy = oy || 0;
    var z = p[2];
    if (z < 0.02) z = 0.02;
    var sc = focal / z;
    return [p[0] * sc + W * 0.5 + ox, -p[1] * sc + H * 0.48 + oy, z];
  }

  function hsla(h, s, l, a) {
    return "hsla(" + h + ", " + s + "%, " + l + "%, " + a + ")";
  }

  function drawCrtFace(W, H) {
    if (crtBaseCache) {
      ctx.drawImage(crtBaseCache, 0, 0, W, H);
    }

    var br = current.bloom;
    var g2 = ctx.createRadialGradient(W * 0.5, H * 0.48, 0, W * 0.5, H * 0.5, Math.min(W, H) * 0.55);
    g2.addColorStop(0, "rgba(" + Math.round(br[0]) + "," + Math.round(br[1]) + "," + Math.round(br[2]) + ",0.14)");
    g2.addColorStop(0.55, "rgba(" + Math.round(br[0] * 0.25) + "," + Math.round(br[1] * 0.25) + "," + Math.round(br[2] * 0.25) + ",0.04)");
    g2.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, W, H);
  }

  function drawGraticule(W, H) {
    var h = current.hue;
    var s = current.sat;
    var nx = 5;
    var ny = 4;
    var sub = 3;
    var stepsX = nx * sub;
    var stepsY = ny * sub;
    var cx = W * 0.5;
    var cy = H * 0.5;

    var minor = hsla(h, s * 0.72, 52, 0.05);
    var major = hsla(h, s * 0.88, 58, 0.12);
    var centerC = hsla(h, Math.min(100, s + 5), 68, 0.28);

    var ix;
    var iy;

    /* Batched paths — was one stroke() per line (~90+ ops); now 6 strokes total. */
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = minor;
    for (ix = 0; ix <= stepsX; ix++) {
      if (ix % sub === 0) continue;
      var xv = (ix / stepsX) * W;
      if (Math.abs(xv - cx) < 1.5) continue;
      ctx.moveTo(xv, 0);
      ctx.lineTo(xv, H);
    }
    ctx.stroke();

    ctx.beginPath();
    ctx.lineWidth = 1;
    ctx.strokeStyle = major;
    for (ix = 0; ix <= stepsX; ix++) {
      if (ix % sub !== 0) continue;
      var xv2 = (ix / stepsX) * W;
      if (Math.abs(xv2 - cx) < 1.5) continue;
      ctx.moveTo(xv2, 0);
      ctx.lineTo(xv2, H);
    }
    ctx.stroke();

    ctx.beginPath();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = centerC;
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, H);
    ctx.stroke();

    ctx.beginPath();
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = minor;
    for (iy = 0; iy <= stepsY; iy++) {
      if (iy % sub === 0) continue;
      var yv = (iy / stepsY) * H;
      if (Math.abs(yv - cy) < 1.5) continue;
      ctx.moveTo(0, yv);
      ctx.lineTo(W, yv);
    }
    ctx.stroke();

    ctx.beginPath();
    ctx.lineWidth = 1;
    ctx.strokeStyle = major;
    for (iy = 0; iy <= stepsY; iy++) {
      if (iy % sub !== 0) continue;
      var yv2 = (iy / stepsY) * H;
      if (Math.abs(yv2 - cy) < 1.5) continue;
      ctx.moveTo(0, yv2);
      ctx.lineTo(W, yv2);
    }
    ctx.stroke();

    ctx.beginPath();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = centerC;
    ctx.moveTo(0, cy);
    ctx.lineTo(W, cy);
    ctx.stroke();

    ctx.strokeStyle = hsla(h, s * 0.9, 62, 0.1);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  }

  function drawScanlines(W, H) {
    if (!scanlinePattern) {
      var sl = document.createElement("canvas");
      sl.width = 1;
      sl.height = 3;
      var slCtx = sl.getContext("2d");
      slCtx.fillStyle = "rgba(0, 0, 0, 0.035)";
      slCtx.fillRect(0, 0, 1, 1);
      scanlinePattern = ctx.createPattern(sl, "repeat");
    }
    ctx.fillStyle = scanlinePattern;
    ctx.fillRect(0, 0, W, H);
  }

  function drawCrtVignette(W, H) {
    var h = current.hue;
    var g = ctx.createRadialGradient(
      W * 0.5,
      H * 0.48,
      Math.min(W, H) * 0.12,
      W * 0.5,
      H * 0.52,
      Math.max(W, H) * 0.78
    );
    g.addColorStop(0, "rgba(0, 0, 0, 0)");
    g.addColorStop(0.55, "rgba(0, 0, 0, 0.08)");
    g.addColorStop(1, "hsla(" + h + ", 40%, 4%, 0.55)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /** Subtle glass / phosphor catch at the four corners (channel-colored). */
  function drawHotCorners(W, H) {
    var h = current.hue;
    var s = current.sat;
    var r = Math.min(W, H) * 0.17;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    var corners = [
      [0, 0],
      [W, 0],
      [0, H],
      [W, H],
    ];
    var ci;
    for (ci = 0; ci < 4; ci++) {
      var cxx = corners[ci][0];
      var cyy = corners[ci][1];
      var g = ctx.createRadialGradient(cxx, cyy, 0, cxx, cyy, r);
      g.addColorStop(0, "hsla(" + h + ", " + Math.min(100, s * 0.78) + "%, 54%, 0.05)");
      g.addColorStop(0.42, "hsla(" + h + ", " + s * 0.55 + "%, 42%, 0.016)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cxx, cyy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawBezelChassisTo(c, W, H) {
    var bw = Math.max(20, Math.min(W, H) * 0.032);
    var g;

    g = c.createLinearGradient(0, 0, 0, bw);
    g.addColorStop(0, "#0d100e");
    g.addColorStop(0.5, "#060807");
    g.addColorStop(1, "#0a0c0a");
    c.fillStyle = g;
    c.fillRect(0, 0, W, bw);

    g = c.createLinearGradient(0, H - bw, 0, H);
    g.addColorStop(0, "#0a0c0a");
    g.addColorStop(0.5, "#060807");
    g.addColorStop(1, "#0d100e");
    c.fillStyle = g;
    c.fillRect(0, H - bw, W, H);

    g = c.createLinearGradient(0, 0, bw, 0);
    g.addColorStop(0, "#0c0e0c");
    g.addColorStop(1, "#060706");
    c.fillStyle = g;
    c.fillRect(0, 0, bw, H);

    g = c.createLinearGradient(W - bw, 0, W, 0);
    g.addColorStop(0, "#060706");
    g.addColorStop(1, "#0c0e0c");
    c.fillStyle = g;
    c.fillRect(W - bw, 0, bw, H);

    c.strokeStyle = "rgba(55, 75, 62, 0.35)";
    c.lineWidth = 1;
    c.strokeRect(bw - 0.5, bw - 0.5, W - bw * 2 + 1, H - bw * 2 + 1);

    c.strokeStyle = "rgba(0, 0, 0, 0.45)";
    c.strokeRect(bw + 1.5, bw + 1.5, W - bw * 2 - 3, H - bw * 2 - 3);

    var screwR = Math.min(4, bw * 0.22);
    var inset = bw * 0.45;
    var screws = [
      [inset, inset],
      [W - inset, inset],
      [inset, H - inset],
      [W - inset, H - inset],
    ];
    var si;
    for (si = 0; si < screws.length; si++) {
      var sx = screws[si][0];
      var sy = screws[si][1];
      c.beginPath();
      c.arc(sx, sy, screwR, 0, Math.PI * 2);
      c.fillStyle = "#252825";
      c.fill();
      c.strokeStyle = "rgba(0,0,0,0.45)";
      c.lineWidth = 0.5;
      c.stroke();
    }
  }

  function drawWireframe3D(c, W, H, t, angX, angY, parallaxOx, parallaxOy) {
    var hue = current.hue;
    var sat = current.sat;
    var base = Math.min(W, H) * 0.14;
    var focal = Math.min(W, H) * 0.9;
    var tz = 4.2;
    var ox = parallaxOx || 0;
    var oy = parallaxOy || 0;
    var projMinZ = 0.02;

    var edgeCount = Math.max(0, Math.min(TOTAL_EDGES, Math.ceil(buildProgress * TOTAL_EDGES)));

    var ei;
    var outI = 0;
    for (ei = 0; ei < edgeCount; ei++) {
      var e = ALL_EDGES[ei];
      var pa = transformPoint(e.a, e.scale * base, angX, angY, tz);
      var pb = transformPoint(e.b, e.scale * base, angX, angY, tz);
      var clipped = clipEdgeToNearPlane(pa, pb, projMinZ);
      if (!clipped) continue;
      pa = clipped[0];
      pb = clipped[1];
      var pA = project(pa, W, H, focal, ox, oy);
      var pB = project(pb, W, H, focal, ox, oy);
      var mz = (pA[2] + pB[2]) * 0.5;
      var pr = projectedScratch[outI];
      if (!pr) {
        pr = { x0: 0, y0: 0, x1: 0, y1: 0, z: 0, ei: 0 };
        projectedScratch[outI] = pr;
      }
      pr.x0 = pA[0];
      pr.y0 = pA[1];
      pr.x1 = pB[0];
      pr.y1 = pB[1];
      pr.z = mz;
      pr.ei = ei;
      outI++;
    }
    projectedScratch.length = outI;

    c.lineCap = "round";
    c.lineJoin = "round";

    var pi;
    for (pi = 0; pi < projectedScratch.length; pi++) {
      var pr = projectedScratch[pi];
      var x0 = pr.x0;
      var y0 = pr.y0;
      var x1 = pr.x1;
      var y1 = pr.y1;
      var depthA = 0.4 + 0.6 * Math.min(1, 2.2 / pr.z);
      var pulse = 0.9 + 0.1 * Math.sin(t * 0.00035 + pr.ei * 0.45);

      var edx = x1 - x0;
      var edy = y1 - y0;
      var elen = Math.sqrt(edx * edx + edy * edy) || 1;
      var px = -edy / elen;
      var py = edx / elen;
      /* 3 strokes/edge — halves GPU work vs 6-pass stack; order is edge index (no depth sort). */
      c.globalAlpha = 0.24 * depthA * pulse;
      c.lineWidth = 2.2;
      c.strokeStyle =
        "hsla(" + ((hue + 178) % 360) + ", " + Math.min(100, sat) + "%, 60%, 0.52)";
      strokeLine(c, x0, y0, x1, y1, px * 1.05, py * 1.05);
      c.globalAlpha = 1;

      var fo = digitalFuzzOffset(pr.ei, 0, t);
      c.strokeStyle =
        "hsla(" + hue + ", " + sat + "%, " + PHOS.lightGlow + "%, " + 0.23 * depthA * pulse + ")";
      c.lineWidth = 3.05;
      strokeLine(c, x0, y0, x1, y1, fo.x * 0.88, fo.y * 0.88);

      c.lineWidth = 1.85;
      c.strokeStyle =
        "hsla(" + hue + ", " + Math.min(100, sat * 0.35) + "%, 94%, " + 0.92 * depthA * pulse + ")";
      strokeLine(c, x0, y0, x1, y1, 0, 0);
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1);
    var w = window.innerWidth;
    var h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!crtBaseCache) crtBaseCache = document.createElement("canvas");
    crtBaseCache.width = Math.max(1, Math.floor(w));
    crtBaseCache.height = Math.max(1, Math.floor(h));
    var crtb = crtBaseCache.getContext("2d");
    var cg = crtb.createRadialGradient(
      w * 0.5,
      h * 0.42,
      0,
      w * 0.5,
      h * 0.52,
      Math.max(w, h) * 0.85
    );
    cg.addColorStop(0, "#07180f");
    cg.addColorStop(0.35, "#030c07");
    cg.addColorStop(0.75, "#010604");
    cg.addColorStop(1, "#000302");
    crtb.fillStyle = cg;
    crtb.fillRect(0, 0, crtBaseCache.width, crtBaseCache.height);

    if (!bezelCanvas) bezelCanvas = document.createElement("canvas");
    bezelCanvas.width = Math.max(1, Math.floor(w));
    bezelCanvas.height = Math.max(1, Math.floor(h));
    drawBezelChassisTo(bezelCanvas.getContext("2d"), w, h);

    if (!wireCanvas) {
      wireCanvas = document.createElement("canvas");
      wireCtx = wireCanvas.getContext("2d", { alpha: true });
    }
    var wfW = Math.max(32, Math.floor(w * WF_SCALE));
    var wfH = Math.max(32, Math.floor(h * WF_SCALE));
    wireCanvas.width = wfW;
    wireCanvas.height = wfH;
    wireCtx.imageSmoothingEnabled = true;
  }

  function frame(now) {
    if (!running) return;
    var t = now - start;
    var W = window.innerWidth;
    var H = window.innerHeight;

    tickChannelBlend();

    var dt = Math.min(Math.max(0, now - lastAnimTime), 80);
    lastAnimTime = now;
    var spin = current.spin;
    angleY += 0.00055 * spin * dt;
    angleX += 0.00035 * spin * dt;
    var wobbleX = Math.sin(t * 0.0002) * 0.15;

    if (reduceMotion) {
      parallaxX = 0;
      parallaxY = 0;
      targetParallaxX = 0;
      targetParallaxY = 0;
    } else {
      parallaxX += (targetParallaxX - parallaxX) * PARALLAX_LERP;
      parallaxY += (targetParallaxY - parallaxY) * PARALLAX_LERP;
    }

    if (!reduceMotion && buildProgress < 1) {
      buildProgress = Math.min(1, buildProgress + 0.022);
    }

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "source-over";
    drawCrtFace(W, H);
    drawGraticule(W, H);

    var pamMain = Math.min(W, H) * 0.019;
    var poxMain = parallaxX * pamMain;
    var poyMain = parallaxY * pamMain;

    if (!wireCtx || !wireCanvas) {
      ctx.globalCompositeOperation = "lighter";
      drawWireframe3D(ctx, W, H, t, angleX + wobbleX, angleY, poxMain, poyMain);
      ctx.globalCompositeOperation = "source-over";
    } else {
      var wfW = wireCanvas.width;
      var wfH = wireCanvas.height;
      var pamWf = Math.min(wfW, wfH) * 0.019;
      var poxWf = parallaxX * pamWf;
      var poyWf = parallaxY * pamWf;
      wireCtx.globalCompositeOperation = "source-over";
      wireCtx.clearRect(0, 0, wfW, wfH);
      wireCtx.globalCompositeOperation = "lighter";
      drawWireframe3D(wireCtx, wfW, wfH, t, angleX + wobbleX, angleY, poxWf, poyWf);
      ctx.globalCompositeOperation = "lighter";
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(wireCanvas, 0, 0, wfW, wfH, 0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
    }

    drawScanlines(W, H);
    drawCrtVignette(W, H);
    drawHotCorners(W, H);
    if (bezelCanvas && bezelCanvas.width === Math.floor(W) && bezelCanvas.height === Math.floor(H)) {
      ctx.drawImage(bezelCanvas, 0, 0, W, H);
    } else {
      drawBezelChassisTo(ctx, W, H);
    }

    if (reduceMotion) {
      return;
    }
    requestAnimationFrame(frame);
  }

  resize();
  window.addEventListener("resize", function () {
    resize();
    if (reduceMotion) {
      frame(performance.now());
    } else {
      requestAnimationFrame(frame);
    }
  });

  if (reduceMotion) {
    frame(performance.now());
  } else {
    requestAnimationFrame(frame);
  }

  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", function (e) {
    reduceMotion = e.matches;
    LERP = reduceMotion ? 1 : 0.085;
    buildProgress = reduceMotion ? 1 : buildProgress;
    start = performance.now();
    if (reduceMotion) {
      targetParallaxX = 0;
      targetParallaxY = 0;
      parallaxX = 0;
      parallaxY = 0;
      frame(performance.now());
    } else {
      requestAnimationFrame(frame);
    }
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      running = false;
      hiddenAt = performance.now();
    } else {
      start += performance.now() - hiddenAt;
      running = true;
      if (!reduceMotion) requestAnimationFrame(frame);
    }
  });

  window.addEventListener(
    "pointermove",
    function (e) {
      if (reduceMotion) return;
      var iw = window.innerWidth;
      var ih = window.innerHeight;
      var hc = iw * 0.5;
      var vc = ih * 0.5;
      targetParallaxX = (e.clientX - hc) / Math.max(hc, 1);
      targetParallaxY = (e.clientY - vc) / Math.max(vc, 1);
      if (targetParallaxX > 1) targetParallaxX = 1;
      else if (targetParallaxX < -1) targetParallaxX = -1;
      if (targetParallaxY > 1) targetParallaxY = 1;
      else if (targetParallaxY < -1) targetParallaxY = -1;
    },
    { passive: true }
  );
})();
