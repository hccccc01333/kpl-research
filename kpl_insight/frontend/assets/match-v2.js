/* ==========================================================================
   KPL 赛研 · 比赛详情 V2（BO 系列赛）
   数据源：schedule_all.js / games/<league>.json / replay/<match>.json
   ========================================================================== */
(function () {
  "use strict";

  var K = window.KPL;
  var app = document.getElementById("matchApp");
  if (!app) return;
  if (K && K.init) K.init();

  var esc = (K && K.esc) || function (v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  function fmt(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function pct(v, d) { var n = Number(v); return isFinite(n) ? (n * 100).toFixed(d == null ? 0 : d) + "%" : "—"; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function debounce(fn, wait) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }
  function pic(url, alt, fbChar) {
    var fb = fbChar ? '<i class="fb">' + esc(String(fbChar).slice(0, 1)) + "</i>" : "";
    if (!url) return fb;
    return fb + '<img src="' + esc(url) + '" alt="' + esc(alt || "") + '" onerror="this.remove()">';
  }
  function mmss(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  var MID = new URLSearchParams(location.search).get("id") || "";
  var state = { row: null, games: [], replay: {}, heroIcon: {} };

  if (!MID) { fatal("缺少比赛参数", "本页需要 ?id= 比赛 ID，请从赛程中心进入。"); return; }

  state.row = (window.KPL_SCHEDULE_ALL || []).filter(function (r) { return String(r.matchId) === String(MID); })[0] || null;
  if (!state.row) { fatal("未找到这场比赛", "赛程索引里没有这个 ID，可能链接已过期。"); return; }

  try {
    ((K.scopeOf && K.scopeOf("all")) || {}).heroes.forEach(function (h) { state.heroIcon[h.name] = h.icon; });
  } catch (_) {}

  var row = state.row;
  if (!row.team1 || row.team1 === "待定") { fatal("对阵未定", "这场比赛还没有确定双方阵容，稍后再来看看。"); return; }

  var reqs = [];
  var lg = row.leagueId || "";
  if (lg) {
    reqs.push(fetch("assets/games/" + lg + ".json").then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    }).then(function (data) {
      Object.keys(data || {}).forEach(function (bid) {
        var g = data[bid];
        if (g && String(g.match) === String(MID)) state.games.push({ bid: bid, g: g });
      });
      state.games.sort(function (a, b) { return (a.g.seq || 0) - (b.g.seq || 0); });
    }).catch(function () {}));
  }
  if (window.KPL_REPLAY_INDEX && window.KPL_REPLAY_INDEX[MID]) {
    reqs.push(fetch("assets/replay/" + MID + ".json").then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json();
    }).then(function (data) {
      ((data && data.battles) || []).forEach(function (b) { state.replay[b.battleId] = b; });
    }).catch(function () {}));
  }

  Promise.all(reqs).then(function () {
    render();
  });

  /* 系列赛队色：按首局阵营固定，避免每局蓝红互换导致颜色跳变 */
  var TEAM_COLOR = {};
  function computeColors() {
    TEAM_COLOR = {};
    if (state.games.length) {
      var first = state.games[0].g;
      if (first.t1) TEAM_COLOR[first.t1] = "blue";
      if (first.t2) TEAM_COLOR[first.t2] = "red";
    }
    TEAM_COLOR[row.team1] = TEAM_COLOR[row.team1] || "blue";
    TEAM_COLOR[row.team2] = TEAM_COLOR[row.team2] || "red";
  }
  function colorOf(team) { return TEAM_COLOR[team] || "blue"; }

  /* ---------------- 站内基础 ---------------- */
  function fatal(title, note) {
    app.innerHTML = '<section class="mt-hero"><div class="v2-wrap">' +
      '<nav class="v2-crumb"><a href="schedule.html">赛程</a><span class="sep">/</span><b>比赛</b></nav>' +
      '<div class="mt-fatal"><div class="v2-eyebrow"><span class="idx">MATCH</span> 比赛详情</div>' +
      '<h1 class="v2-h1" style="font-size:clamp(24px,3vw,38px);margin-top:14px">' + esc(title) + "</h1>" +
      '<p class="v2-lead" style="margin-top:12px">' + esc(note) + "</p>" +
      '<div class="v2-actions" style="margin-top:22px"><a class="v2-btn solid" href="schedule.html">返回赛程</a></div></div></div></section>';
    document.title = "比赛详情 · KPL赛研";
  }

  /* ---------------- 系列赛计算 ---------------- */
  function winnerName() {
    if (row.score1 == null || row.score2 == null) return "";
    if (Number(row.score1) === Number(row.score2)) return "";
    return Number(row.score1) > Number(row.score2) ? row.team1 : row.team2;
  }
  function seriesScore() {
    return { a: row.score1, b: row.score2 };
  }
  function targetWins() {
    var bo = Number(row.bo) || 0;
    return bo ? Math.floor(bo / 2) + 1 : 3;
  }

  function gamesInfo() {
    var target = targetWins();
    var win = winnerName();
    var running = {};
    var clincher = -1;
    var list = state.games.map(function (item, idx) {
      var g = item.g;
      var t1 = g.t1 || "", t2 = g.t2 || "";
      var camp = Number(g.win);
      var wn = camp === 1 ? t1 : camp === 2 ? t2 : "";
      var ln = camp === 1 ? t2 : camp === 2 ? t1 : "";
      if (wn) {
        running[wn] = (running[wn] || 0) + 1;
        if (clincher < 0 && running[wn] >= target) clincher = idx;
      }
      var battle = state.replay[item.bid] || null;
      var frames = (battle && battle.frames) ? battle.frames.filter(function (f) { return f.p != null; }) : [];
      var minP = null, maxP = null;
      frames.forEach(function (f) {
        var p = Number(f.p);
        if (!isFinite(p)) return;
        minP = minP == null ? p : Math.min(minP, p);
        maxP = maxP == null ? p : Math.max(maxP, p);
      });
      var comeback = false;
      if (frames.length && camp) {
        var winP = camp === 1 ? minP : maxP;
        comeback = camp === 1 ? (minP != null && minP <= 0.35) : (maxP != null && maxP >= 0.65);
        if (winP == null) comeback = false;
      }
      var mvp = "";
      (g.players || []).forEach(function (p) { if (p.mvp) mvp = p.n; });
      return {
        idx: idx, bid: item.bid, g: g, t1: t1, t2: t2, camp: camp,
        win: wn, lose: ln, dur: Number(g.dur) || 0,
        k1: g.k1, k2: g.k2, mvp: mvp,
        frames: frames, minP: minP, maxP: maxP, comeback: comeback,
        isClincher: false, isLongest: false, isFastest: false, live: !!(g.live === 1 || g.win == null || win === "")
      };
    });
    if (clincher >= 0) list[clincher].isClincher = true;
    var durs = list.map(function (x) { return x.dur; });
    var maxD = durs.length ? Math.max.apply(null, durs) : 0;
    var minD = durs.length ? Math.min.apply(null, durs) : 0;
    list.forEach(function (x) {
      if (x.dur === maxD && list.length > 1) x.isLongest = true;
      if (x.dur === minD && list.length > 1) x.isFastest = true;
    });
    return { list: list, winner: win, clincher: clincher };
  }

  function totals(info) {
    var dur = 0, kills = 0;
    info.list.forEach(function (x) { dur += x.dur; kills += (Number(x.k1) || 0) + (Number(x.k2) || 0); });
    return {
      dur: dur,
      avgDur: info.list.length ? dur / info.list.length : 0,
      kills: kills
    };
  }

  /* ---------------- 迷你胜率曲线 ---------------- */
  var sparkSeq = 0;
  function sparkSVG(frames, invert, color) {
    var W = 260, H = 58, pad = 5;
    var pts = frames.filter(function (f) { return f.p != null; }).map(function (f) {
      var pv = clamp(Number(f.p), 0, 1);
      return { m: Number(f.m) || 0, p: invert ? 1 - pv : pv };
    });
    if (pts.length < 3) {
      return '<div class="mg-spark-empty">无分钟级快照</div>';
    }
    var dur = Math.max(1, pts[pts.length - 1].m);
    var X = function (m) { return pad + (m / dur) * (W - pad * 2); };
    var Y = function (p) { return pad + (1 - p) * (H - pad * 2); };
    var d = "";
    pts.forEach(function (p, i) {
      var x = X(p.m), y = Y(p.p);
      if (i === 0) { d += "M" + x.toFixed(1) + "," + y.toFixed(1); }
      else {
        var prev = pts[i - 1];
        var x0 = X(prev.m), y0 = Y(prev.p);
        var cx = (x0 + x) / 2;
        d += " C" + cx.toFixed(1) + "," + y0.toFixed(1) + " " + cx.toFixed(1) + "," + y.toFixed(1) + " " + x.toFixed(1) + "," + y.toFixed(1);
      }
    });
    var base = H - pad;
    var area = d + " L" + X(pts[pts.length - 1].m).toFixed(1) + "," + base + " L" + X(pts[0].m).toFixed(1) + "," + base + " Z";
    var y50 = Y(0.5);
    var uid = "mg" + (++sparkSeq);
    var last = pts[pts.length - 1];
    var cvar = color === "red" ? "var(--v2-red)" : "var(--v2-blue)";
    return '<svg class="mg-spark" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<defs><linearGradient id="' + uid + 'a" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" style="stop-color:' + cvar + ';stop-opacity:.20"/>' +
      '<stop offset="1" style="stop-color:' + cvar + ';stop-opacity:.02"/></linearGradient></defs>' +
      '<line x1="' + pad + '" y1="' + y50.toFixed(1) + '" x2="' + (W - pad) + '" y2="' + y50.toFixed(1) +
      '" style="stroke:var(--v2-line-2);stroke-width:1;stroke-dasharray:2 4;opacity:.7" vector-effect="non-scaling-stroke"></line>' +
      '<path d="' + area + '" fill="url(#' + uid + 'a)"></path>' +
      '<path d="' + d + '" fill="none" style="stroke:' + cvar + ';stroke-width:1.8" stroke-linecap="round" vector-effect="non-scaling-stroke"></path>' +
      '<circle cx="' + X(last.m).toFixed(1) + '" cy="' + Y(last.p).toFixed(1) + '" r="2.4" style="fill:var(--v2-card);stroke:' +
      cvar + ';stroke-width:1.6" vector-effect="non-scaling-stroke"></circle>' +
      "</svg>";
  }

  /* ---------------- 头版 ---------------- */
  function heroHTML(info) {
    var win = info.winner;
    var t1 = row.team1, t2 = row.team2;
    var score = seriesScore();
    var s1 = score.a == null ? "–" : score.a;
    var s2 = score.b == null ? "–" : score.b;
    var win1 = win === t1, win2 = win === t2;
    var c1 = colorOf(t1), c2 = colorOf(t2);
    var live = !!(row.st === 1 || (!row.done && row.st !== 2));
    var done = !!(row.done || row.st === 2);
    var t = totals(info);
    var pills = info.list.map(function (x) {
      var cls = x.win ? colorOf(x.win) : "";
      return '<a class="mt-pill ' + cls + '" href="game.html?id=' + encodeURIComponent(x.bid) + '" title="' +
        "第 " + (x.idx + 1) + " 局 · " + esc(x.win || "进行中") + " · " + x.dur + " 分钟" + '">' +
        "<i>G" + (x.idx + 1) + "</i><b>" + (x.win ? (x.win === t1 ? esc(t1) : esc(t2)) : "—") + "</b></a>";
    }).join("");

    return '<section class="mt-hero">' +
      '<div class="mt-hero-gridlines" aria-hidden="true"></div>' +
      '<div class="v2-wrap">' +
      '<nav class="v2-crumb">' +
      '<a href="schedule.html">赛程</a><span class="sep">/</span>' +
      "<b>比赛</b>" +
      (row.leagueName ? '<span class="sep">·</span><span>' + esc(row.leagueName) + "</span>" : "") +
      (row.stage ? '<span class="sep">·</span><span>' + esc(row.stage) + "</span>" : "") +
      (row.date ? '<span class="sep">·</span><span>' + esc(row.date) + " " + esc(row.time || "") + "</span>" : "") +
      '<span class="v2-chip ' + (done ? "" : "blue") + '" style="margin-left:auto">' +
      (live ? "进行中" : done ? "已结束" : "未开始") + "</span>" +
      "</nav>" +

      '<div class="mt-faceoff">' +
      '<div class="mt-side c-' + c1 + (win1 ? " win" : "") + '">' +
      '<a class="v2-logo mt-logo" href="team.html?id=' + encodeURIComponent(t1) + '">' + pic(row.icon1, t1, t1) + "</a>" +
      '<div class="mt-id"><a class="mt-name" href="team.html?id=' + encodeURIComponent(t1) + '">' + esc(t1) + "</a></div></div>" +

      '<div class="mt-core">' +
      '<span class="mt-scorelab">' + (row.bo ? "BO" + esc(row.bo) : "BO7") + " · 系列赛比分</span>" +
      '<div class="mt-scoreline"><b class="' + c1 + '">' + esc(String(s1)) + '</b><i>:</i><b class="' + c2 + '">' + esc(String(s2)) + "</b></div>" +
      '<span class="mt-outcome"><i class="dot"></i>' + (win ? "<b>" + esc(win) + "</b> 拿下系列赛" : live ? "比赛进行中" : "待开赛") + "</span>" +
      '<span class="mt-clock">总局数 <b>' + info.list.length + "</b> · 总时长 <b>" + t.dur + " 分钟</b></span>" +
      "</div>" +

      '<div class="mt-side away c-' + c2 + (win2 ? " win" : "") + '">' +
      '<div class="mt-id"><a class="mt-name" href="team.html?id=' + encodeURIComponent(t2) + '">' + esc(t2) + "</a></div>" +
      '<a class="v2-logo mt-logo" href="team.html?id=' + encodeURIComponent(t2) + '">' + pic(row.icon2, t2, t2) + "</a></div>" +
      "</div>" +

      '<div class="mt-pills">' + pills + "</div>" +

      '<div class="mt-hero-foot">' +
      '<div class="mt-facts">' +
      '<span class="mt-fact">总击杀 <b>' + fmt(t.kills) + "</b></span>" +
      '<span class="mt-fact">场均时长 <b>' + mmss(t.avgDur * 60) + "</b></span>" +
      '<span class="mt-fact">最长一局 <b>' + Math.max.apply(null, info.list.map(function (x) { return x.dur; })) + " 分钟</b></span>" +
      '<span class="mt-fact">有分钟级 <b>' + info.list.filter(function (x) { return x.frames.length; }).length + " / " + info.list.length + " 局</b></span>" +
      "</div>" +
      '<div class="v2-actions">' +
      '<a class="v2-btn" href="schedule.html">全部赛程 <span class="arr">→</span></a>' +
      '<a class="v2-btn" href="bp-studio.html?match=' + encodeURIComponent(MID) + '">BP 演播室 <span class="arr">→</span></a>' +
      '<a class="v2-btn" href="h2h.html?a=' + encodeURIComponent(t1) + "&amp;b=" + encodeURIComponent(t2) + '">交手记录 <span class="arr">→</span></a>' +
      (row.video ? '<a class="v2-btn solid" href="' + esc(row.video) + '" target="_blank" rel="noopener">整场回放 <span class="arr">↗</span></a>' : "") +
      "</div></div>" +
      "</div></section>";
  }

  /* ---------------- 对局列表 ---------------- */
  function gamesHTML(info) {
    if (!info.list.length) {
      return '<section class="v2-wrap v2-section"><div class="v2-card v2-empty"><span class="ic">◇</span><b>暂无逐局数据</b>这场比赛的逐局数据还在归档中。</div></section>';
    }
    var cards = info.list.map(function (x, i) {
      var tags = [];
      if (x.isClincher) tags.push('<span class="v2-tag gold">决胜局</span>');
      if (x.comeback) tags.push('<span class="v2-tag">翻盘局</span>');
      if (x.isLongest) tags.push('<span class="v2-tag">最长局</span>');
      if (x.isFastest) tags.push('<span class="v2-tag">最快局</span>');
      var side = x.win ? colorOf(x.win) : "";
      return '<a class="mg-card v2-card hoverable" href="game.html?id=' + encodeURIComponent(x.bid) + '">' +
        '<div class="mg-top">' +
        '<span class="mg-no">第 ' + (x.idx + 1) + ' 局<em>GAME ' + (x.idx + 1) + "</em></span>" +
        '<span class="mg-tags">' + tags.join("") + "</span>" +
        "</div>" +
        '<div class="mg-win ' + side + '"><i></i>' + esc(x.win || "进行中") + "<b>胜</b></div>" +
        '<div class="mg-score"><b class="' + colorOf(x.t1) + '">' + esc(String(x.k1 == null ? "–" : x.k1)) +
        '</b><i>:</i><b class="' + colorOf(x.t2) + '">' + esc(String(x.k2 == null ? "–" : x.k2)) +
        '</b><span>击杀</span><em>' + x.dur + " 分钟</em></div>" +
        (x.frames && x.frames.length >= 3
          ? '<div class="mg-spark-wrap">' + sparkSVG(x.frames, x.camp === 2, x.win ? colorOf(x.win) : "blue") + "</div>"
          : "") +
        '<div class="mg-foot">' +
        '<span class="mg-mvp">' + (x.mvp ? "MVP <b>" + esc(x.mvp) + "</b>" : "无 MVP 记录") + "</span>" +
        '<span class="mg-go">查看该局 <span class="arr">→</span></span>' +
        "</div></a>";
    }).join("");

    return '<section class="v2-wrap v2-section" id="mtGames">' +
      '<div class="v2-sec-head"><div class="l">' +
      '<span class="v2-eyebrow"><span class="idx">01</span> GAMES</span>' +
      '<h2 class="v2-h2">逐局战报</h2>' +
      '<p class="v2-note">' + info.list.length + " 局 · 点击任意一局进入完整复盘（曲线、事件与选手明细）</p>" +
      "</div></div>" +
      '<div class="mg-grid">' + cards + "</div></section>";
  }

  /* ---------------- BP 总览 ---------------- */
  function bpRows(info) {
    var rows = [];
    info.list.forEach(function (x, i) {
      var bp = x.g.bp || [];
      if (!bp.length) return;
      var picks = function (camp) {
        return bp.filter(function (b) { return b[0] === camp && b[1] === 1; }).map(function (b) {
          var nm = b[2];
          var ic = state.heroIcon[nm] || "";
          return '<span class="bp-pick" title="' + esc(nm) + '"><span class="ph">' +
            '<span class="fb">' + esc(String(nm).slice(0, 1)) + "</span>" +
            (ic ? '<img src="' + esc(ic) + '" alt="" onerror="this.remove()">' : "") +
            "</span><em>" + esc(nm) + "</em></span>";
        }).join("");
      };
      var bans = function (camp) {
        return bp.filter(function (b) { return b[0] === camp && b[1] === 0; }).map(function (b) {
          var nm = b[2];
          var ic = state.heroIcon[nm] || "";
          return '<span class="bp-ban" title="禁用 ' + esc(nm) + '">' +
            (ic ? '<img src="' + esc(ic) + '" alt="" onerror="this.remove()">' : "<i></i>") + "</span>";
        }).join("");
      };
      var winnerCamp = Number(x.win === x.t1 ? 1 : 2);
      var winnerColor = x.win ? colorOf(x.win) : "blue";
      rows.push('<div class="bp-row">' +
        '<div class="bp-g"><b>G' + (x.idx + 1) + '</b><span class="' + winnerColor + '">' +
        esc(x.win || "—") + "</span></div>" +
        '<div class="bp-side ' + (winnerCamp === 1 ? "is-win" : "") + '">' +
        '<div class="bp-team"><span class="v2-logo">' + pic(x.g.i1, x.t1, x.t1) + "</span><b>" + esc(x.t1) +
        '</b><em>蓝</em></div><div class="bp-picks">' + picks(1) + "</div>" +
        (bans(1) ? '<div class="bp-bans"><span>禁用</span>' + bans(1) + "</div>" : "") + "</div>" +
        '<div class="bp-side ' + (winnerCamp === 2 ? "is-win" : "") + '">' +
        '<div class="bp-team"><span class="v2-logo">' + pic(x.g.i2, x.t2, x.t2) + "</span><b>" + esc(x.t2) +
        '</b><em>红</em></div><div class="bp-picks">' + picks(2) + "</div>" +
        (bans(2) ? '<div class="bp-bans"><span>禁用</span>' + bans(2) + "</div>" : "") + "</div>" +
        "</div>");
    });
    if (!rows.length) return "";
    return '<section class="v2-wrap v2-section" id="mtBp">' +
      '<div class="v2-sec-head"><div class="l">' +
      '<span class="v2-eyebrow"><span class="idx">02</span> DRAFT</span>' +
      '<h2 class="v2-h2">系列赛 BP</h2>' +
      '<p class="v2-note">逐局双方选人与禁用 · 蓝 / 红方按当局阵营标注</p>' +
      "</div></div>" +
      '<div class="v2-card bp-card">' + rows.join("") + "</div></section>";
  }

  /* ---------------- 选手汇总 ---------------- */
  function playersHTML(info) {
    var map = {};
    info.list.forEach(function (x) {
      var t1 = x.t1, t2 = x.t2;
      (x.g.players || []).forEach(function (p) {
        var team = Number(p.c) === 1 ? t1 : t2;
        var key = (p.n || "") + "|" + team;
        var rec = map[key];
        if (!rec) {
          rec = map[key] = {
            name: p.n, team: team, icon: p.pi, camp: Number(p.c), hero: {},
            games: 0, k: 0, d: 0, a: 0, gold: 0, dmg: 0, bh: 0, mvp: 0
          };
        }
        rec.games++;
        rec.k += Number(p.k) || 0;
        rec.d += Number(p.d) || 0;
        rec.a += Number(p.a) || 0;
        rec.gold += Number(p.g) || 0;
        rec.dmg += Number(p.dmg) || 0;
        rec.bh += Number(p.bh) || 0;
        rec.mvp += p.mvp ? 1 : 0;
        rec.hero[p.h] = (rec.hero[p.h] || 0) + 1;
      });
    });
    var rows = Object.keys(map).map(function (k) { return map[k]; });
    var teamOrder = {};
    teamOrder[row.team1] = 0;
    teamOrder[row.team2] = 1;
    function kdaOf(x) { return (x.k + x.a) / Math.max(1, x.d); }
    rows.sort(function (a, b) {
      var ta = teamOrder[a.team] == null ? 2 : teamOrder[a.team];
      var tb = teamOrder[b.team] == null ? 2 : teamOrder[b.team];
      if (ta !== tb) return ta - tb;
      return kdaOf(b) - kdaOf(a);
    });
    function kda(r) { return ((r.k + r.a) / Math.max(1, r.d)).toFixed(2); }
    var html = rows.map(function (r) {
      return '<tr>' +
        '<td><span class="pl-cell"><span class="v2-ava">' + pic(r.icon, r.name, r.name) + "</span>" +
        "<span><b>" + esc(r.name) + "</b><em>" + esc(r.team) + "</em></span></span></td>" +
        '<td class="num">' + r.games + "</td>" +
        '<td class="num mono">' + r.k + " / " + r.d + " / " + r.a + "</td>" +
        '<td class="num"><b class="mono">' + kda(r) + "</b></td>" +
        '<td class="num mono">' + fmt(r.gold / Math.max(1, r.games)) + "</td>" +
        '<td class="num mono">' + (r.dmg / Math.max(1, r.games)).toFixed(1) + "%</td>" +
        '<td class="num mono">' + (r.bh / Math.max(1, r.games)).toFixed(1) + "%</td>" +
        '<td class="num">' + (r.mvp ? '<span class="pl-mvp">' + r.mvp + " 次</span>" : "—") + "</td>" +
        "</tr>";
    }).join("");
    if (!html) return "";
    return '<section class="v2-wrap v2-section" id="mtPlayers">' +
      '<div class="v2-sec-head"><div class="l">' +
      '<span class="v2-eyebrow"><span class="idx">03</span> PLAYERS</span>' +
      '<h2 class="v2-h2">选手数据</h2>' +
      '<p class="v2-note">整场汇总 · 输出 / 承伤为当局全队占比均值</p>' +
      "</div></div>" +
      '<div class="v2-card pl-card"><div class="pl-scroll"><table class="pl-table">' +
      "<thead><tr><th>选手</th><th class=\"num\">出场</th><th class=\"num\">K / D / A</th><th class=\"num\">KDA</th>" +
      '<th class="num">场均经济</th><th class="num">输出</th><th class="num">承伤</th><th class="num">MVP</th></tr></thead>' +
      "<tbody>" + html + "</tbody></table></div></div></section>";
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    computeColors();
    var info = gamesInfo();
    document.title = (row.team1 || "") + " vs " + (row.team2 || "") + " · 比赛详情 · KPL赛研";
    app.innerHTML = heroHTML(info) +
      '<div class="mt-body">' +
      gamesHTML(info) +
      bpRows(info) +
      playersHTML(info) +
      '<div class="v2-wrap mt-source">' +
      "<span>数据来源：官方逐局数据 · " + esc(MID) + " · " + esc(row.leagueName || "") +
      (row.stage ? " · " + esc(row.stage) : "") + "</span>" +
      '<span><a href="about.html">数据说明</a> · <a href="schedule.html">回到赛程</a></span></div>' +
      "</div>";
  }
})();
