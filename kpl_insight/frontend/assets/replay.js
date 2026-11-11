var CP = (window.KPL && KPL.chartPalette) ? KPL.chartPalette() : {grid:'#E3E5EA',axis:'#D9DCE2',label:'#6E7480',line:'#2E6FD0',mark:'#F02F55',onLine:'#191B23',dot:'#FFFFFF'};
/* KPL赛研 · 单局复盘工作台（V4 阶段二）
   一条时间轴同时驱动：模型胜率 / 经济 / 资源 / 选手 / 邻近事件。
   数据由 build_replay_frames.py 预生成（assets/replay/<matchId>.json），按需加载。 */
window.KPL_REPLAY = (function () {
  "use strict";
  var esc = (window.KPL && KPL.esc) || function (v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var pct = function (v, d) { return v == null ? "—" : (Number(v) * 100).toFixed(d == null ? 0 : d) + "%"; };
  // 本组件独立于 common.js 的变量作用域：只从 window.KPL 取需要的工具，不能直接用 K
  var fmtInt = (window.KPL && window.KPL.fmtInt)
    ? function (n) { return window.KPL.fmtInt(n); }
    : function (n) { return Number(n || 0).toLocaleString("en-US"); };
  var signed = function (v, d) { var n = Number(v || 0); return (n >= 0 ? "+" : "") + n.toFixed(d == null ? 0 : d); };
  var cache = {};
  var activeJump = null;
  // 与 build_replay_frames.py 的 PLAYER_LANE_ORDER 一致：frames[].g / names 恒按此序排列
  var LANES = ["对抗路", "打野", "中路", "发育路", "游走"];
  var NEUTRAL = { tyrant: 1, dark_tyrant: 1, lord: 1, storm: 1 };

  function gdAt(points, m) {
    if (!points || !points.length) return 0;
    if (m <= points[0].m) return points[0].gd || 0;
    if (m >= points[points.length - 1].m) return points[points.length - 1].gd || 0;
    for (var i = 1; i < points.length; i++) {
      if (m <= points[i].m) {
        var a = points[i - 1], c = points[i];
        var den = c.m - a.m;
        var t = den ? (m - a.m) / den : 0;
        return (a.gd || 0) + ((c.gd || 0) - (a.gd || 0)) * t;
      }
    }
    return points[points.length - 1].gd || 0;
  }

  function keyEventsOf(b) {
    var all = (b && b.events) || [];
    var keys = all.filter(function (e) {
      return e.t === "death" || NEUTRAL[e.t] || e.t === "first_blood" ||
        (e.t === "tower" && Math.abs(e.dgd || 0) >= 1500);
    });
    return keys.length ? keys : all;
  }

  function evBadges(e) {
    var out = "";
    if (e.dgd != null) {
      out += '<em class="rp-evdg ' + (e.dgd >= 0 ? "up" : "down") + '">' + goldText(e.dgd) + "</em>";
    }
    if (e.t === "death") {
      out += '<em class="rp-evt">' + (e.respawn_sec ? "复活 " + e.respawn_sec + "s" : "终局") + "</em>";
    }
    return out;
  }

  function eventBtn(e, active) {
    return '<button type="button" class="rp-ev' + (active ? " on" : "") + '" data-m="' + e.m + '">' +
      '<span class="t mono">' + e.m.toFixed(0) + "′</span>" + esc(e.l) + evBadges(e) + "</button>";
  }

  function mmss(m) {
    var total = Math.max(0, Math.round(Number(m || 0) * 60));
    return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
  }

  function eventShort(t) {
    return ({ death: "死", first_blood: "血", kill: "击", tower: "塔", tyrant: "暴", dark_tyrant: "暗", lord: "主", storm: "龙" })[t] || "•";
  }

  function nearestFrame(b, m) {
    var fr = (b && b.frames) || [], best = 0;
    for (var i = 0; i < fr.length; i++) {
      if (Math.abs(fr[i].m - m) < Math.abs(fr[best].m - m)) best = i;
    }
    return best;
  }

  function pAtM(b, side, m) {
    var pts = ((b && b.frames) || []).filter(function (f) { return f.p != null; });
    if (!pts.length) return null;
    if (m <= pts[0].m) return side === 2 ? 1 - pts[0].p : pts[0].p;
    if (m >= pts[pts.length - 1].m) return side === 2 ? 1 - pts[pts.length - 1].p : pts[pts.length - 1].p;
    for (var i = 1; i < pts.length; i++) {
      if (m <= pts[i].m) {
        var a = pts[i - 1], c = pts[i], den = c.m - a.m;
        var t = den ? (m - a.m) / den : 0;
        var p = a.p + (c.p - a.p) * t;
        return side === 2 ? 1 - p : p;
      }
    }
    return null;
  }

  function gdAtM(b, side, m) {
    var gd = (b.gold_curve && b.gold_curve.length) ? gdAt(b.gold_curve, m) : (b.frames[0] || {}).gd || 0;
    return side === 2 ? -gd : gd;
  }

  function directionOf(dp, dg) {
    if (dp == null || dg == null || (!dp && !dg)) return "";
    return dp * dg < 0 ? "反向" : "同向";
  }

  function loadPackage(matchId, cb) {
    if (cache[matchId]) { cb(cache[matchId]); return; }
    fetch("assets/replay/" + encodeURIComponent(matchId) + ".json", { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (d) { cache[matchId] = d; cb(d); })
      .catch(function (err) { if (window.__RP_DEBUG) console.error("[replay] load failed", err); cb(null); });
  }

  function hasReplay(matchId) {
    var idx = window.KPL_REPLAY_INDEX || {};
    return !!idx[matchId];
  }

  /* ---------- 时间轴曲线（V5 设计语言：天平优势面积 + 金差条带） ---------- */
  function curveSVG(frames, t1, t2, curIdx, b) {
    var W = 1040, H = 330;
    var P = { l: 54, r: 58, t: 20 };
    var mainT = P.t, mainB = 210;
    var stripT = 232, stripB = 292, railY = 314;
    var gc = (b && b.gold_curve && b.gold_curve.length)
      ? b.gold_curve
      : frames.map(function (f) { return { m: f.m, gd: f.gd || 0 }; });
    var maxM = Math.max(10, frames[frames.length - 1].m, gc[gc.length - 1].m);
    var light = !document.documentElement.classList.contains("dark-site");
    var T1 = light ? "#C43A4B" : "#FF7184";
    var T2 = light ? "#2E6FD0" : "#6FA5FF";
    var LINE = light ? "#12203A" : "#E8EEF7";
    var GRID = light ? "#E3E8F1" : "#22304A";
    var LABEL = light ? "#64738B" : "#8FA0B8";
    var CARD = light ? "#FFFFFF" : "#111A29";
    var X = function (m) { return P.l + m / maxM * (W - P.l - P.r); };
    var Y = function (p) { return mainB - p * (mainB - mainT); };
    var gds = gc.map(function (f) { return Number(f.gd) || 0; });
    var gMax = Math.max(1000, Math.max.apply(null, gds.map(Math.abs))) * 1.15;
    var YG = function (v) { return (stripT + stripB) / 2 - v / gMax * ((stripB - stripT) / 2 - 4); };
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" aria-label="胜率与金差时间轴">';
    s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + CARD + '"/>';
    /* 0–100% 胜率网格；50% 是唯一基线 */
    [0, 25, 50, 75, 100].forEach(function (pct) {
      var y = Y(pct / 100).toFixed(1);
      var zero = pct === 50;
      s += '<line x1="' + P.l + '" y1="' + y + '" x2="' + (W - P.r) + '" y2="' + y +
        '" stroke="' + GRID + '"' + (zero ? "" : ' stroke-dasharray="4 7"') + ' opacity="' + (zero ? 1 : .9) + '"/>' +
        '<text x="' + (P.l - 9) + '" y="' + (parseFloat(y) + 4) + '" text-anchor="end" font-size="10.5" fill="' + LABEL +
        '" font-family="Inter,monospace">' + pct + "%</text>";
    });
    s += '<text x="' + (P.l + 6) + '" y="' + (Y(0.5) - 6).toFixed(1) + '" font-size="10" fill="' + LABEL +
      '" font-family="Inter,monospace">五五开</text>';
    /* 领先带：只从 50% 基线长出来，低透明度，不再糊成整块 */
    function areaPath(sign) {
      var d = "";
      frames.forEach(function (f, i) {
        var p = f.p == null ? 0.5 : Math.max(0, Math.min(1, Number(f.p)));
        var v = sign > 0 ? Math.max(0.5, p) : Math.min(0.5, p);
        d += (i ? "L" : "M") + X(f.m).toFixed(1) + " " + Y(v).toFixed(1) + " ";
      });
      var first = frames[0].m, last = frames[frames.length - 1].m;
      return d + "L" + X(last).toFixed(1) + " " + Y(0.5).toFixed(1) + " L" + X(first).toFixed(1) + " " +
        Y(0.5).toFixed(1) + " Z";
    }
    s += '<path d="' + areaPath(1) + '" fill="' + T1 + '" fill-opacity=".12" stroke="none"/>';
    s += '<path d="' + areaPath(-1) + '" fill="' + T2 + '" fill-opacity=".12" stroke="none"/>';
    /* 胜率主线 */
    var line = "";
    frames.forEach(function (f, i) {
      var p = f.p == null ? 0.5 : Math.max(0, Math.min(1, Number(f.p)));
      line += (i ? "L" : "M") + X(f.m).toFixed(1) + " " + Y(p).toFixed(1) + " ";
    });
    s += '<path d="' + line + '" fill="none" stroke="' + LINE + '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>';
    /* 金差条带 */
    s += '<rect x="' + P.l + '" y="' + stripT + '" width="' + (W - P.l - P.r) + '" height="' + (stripB - stripT) +
      '" rx="7" fill="' + GRID + '" opacity=".5"/>';
    var gLine = "", gPos = "", gNeg = "";
    gc.forEach(function (f, i) {
      var x = X(f.m).toFixed(1), y = YG(f.gd || 0).toFixed(1);
      gLine += (i ? "L" : "M") + x + " " + y + " ";
      gPos += (i ? "L" : "M") + x + " " + YG(Math.max(0, f.gd || 0)).toFixed(1) + " ";
      gNeg += (i ? "L" : "M") + x + " " + YG(Math.min(0, f.gd || 0)).toFixed(1) + " ";
    });
    var gx0 = X(gc[0].m).toFixed(1), gx1 = X(gc[gc.length - 1].m).toFixed(1), gy0 = YG(0).toFixed(1);
    s += '<path d="' + gPos + "L" + gx1 + " " + gy0 + " L" + gx0 + " " + gy0 + ' Z" fill="' + T1 + '" fill-opacity=".14" stroke="none"/>';
    s += '<path d="' + gNeg + "L" + gx1 + " " + gy0 + " L" + gx0 + " " + gy0 + ' Z" fill="' + T2 + '" fill-opacity=".14" stroke="none"/>';
    s += '<path d="' + gLine + '" fill="none" stroke="' + LINE + '" stroke-width="1.4" opacity=".55"/>';
    s += '<line x1="' + P.l + '" y1="' + gy0 + '" x2="' + (W - P.r) + '" y2="' + gy0 + '" stroke="' + GRID + '" opacity=".9"/>';
    [gMax, 0, -gMax].forEach(function (gv) {
      s += '<text x="' + (W - P.r + 8) + '" y="' + (YG(gv) + 4).toFixed(1) + '" font-size="10" fill="' + LABEL +
        '" font-family="Inter,monospace">' + (gv > 0 ? "+" : gv < 0 ? "−" : "") +
        (Math.abs(gv) / 1000).toFixed(gv === 0 ? 0 : 1) + "k</text>";
    });
    s += '<text x="' + (P.l - 9) + '" y="' + ((stripT + stripB) / 2 + 4).toFixed(1) + '" text-anchor="end" font-size="10" fill="' +
      LABEL + '" font-family="Inter,monospace">金差</text>';
    var stepM = maxM > 40 ? 10 : 5;
    for (var m = 0; m <= maxM; m += stepM) {
      s += '<text x="' + X(m).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10.5" fill="' + LABEL +
        '" font-family="Inter,monospace">' + m + "′</text>";
    }
    /* 关键事件：少量竖线 + 底部圆点，避免糊屏 */
    var evs = keyEventsOf(b).filter(function (e) { return e.key !== 0 && e.m != null; }).slice(-12);
    evs.forEach(function (e) {
      var ex = X(e.m);
      if (ex < P.l || ex > W - P.r) return;
      var color = e.team === t1 ? T1 : e.team === t2 ? T2 : LABEL;
      s += '<g><line x1="' + ex.toFixed(1) + '" y1="' + mainT + '" x2="' + ex.toFixed(1) + '" y2="' + stripB +
        '" stroke="' + color + '" stroke-width="1" stroke-dasharray="3 5" opacity=".15"/>' +
        '<circle cx="' + ex.toFixed(1) + '" cy="' + railY + '" r="2.6" fill="' + color + '" opacity=".9"/>' +
        '<title>' + esc(e.m.toFixed(1) + "′ " + e.l) + "</title></g>";
    });
    s += '<text x="' + (P.l - 9) + '" y="' + (railY + 4) + '" text-anchor="end" font-size="10" fill="' + LABEL +
      '" font-family="Inter,monospace">事件</text>';
    /* 当前帧游标 */
    var cf = frames[curIdx] || frames[frames.length - 1];
    var cx = X(cf.m).toFixed(1);
    var pCur = cf.p == null ? 0.5 : Math.max(0, Math.min(1, Number(cf.p)));
    var cy = Y(pCur).toFixed(1);
    var gy = YG(gdAt(gc, cf.m)).toFixed(1);
    s += '<line x1="' + cx + '" y1="' + mainT + '" x2="' + cx + '" y2="' + stripB + '" stroke="' + LABEL +
      '" stroke-width="1" stroke-dasharray="3 4" opacity=".8"/>';
    s += '<circle cx="' + cx + '" cy="' + cy + '" r="4.5" fill="' + CARD + '" stroke="' + LINE + '" stroke-width="2.2"/>';
    s += '<circle cx="' + cx + '" cy="' + gy + '" r="3.2" fill="' + CARD + '" stroke="' + T1 + '" stroke-width="1.8"/>';
    s += '<text x="' + (parseFloat(cx) + 8) + '" y="' + (parseFloat(cy) - 8).toFixed(1) + '" font-size="11" font-weight="700" fill="' +
      LINE + '" font-family="Inter,monospace">' + Math.round(pCur * 100) + "%</text>";
    s += '<text x="' + (parseFloat(cx) + 8) + '" y="' + (parseFloat(gy) - 6).toFixed(1) + '" font-size="10" fill="' +
      LABEL + '" font-family="Inter,monospace">' + goldText(gdAt(gc, cf.m)) + "</text>";
    s += '<text x="' + (W - P.r) + '" y="' + (P.t - 4) + '" text-anchor="end" font-size="10.5" font-family="Inter,monospace">' +
      '<tspan fill="' + T1 + '">●</tspan><tspan fill="' + LABEL + '"> ' + esc(t1) +
      '</tspan><tspan fill="' + LABEL + '"> vs </tspan><tspan fill="' + T2 + '">●</tspan><tspan fill="' + LABEL + '"> ' + esc(t2) + "</tspan></text>";
    s += "</svg>";
    return s;
  }

  /* ---------- 面板 ---------- */
  /* 分层一：队伍总量。用一条按分路拆分的堆叠条替代直接铺 10 列，
     色阶从亮到暗对应 对抗路→游走，先看"总量与结构"，再决定要不要展开到逐人。 */
  function laneBars(g, total) {
    var t = Math.max(1, total);
    return '<div class="rp-lb">' + g.map(function (v, i) {
      var w = Math.max(0, (v || 0) / t * 100);
      return '<i class="ln' + i + '" style="width:' + w.toFixed(1) + '%" title="' +
        LANES[i] + " " + fmtInt(v || 0) + '"></i>';
    }).join("") + "</div>";
  }

  function goldPanel(b, f, prev, layer) {
    var gd = f.gd, d = prev ? gd - prev.gd : 0;
    var g1 = f.g[0] || [], g2 = f.g[1] || [];
    var sum = function (a) { return a.reduce(function (x, v) { return x + (v || 0); }, 0); };
    var t1 = sum(g1), t2 = sum(g2);
    var head = '<div class="rp-pt">经济状态 <em class="mono">金差 ' + signed(gd) +
      (prev ? " · 较上一帧 " + signed(d) : "") + "</em>" +
      '<span class="rp-gold-src">' + (b.gold_src === "camp+local" ? "营地网格 + 本地校准" : "本地分钟") + "</span></div>";
    if (layer !== "lane") {
      return '<div class="rp-panel">' + head +
        '<div class="rp-gd"><b class="' + (gd >= 0 ? "up" : "down") + '">' + signed(gd) + "</b>" +
        '<span class="mono">' + esc(b.t1) + " 视角</span></div>" +
        '<div class="rp-tot"><span>' + esc(b.t1) + ' 总经济</span><b class="mono">' + fmtInt(t1) + "</b>" +
        '<span>' + esc(b.t2) + ' 总经济</span><b class="mono">' + fmtInt(t2) + "</b></div>" +
        '<div class="rp-lbwrap"><div class="rp-lbrow"><span>' + esc(b.t1) + "</span>" + laneBars(g1, t1) + "</div>" +
        '<div class="rp-lbrow"><span>' + esc(b.t2) + "</span>" + laneBars(g2, t2) + "</div>" +
        '<div class="rp-lbaxis">' + LANES.map(function (n, i) {
          return '<span class="ln' + i + '">' + n + "</span>";
        }).join("") + "</div></div>" +
        '<p class="rp-disc">五段色阶按分路拆分（亮→暗：' + LANES.join(" → ") +
        '）。要看逐人同位置对位，切到「分路对位」。</p></div>';
    }
    var rows = [];
    for (var i = 0; i < Math.max(g1.length, g2.length); i++) {
      var a = g1[i] || 0, c = g2[i] || 0;
      var n1 = (b.names || [])[i] || "?", n2 = (b.names || [])[i + 5] || "?";
      rows.push('<tr><td class="ln">' + (LANES[i] || "—") + '</td>' +
        '<td class="n">' + esc(n1) + '</td><td class="num">' + fmtInt(a) + '</td>' +
        '<td class="d ' + (a - c >= 0 ? "up" : "down") + '">' + signed(a - c) + "</td>" +
        '<td class="num">' + fmtInt(c) + '</td><td class="n r">' + esc(n2) + "</td></tr>");
    }
    return '<div class="rp-panel">' + head +
      '<div class="rp-gd"><b class="' + (gd >= 0 ? "up" : "down") + '">' + signed(gd) + "</b>" +
      '<span class="mono">' + esc(b.t1) + " 视角</span></div>" +
      '<div class="rp-tblwrap"><table class="rp-tbl"><thead><tr><th>分路</th><th>' + esc(b.t1) +
      '</th><th class="num">金币</th><th class="num">差值</th><th class="num">金币</th><th class="r">' +
      esc(b.t2) + "</th></tr></thead><tbody>" + rows.join("") + "</tbody></table></div>" +
      '<p class="rp-disc">同一行 = 同一分路，两侧选手按官方对位行序对齐（对抗路→游走）。</p></div>';
  }

  /* 转折诊断：在模型胜率序列上找"方向一致且幅度最大"的摆动段（变点检测的轻量版）。
     只陈述"这段时间里胜率方向明确变化"，不做因果归因；无直播胜率的局直接跳过。 */
  function turningPoints(b) {
    var fr = b.frames || [];
    var withP = fr.filter(function (x) { return x.p != null; }).length;
    if (withP < 3) return [];
    var segs = [], cur = null;
    for (var i = 1; i < fr.length; i++) {
      var a = fr[i - 1].p, c = fr[i].p;
      if (a == null || c == null) continue;
      var d = c - a;
      if (Math.abs(d) < 0.004) continue;
      var dir = d > 0 ? 1 : -1;
      if (cur && cur.dir === dir) {
        cur.to = c; cur.endIdx = i; cur.mag = Math.abs(c - cur.from);
      } else {
        if (cur) segs.push(cur);
        cur = { dir: dir, from: a, to: c, startIdx: i - 1, endIdx: i, mag: Math.abs(d) };
      }
    }
    if (cur) segs.push(cur);
    segs.sort(function (x, y) { return y.mag - x.mag; });
    return segs.slice(0, 3);
  }

  /* ---------- 赛后故事层：一句话结论 + 关键节点 ----------
     原则：
       1. 只陈述数据里能直接读到的变化，不写因果；
       2. 官方 / 代理 / 估算分开标注；
       3. 没有直播胜率的局退回官方事件 + 经济快照，不拿赛后重放曲线做结论。 */
  function teamName(b, side) { return side === 1 ? b.t1 : b.t2; }
  function pOf(f, side) {
    if (!f || f.p == null) return null;
    return side === 1 ? f.p : 1 - f.p;
  }
  function gdOf(f, side) {
    if (!f || f.gd == null) return null;
    return side === 1 ? f.gd : -f.gd;
  }
  function minute(v) {
    var x = Math.round(Number(v || 0) * 10) / 10;
    return String(x).replace(/\.0$/, "");
  }
  function goldText(v) {
    if (v == null || isNaN(v)) return "—";
    var a = Math.abs(v);
    var body = a >= 1000 ? (a / 1000).toFixed(1) + "k" : Math.round(a).toString();
    return (v > 0 ? "+" : v < 0 ? "-" : "") + body;
  }
  function eventsNear(b, m0, m1, pad) {
    var p = pad == null ? 0.8 : pad;
    var seen = {}, out = [];
    (b.events || []).forEach(function (e) {
      if (e.m < m0 - p || e.m > m1 + p) return;
      var key = e.l + "@" + e.m;
      if (seen[key]) return;
      seen[key] = 1;
      out.push(e);
    });
    return out.sort(function (a, c) { return a.m - c.m; }).slice(0, 4);
  }
  function segmentList(b) {
    var fr = b.frames || [], segs = [], cur = null;
    for (var i = 1; i < fr.length; i++) {
      var a = fr[i - 1].p, c = fr[i].p;
      if (a == null || c == null) { if (cur) { segs.push(cur); cur = null; } continue; }
      var d = c - a;
      if (Math.abs(d) < 0.004) continue;
      var dir = d > 0 ? 1 : -1;
      if (cur && cur.dir === dir && cur.end === i - 1) {
        cur.to = c; cur.end = i; cur.mag = Math.abs(c - cur.from);
      } else {
        if (cur) segs.push(cur);
        cur = { dir: dir, from: a, to: c, start: i - 1, end: i, mag: Math.abs(d) };
      }
    }
    if (cur) segs.push(cur);
    segs = segs.filter(function (s) {
      var m0 = fr[s.start].m, m1 = fr[s.end].m;
      // 几秒钟内跳 8pp 以内更像采样噪声，不当作“转折”
      return !(m1 - m0 < 0.75 && s.mag < 0.08);
    });
    segs.forEach(function (s) {
      s.m0 = fr[s.start].m;
      s.m1 = fr[s.end].m;
      s.favored = s.dir > 0 ? 1 : 2;
      s.p0 = pOf(fr[s.start], s.favored);
      s.p1 = pOf(fr[s.end], s.favored);
      s.g0 = gdOf(fr[s.start], s.favored);
      s.g1 = gdOf(fr[s.end], s.favored);
    });
    return segs;
  }
  function decisiveSegment(b, segs) {
    if (b.win !== 1 && b.win !== 2) return null;
    var fav = segs.filter(function (s) { return s.favored === b.win; });
    if (!fav.length) return null;
    function heldToEnd(s) {
      var pe = pOf(b.frames[s.end], b.win);
      if (pe == null || pe < 0.5) return false;
      for (var i = s.end + 1; i < b.frames.length; i++) {
        var p = pOf(b.frames[i], b.win);
        if (p != null && p < 0.5) return false;
      }
      return true;
    }
    var held = fav.filter(heldToEnd);
    var out;
    if (held.length) {
      var startP = pOf(b.frames[0], b.win);
      // 开局落后：取“第一次领先后再没交回去”的窗口；开局领先：取优势扩得最大的一段。
      held.sort(startP != null && startP < 0.5
        ? function (a, c) { return a.m0 - c.m0; }
        : function (a, c) { return c.mag - a.mag; });
      out = held[0];
    } else {
      // 整局有反复：取对赢家最有利的最大摆动，但明确不写“决定胜负”。
      out = fav.slice().sort(function (a, c) { return c.mag - a.mag; })[0];
    }
    out.held = heldToEnd(out);
    return out;
  }
  function recentCoverage() {
    var sched = window.KPL_SCHEDULE_ALL || [], idx = window.KPL_REPLAY_INDEX || {};
    var done = sched.filter(function (r) {
      return r && (r.st === 2 || r.done === true) && r.date && r.matchId;
    }).sort(function (a, c) { return (c.date + (c.time || "")).localeCompare(a.date + (a.time || "")); });
    var rows = done.slice(0, 10), covered = 0;
    rows.forEach(function (r) { if (idx[r.matchId]) covered++; });
    return rows.length ? { n: rows.length, covered: covered } : null;
  }
  var _coverage = null;
  function coverageStats() {
    if (_coverage) return _coverage;
    var idx = window.KPL_REPLAY_INDEX || {}, matches = 0, battles = 0, prob = 0;
    Object.keys(idx).forEach(function (mid) {
      var e = idx[mid] || {};
      matches++;
      var bs = e.b || [], ps = e.p || [];
      battles += bs.length;
      for (var i = 0; i < bs.length; i++) if (ps[i]) prob++;
    });
    var total = Number((window.KPL_TOTALS || {}).battles) || 0;
    if (!total) {
      try { total = Number(window.KPL_SEASONS.scopes.all.totals.battles) || 0; }
      catch (e) { total = 0; }
    }
    _coverage = {
      matches: matches, battles: battles, probBattles: prob, totalBattles: total,
      recent: recentCoverage()
    };
    return _coverage;
  }
  function coverageText(b) {
    var c = coverageStats(), parts = [];
    parts.push("本局分钟级快照 " + (b.frames || []).length + " 帧");
    if (c.probBattles && c.totalBattles) {
      parts.push("全站有直播胜率 " + c.probBattles + " / " + fmtInt(c.totalBattles) +
        " 局（" + (c.probBattles / c.totalBattles * 100).toFixed(1) + "%，其余仅基础数据）");
    }
    if (c.recent && c.recent.n >= 5) {
      parts.push("最近 " + c.recent.n + " 场（实时监控期）" + c.recent.covered + "/" + c.recent.n + " 场可复盘");
    }
    return parts.join(" · ");
  }
  function clusterKeyEvents(b) {
    var evs = keyEventsOf(b).filter(function (e) { return e.m != null; })
      .sort(function (a, c) { return a.m - c.m; });
    var groups = [];
    evs.forEach(function (e) {
      var g = groups[groups.length - 1];
      if (g && e.m - g.m1 <= 1.2) { g.evs.push(e); g.m1 = e.m; }
      else groups.push({ evs: [e], m0: e.m, m1: e.m });
    });
    return groups.map(function (g) {
      var deaths = g.evs.filter(function (e) { return e.t === "death"; });
      var teams = {};
      g.evs.forEach(function (e) { if (e.team) teams[e.team] = (teams[e.team] || 0) + 1; });
      var team = Object.keys(teams).sort(function (a, c) { return teams[c] - teams[a]; })[0] || "";
      var side = team === b.t1 ? 1 : team === b.t2 ? 2 : null;
      var neutral = g.evs.filter(function (e) { return NEUTRAL[e.t]; })[0];
      var label, kind, iconType;
      if (deaths.length >= 2) {
        label = "团战 · " + team; kind = "fight"; iconType = "death";
      } else if (deaths.length === 1) {
        label = deaths[0].l; kind = "death"; iconType = "death";
      } else if (neutral) {
        label = neutral.l; kind = "objective"; iconType = neutral.t;
      } else {
        label = g.evs[0].l; kind = "event"; iconType = g.evs[0].t;
      }
      var p0 = side ? pAtM(b, side, Math.max(0, g.m0 - 0.5)) : null;
      var p1 = side ? pAtM(b, side, g.m1 + 0.5) : null;
      var gd0 = side ? gdAtM(b, side, g.m0) : null;
      var gd1 = side ? gdAtM(b, side, g.m1) : null;
      var dp = (p0 != null && p1 != null) ? (p1 - p0) * 100 : null;
      var dg = (gd0 != null && gd1 != null) ? (gd1 - gd0) : null;
      return {
        m0: g.m0, m1: g.m1, side: side, team: team, label: label, kind: kind,
        icon: eventShort(iconType), iconType: iconType,
        p0: p0, p1: p1, g0: gd0, g1: gd1, dp: dp, dg: dg,
        conflict: dp != null && dg != null && dp * dg < 0,
        evs: g.evs
      };
    });
  }

  function storyNodes(b, decisive) {
    var nodes = [];
    if (decisive) {
      var dp = (decisive.p1 - decisive.p0) * 100;
      var dg = decisive.g1 - decisive.g0;
      nodes.push({
        m0: decisive.m0, m1: decisive.m1, side: decisive.favored,
        team: teamName(b, decisive.favored), label: "模型跳变",
        kind: "model", icon: "模", iconType: "model",
        p0: decisive.p0, p1: decisive.p1, g0: decisive.g0, g1: decisive.g1,
        dp: dp, dg: dg,
        conflict: dp * dg < 0,
        evs: eventsNear(b, decisive.m0, decisive.m1, 0.8)
      });
    }
    var clusters = clusterKeyEvents(b).filter(function (c) {
      return !decisive || c.m1 < decisive.m0 - 1.2 || c.m0 > decisive.m1 + 1.2;
    });
    clusters.sort(function (a, c) { return Math.abs(c.dg || 0) - Math.abs(a.dg || 0); });
    clusters.slice(0, decisive ? 3 : 4).forEach(function (c) { nodes.push(c); });
    nodes.sort(function (a, c) { return a.m0 - c.m0; });
    return nodes.slice(0, 5);
  }

  function buildStory(b) {
    var fr = b.frames || [], win = b.win;
    var story = {
      hasProb: b.src === "live" && fr.filter(function (f) { return f.p != null; }).length >= 3,
      winner: win === 1 || win === 2 ? teamName(b, win) : "—",
      duration: Number(b.dur || 0),
      sentence: "", note: "", decisive: null,
      nodes: [], directionConflict: false
    };
    if (win !== 1 && win !== 2) {
      story.sentence = "本局结果未记录，无法生成胜负结论。可展开时间轴查看官方事件与经济快照。";
      story.note = "官方结果缺失";
      return story;
    }
    var finalP = null;
    for (var fi = fr.length - 1; fi >= 0; fi--) {
      if (fr[fi].p != null) { finalP = pOf(fr[fi], win); break; }
    }
    story.finalP = finalP;
    story.modelAgrees = finalP == null ? null : finalP >= 0.5;
    if (story.hasProb && fr.length >= 3 && story.modelAgrees === false) {
      // 终局方向和官方结果相反：这局不能用胜率曲线讲“谁赢在哪一段”，
      // 只保留官方事件与经济快照，并把模型未命中说清楚。
      story.sentence = "<b>" + esc(story.winner) + "</b> 最终在 " + minute(story.duration) +
        "′ 结束比赛。但模型最后一帧只给 " + esc(story.winner) + " <b>" + pct(finalP) +
        "</b> 的胜率，方向和官方结果相反，所以本页不拿这条曲线解释胜负；" +
        "下面按官方事件与经济快照列出关键节点。";
      story.note = "模型终局判断与官方结果相反（" + pct(finalP) + "），不藏。此处只陈述官方事件与经济代理，不做胜负归因。";
    } else if (story.hasProb && fr.length >= 3) {
      var segs = segmentList(b);
      var decisive = decisiveSegment(b, segs);
      story.decisive = decisive;
      if (decisive) {
        var evs = eventsNear(b, decisive.m0, decisive.m1, 0.8);
        var evText = evs.length
          ? "同段官方事件为 " + evs.slice(0, 3).map(function (e) { return esc(e.l); }).join(" / ") + "。"
          : "同段没有结构性事件记录。";
        var dp = (decisive.p1 - decisive.p0) * 100;
        var dg = decisive.g1 - decisive.g0;
        story.directionConflict = dp * dg < 0;
        story.sentence = "<b>" + esc(story.winner) + "</b> 在第 " + minute(decisive.m0) + "–" +
          minute(decisive.m1) + " 分钟把估算胜率从 <b>" + pct(decisive.p0) + "</b> 拉到 <b>" +
          pct(decisive.p1) + "</b>（" + signed(dp) + "pp），" +
          "同期金差从 " + goldText(decisive.g0) + " 到 " + goldText(decisive.g1) +
          (story.directionConflict ? "（方向相反）" : "") + "；" + evText +
          (decisive.held ? "此后模型胜率未再低于 50%。" : "") +
          "最终在 " + minute(story.duration) + "′ 结束比赛。";
        story.note = story.directionConflict
          ? "胜率跳变与金差方向不一致，可能由阵容、先验或其他特征驱动；这里只陈述同期发生，不写成因果。"
          : (decisive.held
            ? "“胜负窗口”按模型胜率选择：该段结束后领先方再未被模型判为落后。只描述同段共现，不构成因果。"
            : "“胜负窗口”按模型胜率变化幅度选择；该段结束后仍有反复，不写成“决定胜负”。");
      } else {
        story.sentence = "<b>" + esc(story.winner) + "</b> 最终在 " + minute(story.duration) +
          "′ 结束比赛。整局没有出现方向明确、幅度足够大的模型胜率摆动，无法指出单一胜负窗口。";
        story.note = "本局胜率曲线没有可判定的转折段。";
      }
    } else {
      story.sentence = "<b>" + esc(story.winner) + "</b> 最终在 " + minute(story.duration) +
        "′ 结束比赛。本局没有直播期模型胜率记录，不能用胜率判断转折；" +
        "下面按官方事件与经济快照列出关键节点。";
      story.note = "没有直播胜率时，结论只依赖官方事件与经济代理，不写“胜率逆转”。";
    }
    story.nodes = storyNodes(b, story.decisive);
    if (story.modelAgrees === false) {
      story.nodes.forEach(function (n) {
        n.p0 = null; n.p1 = null; n.dp = null; n.conflict = false;
      });
    }
    return story;
  }
  function storyHTML(b) {
    var s = buildStory(b);
    var hasBp = !!document.querySelector(".bp-grid");
    var hrefAnalog = "sandbox.html?battle=" + encodeURIComponent(b.battleId) +
      "&m=" + encodeURIComponent(minute(s.decisive ? s.decisive.m0 : (b.frames[0] || {}).m || 0));
    var kpis = "";
    if (s.decisive) {
      var dp0 = (s.decisive.p1 - s.decisive.p0) * 100;
      var dg0 = s.decisive.g1 - s.decisive.g0;
      kpis = '<div class="rp-kpis">' +
        '<span class="rp-kpi"><b class="mono up">' + signed(dp0) + "pp</b><em>估算胜率</em></span>" +
        '<span class="rp-kpi' + (s.directionConflict ? " warn" : "") + '"><b class="mono ' +
        (dg0 >= 0 ? "up" : "down") + '">' + goldText(dg0) + "</b><em>金差" +
        (s.directionConflict ? " · 反向" : "") + "</em></span>" +
        '<span class="rp-kpi"><b class="mono">' + (s.nodes || []).length + "</b><em>关键节点</em></span>" +
        "</div>";
    } else if ((s.nodes || []).length) {
      kpis = '<div class="rp-kpis">' +
        (s.hasProb && s.finalP != null
          ? '<span class="rp-kpi' + (s.modelAgrees === false ? " warn" : "") +
            '"><b class="mono">' + pct(s.finalP) + "</b><em>模型终局</em></span>"
          : "") +
        '<span class="rp-kpi"><b class="mono">' + s.nodes.length + "</b><em>关键节点</em></span>" +
        "</div>";
    }
    var rows = (s.nodes || []).map(function (n) {
      var dp = n.dp, dg = n.dg;
      var conflict = n.conflict || (dp != null && dg != null && dp * dg < 0);
      var pTxt = (n.p0 == null || n.p1 == null) ? "—" :
        pct(n.p0) + " → " + pct(n.p1) + ' <em class="' + (dp >= 0 ? "up" : "down") + '">' +
        signed(dp, 0) + "pp</em>";
      var gTxt = (n.g0 == null || n.g1 == null) ? "—" :
        goldText(n.g0) + " → " + goldText(n.g1) + ' <em class="' + (dg >= 0 ? "up" : "down") + '">' +
        goldText(dg) + "</em>";
      var dir = (dp == null || dg == null) ? "—" :
        (conflict ? '<span class="rp-dir warn">反向</span>' : '<span class="rp-dir">同向</span>');
      var time = mmss(n.m0) + (n.m1 - n.m0 > 0.15 ? "–" + mmss(n.m1) : "");
      var icon = n.icon || eventShort(n.iconType || n.kind);
      return '<tr class="rp-node" data-m="' + n.m0 + '" tabindex="0">' +
        '<td class="mono">' + time + "</td>" +
        '<td><span class="rp-node-i">' + esc(icon) + "</span>" + esc(n.label) + "</td>" +
        '<td class="num">' + pTxt + "</td>" +
        '<td class="num">' + gTxt + "</td>" +
        "<td>" + dir + "</td></tr>";
    }).join("");
    var table = rows
      ? '<div class="rp-node-wrap"><table class="rp-node-table"><thead><tr><th>时间</th><th>关键节点</th>' +
        '<th class="num">估算胜率</th><th class="num">金差</th><th>方向</th></tr></thead><tbody>' +
        rows + "</tbody></table></div>"
      : "";
    return '<div class="rp-story">' +
      '<div class="rp-story-kicker"><span class="mono">本局结论 · G' + (b.seq || 1) + "</span>" +
      '<span class="rp-tag official">官方结果</span>' +
      (s.hasProb
        ? (s.modelAgrees === false
            ? '<span class="rp-tag warn">模型终局未命中</span>'
            : '<span class="rp-tag est">模型估算</span>')
        : '<span class="rp-tag proxy">无直播胜率</span>') +
      '<span class="rp-story-who">' + esc(b.t1) + " vs " + esc(b.t2) + " · " + minute(b.dur) + "′</span></div>" +
      '<div class="rp-story-lead">' + s.sentence + "</div>" +
      kpis + table +
      '<div class="rp-story-note">' + s.note + "</div>" +
      '<div class="rp-story-foot"><span class="rp-cov mono">' + coverageText(b) + "</span>" +
      '<span class="rp-legend"><span class="rp-tag official">官方</span>结果 / 击杀 / 推塔 / 资源　' +
      '<span class="rp-tag proxy">代理</span>金差　<span class="rp-tag est">估算</span>模型胜率</span>' +
      '<span class="rp-story-acts">' +
      '<button type="button" class="rp-more" id="rpExpand" aria-expanded="false" aria-controls="rpDetail">展开完整时间轴与数据面板 ↓</button>' +
      '<a class="rp-link" href="' + hrefAnalog + '">看历史上类似局面 →</a>' +
      (hasBp
        ? '<button type="button" class="rp-link" id="rpBp">看 BP 与选手 ↓</button>'
        : '<a class="rp-link" href="game.html?id=' + encodeURIComponent(b.battleId) + '">看本局 BP 与选手 →</a>') +
      "</span></div></div>";
  }

  function tpPanel(b) {
    var tps = turningPoints(b);
    if (!tps.length) {
      return '<details class="rp-tp-fold"><summary><span>完整变点列表</span><span class="mono">无显著转折</span></summary>' +
        '<p class="rp-disc">' +
        (b.src === "replay"
          ? "本局没有直播期模型胜率记录，赛后重放曲线波动大，不做转折判定。"
          : "本局胜率曲线平稳，未检出显著转折段。") + "</p></details>";
    }
    var items = tps.map(function (t) {
      var m0 = b.frames[t.startIdx].m, m1 = b.frames[t.endIdx].m;
      var near = (b.events || []).filter(function (e) { return e.m >= m0 - 1 && e.m <= m1 + 1; });
      return '<div class="rp-tp-item"><div class="rp-tp-hd">' +
        '<span class="t mono">' + mmss(m0) + " → " + mmss(m1) + "</span>" +
        '<b>' + esc(t.dir > 0 ? b.t1 : b.t2) + " 占优</b>" +
        '<span class="pp ' + (t.dir > 0 ? "up" : "down") + '">' + pct(t.from) + " → " + pct(t.to) +
        "（" + signed((t.to - t.from) * 100) + "pp）</span></div>" +
        '<div class="rp-tp-ev">' + (near.length
          ? "同段事件：" + near.map(function (e) { return esc(e.l); }).join(" · ")
          : "同段无结构性事件记录") + "</div></div>";
    }).join("");
    return '<details class="rp-tp-fold"><summary><span>完整变点列表</span><span class="mono">' +
      tps.length + " 段 · 点击展开</span></summary>" + items +
      '<p class="rp-disc">口径：模型胜率曲线上方向一致、幅度最大的 3 个摆动段（相邻采样点变化 ≥0.4pp 才计入），' +
      "只说明这段时间胜率方向明确变化，不构成因果归因。</p></details>";
  }

  function resourcePanel(b, f, prev) {
    var names = ["暴君", "黑暗暴君", "主宰", "风暴龙王"];
    var d1 = prev ? f.o[0].map(function (v, i) { return v - prev.o[0][i]; }) : [0, 0, 0, 0];
    var d2 = prev ? f.o[1].map(function (v, i) { return v - prev.o[1][i]; }) : [0, 0, 0, 0];
    var rows = names.map(function (nm, i) {
      var a = f.o[0][i], c = f.o[1][i];
      var hot1 = d1[i] > 0 ? ' <em class="rp-hot">+' + d1[i] + "</em>" : "";
      var hot2 = d2[i] > 0 ? ' <em class="rp-hot">+' + d2[i] + "</em>" : "";
      return "<tr><td>" + nm + "</td><td class='num'>" + a + hot1 + "</td><td class='num'>" + c + hot2 + "</td></tr>";
    }).join("");
    var tk = f.t, kk = f.k;
    return '<div class="rp-panel"><div class="rp-pt">资源控制 <em class="mono">本帧累计</em></div>' +
      '<div class="rp-kv"><span>推塔</span><b class="mono">' + tk[0] + " : " + tk[1] + "</b>" +
      '<span>击杀</span><b class="mono">' + kk[0] + " : " + kk[1] + "</b></div>" +
      '<table class="rp-tbl two"><thead><tr><th>资源</th><th class="num">' + esc(b.t1) + '</th><th class="num">' + esc(b.t2) + "</th></tr></thead>" +
      "<tbody>" + rows + "</tbody></table></div>";
  }

  /* 事件证据摘要：只陈述"同一时间段发生"，不做因果归因 */
  function evidencePanel(b, f, prev, frames, idx) {
    var fiveAgo = frames[Math.max(0, idx - 3)];
    var dp = (f.p != null && fiveAgo && fiveAgo.p != null) ? (f.p - fiveAgo.p) * 100 : 0;
    var near = (b.events || []).filter(function (e) { return Math.abs(e.m - f.m) <= 1.5; });
    var lines = [];
    var lead = f.p == null ? "" : (f.p >= 0.5 ? b.t1 : b.t2);
    lines.push("第 <b>" + f.m.toFixed(0) + "</b> 分钟：" +
      (f.p == null ? "无模型胜率" : "模型给 <b>" + esc(lead) + "</b> " + pct(f.p >= 0.5 ? f.p : 1 - f.p) + " 胜率") +
      (fiveAgo && fiveAgo.p != null ? "，较约 3 个采样点前 " + signed(dp, 0) + "pp" : ""));
    var gdNow = f.gd, gdThen = fiveAgo ? fiveAgo.gd : f.gd;
    lines.push("同期金差 <b class='mono'>" + signed(gdNow) + "</b>（" + signed(gdNow - gdThen) + "）" +
      "，推塔 " + f.t[0] + ":" + f.t[1] + "，击杀 " + f.k[0] + ":" + f.k[1]);
    if (near.length) {
      lines.push("同时间段事件：" + near.map(function (e) { return esc(e.l); }).join(" · "));
    } else {
      lines.push("同时间段无结构性事件记录");
    }
    if (f.lc) {
      lines.push('<span class="rp-lc">该采样点模型置信度低：早期局势样本少，胜率波动不代表局势真的剧烈变化。</span>');
    }
    return '<div class="rp-panel rp-evidence"><div class="rp-pt">事件证据摘要 <em class="mono">同时发生，不等于因果</em></div>' +
      lines.map(function (l) { return '<p class="rp-line">' + l + "</p>"; }).join("") +
      '<p class="rp-disc">说明：以上只表示这些现象出现在同一时间段，不能据此断言是某个事件改变了胜率。</p></div>';
  }

  function ledgerHTML(b, filter) {
    filter = filter || "all";
    var all = (b.events || []).filter(function (e) { return e.dgd != null; });
    var evs = all.filter(function (e) {
      if (filter === "death") return e.t === "death";
      if (filter === "objective") return !!NEUTRAL[e.t];
      if (filter === "tower") return e.t === "tower";
      return true;
    });
    evs.sort(function (a, c) { return Math.abs(c.dgd) - Math.abs(a.dgd); });
    evs = evs.slice(0, 8);
    var filters = [["all", "全部"], ["death", "死亡"], ["objective", "资源"], ["tower", "推塔"]];
    var bar = '<div class="rp-ledger-filter">' + filters.map(function (f) {
      return '<button type="button" data-f="' + f[0] + '"' + (filter === f[0] ? ' class="on"' : "") + ">" + f[1] + "</button>";
    }).join("") + "</div>";
    var head = '<div class="rp-ledger-hd"><div class="rp-pt">事件经济账本 <em class="mono">按事件窗口金差变化排序</em></div>' + bar + "</div>";
    if (!evs.length) {
      return '<div class="rp-panel rp-ledger">' + head + '<div class="empty-tip">当前筛选没有可计算的事件</div></div>';
    }
    var rows = evs.map(function (e) {
      var extra = [];
      if (e.t === "death") extra.push(e.respawn_sec ? "复活 " + e.respawn_sec + "s" : "终局");
      if (e.lost_farm_est != null) extra.push("损失≈" + fmtInt(e.lost_farm_est) + "g");
      if (NEUTRAL[e.t]) {
        extra.push("buff " + (e.buff_window_sec || e.window_sec || 0) + "s");
        if (e.buff_respawn_min != null) extra.push(e.buff_respawn_min ? "刷新 " + e.buff_respawn_min + "min" : "不刷新");
      }
      return '<tr class="rp-ledger-row" data-m="' + e.m + '" tabindex="0">' +
        '<td class="mono">' + mmss(e.m) + "</td><td>" + esc(e.l) + "</td>" +
        '<td class="num ' + (e.dgd >= 0 ? "up" : "down") + '">' + goldText(e.dgd) + "</td>" +
        '<td class="num">' + (e.window_sec || 0) + "s</td><td>" + esc(extra.join(" · ")) + "</td></tr>";
    }).join("");
    return '<div class="rp-panel rp-ledger">' + head +
      '<div class="rp-tblwrap"><table class="rp-tbl"><thead><tr><th>时间</th><th>事件</th><th class="num">金差变化</th>' +
      '<th class="num">窗口</th><th>补充</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
      '<p class="rp-disc">金差变化 = 阵营1视角，事件时刻 → 窗口结束的观测值；死亡损失为「队伍金速×复活秒×20%」估算，不是官方结算。中立 buff 窗口默认 90s，刷新间隔按资源不同，可在 neutral_buffs 表覆盖。</p></div>';
  }

  /* ---------- 挂载 ---------- */
  function mount(el, opts) {
    if (!el) return;
    activeJump = null;
    var matchId = String(opts.matchId || "");
    if (!matchId) { el.innerHTML = '<div class="empty-tip">缺少 matchId</div>'; return; }
    el.innerHTML = '<div class="rp-loading mono">加载复盘数据…</div>';
    loadPackage(matchId, function (pkg) {
      if (!pkg || !(pkg.battles || []).length) {
        var cov = coverageStats();
        var covText = cov.totalBattles
          ? "全站 " + cov.probBattles + " / " + fmtInt(cov.totalBattles) + " 局有直播胜率；其余只展示赛果、BP 与选手明细。"
          : "仅有赛果、BP 与选手明细。";
        el.innerHTML = '<div class="empty-tip">该场暂无分钟级复盘数据。' + covText + "</div>";
        return;
      }
      var battles = pkg.battles;
      var bi = 0;
      if (opts.battleId) {
        for (var i = 0; i < battles.length; i++) if (battles[i].battleId === opts.battleId) { bi = i; break; }
      }
      var frameIdx = 0;
      // 分享深链直接指向某一分钟时展开技术面板；普通进入先看结论与关键节点。
      var detailOpen = opts.initialMinute != null && !isNaN(Number(opts.initialMinute));
      var layerMode = "team";   // team = 队伍总量（默认答案）；lane = 同位置对位
      var ledgerFilter = "all";
      var detailTab = "timeline";
      // 支持从链接直接回到某一分钟（?g=3&m=12）
      if (opts.initialMinute != null && !isNaN(Number(opts.initialMinute))) {
        var targetM = Number(opts.initialMinute);
        var bestI = 0;
        for (var k = 0; k < battles[bi].frames.length; k++) {
          if (Math.abs(battles[bi].frames[k].m - targetM) < Math.abs(battles[bi].frames[bestI].m - targetM)) bestI = k;
        }
        frameIdx = bestI;
      }

      function frameCount() { return battles[bi].frames.length; }

      // 外壳只在切局时重建一次；拖动滑块只更新 paint() 里的几个区域。
      // 旧版 draw() 每次 input 都重写 el.innerHTML，滑块节点被销毁 →
      // 拖到一半指针捕获丢失，手柄不再跟随鼠标（桌面和手机都会中招）。
      function applyDetail() {
        var detail = document.getElementById("rpDetail");
        var btn = document.getElementById("rpExpand");
        if (detail) detail.hidden = !detailOpen;
        if (btn) {
          btn.setAttribute("aria-expanded", detailOpen ? "true" : "false");
          btn.textContent = detailOpen ? "收起详细分析 ↑" : "展开详细分析 ↓";
        }
      }

      function applyDetailTab() {
        var tabs = document.querySelectorAll("#rpTabs button");
        Array.prototype.forEach.call(tabs, function (b) {
          b.classList.toggle("on", b.getAttribute("data-tab") === detailTab);
        });
        ["timeline", "resource", "turn"].forEach(function (k) {
          var el = document.getElementById("rpPane-" + k);
          if (el) el.hidden = k !== detailTab;
        });
        var note = document.getElementById("rpTabNote");
        if (note) {
          note.textContent = detailTab === "timeline"
            ? "时间轴：天平优势 + 金差条带"
            : detailTab === "resource"
              ? "资源与证据：中立资源、击杀推塔、同段事件"
              : "转折与事件：模型变点和关键事件";
        }
      }

      function renderShell() {
        var b = battles[bi];
        el.innerHTML =
          '<div class="rp">' +
          '<div class="rp-head">' +
          (function () {
            function tab(x, i) {
              return '<button type="button" class="rp-tab' + (i === bi ? " on" : "") + '" data-i="' + i + '">G' +
                (x.seq || i + 1) + '<i class="' + (x.win === 1 ? "w" : x.win === 2 ? "l" : "") + '">' +
                (x.win === 1 ? "胜" : x.win === 2 ? "负" : "—") + "</i></button>";
            }
            var only = opts.showTabs === false;
            return '<div class="rp-tabs' + (only ? " rp-tabs-single" : "") + '">' +
              (only ? tab(battles[bi], bi) : battles.map(tab).join("")) + "</div>";
          })() +
          '<div class="rp-meta mono">' + esc(b.t1) + " vs " + esc(b.t2) + " · 时长 " + b.dur.toFixed(0) + "′ · " +
          (b.win === 1 ? esc(b.t1) : b.win === 2 ? esc(b.t2) : "—") + " 胜出" +
          ' <span class="rp-src ' + (b.src === "live" ? "live" : "replay") + '">' +
          (b.src === "live" ? "胜率=直播当时预测" : "胜率=赛后重放") + "</span>" +
          ' <button type="button" class="rp-share" id="rpShare">复制本帧链接</button>' +
          "</div>" +
          storyHTML(b) +
          '<div class="rp-detail" id="rpDetail"' + (detailOpen ? "" : " hidden") + '>' +
          (b.src === "replay"
            ? '<div class="rp-warn">本局没有直播期预测记录，曲线是赛后用当前模型重放的结果，只作参考；复盘结论请以经济 / 资源等客观指标为主。</div>'
            : "") +
          '<div class="rp-tabs2"><div class="seg" id="rpTabs">' +
            '<button type="button" data-tab="timeline" class="on">时间轴</button>' +
            '<button type="button" data-tab="resource">资源与证据</button>' +
            '<button type="button" data-tab="turn">转折与事件</button>' +
          '</div><span class="rp-tab-note mono" id="rpTabNote"></span></div>' +
          '<div id="rpPane-timeline">' +
            '<div class="rp-chart" id="rpChart"></div>' +
            '<div class="rp-chart-legend">' +
              '<span><i style="background:#F0C36A"></i>一血 / 击杀</span>' +
              '<span><i style="background:#D5374B"></i>死亡</span>' +
              '<span><i style="background:#B08A2E"></i>推塔</span>' +
              '<span><i style="background:#2E6FD0"></i>中立资源</span>' +
              '<span class="mono">事件轨 · 悬停看金差</span></div>' +
            '<div class="rp-tl"><input type="range" min="0" max="' + (b.frames.length - 1) + '" step="1" value="' + frameIdx + '" id="rpRange">' +
            '<div class="rp-tl-meta mono"><span id="rpTime"></span>' +
            "<span>拖动查看该时刻的经济、资源与选手表现</span></div></div>" +
            '<div class="rp-layer seg" id="rpLayer">' +
              '<button type="button" data-layer="team"' + (layerMode === "team" ? ' class="on"' : "") + ">队伍总量</button>" +
              '<button type="button" data-layer="lane"' + (layerMode === "lane" ? ' class="on"' : "") + ">分路对位</button></div>" +
            '<div class="rp-grid" id="rpGridGold"></div>' +
          '</div>' +
          '<div id="rpPane-resource" hidden>' +
            '<div class="rp-grid" id="rpGridData"></div>' +
            '<div class="rp-evs"><div class="rp-pt">关键事件 <em class="mono">点击跳到该分钟</em></div>' +
            '<div class="rp-events" id="rpEvents"></div></div>' +
          '</div>' +
          '<div id="rpPane-turn" hidden><div class="rp-turn" id="rpTurn"></div></div>' +
          "</div>" +
          "</div>";

        var evBox = document.getElementById("rpEvents");
        if (evBox) {
          var evs = keyEventsOf(b);
          evBox.innerHTML = evs.length
            ? evs.map(function (e) { return eventBtn(e, false); }).join("")
            : '<div class="empty-tip">该局没有结构性事件记录</div>';
        }
        applyDetail();
        applyDetailTab();
        bind();
        paint();
      }

      // 只改内容，不动节点：图表容器、三块面板、滑块 value/max、时间标签、事件高亮
      function paint() {
        var b = battles[bi];
        var f = b.frames[frameIdx];
        var prev = frameIdx > 0 ? b.frames[frameIdx - 1] : null;

        var chart = document.getElementById("rpChart");
        if (chart) chart.innerHTML = curveSVG(b.frames, b.t1, b.t2, frameIdx, b);

        var gold = document.getElementById("rpGridGold");
        if (gold) gold.innerHTML = goldPanel(b, f, prev, layerMode);

        var data = document.getElementById("rpGridData");
        if (data) data.innerHTML = resourcePanel(b, f, prev) + evidencePanel(b, f, prev, b.frames, frameIdx);

        var turn = document.getElementById("rpTurn");
        if (turn) turn.innerHTML = ledgerHTML(b, ledgerFilter) + tpPanel(b);

        var r = document.getElementById("rpRange");
        if (r) {
          r.max = String(b.frames.length - 1);
          if (r.value !== String(frameIdx)) r.value = String(frameIdx);
        }

        var t = document.getElementById("rpTime");
        if (t) t.innerHTML = "第 <b>" + f.m.toFixed(0) + "′</b> / " + b.dur.toFixed(0) + "′";

        // 事件按钮只切换高亮，不重建（重建会丢监听）
        Array.prototype.forEach.call(el.querySelectorAll(".rp-ev"), function (btn) {
          var m = parseFloat(btn.getAttribute("data-m"));
          btn.classList.toggle("on", Math.abs(m - f.m) <= 1.5);
        });
      }

      function setFrame(i) {
        frameIdx = Math.max(0, Math.min(frameCount() - 1, i));
        paint();
        var r = document.getElementById("rpRange");
        if (r) r.focus({ preventScroll: true });
      }

      function jumpTo(m) {
        detailOpen = true;
        applyDetail();
        if (window.KPL && KPL.track) KPL.track("key_moment_click");
        setFrame(nearestFrame(battles[bi], m));
        var chart = document.getElementById("rpChart");
        if (chart) chart.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      function bind() {
        var expand = document.getElementById("rpExpand");
        if (expand) {
          expand.addEventListener("click", function () {
            detailOpen = !detailOpen;
            applyDetail();
            if (detailOpen) {
              var detail = document.getElementById("rpDetail");
              if (detail) detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }
          });
        }
        el.querySelectorAll(".rp-node").forEach(function (row) {
          function go() { jumpTo(parseFloat(row.getAttribute("data-m"))); }
          row.addEventListener("click", go);
          row.addEventListener("keydown", function (ev) {
            if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); }
          });
        });
        var turnBox = document.getElementById("rpTurn");
        if (turnBox) {
          turnBox.addEventListener("click", function (ev) {
            var target = ev.target;
            var fbtn = target && target.closest ? target.closest("[data-f]") : null;
            if (fbtn) { ledgerFilter = fbtn.getAttribute("data-f"); paint(); return; }
            var row = target && target.closest ? target.closest("tr[data-m]") : null;
            if (row) jumpTo(parseFloat(row.getAttribute("data-m")));
          });
          turnBox.addEventListener("keydown", function (ev) {
            var row = ev.target && ev.target.closest ? ev.target.closest("tr[data-m]") : null;
            if (row && (ev.key === "Enter" || ev.key === " ")) {
              ev.preventDefault();
              jumpTo(parseFloat(row.getAttribute("data-m")));
            }
          });
        }
        var bpBtn = document.getElementById("rpBp");
        if (bpBtn) {
          bpBtn.addEventListener("click", function () {
            var bp = document.querySelector(".bp-grid");
            if (bp) bp.scrollIntoView({ behavior: "smooth", block: "start" });
          });
        }
        var r = document.getElementById("rpRange");
        if (r) {
          // 拖动中只重绘内容：滑块节点必须留着，否则指针捕获丢失、手柄不跟手
          var dragTracked = false;
          r.addEventListener("input", function () {
            frameIdx = parseInt(r.value, 10); paint();
            if (!dragTracked && window.KPL && KPL.track) {
              dragTracked = true;
              KPL.track("timeline_drag");
              setTimeout(function () { dragTracked = false; }, 30000);
            }
          });
          r.addEventListener("change", function () { frameIdx = parseInt(r.value, 10); paint(); });
          r.addEventListener("keydown", function (e) {
            if (e.key === "ArrowLeft") { e.preventDefault(); setFrame(frameIdx - 1); }
            if (e.key === "ArrowRight") { e.preventDefault(); setFrame(frameIdx + 1); }
          });
        }
        el.querySelectorAll(".rp-tab").forEach(function (btn) {
          btn.addEventListener("click", function () {
            bi = parseInt(btn.getAttribute("data-i"), 10);
            frameIdx = 0;
            var nextBattleId = battles[bi].battleId;
            if (opts.onBattleChange) opts.onBattleChange(nextBattleId);
            renderShell();
          });
        });
        el.querySelectorAll(".rp-ev").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var m = parseFloat(btn.getAttribute("data-m"));
            var b = battles[bi], best = 0;
            for (var i = 0; i < b.frames.length; i++) {
              if (Math.abs(b.frames[i].m - m) < Math.abs(b.frames[best].m - m)) best = i;
            }
            setFrame(best);
          });
        });
        var tabBox = document.getElementById("rpTabs");
        if (tabBox) {
          tabBox.addEventListener("click", function (e) {
            var btn = e.target.closest("button"); if (!btn) return;
            detailTab = btn.getAttribute("data-tab") || "timeline";
            applyDetailTab();
          });
        }
        var layerBox = document.getElementById("rpLayer");
        if (layerBox) {
          layerBox.addEventListener("click", function (e) {
            var btn = e.target.closest("button"); if (!btn) return;
            layerMode = btn.getAttribute("data-layer") === "lane" ? "lane" : "team";
            Array.prototype.forEach.call(layerBox.children, function (x) { x.classList.toggle("on", x === btn); });
            paint();
          });
        }
        var share = document.getElementById("rpShare");
        if (share) {
          share.addEventListener("click", function () {
            if (window.KPL && KPL.track) KPL.track("share_click");
            var b0 = battles[bi];
            var url = location.origin + location.pathname + "?id=" + encodeURIComponent(matchId) +
              "&g=" + (b0.seq || 1) + "&m=" + Math.round(b0.frames[frameIdx].m);
            var done = function () {
              share.textContent = "已复制 ✓";
              setTimeout(function () { share.textContent = "复制本帧链接"; }, 1600);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(url).then(done, function () { share.textContent = url; });
            } else {
              share.textContent = url;
            }
          });
        }
        var chart = document.getElementById("rpChart");
        if (chart) {
          chart.addEventListener("click", function (e) {
            var rect = chart.getBoundingClientRect();
            var ratio = (e.clientX - rect.left) / rect.width;
            var b = battles[bi];
            var maxM = Math.max(10, b.frames[b.frames.length - 1].m);
            var target = ratio * maxM;
            var best = 0;
            for (var i = 0; i < b.frames.length; i++) {
              if (Math.abs(b.frames[i].m - target) < Math.abs(b.frames[best].m - target)) best = i;
            }
            setFrame(best);
          });
        }
      }

      activeJump = jumpTo;
      renderShell();
    });
  }

  return {
    mount: mount,
    hasReplay: hasReplay,
    loadPackage: loadPackage,
    jumpTo: function (m) {
      if (activeJump && isFinite(Number(m))) activeJump(Number(m));
    }
  };
})();
