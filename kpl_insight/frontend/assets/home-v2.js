/* ==========================================================================
   KPL 赛研 · 首页 V2
   赛事焦点 + 赛程速览 + 精选复盘 + 三榜 + 工具入口
   数据源：schedule_all.js / seasons.js / picks.js / site_totals.js / data.js
   ========================================================================== */
(function () {
  "use strict";

  var K = window.KPL;
  var app = document.getElementById("homeApp");
  if (!app) return;
  if (K && K.init) K.init();

  var esc = (K && K.esc) || function (v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };

  function fmt(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function pct(v, d) {
    var n = Number(v);
    if (!isFinite(n)) return "—";
    return (n * 100).toFixed(d == null ? 0 : d) + "%";
  }
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

  /* ---------------- 时间 ---------------- */
  var DAY = 86400000;
  function nowCN() { return new Date(Date.now() + 8 * 3600000); }
  function isoCN() { return nowCN().toISOString().slice(0, 10); }
  function parseCN(date, time) {
    var d = String(date || "");
    var t = String(time || "00:00");
    var ms = Date.parse(d + "T" + (t.length === 5 ? t : "00:00") + ":00+08:00");
    return isFinite(ms) ? ms : 0;
  }
  function mmdd(iso) { return String(iso || "").slice(5).replace("-", "/"); }
  function weekdayCN(iso) {
    var names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    var ms = Date.parse(iso + "T00:00:00+08:00");
    return isFinite(ms) ? names[new Date(ms).getUTCDay()] : "";
  }
  function countdown(ms) {
    var left = ms - Date.now();
    if (left <= 0) return "";
    var min = Math.round(left / 60000);
    if (min < 60) return min + " 分钟后开始";
    var h = Math.floor(min / 60);
    if (h < 24) return Math.floor(h) + " 小时 " + (min % 60) + " 分后开始";
    var d = Math.floor(h / 24);
    return d + " 天 " + (h % 24) + " 小时后开始";
  }

  /* ---------------- 数据 ---------------- */
  var ALL = (window.KPL_SCHEDULE_ALL || []).slice();
  var TOTALS = window.KPL_TOTALS || {};
  var PICKS = window.KPL_PICKS || { rows: [] };
  var SCOPE = (function () {
    try { return K.scopeOf("all") || {}; } catch (_) { return {}; }
  })();
  var TODAY = isoCN();

  function isDone(r) { return !!(r && (r.st === 2 || r.done === true || r.done === 1)); }
  function isLive(r) { return !!(r && (r.st === 1 || r.live === true)); }
  function byTimeAsc(a, b) { return (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")); }
  function byTimeDesc(a, b) { return -byTimeAsc(a, b); }
  function teamHref(name) { return "team.html?id=" + encodeURIComponent(name || ""); }

  var live = ALL.filter(isLive).sort(byTimeAsc)[0] || null;
  var todayAll = ALL.filter(function (r) { return r.date === TODAY; }).sort(byTimeAsc);
  var todayOpen = todayAll.filter(function (r) { return !isDone(r); });
  var upcoming = ALL.filter(function (r) { return !isDone(r) && !isLive(r); }).sort(byTimeAsc);
  var recent = ALL.filter(isDone).sort(byTimeDesc);
  var next = upcoming[0] || null;
  var lastName = recent[0] || null;

  /* ---------------- 焦点卡 ---------------- */
  function focusData() {
    if (live) return { mode: "live", row: live };
    if (todayOpen.length) return { mode: "today", row: todayOpen[0] };
    if (next) return { mode: "next", row: next };
    if (lastName) return { mode: "done", row: lastName };
    return null;
  }

  function focusHTML() {
    var f = focusData();
    if (!f) {
      return '<article class="focus-card v2-card"><div class="v2-empty"><span class="ic">◇</span><b>暂无赛程数据</b>2016–2026 赛程正在归档。</div></article>';
    }
    var r = f.row;
    var mode = f.mode;
    var label = { live: "进行中", today: "今日开赛", next: "下一场", done: "最近结束" }[mode];
    var tag = { live: "LIVE", today: "TODAY", next: "UP NEXT", done: "FINAL" }[mode];
    var started = isDone(r) || isLive(r);
    var score = started && r.score1 >= 0 && r.score2 >= 0 ? (r.score1 + " : " + r.score2) : "VS";
    var win1 = isDone(r) && Number(r.score1) > Number(r.score2);
    var win2 = isDone(r) && Number(r.score2) > Number(r.score1);
    var cta, href, note;
    if (mode === "live" || mode === "today") {
      href = "match.html?id=" + encodeURIComponent(r.matchId);
      cta = "进入比赛中心";
      note = mode === "live" ? "比分每 30 秒同步" : countdown(parseCN(r.date, r.time)) || "即将开始";
    } else if (mode === "next") {
      href = r.hasDetail ? "match.html?id=" + encodeURIComponent(r.matchId)
        : "h2h.html?a=" + encodeURIComponent(r.team1) + "&b=" + encodeURIComponent(r.team2);
      cta = r.hasDetail ? "查看赛前数据" : "看双方交手";
      note = countdown(parseCN(r.date, r.time));
    } else {
      href = "match.html?id=" + encodeURIComponent(r.matchId);
      cta = r.hasDetail ? "查看复盘" : "查看详情";
      note = "已结束 · " + mmdd(r.date);
    }
    return '<article class="focus-card' + (mode === "live" ? " is-live" : "") + (mode === "next" || mode === "today" ? " is-next" : "") + '">' +
      '<header class="fc-top">' +
      '<span class="fc-label"><i class="dot"></i>' + label + '<em>' + tag + "</em></span>" +
      '<span class="fc-when">' + (r.date === TODAY ? "今天 " : mmdd(r.date) + " ") + esc(r.time || "") + "</span>" +
      "</header>" +
      '<div class="fc-main">' +
      '<a class="fc-team home" href="' + teamHref(r.team1) + '">' +
      '<span class="v2-logo">' + pic(r.icon1, r.team1, r.team1) + "</span>" +
      '<b class="' + (win1 ? "win" : win2 ? "lose" : "") + '">' + esc(r.team1) + "</b></a>" +
      '<div class="fc-score"><b>' + esc(score) + '</b><span>' + (r.bo ? "BO" + esc(r.bo) : "") +
      (isDone(r) || isLive(r) ? "" : " · 待开赛") + "</span></div>" +
      '<a class="fc-team away" href="' + teamHref(r.team2) + '">' +
      '<b class="' + (win2 ? "win" : win1 ? "lose" : "") + '">' + esc(r.team2) + "</b>" +
      '<span class="v2-logo">' + pic(r.icon2, r.team2, r.team2) + "</span></a>" +
      "</div>" +
      '<div class="fc-meta">' + esc(r.leagueName || "") + (r.stage ? " · " + esc(r.stage) : "") +
      (r.bo ? " · BO" + esc(r.bo) : "") + "</div>" +
      '<footer class="fc-foot">' +
      '<a class="v2-btn solid sm" href="' + href + '">' + cta + ' <span class="arr">→</span></a>' +
      '<span class="fc-note">' + esc(note) + "</span>" +
      "</footer></article>";
  }

  /* ---------------- 赛程行 ---------------- */
  function matchRowHTML(r, opts) {
    opts = opts || {};
    var done = isDone(r);
    var s1 = done && r.score1 >= 0 ? r.score1 : "–";
    var s2 = done && r.score2 >= 0 ? r.score2 : "–";
    var win1 = done && Number(r.score1) > Number(r.score2);
    var win2 = done && Number(r.score2) > Number(r.score1);
    var href = done ? "match.html?id=" + encodeURIComponent(r.matchId)
      : (r.hasDetail ? "match.html?id=" + encodeURIComponent(r.matchId)
        : "h2h.html?a=" + encodeURIComponent(r.team1) + "&b=" + encodeURIComponent(r.team2));
    return '<a class="v2-row hm-row" href="' + href + '">' +
      '<span class="v2-row-time">' + (opts.showDate ? mmdd(r.date) + " " : "") + esc(r.time || "--:--") + "</span>" +
      '<span class="v2-row-team ' + (win1 ? "win" : win2 ? "lose" : "") + '"><span class="v2-logo">' +
      pic(r.icon1, r.team1, r.team1) + "</span><b>" + esc(r.team1) + "</b></span>" +
      '<span class="v2-row-score">' + (done || isLive(r) ? s1 + '<em>:</em>' + s2 : '<em>VS</em>') + "</span>" +
      '<span class="v2-row-team away ' + (win2 ? "win" : win1 ? "lose" : "") + '"><b>' + esc(r.team2) + '</b><span class="v2-logo">' +
      pic(r.icon2, r.team2, r.team2) + "</span></span>" +
      '<span class="v2-row-meta">' + (isLive(r) ? "进行中" : done ? "已结束" : "未开始") + "</span>" +
      '<span class="v2-row-arr">→</span></a>';
  }

  function scheduleRows() {
    var rows = todayOpen.slice();
    upcoming.forEach(function (r) {
      if (rows.length < 6 && rows.indexOf(r) < 0) rows.push(r);
    });
    return rows.slice(0, 6);
  }

  /* ---------------- 精选复盘 ---------------- */
  function pickCardHTML(row) {
    var tags = (row.tags || []).slice(0, 2).map(function (t) {
      return '<span class="v2-tag' + (t.k === "comeback" ? " est" : "") + '">' + esc(t.label || "") + "</span>";
    }).join("");
    var swing = Math.round(Number(row.swing || 0) * 100);
    return '<a class="pick-card v2-card hoverable" href="game.html?id=' + encodeURIComponent(row.battleId) + '">' +
      '<div class="pc-top"><span class="v2-chip gold">' + esc((row.tags && row.tags[0] && row.tags[0].label) || "名局") + "</span>" +
      '<span class="pc-date">' + mmdd(row.date) + " · 第 " + esc(row.seq || 1) + " 局</span></div>" +
      '<div class="pc-match">' +
      '<span class="pc-team"><span class="v2-logo">' + pic(logos[row.t1], row.t1, row.t1) + "</span>" + esc(row.t1) + "</span>" +
      '<span class="pc-vs">VS</span>' +
      '<span class="pc-team away">' + esc(row.t2) + '<span class="v2-logo">' + pic(logos[row.t2], row.t2, row.t2) + "</span></span>" +
      "</div>" +
      '<div class="pc-meta">用时 ' + esc(String(row.dur || "—")) + " 分钟 · 胜方 " + esc(row.winner || "") + "</div>" +
      '<div class="pc-tags">' + tags + '<span class="pc-swing">胜率摆动 <b>' + swing + '</b> 个百分点</span></div>' +
      '<div class="pc-foot"><span>进入复盘时间轴</span><span class="arr">→</span></div>' +
      "</a>";
  }

  function picksHTML() {
    var rows = (PICKS.rows || []).slice();
    if (!rows.length) return '<div class="v2-empty"><span class="ic">◇</span><b>暂无精选对局</b>赛后将从有直播快照的比赛中筛选。</div>';
    rows.sort(function (a, b) { return Number(b.swing || 0) - Number(a.swing || 0); });
    var byTag = {};
    var used = {};
    rows.forEach(function (r) {
      (r.tags || []).forEach(function (t) {
        if (byTag[t.k]) return;
        if (used[r.t1 + "|" + r.t2]) return;
        byTag[t.k] = r;
        used[r.t1 + "|" + r.t2] = 1;
      });
    });
    var picked = [];
    ["long", "swing", "events"].forEach(function (k) {
      if (byTag[k]) picked.push(byTag[k]);
    });
    var usedTeams = {};
    picked.forEach(function (r) { usedTeams[r.t1 + "|" + r.t2] = 1; });
    rows.forEach(function (r) {
      if (picked.length >= 4) return;
      if (usedTeams[r.t1 + "|" + r.t2]) return;
      usedTeams[r.t1 + "|" + r.t2] = 1;
      picked.push(r);
    });
    return '<div class="picks-grid">' + picked.slice(0, 4).map(pickCardHTML).join("") + "</div>";
  }

  /* ---------------- 榜单 ---------------- */
  var logos = {};
  ALL.forEach(function (r) {
    if (r.team1 && r.icon1) logos[r.team1] = logos[r.team1] || r.icon1;
    if (r.team2 && r.icon2) logos[r.team2] = logos[r.team2] || r.icon2;
  });

  function teamBoard() {
    var teams = (SCOPE.teams || []).filter(function (t) { return (t.games || 0) >= 80; }).slice();
    teams.sort(function (a, b) { return (b.wr || 0) - (a.wr || 0); });
    return teams.slice(0, 8).map(function (t, i) {
      var wr = clamp(Number(t.wr) || 0, 0, 1);
      return '<a class="board-row" href="' + teamHref(t.team) + '">' +
        '<span class="rk' + (i < 3 ? " top" : "") + '">' + (i + 1) + "</span>" +
        '<span class="v2-logo">' + pic(t.icon || logos[t.team], t.team, t.team) + "</span>" +
        '<span class="nm"><b>' + esc(t.team) + '</b><em>' + esc(t.matches || 0) + " 大场 · " + fmt(t.games) + " 局</em></span>" +
        '<span class="val"><b class="v2-mono">' + pct(wr, 1) + '</b><span class="bar"><i style="width:' + (wr * 100).toFixed(1) + '%"></i></span></span>' +
        "</a>";
    }).join("");
  }

  function heroBoard() {
    var heroes = (SCOPE.heroes || []).filter(function (h) { return (h.games || 0) >= 30; }).slice();
    heroes.sort(function (a, b) { return (b.games || 0) - (a.games || 0); });
    return heroes.slice(0, 8).map(function (h, i) {
      return '<a class="board-row" href="hero.html?id=' + encodeURIComponent(h.name) + '">' +
        '<span class="rk' + (i < 3 ? " top" : "") + '">' + (i + 1) + "</span>" +
        '<span class="v2-logo round">' + pic(h.icon, h.name, h.name) + "</span>" +
        '<span class="nm"><b>' + esc(h.name) + '</b><em>' + esc(h.tier || "") + " 档 · 出场 " + fmt(h.games) + "</em></span>" +
        '<span class="val"><b class="v2-mono">' + pct(h.wr, 1) + '</b><span class="bar"><i style="width:' +
        (clamp(Number(h.wr) || 0, 0, 1) * 100).toFixed(1) + '%"></i></span></span>' +
        "</a>";
    }).join("");
  }

  function playerBoard() {
    var players = (SCOPE.players || []).filter(function (p) { return (p.games || 0) >= 80; }).slice();
    players.sort(function (a, b) { return (b.kda || 0) - (a.kda || 0); });
    return players.slice(0, 8).map(function (p, i) {
      var kda = Number(p.kda) || 0;
      return '<a class="board-row" href="player.html?id=' + encodeURIComponent(p.name) + '">' +
        '<span class="rk' + (i < 3 ? " top" : "") + '">' + (i + 1) + "</span>" +
        '<span class="v2-ava big">' + pic(p.icon, p.name, p.name) + "</span>" +
        '<span class="nm"><b>' + esc(p.name) + '</b><em>' + esc(p.team || "") + " · " + esc(p.pos || "") + "</em></span>" +
        '<span class="val"><b class="v2-mono">' + kda.toFixed(2) + '</b><span class="bar"><i style="width:' +
        clamp((kda / 6) * 100, 8, 100).toFixed(1) + '%"></i></span></span>' +
        "</a>";
    }).join("");
  }

  /* ---------------- 工具 ---------------- */
  var TOOLS = [
    { href: "predict.html", k: "预测", t: "实时胜率预测", d: "模型逐分钟估算一场比赛的走势", ic: "◈" },
    { href: "simulator.html", k: "模拟", t: "大场模拟器", d: "BO3 / BO5 / BO7 系列赛胜率分布", ic: "▲" },
    { href: "picks.html", k: "名局", t: "精选对局", d: "翻盘、拉锯与资源战的关键分钟", ic: "◆" },
    { href: "combos.html", k: "组合", t: "英雄组合", d: "双人 / 三人协同加成与胜率", ic: "●" },
    { href: "h2h.html", k: "对位", t: "交手记录", d: "两支战队的全部历史交锋", ic: "■" },
    { href: "bracket.html", k: "赛程", t: "赛事进程", d: "赛段、对阵与冠军预测", ic: "◇" }
  ];

  function toolsHTML() {
    return TOOLS.map(function (t) {
      return '<a class="tool-card" href="' + t.href + '">' +
        '<span class="tc-top"><i>' + t.ic + "</i><em>" + esc(t.k) + "</em></span>" +
        "<b>" + esc(t.t) + "</b><p>" + esc(t.d) + '</p><span class="tc-arr">→</span></a>';
    }).join("");
  }

  /* ---------------- 页面 ---------------- */
  function render() {
    var totals = TOTALS;
    var gen = (window.KPL && K.data && K.data.generatedAt) ? K.data.generatedAt : "";
    var scheduleEl = scheduleRows();
    var recentEl = recent.slice(0, 6);

    app.innerHTML =
      '<section class="v2-hero home-top">' +
      '<div class="home-grid" aria-hidden="true"></div>' +
      '<div class="v2-wrap home-top-grid">' +
      '<div class="home-copy">' +
      '<div class="v2-kicker"><i></i>KPL 赛研<b>·</b>KPL RESEARCH</div>' +
      '<h1 class="v2-h1">看比赛，<br>也<span>看懂</span>比赛。</h1>' +
      '<p class="v2-lead">2016–2026 全量赛事数据：赛程、比分、BP、选手与逐分钟胜率。把一场比赛拆成可读的曲线与节点，看懂胜负是怎么发生的。</p>' +
      '<div class="v2-actions">' +
      '<a class="v2-btn solid" href="schedule.html">浏览赛程 <span class="arr">→</span></a>' +
      '<a class="v2-btn" href="predict.html">实时胜率预测</a>' +
      '<a class="home-tlink" href="about.html">数据说明</a>' +
      "</div>" +
      '<div class="home-copy-meta">' +
      (gen ? "数据更新于 " + esc(gen) : "") + '<span>·</span>官方接口<span>·</span>本地生成' +
      "</div></div>" +
      '<div class="home-focus" id="homeFocus">' + focusHTML() + "</div>" +
      "</div>" +
      '<div class="v2-wrap home-stats-wrap"><div class="v2-stats">' +
      '<div class="v2-stat"><b class="v2-mono">' + fmt(totals.matches) + '</b><span>大场赛事</span></div>' +
      '<div class="v2-stat"><b class="v2-mono">' + fmt(totals.battles) + '</b><span>归档小局</span></div>' +
      '<div class="v2-stat"><b class="v2-mono">' + fmt(totals.replayBattles || 0) + '</b><span>局有分钟级胜率</span></div>' +
      '<div class="v2-stat"><b class="v2-mono">' + fmt(totals.leagues || 0) + '</b><span>项赛事 · 2016—2026</span></div>' +
      "</div></div>" +
      "</section>" +

      '<section class="v2-wrap v2-section home-schedule">' +
      '<div class="v2-sec-head"><div class="l">' +
      '<span class="v2-eyebrow"><span class="idx">01</span> SCHEDULE</span>' +
      '<h2 class="v2-h2">接下来的比赛</h2>' +
      '<p class="v2-note">今天、即将开始与最近结束 · 点进任意一场看比分、BP 与复盘</p>' +
      "</div>" +
      '<a class="v2-more" href="schedule.html">全部赛程 <span class="arr">→</span></a></div>' +
      '<div class="home-schedule-grid">' +
      '<div class="v2-card home-list"><div class="hl-hd"><span>最新赛果</span><em>recent</em></div>' +
      '<div class="v2-rows">' + recentEl.map(function (r) { return matchRowHTML(r, { showDate: true }); }).join("") + "</div></div>" +
      '<div class="v2-card home-list"><div class="hl-hd"><span>即将开始</span><em>' + (upcoming.length ? upcoming.length + " 场待赛" : "off season") + "</em></div>" +
      '<div class="v2-rows">' + (scheduleEl.length ? scheduleEl.map(function (r) { return matchRowHTML(r, { showDate: r.date !== TODAY }); }).join("") :
        '<div class="v2-empty" style="padding:26px 10px"><b>暂无已排期比赛</b>下赛季赛程发布后自动更新</div>') +
      "</div>" + (next ? '<a class="hl-more" href="schedule.html">查看全部赛程<span>→</span></a>' : "") +
      "</div></div></section>" +

      '<section class="v2-wrap v2-section home-picks">' +
      '<div class="v2-sec-head"><div class="l">' +
      '<span class="v2-eyebrow"><span class="idx">02</span> REPLAY</span>' +
      '<h2 class="v2-h2">精选复盘</h2>' +
      '<p class="v2-note">翻盘、拉锯与资源战 · 从胜率曲线最陡的那几分钟开始看</p>' +
      "</div>" +
      '<a class="v2-more" href="picks.html">全部精选 <span class="arr">→</span></a></div>' +
      picksHTML() + "</section>" +

      '<section class="v2-wrap v2-section home-boards">' +
      '<div class="v2-sec-head"><div class="l">' +
      '<span class="v2-eyebrow"><span class="idx">03</span> LEADERBOARD</span>' +
      '<h2 class="v2-h2">全历史榜单</h2>' +
      '<p class="v2-note">2019–2026 · 全部赛事与年份的合并口径</p>' +
      "</div></div>" +
      '<div class="board-grid">' +
      '<div class="v2-card board"><div class="board-hd"><b>战队胜率</b><a href="teams.html">全部战队 →</a></div><div class="board-body">' + teamBoard() + "</div></div>" +
      '<div class="v2-card board"><div class="board-hd"><b>英雄出场</b><a href="heroes.html">英雄图鉴 →</a></div><div class="board-body">' + heroBoard() + "</div></div>" +
      '<div class="v2-card board"><div class="board-hd"><b>选手 KDA</b><a href="players.html">全部选手 →</a></div><div class="board-body">' + playerBoard() + "</div></div>" +
      "</div></section>" +

      '<section class="v2-wrap v2-section home-tools">' +
      '<div class="v2-sec-head"><div class="l">' +
      '<span class="v2-eyebrow"><span class="idx">04</span> TOOLKIT</span>' +
      '<h2 class="v2-h2">数据工具</h2>' +
      '<p class="v2-note">六种读法：从赛前判断到赛后复盘</p>' +
      "</div>" +
      '<a class="v2-more" href="updates.html">更新日志 <span class="arr">→</span></a></div>' +
      '<div class="tools-grid">' + toolsHTML() + "</div></section>" +

      '<div class="v2-wrap home-source">' +
      "<span>数据来自官方赛事接口，本地生成；胜率为历史区间模型估算，赛程与比分以官方发布为准。</span>" +
      '<a href="about.html">了解数据口径 →</a></div>';
  }

  render();
  reveal();
  window.addEventListener("resize", debounce(reveal, 200));

  function reveal() {
    var items = document.querySelectorAll(".v2-r");
    if (!("IntersectionObserver" in window) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      items.forEach(function (x) { x.classList.add("in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.02 });
    items.forEach(function (x) { if (!x.classList.contains("in")) io.observe(x); });
  }
})();
