/* ==========================================================================
   KPL 赛研 · 单局详情页（Game Report）
   纯前端渲染：赛事头版 → 走势 → 复盘结论 → 对局记录 → 阵容
   数据：assets/games/<league>.json · assets/replay/<match>.json · assets/record/<match>.js
   ========================================================================== */
(function () {
  "use strict";

  var K = window.KPL;
  var esc = (K && K.esc) || function (v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var app = document.getElementById("gpApp");
  if (!app) return;

  if (K && K.init) K.init();

  var QS = new URLSearchParams(location.search);
  var BID = QS.get("id") || "";
  var JUMP_M = parseFloat(QS.get("m"));

  /* ---------------- utils ---------------- */

  function fmt(n) {
    var v = Math.round(Number(n) || 0);
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  function fmt1(n) {
    var v = Number(n);
    if (!isFinite(v)) return "—";
    return (Math.round(v * 10) / 10).toFixed(1);
  }
  function signed(n, d) {
    var v = Number(n);
    if (!isFinite(v)) return "—";
    var s = d == null ? fmt(v) : (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d);
    return (v > 0 ? "+" : v < 0 ? "−" : "") + String(s).replace("-", "");
  }
  function pct(p, d) {
    var v = Number(p);
    if (!isFinite(v)) return "—";
    return (v * 100).toFixed(d == null ? 0 : d) + "%";
  }
  function mmss(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }
  function r1(v) { return Math.round(Number(v) * 10) / 10; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function debounce(fn, wait) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  /* 图片 + 兜底字：加载失败时移除 img，露出底层字符 */
  function pic(url, alt, cls, fbChar) {
    var fb = fbChar ? '<i class="fb">' + esc(String(fbChar).slice(0, 1)) + "</i>" : "";
    if (!url) return fb;
    return fb + '<img class="' + (cls || "") + '" src="' + esc(url) + '" alt="' +
      esc(alt || "") + '" onerror="this.remove()">';
  }

  function durLabel(g, rec) {
    if (rec && rec.duration_sec) return mmss(rec.duration_sec);
    var m = Number(g.dur) || 0;
    return m + "′";
  }
  function durMinutes(g, rec, battle) {
    if (rec && rec.duration_sec) return rec.duration_sec / 60;
    var m = Number(g.dur) || 0;
    if (battle && battle.frames && battle.frames.length) {
      m = Math.max(m, battle.frames[battle.frames.length - 1].m || 0);
    }
    return m;
  }

  var TAG = {
    "Buff": { cls: "buff", label: "野区", glyph: "◆" },
    "打龙": { cls: "dragon", label: "打龙", glyph: "▲" },
    "推塔": { cls: "tower", label: "推塔", glyph: "■" },
    "出装": { cls: "", label: "出装", glyph: "●" }
  };
  function tagOf(t) { return TAG[t] || { cls: "", label: t || "事件", glyph: "◇" }; }

  function phaseOf(sec) {
    if (sec < 240) return { key: "early", nm: "对线期", rg: "0–4′" };
    if (sec < 600) return { key: "mid", nm: "转线期", rg: "4–10′" };
    if (sec < 900) return { key: "late", nm: "抱团期", rg: "10–15′" };
    return { key: "end", nm: "决胜期", rg: "15′ +" };
  }

  /* ---------------- 数据加载 ---------------- */

  var state = {
    g: null, sched: {}, battle: null, rec: null,
    mid: "", lg: "", flags: 0, names: null, heroIcon: {}
  };

  if (!BID) { fatal("缺少对局参数", "本页需要 ?id= 对局 ID，请从比赛页或选手页进入。"); return; }

  Object.keys(window.KPL_GAME_INDEX || {}).some(function (mid) {
    var e = window.KPL_GAME_INDEX[mid];
    for (var i = 0; i < (e.b || []).length; i++) {
      if (e.b[i][0] === BID) {
        state.mid = mid; state.lg = e.lg; state.flags = Number(e.b[i][5] || 0);
        return true;
      }
    }
    return false;
  });
  if (!state.mid) { fatal("未找到这局比赛", "对局索引里没有这个 ID，可能链接已过期。"); return; }

  state.sched = (window.KPL_SCHEDULE_ALL || []).filter(function (r) {
    return r.matchId === state.mid;
  })[0] || {};

  try {
    ((K.scopeOf && K.scopeOf("all")) || {}).heroes.forEach(function (h) { state.heroIcon[h.name] = h.icon; });
  } catch (_) {}
  state.names = state.heroIcon;

  if (window.KPL_REPLAY_INDEX && (window.KPL_REPLAY_INDEX[state.mid] || {}).b) {
    state.rpIndex = window.KPL_REPLAY_INDEX[state.mid];
  } else {
    state.rpIndex = null;
  }

  var reqs = [];

  reqs.push(fetch("assets/games/" + state.lg + ".json").then(function (r) {
    if (!r.ok) throw new Error("http " + r.status);
    return r.json();
  }).then(function (data) { state.g = data && data[BID] ? data[BID] : null; }).catch(function () { state.g = null; }));

  if (state.rpIndex) {
    reqs.push(fetch("assets/replay/" + state.mid + ".json").then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    }).then(function (data) {
      var list = (data && data.battles) || [];
      state.battle = list.filter(function (b) { return b.battleId === BID; })[0] || null;
    }).catch(function () { state.battle = null; }));
  }

  reqs.push(loadRecord());

  Promise.all(reqs).then(function () {
    if (!state.g && !state.battle) { fatal("对局数据加载失败", "请通过本地服务器（python start.py）打开站点后重试。"); return; }
    if (state.g && state.g.win != null && !state.rec) { /* 记录面板可缺省 */ }
    renderPage();
  });

  function loadRecord() {
    return new Promise(function (resolve) {
      if (!state.rpIndex) { resolve(null); return; }
      var s = document.createElement("script");
      s.src = "assets/record/" + state.mid + ".js?ts=" + Date.now();
      s.onload = function () {
        s.remove();
        try {
          state.rec = (window.KPL_RECORD || {})[BID] || null;
          if (!state.rec) state.rec = null;
        } catch (_) { state.rec = null; }
        resolve(state.rec);
      };
      s.onerror = function () { s.remove(); resolve(null); };
      document.head.appendChild(s);
    });
  }

  function fatal(title, note) {
    app.innerHTML =
      '<section class="gp-hero"><div class="gp-wrap">' +
      '<nav class="gp-crumb"><a href="schedule.html">赛程</a><span class="sep">/</span><b>对局详情</b></nav>' +
      '<div class="gp-empty-hero"><div class="gp-eyebrow"><span class="idx">GAME</span> 对局详情</div>' +
      '<h1 class="gp-title" style="font-size:clamp(24px,3vw,38px)">' + esc(title) + "</h1>" +
      '<p class="gp-note" style="max-width:56ch;margin-top:12px">' + esc(note) + "</p>" +
      '<div class="gp-actions" style="margin-top:22px"><a class="gp-btn solid" href="schedule.html">返回赛程 <span class="arr">→</span></a></div>' +
      "</div></div></section>";
  }

  /* ---------------- 选择器 ---------------- */

  function heroIcon(name) { return state.heroIcon[name] || ""; }

  function covChips() {
    var items = [
      ["比分", 1], ["BP", 2], ["选手", 4], ["回放", 8], ["分钟级", 16]
    ];
    var mask = state.flags ? (state.flags | 1 | 8) : 1;
    // 复算覆盖位：比赛索引 flags(1/2)、回放索引(8/16)
    var m = 1;
    if (state.flags & 1) m |= 2;
    if (state.flags & 2) m |= 4;
    if (state.rpIndex) m |= 8;
    if (state.battle) m |= 16;
    return items.map(function (it) {
      var on = !!(m & it[1]);
      return '<span class="' + (on ? "on" : "") + '">' + it[0] + "</span>";
    }).join("");
  }

  /* ---------------- 头版 ---------------- */

  function heroHTML() {
    var g = state.g || {};
    var win = g.win;
    var live = !!(g.live === 1 || win === 0 || win == null);
    var t1 = g.t1 || state.sched.team1 || "蓝方";
    var t2 = g.t2 || state.sched.team2 || "红方";
    var k1 = g.k1 != null ? g.k1 : "–";
    var k2 = g.k2 != null ? g.k2 : "–";
    var winName = win === 1 ? t1 : win === 2 ? t2 : "";
    var league = state.sched.leagueName || "";
    var stage = state.sched.stage || "";
    var date = state.sched.date || "";
    var facts = [];

    if (state.sched.score1 != null && state.sched.score2 != null) {
      facts.push('<span class="gp-fact">系列赛 <b>' + state.sched.score1 + " : " + state.sched.score2 + "</b> BO" +
        esc(state.sched.bo || "?") + "</span>");
    }
    if (g.g1 != null && g.g2 != null) {
      var gd = Number(g.g1) - Number(g.g2);
      facts.push('<span class="gp-fact">经济 <b>' + fmt(g.g1) + "</b> : <b>" + fmt(g.g2) + "</b> " +
        '<b class="' + (gd >= 0 ? "pos" : "neg") + '" style="margin-left:4px">' + signed(gd) + "</b></span>");
    }
    var towers = lastTowers();
    if (towers) {
      facts.push('<span class="gp-fact">推塔 <b>' + towers[0] + " : " + towers[1] + "</b></span>");
    }

    var outcome = live
      ? '<span class="gp-outcome live"><span class="dot"></span>进行中 · 第 ' + esc(String(Math.round(g.dur || 0))) + " 分钟</span>"
      : (winName
        ? '<span class="gp-outcome"><span class="dot"></span><b>' + esc(winName) + "</b> 赢下本局</span>"
        : '<span class="gp-outcome"><span class="dot"></span>赛果待补</span>');

    var download = g.video
      ? '<a class="gp-btn solid" href="' + esc(g.video) + '" target="_blank" rel="noopener">本局回放 <span class="arr">↗</span></a>'
      : '<a class="gp-btn solid" href="https://search.bilibili.com/all?keyword=' +
        encodeURIComponent("KPL " + t1 + " " + t2 + " 第" + (g.seq || 1) + "局") +
        '" target="_blank" rel="noopener">去 B 站找本局 <span class="arr">↗</span></a>';

    return '<section class="gp-hero">' +
      '<div class="gp-gridlines" aria-hidden="true"></div>' +
      '<div class="gp-wrap">' +
      '<nav class="gp-crumb">' +
      '<a href="schedule.html">赛程</a><span class="sep">/</span>' +
      '<a href="match.html?id=' + encodeURIComponent(state.mid) + '">比赛</a><span class="sep">/</span>' +
      '<b>第 ' + esc(g.seq || 1) + " 局</b>" +
      (league ? '<span class="sep">·</span><span>' + esc(league) + "</span>" : "") +
      (stage ? '<span class="sep">·</span><span>' + esc(stage) + "</span>" : "") +
      (date ? '<span class="sep">·</span><span>' + esc(date) + "</span>" : "") +
      '<span class="gp-cov" style="margin-left:auto" title="本局数据覆盖">' + covChips() + "</span>" +
      "</nav>" +

      '<div class="gp-faceoff">' +
      teamHTML(1, t1, g.i1, win === 1, "蓝方") +
      '<div class="gp-core">' +
      '<span class="gp-scorelab">本局击杀</span>' +
      '<div class="gp-scoreline">' +
      '<b class="blue">' + esc(String(k1)) + "</b>" +
      '<i class="gp-colon">:</i>' +
      '<b class="red">' + esc(String(k2)) + "</b>" +
      "</div>" +
      outcome +
      '<div class="gp-clock">用时 <b>' + esc(durLabel(g, state.rec)) + "</b>" +
      (live ? " · 实时" : "") + "</div>" +
      "</div>" +
      teamHTML(2, t2, g.i2, win === 2, "红方") +
      "</div>" +

      '<div class="gp-hero-foot">' +
      '<div class="gp-facts">' + facts.join("") + "</div>" +
      '<div class="gp-actions">' +
      '<a class="gp-btn" href="match.html?id=' + encodeURIComponent(state.mid) + '">整场详情 <span class="arr">→</span></a>' +
      '<a class="gp-btn" href="bp-studio.html?match=' + encodeURIComponent(state.mid) + "&amp;g=" +
      encodeURIComponent(g.seq || 1) + '">BP 演播室 <span class="arr">→</span></a>' +
      download +
      "</div></div>" +
      "</div></section>";
  }

  function teamHTML(camp, name, logo, isWin, campLabel) {
    var side = camp === 1 ? "blue" : "red";
    return '<div class="gp-side ' + side + (isWin ? " win" : "") + '">' +
      '<span class="gp-logo">' + pic(logo, name, "", String(name || "").slice(0, 1)) + "</span>" +
      '<div class="gp-id">' +
      '<span class="gp-camp"><i></i>' + campLabel + "</span>" +
      '<div class="gp-name">' + esc(name) + "</div>" +
      '<div class="gp-sub">' + (isWin ? "本局胜方" : "本局对阵") + "</div>" +
      "</div></div>";
  }

  function lastTowers() {
    var f = framesOf();
    if (!f.length) return null;
    var t = f[f.length - 1].t;
    if (!t || t.length < 2) return null;
    return [t[0], t[1]];
  }

  /* ---------------- 走势数据 ---------------- */

  function framesOf() {
    var b = state.battle;
    if (!b || !b.frames || !b.frames.length) return [];
    var out = [];
    b.frames.forEach(function (f) {
      if (f.p == null && f.gd == null) return;
      out.push({
        m: Number(f.m) || 0,
        p: f.p == null ? null : Number(f.p),
        gd: f.gd == null ? null : Number(f.gd),
        k: Array.isArray(f.k) ? f.k : null,
        t: Array.isArray(f.t) ? f.t : null
      });
    });
    out.sort(function (a, b2) { return a.m - b2.m; });
    return out;
  }

  function probFrames() {
    return framesOf().filter(function (f) { return f.p != null && isFinite(f.p); });
  }

  function economySeries() {
    if (state.rec && state.rec.economy && state.rec.economy.points && state.rec.economy.points.length) {
      return state.rec.economy.points.map(function (p) {
        return { sec: Number(p.t) || 0, m: (Number(p.t) || 0) / 60, diff: Number(p.diff) || 0 };
      });
    }
    return framesOf().filter(function (f) { return f.gd != null; }).map(function (f) {
      return { sec: f.m * 60, m: f.m, diff: f.gd };
    });
  }

  function killsSeries() {
    var f = framesOf().filter(function (x) { return x.k && x.k.length === 2; });
    var out = f.map(function (x) { return { m: x.m, k1: Number(x.k[0]) || 0, k2: Number(x.k[1]) || 0, gd: x.gd }; });
    var g = state.g || {};
    if (out.length && g.k1 != null && g.k2 != null) {
      var dur = durMinutes(g, state.rec, state.battle);
      var last = out[out.length - 1];
      if (dur > last.m + 0.2) out.push({ m: dur, k1: Number(g.k1) || 0, k2: Number(g.k2) || 0, gd: null });
    }
    return out;
  }

  /* ---------------- 01 本局走势 ---------------- */

  function flowHTML() {
    var g = state.g || {};
    var t1 = g.t1 || "蓝方", t2 = g.t2 || "红方";
    var hasChart = probFrames().length >= 3 || economySeries().length >= 3;
    var stats = flowStats();
    var totals = window.KPL_TOTALS || {};
    var covNote = totals.replayBattles
      ? "全站 " + fmt(totals.replayBattles) + " / " + fmt(totals.battles) + " 局有直播快照"
      : "全站仅覆盖有直播快照的对局";
    return '<section class="gp-card gp-flow gp-r" id="gpFlow">' +
      '<div class="gp-head">' +
      '<div>' +
      '<div class="gp-eyebrow"><span class="idx">01</span> MATCH FLOW</div>' +
      '<h2 class="gp-title">本局走势</h2>' +
      '<p class="gp-note">' + (hasChart
        ? "逐分钟采样 · 模型实时估算 · 纵轴为 " + esc(t1) + " 的胜率"
        : "本局没有分钟级胜率档案") + "</p>" +
      (hasChart ? '<div class="gp-legend">' +
        '<span class="b"><i></i>' + esc(t1) + " 领先</span>" +
        '<span class="r"><i></i>' + esc(t2) + " 领先</span>" +
        '<span class="m"><i></i>五五开</span>' +
        "</div>" : "") +
      "</div>" +
      (hasChart ? '<div class="gp-seg" role="group" aria-label="走势指标">' +
        '<button type="button" data-mode="p" aria-pressed="true">胜率</button>' +
        '<button type="button" data-mode="g" aria-pressed="false">经济差</button>' +
        '<button type="button" data-mode="k" aria-pressed="false">击杀</button>' +
        "</div>" : "") +
      "</div>" +
      '<div class="gp-chart-box">' +
      (hasChart
        ? '<div class="gp-chart" id="gpChart"></div><div class="gp-tip" id="gpTip"></div>'
        : '<div class="gp-chart-empty"><div class="gp-empty-in">' +
          '<span class="ic">◇</span>' +
          "<b>本局没有逐分钟胜率</b>" +
          "<p>" + covNote + "。本局保留官方比分、BP、选手明细与逐事件记录。</p>" +
          '<a class="gp-btn" href="match.html?id=' + encodeURIComponent(state.mid) + '">看整场数据 <span class="arr">→</span></a>' +
          "</div></div>") +
      "</div>" +
      (stats ? '<div class="gp-stats">' + stats + "</div>" : "") +
      "</section>";
  }

  function flowStats() {
    var pf = probFrames();
    if (!pf.length) return "";
    var final = pf[pf.length - 1];
    var peak = pf.reduce(function (a, b) { return b.p > a.p ? b : a; }, pf[0]);
    var swing = decisive(pf);
    var g = state.g || {};
    var gd = (g.g1 != null && g.g2 != null) ? Number(g.g1) - Number(g.g2) : final.gd;
    var gdNote = (g.g1 != null && g.g2 != null) ? "官方结算" : "最后采样点";
    var swingTxt = swing ? (r1(Math.abs(swing.dp) * 100) + '<span class="u">个百分点</span>') : "—";
    return "" +
      '<div class="gp-stat"><div class="k">终局胜率</div><b class="' + (final.p >= 0.5 ? "blue" : "red") + '">' +
      pct(final.p) + '</b><small>' + esc(g.t1 || "蓝方") + " 视角 · " + r1(final.m) + "′ 采样</small></div>" +
      '<div class="gp-stat"><div class="k">胜率峰值</div><b>' + pct(peak.p) + "</b><small>" + r1(peak.m) + "′ 时达到</small></div>" +
      '<div class="gp-stat"><div class="k">最大单次摆动</div><b>' + swingTxt + "</b><small>" +
      (swing ? r1(swing.m0) + "′ → " + r1(swing.m1) + "′" : "采样不足") + "</small></div>" +
      '<div class="gp-stat"><div class="k">终局经济差</div><b class="' + (gd >= 0 ? "blue" : "red") + '">' +
      (gd == null ? "—" : signed(gd)) + "</b><small>" + (gd == null ? "无金币档案" : gdNote + " · " + (gd >= 0 ? "蓝方领先" : "红方领先")) + "</small></div>";
  }

  function decisive(pf) {
    var best = null;
    for (var i = 1; i < pf.length; i++) {
      var dp = pf[i].p - pf[i - 1].p;
      if (!best || Math.abs(dp) > Math.abs(best.dp)) {
        best = { i: i, m0: pf[i - 1].m, m1: pf[i].m, p0: pf[i - 1].p, p1: pf[i].p, dp: dp, g0: pf[i - 1].gd, g1: pf[i].gd };
      }
    }
    return best;
  }

  /* ---------------- 走势图引擎 ---------------- */

  var chartState = { mode: "p", mounted: false, el: null, tip: null, rows: [], geo: null };

  function mountChart() {
    var el = document.getElementById("gpChart");
    if (!el) return;
    chartState.el = el;
    chartState.tip = document.getElementById("gpTip");
    chartState.mounted = true;
    drawChart();
    var seg = document.querySelector(".gp-flow .gp-seg");
    if (seg) {
      seg.addEventListener("click", function (e) {
        var btn = e.target.closest("button[data-mode]");
        if (!btn) return;
        chartState.mode = btn.getAttribute("data-mode");
        seg.querySelectorAll("button").forEach(function (b) {
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        drawChart();
      });
    }
  }

  function chartColors() {
    var cs = getComputedStyle(document.body);
    return {
      blue: cs.getPropertyValue("--gp-blue").trim() || "#2c5bd8",
      red: cs.getPropertyValue("--gp-red").trim() || "#c9354e",
      gold: cs.getPropertyValue("--gp-gold").trim() || "#a2761f",
      ink: cs.getPropertyValue("--gp-ink").trim() || "#171c26",
      ink2: cs.getPropertyValue("--gp-ink-2").trim() || "#4a5568",
      ink3: cs.getPropertyValue("--gp-ink-3").trim() || "#838fa3",
      line: cs.getPropertyValue("--gp-line").trim() || "#e4e9f1",
      line2: cs.getPropertyValue("--gp-line-2").trim() || "#cbd6e6",
      card: cs.getPropertyValue("--gp-card-soft").trim() || "#f4f7fc",
      bg: cs.getPropertyValue("--gp-bg").trim() || "#f5f7fb"
    };
  }

  function svgEl(tag, attrs) {
    var s = "<" + tag;
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) {
      s += " " + k + '="' + attrs[k] + '"';
    }
    return s + ">";
  }

  function drawChart() {
    var el = chartState.el;
    if (!el) return;
    var W = Math.max(320, Math.round(el.clientWidth || el.getBoundingClientRect().width || 640));
    var H = Math.max(220, Math.round(el.clientHeight || 360));
    var C = chartColors();
    var dur = Math.max(1, durMinutes(state.g || {}, state.rec, state.battle));
    var pad = { l: W < 520 ? 38 : 48, r: W < 520 ? 14 : 20, t: W < 520 ? 40 : 46, b: 30 };
    var PW = W - pad.l - pad.r, PH = H - pad.t - pad.b;
    var geo = { W: W, H: H, pad: pad, PW: PW, PH: PH, dur: dur, C: C };
    chartState.geo = geo;

    var html = "";
    var uid = "gp" + Math.random().toString(36).slice(2, 8);

    if (chartState.mode === "p") {
      html = drawProb(geo, uid);
    } else if (chartState.mode === "g") {
      html = drawEconomy(geo, uid);
    } else {
      html = drawKills(geo, uid);
    }

    html += '<rect id="gpHit" x="' + pad.l + '" y="' + pad.t + '" width="' + PW + '" height="' + PH +
      '" fill="transparent" style="cursor:crosshair"></rect>';
    html += '<g id="gpCursor" style="opacity:0;pointer-events:none">' +
      '<line class="cur-line" x1="0" y1="' + pad.t + '" x2="0" y2="' + (pad.t + PH) +
      '" style="stroke:' + C.ink3 + ';stroke-width:1;stroke-dasharray:3 4;opacity:.6"></line>' +
      '<circle class="cur-dot" r="5.5" style="fill:' + C.bg + ';stroke:' + C.blue + ';stroke-width:2"></circle></g>';

    el.innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="本局走势图">' + html + "</svg>";
    chartState.rows = chartState.mode === "p" ? probFrames() :
      chartState.mode === "g" ? economySeries() : killsSeries();
    bindHover();
  }

  function axes(geo, opts) {
    var C = geo.C, pad = geo.pad, PW = geo.PW, PH = geo.PH;
    var s = "";
    // 横轴
    var step = geo.dur <= 12 ? 2 : geo.dur <= 24 ? 3 : 4;
    var lastTick = Math.floor(geo.dur / step) * step;
    var showEnd = geo.dur - lastTick >= 0.9;
    var xs = "";
    for (var m = 0; m <= geo.dur + 0.01; m += step) {
      if (showEnd && geo.dur - m < step * 0.55) continue;
      var x = pad.l + (m / geo.dur) * PW;
      xs += '<line x1="' + r1(x) + '" y1="' + (pad.t + PH) + '" x2="' + r1(x) + '" y2="' + (pad.t + PH + 5) +
        '" style="stroke:' + C.line2 + ';stroke-width:1"></line>';
      xs += '<text x="' + r1(x) + '" y="' + (pad.t + PH + 20) + '" text-anchor="middle" style="fill:' + C.ink3 +
        ';font-size:10px;letter-spacing:.06em">' + m + "′</text>";
    }
    // 纵轴网格
    var ys = "";
    (opts.yTicks || []).forEach(function (t) {
      var y = opts.y(t);
      var strong = opts.strong != null && Math.abs(t - opts.strong) < 1e-9;
      ys += '<line x1="' + pad.l + '" y1="' + r1(y) + '" x2="' + (pad.l + PW) + '" y2="' + r1(y) +
        '" style="stroke:' + (strong ? C.line2 : C.line) + ';stroke-width:1' +
        (strong ? "" : ';stroke-dasharray:' + (opts.dash || "2 5")) + ';opacity:' + (strong ? ".9" : ".8") + '"></line>';
      ys += '<text x="' + (pad.l - 9) + '" y="' + r1(y + 3.5) + '" text-anchor="end" style="fill:' +
        (strong ? C.ink2 : C.ink3) + ';font-size:10px;letter-spacing:.04em">' + opts.label(t) + "</text>";
    });
    // 赛期分区
    var bands = phaseBands(geo.dur);
    bands.forEach(function (b, i) {
      var x0 = pad.l + (b.a / geo.dur) * PW, x1 = pad.l + (Math.min(b.b, geo.dur) / geo.dur) * PW;
      if (i % 2 === 0) {
        xs += '<rect x="' + r1(x0) + '" y="' + pad.t + '" width="' + r1(x1 - x0) + '" height="' + PH +
          '" style="fill:' + C.ink + ';opacity:.018"></rect>';
      }
      xs += '<line x1="' + r1(x0) + '" y1="' + pad.t + '" x2="' + r1(x0) + '" y2="' + (pad.t + PH) +
        '" style="stroke:' + C.line + ';stroke-width:1;stroke-dasharray:1 5;opacity:.7"></line>';
      if (geo.W > 560) {
        xs += '<text x="' + r1((x0 + x1) / 2) + '" y="' + (pad.t - 27) + '" text-anchor="middle" style="fill:' + C.ink3 +
          ';font-size:9.5px;letter-spacing:.18em">' + b.nm + "</text>";
      }
    });
    // 末段时长刻度
    if (showEnd) {
      var xEnd = pad.l + PW;
      xs += '<line x1="' + r1(xEnd) + '" y1="' + (pad.t + PH) + '" x2="' + r1(xEnd) + '" y2="' + (pad.t + PH + 5) +
        '" style="stroke:' + C.line2 + ';stroke-width:1"></line>';
      xs += '<text x="' + r1(xEnd) + '" y="' + (pad.t + PH + 20) + '" text-anchor="end" style="fill:' + C.ink3 +
        ';font-size:10px;letter-spacing:.06em">' + Math.round(geo.dur) + "′</text>";
    }
    if (opts.strongLabel && geo.W > 460) {
      xs += '<text x="' + (pad.l + PW) + '" y="' + r1(opts.y(opts.strong) - 6) +
        '" text-anchor="end" style="fill:' + C.ink3 + ';font-size:9px;letter-spacing:.12em">' + opts.strongLabel + "</text>";
    }
    return ys + xs;
  }

  function phaseBands(dur) {
    var bands = [
      { nm: "对线期", a: 0, b: 4 },
      { nm: "转线期", a: 4, b: 10 },
      { nm: "抱团期", a: 10, b: 15 },
      { nm: "决胜期", a: 15, b: Math.max(15, dur) }
    ];
    return bands.filter(function (b) { return b.a < dur; });
  }

  function drawProb(geo, uid) {
    var C = geo.C, pad = geo.pad, PW = geo.PW, PH = geo.PH;
    var pf = probFrames();
    if (pf.length < 3) return emptySvg(geo);
    var X = function (m) { return pad.l + (clamp(m, 0, geo.dur) / geo.dur) * PW; };
    var Y = function (p) { return pad.t + (1 - clamp(p, 0, 1)) * PH; };
    var pts = pf.map(function (f) { return [X(f.m), Y(f.p)]; });
    var line = smooth(pts, pad.t, pad.t + PH);
    var base = pad.t + PH;
    var y50 = Y(0.5);
    var area = line + " L" + r1(pts[pts.length - 1][0]) + "," + r1(y50) + " L" + r1(pts[0][0]) + "," + r1(y50) + " Z";

    var s = '<defs>' +
      '<linearGradient id="' + uid + 'ln" x1="0" y1="' + pad.t + '" x2="0" y2="' + base + '" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0" stop-color="' + C.blue + '"/><stop offset=".46" stop-color="' + C.blue + '"/>' +
      '<stop offset=".54" stop-color="' + C.red + '"/><stop offset="1" stop-color="' + C.red + '"/></linearGradient>' +
      '<linearGradient id="' + uid + 'au" x1="0" y1="' + pad.t + '" x2="0" y2="' + y50 + '" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0" stop-color="' + C.blue + '" stop-opacity=".03"/>' +
      '<stop offset="1" stop-color="' + C.blue + '" stop-opacity=".16"/></linearGradient>' +
      '<linearGradient id="' + uid + 'ad" x1="0" y1="' + y50 + '" x2="0" y2="' + base + '" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0" stop-color="' + C.red + '" stop-opacity=".14"/>' +
      '<stop offset="1" stop-color="' + C.red + '" stop-opacity=".02"/></linearGradient>' +
      '<clipPath id="' + uid + 'up"><rect x="' + pad.l + '" y="' + pad.t + '" width="' + PW + '" height="' + (y50 - pad.t) + '"/></clipPath>' +
      '<clipPath id="' + uid + 'dn"><rect x="' + pad.l + '" y="' + y50 + '" width="' + PW + '" height="' + (base - y50) + '"/></clipPath>' +
      "</defs>";

    s += axes(geo, {
      yTicks: geo.W < 520 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1],
      y: Y,
      strong: 0.5,
      label: function (t) { return Math.round(t * 100) + "%"; },
      strongLabel: "五五开"
    });

    s += '<path d="' + area + '" fill="url(#' + uid + 'au)" clip-path="url(#' + uid + 'up)"></path>';
    s += '<path d="' + area + '" fill="url(#' + uid + 'ad)" clip-path="url(#' + uid + 'dn)"></path>';

    // 关键转折区
    var dec = decisive(pf);
    if (dec && Math.abs(dec.dp) > 0.06) {
      var x0 = X(dec.m0), x1 = X(dec.m1);
      s += '<rect x="' + r1(x0) + '" y="' + pad.t + '" width="' + r1(Math.max(2, x1 - x0)) + '" height="' + PH +
        '" style="fill:' + C.gold + ';opacity:.055"></rect>';
      s += '<line x1="' + r1(x0) + '" y1="' + pad.t + '" x2="' + r1(x0) + '" y2="' + base +
        '" style="stroke:' + C.gold + ';stroke-width:1;stroke-dasharray:3 4;opacity:.5"></line>';
      s += '<line x1="' + r1(x1) + '" y1="' + pad.t + '" x2="' + r1(x1) + '" y2="' + base +
        '" style="stroke:' + C.gold + ';stroke-width:1;stroke-dasharray:3 4;opacity:.5"></line>';
      s += '<text x="' + r1((x0 + x1) / 2) + '" y="' + (pad.t - 10) + '" text-anchor="middle" style="fill:' + C.gold +
        ';font-size:9.5px;letter-spacing:.14em">关键转折</text>';
    }

    s += '<path d="' + line + '" fill="none" stroke="url(#' + uid + 'ln)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"></path>';

    // 事件刻度
    eventTicks(geo, X, C).forEach(function (t) { s += t; });

    // 采样点
    pf.forEach(function (f, i) {
      var isLast = i === pf.length - 1;
      var col = f.p >= 0.5 ? C.blue : C.red;
      s += '<circle cx="' + r1(X(f.m)) + '" cy="' + r1(Y(f.p)) + '" r="' + (isLast ? 4.6 : 2.6) +
        '" style="fill:' + geo.C.bg + ';stroke:' + col + ';stroke-width:' + (isLast ? 2.4 : 1.6) + '"></circle>';
    });

    // 末点标签
    var lastP = pf[pf.length - 1];
    var lx = X(lastP.m), ly = Y(lastP.p);
    s += pill(lx, ly, pct(lastP.p), C, geo);
    return s;
  }

  function drawEconomy(geo, uid) {
    var C = geo.C, pad = geo.pad, PW = geo.PW, PH = geo.PH;
    var eco = economySeries();
    if (eco.length < 3) return emptySvg(geo);
    var maxAbs = Math.max(1000, Math.ceil(Math.max.apply(null, eco.map(function (p) { return Math.abs(p.diff); })) / 1000) * 1000);
    var X = function (m) { return pad.l + (clamp(m, 0, geo.dur) / geo.dur) * PW; };
    var Y = function (v) { return pad.t + (0.5 - (v / maxAbs) * 0.46) * PH; };
    var zero = Y(0);
    var pts = eco.map(function (p) { return [X(p.m), Y(p.diff)]; });
    var line = smooth(pts, pad.t, pad.t + PH);
    var area = line + " L" + r1(pts[pts.length - 1][0]) + "," + r1(zero) + " L" + r1(pts[0][0]) + "," + r1(zero) + " Z";

    var s = '<defs><linearGradient id="' + uid + 'g" x1="0" y1="' + pad.t + '" x2="0" y2="' + (pad.t + PH) + '" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0" stop-color="' + C.blue + '"/><stop offset=".46" stop-color="' + C.blue + '"/>' +
      '<stop offset=".54" stop-color="' + C.red + '"/><stop offset="1" stop-color="' + C.red + '"/></linearGradient>' +
      '<linearGradient id="' + uid + 'eu" x1="0" y1="' + pad.t + '" x2="0" y2="' + zero + '" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0" stop-color="' + C.blue + '" stop-opacity=".03"/>' +
      '<stop offset="1" stop-color="' + C.blue + '" stop-opacity=".15"/></linearGradient>' +
      '<linearGradient id="' + uid + 'ed" x1="0" y1="' + zero + '" x2="0" y2="' + (pad.t + PH) + '" gradientUnits="userSpaceOnUse">' +
      '<stop offset="0" stop-color="' + C.red + '" stop-opacity=".14"/>' +
      '<stop offset="1" stop-color="' + C.red + '" stop-opacity=".02"/></linearGradient>' +
      '<clipPath id="' + uid + 'u"><rect x="' + pad.l + '" y="' + pad.t + '" width="' + PW + '" height="' + (zero - pad.t) + '"/></clipPath>' +
      '<clipPath id="' + uid + 'd"><rect x="' + pad.l + '" y="' + zero + '" width="' + PW + '" height="' + (pad.t + PH - zero) + '"/></clipPath></defs>';

    s += axes(geo, {
      yTicks: [maxAbs, maxAbs / 2, 0, -maxAbs / 2, -maxAbs],
      y: Y,
      strong: 0,
      label: function (t) {
        if (Math.abs(t) < 1) return "0";
        var a = Math.abs(t) >= 1000 ? (Math.abs(t) / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(Math.round(Math.abs(t)));
        return (t > 0 ? "+" : "−") + a;
      },
      strongLabel: ""
    });
    s += '<path d="' + area + '" fill="url(#' + uid + 'eu)" clip-path="url(#' + uid + 'u)"></path>';
    s += '<path d="' + area + '" fill="url(#' + uid + 'ed)" clip-path="url(#' + uid + 'd)"></path>';
    eventTicks(geo, X, C).forEach(function (t) { s += t; });
    s += '<path d="' + line + '" fill="none" stroke="url(#' + uid + 'g)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path>';
    var last = eco[eco.length - 1];
    s += '<circle cx="' + r1(X(last.m)) + '" cy="' + r1(Y(last.diff)) + '" r="4.4" style="fill:' + C.bg +
      ';stroke:' + (last.diff >= 0 ? C.blue : C.red) + ';stroke-width:2.2"></circle>';
    s += pill(X(last.m), Y(last.diff), signed(last.diff), C, geo);
    return s;
  }

  function drawKills(geo, uid) {
    var C = geo.C, pad = geo.pad, PW = geo.PW, PH = geo.PH;
    var ks = killsSeries();
    if (ks.length < 3) return emptySvg(geo);
    var maxK = Math.max(5, Math.max(ks[ks.length - 1].k1, ks[ks.length - 1].k2));
    maxK = Math.ceil(maxK / 5) * 5;
    var X = function (m) { return pad.l + (clamp(m, 0, geo.dur) / geo.dur) * PW; };
    var Y = function (v) { return pad.t + (1 - v / maxK) * PH; };
    var ticks = [];
    for (var i = 0; i <= maxK; i += Math.max(1, Math.round(maxK / 5))) ticks.push(i);

    var s = "";
    s += axes(geo, {
      yTicks: ticks, y: Y,
      label: function (t) { return String(t); }
    });
    eventTicks(geo, X, C).forEach(function (t) { s += t; });

    function stepPath(vals, key, color) {
      var d = "";
      ks.forEach(function (p, i) {
        var x = X(p.m), y = Y(p[key]);
        if (i === 0) { d += "M" + r1(x) + "," + r1(y); }
        else { d += " L" + r1(x) + "," + r1(Y(ks[i - 1][key])) + " L" + r1(x) + "," + r1(y); }
      });
      var lastX = X(ks[ks.length - 1].m), lastY = Y(ks[ks.length - 1][key]);
      s += '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2.2" stroke-linejoin="round"></path>';
      s += '<circle cx="' + r1(lastX) + '" cy="' + r1(lastY) + '" r="4" style="fill:' + C.bg + ';stroke:' + color + ';stroke-width:2.2"></circle>';
      s += pill(lastX, lastY, String(ks[ks.length - 1][key]), C, geo, color);
    }
    stepPath(ks, "k2", C.red);
    stepPath(ks, "k1", C.blue);
    return s;
  }

  function emptySvg(geo) {
    return '<text x="' + (geo.pad.l + geo.PW / 2) + '" y="' + (geo.pad.t + geo.PH / 2) +
      '" text-anchor="middle" style="fill:' + geo.C.ink3 + ';font-size:12px">采样点不足，无法绘制走势</text>';
  }

  function pill(x, y, text, C, geo, color) {
    var w = 34 + String(text).length * 6.2;
    var bx = clamp(x - w / 2, geo.pad.l + 2, geo.pad.l + geo.PW - w - 2);
    var by = (y - 32 >= geo.pad.t + 2) ? y - 32 : clamp(y + 12, geo.pad.t + 2, geo.pad.t + geo.PH - 24);
    return '<g><rect x="' + r1(bx) + '" y="' + r1(by) + '" width="' + r1(w) + '" height="20" rx="6" style="fill:' +
      (color || C.ink) + ';opacity:.08"></rect>' +
      '<rect x="' + r1(bx) + '" y="' + r1(by) + '" width="' + r1(w) + '" height="20" rx="6" style="fill:none;stroke:' +
      (color || C.ink) + ';stroke-opacity:.2"></rect>' +
      '<text x="' + r1(bx + w / 2) + '" y="' + r1(by + 13.5) + '" text-anchor="middle" style="fill:' +
      (color || C.ink2) + ';font-size:10.5px;font-weight:600;letter-spacing:.02em">' + esc(text) + "</text></g>";
  }

  function eventTicks(geo, X, C) {
    var evs = ((state.battle && state.battle.events) || []).filter(function (e) {
      return e.key === 1 && e.m != null && e.m <= geo.dur + 0.2;
    });
    var out = [];
    var lastX = -99;
    evs.forEach(function (e) {
      var x = X(e.m);
      if (x - lastX < 16) return;
      lastX = x;
      var blue = String(e.team || "").indexOf(state.g && state.g.t1 || "\u0000") === 0;
      var col = blue ? C.blue : C.red;
      out.push('<g><title>' + esc((e.l || "") + " · " + r1(e.m) + "′") + "</title>" +
        '<circle cx="' + r1(x) + '" cy="' + (geo.pad.t + geo.PH + 2) + '" r="2.2" style="fill:' + col + ';opacity:.65"></circle>' +
        '<line x1="' + r1(x) + '" y1="' + (geo.pad.t + geo.PH - 6) + '" x2="' + r1(x) + '" y2="' + (geo.pad.t + geo.PH + 1) +
        '" style="stroke:' + col + ';stroke-width:1;opacity:.28"></line></g>');
    });
    return out;
  }

  function smooth(pts, yMin, yMax) {
    if (!pts.length) return "";
    var d = "M" + r1(pts[0][0]) + "," + r1(pts[0][1]);
    for (var i = 1; i < pts.length; i++) {
      var p0 = pts[Math.max(0, i - 2)], p1 = pts[i - 1], p2 = pts[i], p3 = pts[Math.min(pts.length - 1, i + 1)];
      var t = 0.17;
      var c1x = p1[0] + (p2[0] - p0[0]) * t, c1y = clamp(p1[1] + (p2[1] - p0[1]) * t, yMin, yMax);
      var c2x = p2[0] - (p3[0] - p1[0]) * t, c2y = clamp(p2[1] - (p3[1] - p1[1]) * t, yMin, yMax);
      d += " C" + r1(c1x) + "," + r1(c1y) + " " + r1(c2x) + "," + r1(c2y) + " " + r1(p2[0]) + "," + r1(p2[1]);
    }
    return d;
  }

  function bindHover() {
    var el = chartState.el;
    var tip = chartState.tip;
    if (!el || !tip) return;
    var svg = el.querySelector("svg");
    var hit = el.querySelector("#gpHit");
    var cursorG = el.querySelector("#gpCursor");
    if (!svg || !hit) return;

    function move(evt) {
      var geo = chartState.geo;
      if (!geo) return;
      var rect = svg.getBoundingClientRect();
      var px = (evt.clientX - rect.left) * (geo.W / rect.width);
      var py = (evt.clientY - rect.top) * (geo.H / rect.height);
      var m = ((px - geo.pad.l) / geo.PW) * geo.dur;
      var rows = chartState.rows;
      if (!rows.length) return;
      var idx = 0, best = Infinity;
      for (var i = 0; i < rows.length; i++) {
        var d = Math.abs((rows[i].m != null ? rows[i].m : rows[i].sec / 60) - m);
        if (d < best) { best = d; idx = i; }
      }
      var row = rows[idx];
      var rm = row.m != null ? row.m : row.sec / 60;
      var x = geo.pad.l + (rm / geo.dur) * geo.PW;
      var y;
      if (chartState.mode === "p") y = geo.pad.t + (1 - row.p) * geo.PH;
      else if (chartState.mode === "g") {
        var eco = rows;
        var maxAbs = Math.max(1000, Math.ceil(Math.max.apply(null, eco.map(function (p) { return Math.abs(p.diff); })) / 1000) * 1000);
        y = geo.pad.t + (0.5 - (row.diff / maxAbs) * 0.46) * geo.PH;
      } else {
        var ks = rows;
        var maxK = Math.max(5, Math.max(ks[ks.length - 1].k1, ks[ks.length - 1].k2));
        maxK = Math.ceil(maxK / 5) * 5;
        y = geo.pad.t + (1 - row.k1 / maxK) * geo.PH;
      }
      cursorG.style.opacity = "1";
      var line = cursorG.querySelector("line");
      var dot = cursorG.querySelector("circle");
      line.setAttribute("x1", x); line.setAttribute("x2", x);
      dot.setAttribute("cx", x); dot.setAttribute("cy", y);

      tip.innerHTML = tipHTML(row, rm, idx);
      tip.classList.add("show");
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      var left = clamp(x - tw / 2, 8, geo.W - tw - 8);
      var top = clamp(y - th - 18, 6, geo.H - th - 6);
      tip.style.left = left + "px";
      tip.style.top = top + "px";
      tip.style.transform = "none";
    }

    function leave() {
      cursorG.style.opacity = "0";
      tip.classList.remove("show");
    }

    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", leave);
  }

  function tipHTML(row, rm, idx) {
    var g = state.g || {};
    var t1 = g.t1 || "蓝方", t2 = g.t2 || "红方";
    if (chartState.mode === "p") {
      var frame = probFrames()[idx] || {};
      var gd = frame.gd;
      var ev = nearestEvent(rm);
      return '<div class="t">' + esc(r1(rm)) + "′ · " + (row.p >= 0.5 ? "蓝方领先" : "红方领先") + "</div>" +
        '<div class="row"><span>' + esc(t1) + " 胜率</span><b class=\"" + (row.p >= 0.5 ? "blue" : "red") + '">' + pct(row.p, 1) + "</b></div>" +
        (gd != null ? '<div class="row"><span>经济差</span><b>' + signed(gd) + "</b></div>" : "") +
        (frame.k ? '<div class="row"><span>击杀</span><b>' + frame.k[0] + " : " + frame.k[1] + "</b></div>" : "") +
        (ev ? '<div class="row" style="color:var(--gp-ink-3)"><span>' + esc(ev) + "</span></div>" : "");
    }
    if (chartState.mode === "g") {
      return '<div class="t">' + mmss(row.sec) + "</div>" +
        '<div class="row"><span>经济差</span><b class="' + (row.diff >= 0 ? "blue" : "red") + '">' + signed(row.diff) + "</b></div>" +
        '<div class="row"><span>领先方</span><b>' + (row.diff >= 0 ? esc(t1) : esc(t2)) + "</b></div>";
    }
    return '<div class="t">' + esc(r1(rm)) + "′</div>" +
      '<div class="row"><span>' + esc(t1) + " 击杀</span><b class=\"blue\">" + row.k1 + "</b></div>" +
      '<div class="row"><span>' + esc(t2) + " 击杀</span><b class=\"red\">" + row.k2 + "</b></div>";
  }

  function nearestEvent(m) {
    var evs = (state.battle && state.battle.events) || [];
    var best = null;
    evs.forEach(function (e) {
      if (e.m == null) return;
      var d = Math.abs(e.m - m);
      if (d <= 1.2 && (!best || d < best.d)) best = { d: d, l: e.l };
    });
    return best ? best.l : "";
  }

  /* ---------------- 02 复盘结论 ---------------- */

  function storyHTML() {
    var pf = probFrames();
    if (pf.length < 3) return "";
    var g = state.g || {};
    var t1 = g.t1 || "蓝方", t2 = g.t2 || "红方";
    var dec = decisive(pf);
    var winSide = g.win === 2 ? 2 : 1;
    var winner = winSide === 1 ? t1 : t2;
    var lines = [];
    var after = pf.filter(function (f) { return f.m >= dec.m1; });
    var held = after.length ? after.every(function (f) { return winSide === 1 ? f.p >= 0.5 : f.p <= 0.5; }) : false;
    var minAfter = after.reduce(function (a, b) { return Math.min(a, b.p); }, 1);
    var maxAfter = after.reduce(function (a, b) { return Math.max(a, b.p); }, 0);
    var last = pf[pf.length - 1];

    if (Math.abs(dec.dp) < 0.08) {
      lines.push("本局胜率全程胶着，最大单次摆动只有 <em>" + r1(Math.abs(dec.dp) * 100) + " 个百分点</em>。");
      lines.push("直到终场前，模型对 <strong>" + esc(winner) + "</strong> 的胜率估算仍停留在 <em class=\"" +
        (winSide === 1 ? "" : "r") + "\">" + pct(last.p) + "</em>。");
    } else {
      var dirTxt = dec.dp > 0 ? "抬升到" : "跌到";
      var toTeam = dec.dp > 0 ? t1 : t2;
      lines.push("第 <em>" + r1(dec.m0) + "′</em> 到 <em>" + r1(dec.m1) + "′</em>，" + esc(t1) +
        " 的胜率从 <em>" + pct(dec.p0) + "</em> " + dirTxt + " <em class=\"" + (dec.dp > 0 ? "" : "r") + "\">" +
        pct(dec.p1) + "</em>（" + (dec.dp > 0 ? "+" : "−") + r1(Math.abs(dec.dp) * 100) + " 个百分点）" +
        (dec.dp > 0 ? "，比赛在这一段被拉开。" : "，主动权转到 <strong>" + esc(toTeam) + "</strong>。"));
      if (dec.g0 != null && dec.g1 != null) {
        lines.push("同期经济差从 <em>" + signed(dec.g0) + "</em> 变为 <em>" + signed(dec.g1) + "</em>。");
      }
      if (held) {
        lines.push("此后 <strong>" + esc(winner) + "</strong> 的领先没有再让出，最终在 <em>" + r1(geoDur()) + "′</em> 结束比赛。");
      } else {
        lines.push("此后局面仍有反复：胜率最低回到 <em class=\"" + (winSide === 1 ? "r" : "") + "\">" + pct(minAfter) +
          "</em>，但 <strong>" + esc(winner) + "</strong> 最终收下比赛。");
      }
    }

    // 关键节点（取摆动最大的 3 段）
    var swings = [];
    for (var i = 1; i < pf.length; i++) {
      swings.push({
        m0: pf[i - 1].m, m1: pf[i].m,
        p0: pf[i - 1].p, p1: pf[i].p,
        g0: pf[i - 1].gd, g1: pf[i].gd,
        dp: pf[i].p - pf[i - 1].p
      });
    }
    swings.sort(function (a, b) { return Math.abs(b.dp) - Math.abs(a.dp); });
    var picked = [];
    swings.forEach(function (s) {
      if (picked.length >= 3) return;
      if (picked.some(function (x) { return Math.abs(x.m1 - s.m1) < 2.4; })) return;
      picked.push(s);
    });
    picked.sort(function (a, b) { return a.m1 - b.m1; });

    var nodes = picked.map(function (s) {
      var ev = nearestEvent(s.m1);
      var dpp = s.dp > 0 ? "+" : "−";
      var gtxt = (s.g0 != null && s.g1 != null) ? signed(s.g1) : "—";
      return '<div class="gp-node">' +
        '<span class="t">' + r1(s.m1) + "′</span>" +
        '<span class="e">' + (ev ? esc(ev) : "胜率快速摆动") + "<small>" + pct(s.p0) + " → " + pct(s.p1) + "</small></span>" +
        '<span class="p ' + (s.dp > 0 ? "up" : "down") + '">' + dpp + r1(Math.abs(s.dp) * 100) + '<span class="u">点</span></span>' +
        '<span class="g">' + gtxt + "</span>" +
        "</div>";
    }).join("");

    var sources = '<span class="gp-src">官方比分</span><span class="gp-src">事件 / 经济：官方</span>' +
      '<span class="gp-src est">胜率曲线：模型估算</span>' +
      '<span class="gp-src-note">口径：单局 · 逐分钟采样</span>';

    return '<section class="gp-card gp-r" id="gpStory">' +
      '<div class="gp-head"><div>' +
      '<div class="gp-eyebrow"><span class="idx">02</span> READ</div>' +
      '<h2 class="gp-title">复盘结论</h2>' +
      '<p class="gp-note">先看一句话结论与关键节点；逐分钟明细在下一节。</p>' +
      "</div></div>" +
      '<div class="gp-story">' +
      "<div>" +
      '<p class="gp-quote">' + lines.join("") + "</p>" +
      '<div class="gp-story-actions">' +
      '<button class="gp-linkbtn" type="button" id="gpScrollLog">展开逐分钟明细 <span class="arr">↓</span></button>' +
      '<a class="gp-linkbtn" href="match.html?id=' + encodeURIComponent(state.mid) + '">整场数据 →</a>' +
      '<a class="gp-linkbtn" href="bp-studio.html?match=' + encodeURIComponent(state.mid) + "&amp;g=" +
      encodeURIComponent((state.g && state.g.seq) || 1) + '">进入 BP 演播室 →</a>' +
      '<button class="gp-linkbtn" type="button" id="gpCopy">复制本局链接</button>' +
      "</div>" +
      '<div class="gp-quote-foot">' + sources + "</div>" +
      "</div>" +
      "<div>" +
      '<div class="gp-nodes">' +
      '<div class="gp-nodes-head"><span>时间</span><span>关键节点</span><span>胜率摆动</span><span>经济差</span></div>' +
      (nodes || '<div class="gp-empty-row">采样点不足，暂无可展示节点</div>') +
      "</div></div>" +
      "</div></section>";
  }

  function geoDur() {
    return durMinutes(state.g || {}, state.rec, state.battle);
  }

  /* ---------------- 03 对局记录 ---------------- */

  var logState = { filter: "all" };

  function records() {
    if (!state.rec || !state.rec.records) return [];
    return state.rec.records.slice().sort(function (a, b) { return (a.t || 0) - (b.t || 0); });
  }

  function countBy(tag) {
    return records().filter(function (r) { return r.tag === tag; }).length;
  }

  function evTitle(r) {
    var t = r.tag;
    var actor = esc(r.hero || r.last_hit || "");
    if (t === "Buff") return "<b>" + actor + '</b><span class="act">击杀</span><span class="tgt">' + esc(r.target || "野怪") + "</span>";
    if (t === "打龙") return "<b>" + actor + '</b><span class="act">击败</span><span class="tgt">' + esc(r.target || "中立资源") + "</span>";
    if (t === "推塔") return "<b>" + actor + '</b><span class="act">摧毁</span><span class="tgt">' + esc(r.target || "防御塔") + "</span>";
    if (t === "出装") return "<b>" + actor + '</b><span class="act">购买</span><span class="tgt">' + esc(r.target || "装备") + "</span>";
    return "<b>" + actor + "</b> " + esc(r.target || "");
  }

  function evRow(r, idx) {
    var tg = tagOf(r.tag);
    var camp = Number(r.camp) === 2 ? 2 : 1;
    var team = camp === 2 ? (state.g && state.g.t2 || "红方") : (state.g && state.g.t1 || "蓝方");
    var parts = (r.participants || []).filter(function (p) { return p && p.icon; });
    var party = parts.slice(0, 4).map(function (p) {
      return '<img class="av" src="' + esc(p.icon) + '" alt="" loading="lazy" onerror="this.remove()">';
    }).join("");
    var more = parts.length > 4 ? '<span class="more">+' + (parts.length - 4) + "</span>" : "";
    var detail = "";
    if (parts.length) {
      detail = parts.map(function (p) {
        var share = Number(p.damage_share);
        if (!isFinite(share)) share = 0;
        return '<div class="gp-evd-row ' + (Number(p.camp) === 2 ? "c2" : "") + '">' +
          '<img src="' + esc(p.icon) + '" alt="" loading="lazy" onerror="this.remove()">' +
          '<span class="nm" style="color:' + (Number(p.camp) === 2 ? "var(--gp-red)" : "var(--gp-blue)") + '">' + esc(p.hero || "") + "</span>" +
          '<span class="bar"><i style="width:' + r1(clamp(share, 0, 1) * 100) + '%"></i></span>' +
          '<span class="v">' + (isFinite(Number(p.damage_share)) ? Math.round(Number(p.damage_share) * 100) + "%" : "—") + "</span>" +
          "</div>";
      }).join("");
      detail += '<div class="gp-evd-note">进度条 = 该参与者对本事件的伤害占比（官方营地战报）。</div>';
    } else {
      detail = '<div class="gp-evd-note">该事件为装备购买节点，只记录时间与装备，不包含参战信息。</div>';
    }
    var t = Number(r.t) || 0;
    return '<div class="gp-ev ' + (camp === 2 ? "c2" : "") + (tg.cls ? " t-" + tg.cls : "") + '" data-tag="' + esc(r.tag) +
      '" data-t="' + t + '" tabindex="0" role="button" aria-expanded="false">' +
      '<span class="gp-ev-time">' + esc(r.mmss || "") + "</span>" +
      '<span class="gp-ev-rail"><i></i></span>' +
      '<span class="gp-ev-main">' +
      '<span class="gp-ev-title">' + evTitle(r) + "</span>" +
      '<span class="gp-ev-meta"><span class="gp-tag ' + tg.cls + '">' + esc(tg.label) + "</span>" +
      '<span class="team"><i></i>' + esc(team) + "</span>" +
      (parts.length ? "<span>参与 " + parts.length + " 人</span>" : "") +
      "</span></span>" +
      '<span class="gp-ev-party">' + party + more + "</span>" +
      '<span class="gp-ev-arrow">›</span>' +
      '<span class="gp-evd"><span class="gp-evd-in"><span class="gp-evd-body">' + detail + "</span></span></span>" +
      "</div>";
  }

  function timelineHTML() {
    var rows = records();
    if (!rows.length) return "";
    var tags = [
      ["all", "全部", rows.length],
      ["Buff", "野区", countBy("Buff")],
      ["打龙", "打龙", countBy("打龙")],
      ["推塔", "推塔", countBy("推塔")],
      ["出装", "出装", countBy("出装")]
    ];
    var filters = tags.map(function (t) {
      return '<button class="gp-chip" type="button" data-filter="' + t[0] + '" aria-pressed="' +
        (t[0] === logState.filter ? "true" : "false") + '">' + t[1] + " <b>" + t[2] + "</b></button>";
    }).join("");

    var groups = [];
    var order = ["early", "mid", "late", "end"];
    var phaseInfo = {};
    rows.forEach(function (r) {
      var ph = phaseOf(Number(r.t) || 0);
      if (!phaseInfo[ph.key]) { phaseInfo[ph.key] = { ph: ph, rows: [] }; groups.push(ph.key); }
      phaseInfo[ph.key].rows.push(r);
    });
    var html = groups.map(function (key) {
      var bucket = phaseInfo[key];
      var visible = bucket.rows.filter(function (r) { return logState.filter === "all" || r.tag === logState.filter; });
      return '<div class="gp-phase-bar"><span class="nm">' + bucket.ph.nm + '</span><span class="rg">' +
        bucket.ph.rg + '</span><span class="cnt">' + visible.length + " 条</span></div>" +
        (visible.length ? visible.map(function (r) { return evRow(r); }).join("") :
          '<div class="gp-empty-row" style="padding:14px 0;font-size:12px">该赛期没有这类事件</div>');
    }).join("");

    return '<section class="gp-card gp-r" id="gpLog">' +
      '<div class="gp-head">' +
      "<div>" +
      '<div class="gp-eyebrow"><span class="idx">03</span> LOG</div>' +
      '<h2 class="gp-title">对局记录</h2>' +
      '<p class="gp-note">' + rows.length + " 条逐事件记录 · 营地战报归档 · 点击事件展开参与者</p>" +
      "</div>" +
      '<div class="gp-filters">' + filters + "</div>" +
      "</div>" +
      '<div class="gp-timeline" id="gpTimeline">' + html + "</div>" +
      "</section>";
  }

  /* ---------------- 04 阵容 ---------------- */

  function bpHTML(camp) {
    var g = state.g || {};
    var bp = g.bp || [];
    var picks = bp.filter(function (b) { return b[0] === camp && b[1] === 1; });
    var bans = bp.filter(function (b) { return b[0] === camp && b[1] === 0; });
    function pick(p, i) {
      var ic = heroIcon(p[2]);
      return '<span class="gp-pick" title="' + esc(p[2]) + '"><span class="ph">' +
        '<span class="fb">' + esc(String(p[2] || "").slice(0, 1)) + "</span>" +
        (ic ? '<img src="' + esc(ic) + '" alt="" onerror="this.remove()">' : "") +
        "<i>" + (i + 1) + '</i></span><span class="nm">' + esc(p[2]) + "</span></span>";
    }
    function ban(p) {
      var ic = heroIcon(p[2]);
      return '<span class="ban" title="禁用 ' + esc(p[2]) + '">' +
        '<span class="fb">' + esc(String(p[2] || "").slice(0, 1)) + "</span>" +
        (ic ? '<img src="' + esc(ic) + '" alt="" onerror="this.remove()">' : "") + "</span>";
    }
    if (!picks.length && !bans.length) return "";
    return '<div class="gp-bp">' +
      '<div class="gp-bp-row"><span class="gp-bp-lab">选择</span>' + picks.map(pick).join("") + "</div>" +
      (bans.length ? '<div class="gp-bp-row"><span class="gp-bp-lab">禁用</span><span class="gp-bans">' +
        bans.map(ban).join("") + "</span></div>" : "") +
      "</div>";
  }

  function playersOf(camp) {
    var g = state.g || {};
    return (g.players || []).filter(function (p) { return Number(p.c) === camp; });
  }

  function teamCardHTML(camp) {
    var g = state.g || {};
    var name = camp === 1 ? (g.t1 || "蓝方") : (g.t2 || "红方");
    var logo = camp === 1 ? g.i1 : g.i2;
    var isWin = g.win === camp;
    var kills = camp === 1 ? g.k1 : g.k2;
    var gold = camp === 1 ? g.g1 : g.g2;
    var rows = playersOf(camp).map(function (p) {
      var ic = heroIcon(p.h);
      var eq = (p.eq || []).map(function (n) {
        var e = (window.KPL_EQUIP_ICONS || {})[n] || "";
        return e ? '<img src="' + esc(e) + '" alt="" title="' + esc(n) + '" loading="lazy" onerror="this.remove()">'
          : "";
      }).join("");
      var sa = p.sai ? '<img class="sa" src="' + esc(p.sai) + '" alt="" title="' + esc(p.sa || "召唤师技能") +
        '" loading="lazy" onerror="this.remove()">' : "";
      return '<div class="gp-prow' + (p.mvp ? " mvp" : "") + '">' +
        '<a class="gp-hero-ico" href="hero.html?id=' + encodeURIComponent(p.h) + '" title="' + esc(p.h) + '">' +
        pic(ic, p.h, "", p.h) + "</a>" +
        '<div class="gp-who">' +
        '<a class="h" href="hero.html?id=' + encodeURIComponent(p.h) + '">' + esc(p.h) + "</a>" +
        '<span class="p"><a href="player.html?id=' + encodeURIComponent(p.n) + '">' +
        '<img src="' + esc(p.pi || "") + '" alt="" loading="lazy" onerror="this.remove()">' + esc(p.n) + "</a>" +
        (p.mvp ? "<em>MVP</em>" : "") + "</span>" +
        "</div>" +
        '<div class="gp-kda"><b>' + esc(String(p.k)) + "</b>/" + esc(String(p.d)) + "/" + esc(String(p.a)) + "</div>" +
        '<div class="gp-gold">' + fmt(p.g) + "</div>" +
        '<div class="gp-meters">' + detailMeter("输出", p.dmg) + detailMeter("承伤", p.bh) + "</div>" +
        '<div class="gp-kit">' + eq + sa + "</div>" +
        "</div>";
    }).join("");

    return '<div class="gp-team ' + (camp === 2 ? "c2" : "c1") + '">' +
      '<div class="gp-team-top">' +
      '<img class="lg" src="' + esc(logo || "") + '" alt="" onerror="this.remove()">' +
      '<span class="nm">' + esc(name) + '<span>' + (camp === 1 ? "蓝方" : "红方") + "</span></span>" +
      (isWin ? '<span class="win">本局胜</span>' : "") +
      '<span class="sum">' + (kills != null ? kills + " 击杀 · " + fmt(gold) + " 经济" : "") + "</span>" +
      "</div>" +
      bpHTML(camp) +
      '<div class="gp-ptable">' +
      rows +
      "</div></div>";
  }

  function detailMeter(label, v) {
    var n = Number(v);
    var w = isFinite(n) ? clamp(n, 0, 100) : 0;
    return '<div class="gp-meter"><span class="lb">' + label + '</span><span class="bar"><i style="width:' +
      r1(w) + '%"></i></span><span class="v">' + (isFinite(n) ? n.toFixed(1) + "%" : "—") + "</span></div>";
  }

  function lineupHTML() {
    var g = state.g || {};
    if (!g.players || !g.players.length) return "";
    return '<section class="gp-card gp-r" id="gpLineup">' +
      '<div class="gp-head"><div>' +
      '<div class="gp-eyebrow"><span class="idx">04</span> LINEUP</div>' +
      '<h2 class="gp-title">双方阵容</h2>' +
      '<p class="gp-note">BP 与逐局选手数据 · 输出 / 承伤为全队占比</p>' +
      "</div></div>" +
      '<div class="gp-lineups">' + teamCardHTML(1) + teamCardHTML(2) + "</div>" +
      "</section>";
  }

  /* ---------------- 渲染主流程 ---------------- */

  function renderPage() {
    var g = state.g || {};
    var source = '<div class="gp-source">' +
      "<span>数据来源：官方逐局数据 · " + esc(state.mid) + " 第 " + esc(g.seq || 1) + " 局" +
      (state.rec ? " · 营地战报" : "") + "</span>" +
      '<span><a href="about.html">数据说明</a> · <a href="match.html?id=' + encodeURIComponent(state.mid) +
      '">回到整场</a></span></div>';

    app.innerHTML = heroHTML() +
      '<div class="gp-wrap gp-body">' +
      (flowHTML()) +
      storyHTML() +
      timelineHTML() +
      lineupHTML() +
      source +
      "</div>";

    if (document.getElementById("gpChart")) mountChart();
    bindStory();
    bindLog();
    bindReveal();
    jumpToMinute();
    window.addEventListener("resize", debounce(function () {
      if (chartState.mounted && document.getElementById("gpChart")) drawChart();
    }, 180));
  }

  /* 从「精选对局」带着关键分钟进来：定位并展开最近的一条事件 */
  function jumpToMinute() {
    if (!isFinite(JUMP_M) || JUMP_M <= 0) return;
    var log = document.getElementById("gpLog");
    if (!log) return;
    var rows = Array.prototype.slice.call(log.querySelectorAll(".gp-ev"));
    if (!rows.length) return;
    var target = JUMP_M * 60;
    var best = null, bestD = Infinity;
    rows.forEach(function (r) {
      var t = Number(r.getAttribute("data-t"));
      if (!isFinite(t)) return;
      var d = Math.abs(t - target);
      if (d < bestD) { bestD = d; best = r; }
    });
    if (!best) return;
    best.classList.add("open");
    best.setAttribute("aria-expanded", "true");
    best.classList.add("gp-ev-focus");
    setTimeout(function () {
      best.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 220);
  }

  function bindStory() {
    var scrollBtn = document.getElementById("gpScrollLog");
    if (scrollBtn) {
      scrollBtn.addEventListener("click", function () {
        var el = document.getElementById("gpLog");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    var copy = document.getElementById("gpCopy");
    if (copy) {
      copy.addEventListener("click", function () {
        var txt = location.href;
        var done = function () {
          copy.textContent = "已复制";
          setTimeout(function () { copy.textContent = "复制本局链接"; }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(txt).then(done).catch(done);
        } else {
          done();
        }
      });
    }
  }

  function bindLog() {
    var panel = document.getElementById("gpLog");
    if (!panel) return;
    var filters = panel.querySelectorAll(".gp-chip");
    filters.forEach(function (b) {
      b.addEventListener("click", function () {
        logState.filter = b.getAttribute("data-filter");
        filters.forEach(function (x) {
          x.setAttribute("aria-pressed", x === b ? "true" : "false");
        });
        var holder = document.getElementById("gpTimeline");
        holder.innerHTML = timelineInner();
        bindLogRows();
      });
    });
    bindLogRows();
  }

  function timelineInner() {
    var rows = records().filter(function (r) { return logState.filter === "all" || r.tag === logState.filter; });
    var order = ["early", "mid", "late", "end"];
    var map = {};
    rows.forEach(function (r) {
      var ph = phaseOf(Number(r.t) || 0);
      (map[ph.key] = map[ph.key] || { ph: ph, rows: [] }).rows.push(r);
    });
    var html = "";
    order.forEach(function (key) {
      var bucket = map[key];
      if (!bucket) return;
      html += '<div class="gp-phase-bar"><span class="nm">' + bucket.ph.nm + '</span><span class="rg">' +
        bucket.ph.rg + '</span><span class="cnt">' + bucket.rows.length + " 条</span></div>" +
        bucket.rows.map(function (r) { return evRow(r); }).join("");
    });
    return html || '<div class="gp-empty-row">这个筛选下没有事件</div>';
  }

  function bindLogRows() {
    var wrap = document.getElementById("gpTimeline");
    if (!wrap) return;
    wrap.querySelectorAll(".gp-ev").forEach(function (row) {
      function toggle() {
        var open = row.classList.toggle("open");
        row.setAttribute("aria-expanded", open ? "true" : "false");
      }
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });
    });
  }

  function bindReveal() {
    var items = document.querySelectorAll(".gp-r");
    if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      items.forEach(function (x) { x.classList.add("in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.02 });
    items.forEach(function (x) { io.observe(x); });
  }
})();
