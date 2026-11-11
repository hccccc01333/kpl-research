/* 赛程中心 · 页面逻辑（2026-11-03）
   仅服务 schedule.html；数据全部来自既有 KPL_SCHEDULE_ALL / KPL_SEASONS。 */
(function () {
  "use strict";

  var K = window.KPL;
  if (!K) return;
  K.init();

  var $ = function (s, root) { return (root || document).querySelector(s); };
  var $$ = function (s, root) { return Array.prototype.slice.call((root || document).querySelectorAll(s)); };
  var ALL = window.KPL_SCHEDULE_ALL || [];
  var S = window.KPL_SEASONS || { leagues: [], years: [] };
  var PAGE = 40;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var shown = PAGE;
  var curYear = "all";
  var curLeagueId = "";
  var curScope = "all";
  var stageFilter = "";
  var statusFilter = "";
  var query = "";
  var liveData = null;
  var cdTimer = null;
  var searchTimer = null;
  var currentStageInfo = null;

  var yearCounts = {};
  var leagueById = {};

  ALL.forEach(function (r) {
    var y = String(r.year || "");
    if (y) yearCounts[y] = (yearCounts[y] || 0) + 1;
  });
  (S.leagues || []).forEach(function (l) { leagueById[String(l.id)] = l; });

  function esc(v) { return K.esc(v); }
  function todayCN() { return K.todayCN(); }
  function matchMs(r) {
    var t = Date.parse(r.date + "T" + (r.time || "17:00") + ":00");
    return isNaN(t) ? Date.parse(r.date + "T12:00:00") : t;
  }
  function leagueOf(id) { return leagueById[String(id)] || null; }
  function isLiveRow(r) { return !r.done && (r.st === 1 || K.isLive(r)); }
  function stateOf(r) { return r.done ? "已结束" : (isLiveRow(r) ? "进行中" : "未开始"); }
  function inScope(r) {
    if (curLeagueId) return String(r.leagueId) === curLeagueId;
    if (curYear !== "all") return String(r.year) === curYear;
    return true;
  }
  function scopeRows() { return ALL.filter(inScope); }

  /* ---------- 数字入场 ---------- */
  function countTo(el, target) {
    if (!el) return;
    if (reduce) { el.textContent = K.fmtInt(target); return; }
    var t0 = null;
    var dur = 820;
    function frame(ts) {
      if (!t0) t0 = ts || performance.now();
      var k = Math.min(1, ((ts || performance.now()) - t0) / dur);
      var eased = 1 - Math.pow(1 - k, 3);
      el.textContent = K.fmtInt(Math.round(target * eased));
      if (k < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function renderStats() {
    var doneN = ALL.filter(function (r) { return r.done; }).length;
    var detailN = ALL.filter(function (r) { return r.hasDetail; }).length;
    var vidN = ALL.filter(function (r) { return r.video; }).length;
    countTo($("#mTotal"), ALL.length);
    countTo($("#mDone"), doneN);
    countTo($("#mDetail"), detailN);
    countTo($("#mVid"), vidN);
  }

  /* ---------- 范围状态 ---------- */
  function readSavedScope() {
    var saved = "all";
    try { saved = localStorage.getItem("kpl_scope_v1") || "all"; } catch (e) {}
    if (saved === "all") return;
    if (/^\d{4}$/.test(saved)) { curYear = saved; curScope = saved; return; }
    var lg = leagueOf(saved);
    if (lg) { curYear = String(lg.year); curLeagueId = String(lg.id); curScope = String(lg.id); }
  }

  function setScope(id, opts) {
    opts = opts || {};
    if (id === "all") {
      curYear = "all"; curLeagueId = ""; curScope = "all";
    } else if (/^\d{4}$/.test(String(id))) {
      curYear = String(id); curLeagueId = ""; curScope = String(id);
    } else {
      var lg = leagueOf(id);
      if (!lg) return;
      curYear = String(lg.year); curLeagueId = String(lg.id); curScope = String(lg.id);
    }
    try { localStorage.setItem("kpl_scope_v1", curScope); } catch (e) {}
    shown = PAGE;
    buildYearRail();
    buildLeagueSelect();
    fillStages();
    renderList();
    renderStages();
    renderRecent();
    updateStageMini();
    syncControls();
    if (opts.scroll) scrollToResults();
  }

  /* ---------- 年份轨 ---------- */
  function buildYearRail() {
    var rail = $("#yearRail");
    if (!rail) return;
    var years = (S.years || []).slice().sort(function (a, b) { return Number(b) - Number(a); });
    var html = '<button type="button" class="sch-year' + (curScope === "all" ? " on" : "") +
      '" data-year="all" aria-pressed="' + (curScope === "all" ? "true" : "false") + '">全部<em>' + K.fmtInt(ALL.length) + "</em></button>";
    html += years.map(function (y) {
      return '<button type="button" class="sch-year' + (curYear === String(y) ? " on" : "") +
        '" data-year="' + y + '" aria-pressed="' + (curYear === String(y) ? "true" : "false") + '">' + y +
        "<em>" + K.fmtInt(yearCounts[y] || 0) + "</em></button>";
    }).join("");
    rail.innerHTML = html;
    var active = rail.querySelector(".sch-year.on");
    if (active) {
      var left = active.offsetLeft - rail.clientWidth / 2 + active.offsetWidth / 2;
      rail.scrollLeft = Math.max(0, left);
    }
    updateRailButtons();
  }

  function updateRailButtons() {
    var rail = $("#yearRail");
    var prev = $("#railPrev");
    var next = $("#railNext");
    if (!rail || !prev || !next) return;
    var over = rail.scrollWidth > rail.clientWidth + 4;
    var atEnd = rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 2;
    prev.style.display = over ? "" : "none";
    next.style.display = over ? "" : "none";
    prev.disabled = !over || rail.scrollLeft <= 2;
    next.disabled = !over || atEnd;
    rail.classList.toggle("is-scrollable", over);
    rail.classList.toggle("at-end", over && atEnd);
    rail.classList.toggle("at-start", !over || rail.scrollLeft <= 2);
  }

  function scrollRail(dir) {
    var rail = $("#yearRail");
    if (!rail) return;
    rail.scrollBy({ left: dir * 300, behavior: reduce ? "auto" : "smooth" });
  }

  /* ---------- 赛事下拉 ---------- */
  function buildLeagueSelect() {
    var sel = $("#fLeague");
    if (!sel) return;
    var lgs = (S.leagues || []).slice().sort(function (a, b) {
      return String(b.start || "").localeCompare(String(a.start || ""));
    });
    var html = "";
    if (curYear === "all") {
      html += '<option value="">全部赛事</option>';
      var groups = {};
      lgs.forEach(function (l) {
        var y = String(l.year);
        (groups[y] = groups[y] || []).push(l);
      });
      Object.keys(groups).sort(function (a, b) { return Number(b) - Number(a); }).forEach(function (y) {
        html += '<optgroup label="' + y + ' 年">';
        groups[y].forEach(function (l) {
          html += '<option value="' + esc(l.id) + '">' + esc(l.name) + "（" + K.fmtInt(l.matches) + " 场）</option>";
        });
        html += "</optgroup>";
      });
    } else {
      html += '<option value="">' + curYear + " 年 · 全部赛事</option>";
      lgs.filter(function (l) { return String(l.year) === curYear; }).forEach(function (l) {
        html += '<option value="' + esc(l.id) + '">' + esc(l.name) + "（" + K.fmtInt(l.matches) + " 场）</option>";
      });
    }
    sel.innerHTML = html;
    sel.value = curLeagueId;
    sel.onchange = function () {
      if (sel.value) setScope(sel.value, { scroll: true });
      else setScope(curYear === "all" ? "all" : curYear, { scroll: true });
    };
  }

  /* ---------- 赛段下拉 ---------- */
  function fillStages() {
    var sel = $("#fStage");
    if (!sel) return;
    var map = {};
    scopeRows().forEach(function (r) {
      if (!r.stage) return;
      if (!map[r.stage]) map[r.stage] = r.date;
      else if (r.date < map[r.stage]) map[r.stage] = r.date;
    });
    var keys = Object.keys(map).sort(function (a, b) { return String(map[a]).localeCompare(String(map[b])); });
    if (stageFilter && keys.indexOf(stageFilter) < 0) stageFilter = "";
    sel.innerHTML = '<option value="">全部赛段</option>' + keys.map(function (s) {
      return '<option value="' + esc(s) + '">' + esc(K.stageLabel(s)) + "</option>";
    }).join("");
    sel.value = stageFilter;
  }

  /* ---------- 筛选与排序 ---------- */
  function defaultSort(rows) {
    var today = todayCN();
    var groups = {};
    rows.forEach(function (r) { (groups[r.date] = groups[r.date] || []).push(r); });
    var dates = Object.keys(groups).sort(function (a, b) {
      var ra = a === today ? 0 : (a > today ? 1 : 2);
      var rb = b === today ? 0 : (b > today ? 1 : 2);
      if (ra !== rb) return ra - rb;
      return ra === 2 ? b.localeCompare(a) : a.localeCompare(b);
    });
    var out = [];
    dates.forEach(function (d) {
      groups[d].sort(function (a, b) {
        var al = isLiveRow(a) ? 0 : (a.done ? 2 : 1);
        var bl = isLiveRow(b) ? 0 : (b.done ? 2 : 1);
        if (al !== bl) return al - bl;
        if (a.done) return String(b.time).localeCompare(String(a.time));
        return String(a.time).localeCompare(String(b.time));
      });
      out = out.concat(groups[d]);
    });
    return out;
  }

  function filteredRows() {
    var rows = ALL.filter(function (r) {
      if (!inScope(r)) return false;
      if (stageFilter && String(r.stage) !== stageFilter) return false;
      if (statusFilter && stateOf(r) !== statusFilter) return false;
      if (query) {
        var q = query.toLowerCase();
        if (String(r.team1).toLowerCase().indexOf(q) < 0 && String(r.team2).toLowerCase().indexOf(q) < 0) return false;
      }
      return true;
    });
    if (statusFilter === "已结束") {
      return rows.sort(function (a, b) { return (b.date + b.time).localeCompare(a.date + a.time); });
    }
    if (statusFilter === "未开始") {
      return rows.sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
    }
    return defaultSort(rows);
  }

  /* ---------- 渲染小件 ---------- */
  function initialOf(name) {
    var s = String(name || "?").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
    return (s.slice(0, 1) || "?").toUpperCase();
  }
  function logoHTML(name, icon, big) {
    var initial = esc(initialOf(name));
    return '<span class="sch-logo' + (icon ? "" : " is-fallback") + '" data-initial="' + initial + '">' +
      (icon ? '<img src="' + esc(icon) + '" alt=""' + (big ? "" : ' loading="lazy"') +
        " onerror=\"this.parentNode.classList.add('is-fallback');this.remove()\">" : "") +
      "</span>";
  }
  function teamHTML(name, icon, side, win) {
    var logo = logoHTML(name, icon);
    var label = "<b>" + esc(name) + "</b>";
    return '<span class="sch-team ' + side + (win ? " win" : "") + '">' +
      (side === "home" ? logo + label : label + logo) + "</span>";
  }
  function coverageHTML(r) {
    var mask = K.coverageMask(r.matchId) || 0;
    var items = [
      ["比分", 1, "官方比分与用时"],
      ["BP", 2, "完整 BP"],
      ["选手", 4, "逐局选手数据"],
      ["分钟级", 24, "逐分钟数据与模型胜率（估算）"]
    ];
    var on = 0;
    var titles = [];
    var dots = items.map(function (it) {
      var has = !!(mask & it[1]);
      if (has) { on++; titles.push(it[0]); }
      return '<i class="' + (has ? "on" : "off") + '" title="' + esc(it[0] + "：" + (has ? it[2] : "本场无此数据")) + '"></i>';
    }).join("");
    return '<span class="sch-cov" title="' + esc(titles.length ? "有：" + titles.join(" / ") : "暂无数据徽标") + '">' +
      dots + '</span><span class="sch-cov-n">' + on + "/4</span>";
  }

  /* ---------- 焦点卡 ---------- */
  function renderFeature() {
    var el = $("#evPoster");
    if (!el) return;
    if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
    var live = ALL.filter(function (r) { return isLiveRow(r); }).sort(function (a, b) { return matchMs(a) - matchMs(b); })[0];
    var next = ALL.filter(function (r) { return !r.done && !isLiveRow(r); }).sort(function (a, b) { return matchMs(a) - matchMs(b); })[0];
    var last = ALL.filter(function (r) { return r.done; }).sort(function (a, b) { return matchMs(b) - matchMs(a); })[0];
    var r = live || next || last;
    if (!r) {
      el.className = "sch-feature is-empty";
      el.innerHTML = "暂无赛程数据";
      return;
    }
    var mode = live ? "live" : (next ? "next" : "last");
    el.className = "sch-feature is-" + mode;
    el.setAttribute("data-mid", r.matchId);
    var today = todayCN();
    var todayN = ALL.filter(function (x) { return x.date === today; }).length;
    var scoreSub = r.bo ? "BO" + r.bo : "";
    var label = mode === "live" ? '<i class="sch-live-dot"></i>正在进行'
      : mode === "next" ? '<i class="sch-live-dot"></i>下一场'
        : '<i class="sch-live-dot"></i>最近结束';
    var score;
    if (mode === "next") {
      score = '<span class="vs">VS</span>' + (scoreSub ? "<span>" + esc(scoreSub) + "</span>" : "");
    } else {
      score = "<b>" + Number(r.score1 || 0) + "</b><i>:</i><b>" + Number(r.score2 || 0) + "</b>" +
        (scoreSub ? "<span>" + esc(scoreSub) + "</span>" : "");
    }
    var known = r.team1 && r.team2 && r.team1 !== "待定" && r.team2 !== "待定";
    var cta = mode === "live" ? "进入实时页" : (mode === "next" ? (r.hasDetail ? "查看赛前数据" : (known ? "看双方交手" : "查看赛事进程")) : "查看复盘");
    var ctaHref = "match.html?id=" + encodeURIComponent(r.matchId);
    if (mode === "next" && !r.hasDetail) {
      ctaHref = known
        ? "h2h.html?a=" + encodeURIComponent(r.team1) + "&b=" + encodeURIComponent(r.team2)
        : "bracket.html?id=" + encodeURIComponent(r.leagueId || "");
    }
    var note = mode === "live" ? "比分每 30 秒同步" : (mode === "next" ? (r.hasDetail ? "赛前可看交手、BP 与逐局数据" : (known ? "看双方历史交手记录" : "阵容待定，可查看赛事进程")) : "完整逐局数据与时间轴");
    var kick = mode === "live" ? "LIVE" : (mode === "next" ? "UP NEXT" : "FINAL");
    el.innerHTML =
      '<div class="sch-feature-top"><span class="sch-feature-label">' + label +
      '<em class="sch-feature-kick">' + kick + "</em></span>" +
      '<span class="sch-feature-sync mono">同步 <b id="liveAt">—</b></span></div>' +
      '<div class="sch-feature-main">' +
      '<a class="sch-fteam home" href="team.html?id=' + encodeURIComponent(r.team1) + '">' +
      logoHTML(r.team1, r.icon1, true) + "<b>" + esc(r.team1) + "</b></a>" +
      '<div class="sch-fscore">' + score + "</div>" +
      '<a class="sch-fteam away" href="team.html?id=' + encodeURIComponent(r.team2) + '">' +
      "<b>" + esc(r.team2) + "</b>" + logoHTML(r.team2, r.icon2, true) + "</a></div>" +
      '<div class="sch-feature-meta">' +
      (todayN ? "<em>今日 " + todayN + " 场</em>" : "<em>今日无赛程</em>") +
      "<span>" + esc(r.leagueName || "") + "</span>" +
      (r.stage ? "<span>" + esc(K.stageLabel(r.stage)) + "</span>" : "") + "</div>" +
      '<div class="sch-feature-foot">' +
      '<a class="btn primary" href="' + ctaHref + '">' + cta + "</a>" +
      '<span class="sch-feature-note">' + note + "</span>" +
      (mode === "next" ? '<span class="sch-feature-cd" id="epCd"></span>' : "") +
      "</div>";
    var cd = $("#epCd");
    if (cd) {
      var target = new Date(r.date + "T" + (r.time || "17:00") + ":00").getTime();
      cdTimer = K.countdown(target, cd);
    }
  }

  /* ---------- 主列表 ---------- */
  function dayHead(r, count) {
    var bits = [r.leagueName];
    if (r.stage) bits.push(K.stageLabel(r.stage));
    if (r.bo) bits.push("BO" + r.bo);
    var todayTag = r.date === todayCN() ? '<i class="sch-today-tag">今天</i>' : "";
    return '<div class="sch-dayhead"><b>' + esc(K.dateCN(r.date)) + "</b>" + todayTag + "<span>" + esc(K.weekdayCN(r.date)) +
      "</span><em>" + esc(bits.filter(Boolean).join(" · ")) + " · " + count + " 场</em></div>";
  }

  function rowHTML(r, index) {
    var live = isLiveRow(r);
    var done = !!r.done;
    var state = live ? "live" : (done ? "done" : "next");
    var s1 = Number(r.score1 || 0);
    var s2 = Number(r.score2 || 0);
    var score;
    if (done || live) {
      score = '<b class="' + (s1 > s2 ? "win" : "") + '">' + s1 + "</b><i>:</i>" +
        '<b class="' + (s2 > s1 ? "win" : "") + '">' + s2 + "</b>";
    } else {
      score = '<span class="vs">VS</span>';
    }
    var known = r.team1 && r.team2 && r.team1 !== "待定" && r.team2 !== "待定";
    var hasMatch = !!(r.hasDetail || live || r.st === 1);
    var href = "", label = "";
    if (hasMatch) {
      href = "match.html?id=" + encodeURIComponent(r.matchId);
      label = live ? "实时" : (r.hasDetail ? "复盘" : "详情");
    } else if (!done && known) {
      href = "h2h.html?a=" + encodeURIComponent(r.team1) + "&b=" + encodeURIComponent(r.team2);
      label = "交手";
    } else if (!done) {
      label = "待赛";
    } else if (r.video) {
      href = r.video;
      label = "回放";
    }
    var status = live ? '<span class="sch-status live"><i></i>进行中</span>'
      : done ? '<span class="sch-status done">已结束</span>'
        : '<span class="sch-status next">未开始</span>';
    var go = href
      ? '<span class="sch-go">' + label + '<span class="arr">→</span></span>'
      : '<span class="sch-go off">' + (label || "—") + "</span>";
    var video = r.video
      ? '<a class="sch-video" href="' + esc(r.video) + '" target="_blank" rel="noopener" title="官方回放" aria-label="官方回放">▶</a>'
      : "";
    var cls = "sch-row is-" + state + (index < 10 ? " anim" : "");
    var attrs = ' data-mid="' + esc(r.matchId) + '"' + (href ? ' data-href="' + esc(href) + '" role="link" tabindex="0"' : "");
    return '<div class="' + cls + '"' + attrs + (index < 10 ? ' style="--i:' + index + '"' : "") + ">" +
      '<div class="sch-time"><b>' + esc(r.time || "—") + "</b><span>" + (live ? "LIVE" : (done ? "已完赛" : "待开赛")) + "</span></div>" +
      teamHTML(r.team1, r.icon1, "home", done && s1 > s2) +
      '<div class="sch-score">' + score + "</div>" +
      teamHTML(r.team2, r.icon2, "away", done && s2 > s1) +
      '<div class="sch-meta">' + status + coverageHTML(r) + '<span class="sch-row-arrow">→</span></div>' +
      '<div class="sch-go-wrap">' + go + video + "</div>" +
      "</div>";
  }

  function renderList() {
    var rows = filteredRows();
    var list = $("#list");
    if (!list) return;
    if (shown > rows.length) shown = Math.max(PAGE, rows.length);
    var view = rows.slice(0, shown);
    var today = todayCN();
    var html = "";
    var lastDate = "";
    var seenActive = false;
    var pastSep = false;
    var counts = {};
    view.forEach(function (r) { counts[r.date] = (counts[r.date] || 0) + 1; });
    view.forEach(function (r, i) {
      if (r.date !== lastDate) {
        if (lastDate) html += "</div>";
        var isPast = r.date < today;
        if (isPast && !pastSep && seenActive) {
          html += '<div class="sch-sep"><span>已结束</span></div>';
          pastSep = true;
        }
        html += '<div class="sch-day" data-date="' + esc(r.date) + '">' + dayHead(r, counts[r.date]);
        lastDate = r.date;
      }
      if (!r.done) seenActive = true;
      html += rowHTML(r, i);
    });
    if (lastDate) html += "</div>";

    if (!rows.length) {
      list.innerHTML = '<div class="sch-empty"><b>没有符合条件的场次</b><p>换一个年份、赛段或战队名试试。</p>' +
        '<button type="button" data-reset>清除筛选</button></div>';
    } else {
      list.innerHTML = html;
    }

    var more = $("#moreBtn");
    if (more) more.style.display = shown < rows.length ? "" : "none";
    if ($("#shownN")) $("#shownN").textContent = Math.min(shown, rows.length);
    if ($("#totalN")) $("#totalN").textContent = rows.length;
    if ($("#countNote")) {
      $("#countNote").innerHTML = "共 <b>" + K.fmtInt(rows.length) + "</b> 场";
    }
    var scope = K.scopeName(curScope);
    var sortNote = $("#sortNote");
    if (sortNote) {
      if (statusFilter === "未开始") sortNote.textContent = "按开赛时间从近到远";
      else if (statusFilter === "已结束") sortNote.textContent = "按日期从近到远";
      else if (query || stageFilter || statusFilter) sortNote.textContent = "当前筛选 · " + scope;
      else sortNote.textContent = "今天 → 即将开始 → 最近结束";
    }
    renderBrief(rows);
    syncControls();
  }

  function renderBrief(rows) {
    var fin = rows.filter(function (r) { return r.done; }).length;
    var today = todayCN();
    var live = rows.filter(isLiveRow)[0];
    var todayRows = rows.filter(function (r) { return r.date === today; });
    var upcoming0 = rows.filter(function (r) { return !r.done; }).sort(function (a, b) { return matchMs(a) - matchMs(b); })[0];
    if (window.matchMedia("(max-width: 900px)").matches) {
      var short = "共 <b>" + K.fmtInt(rows.length) + "</b> 场";
      if (todayRows.length) short += " · 今天 <b>" + todayRows.length + "</b> 场";
      if (live) short += " · 直播 <b>" + esc(live.team1) + " " + live.score1 + " : " + live.score2 + " " + esc(live.team2) + "</b>";
      else if (upcoming0) short += " · 下一场 <b>" + esc(upcoming0.time || "") + " " + esc(upcoming0.team1) + " vs " + esc(upcoming0.team2) + "</b>";
      K.brief("#brief", short + "。");
      return;
    }
    var txt = "当前范围共 <b>" + K.fmtInt(rows.length) + "</b> 场（已结束 " + K.fmtInt(fin) + " 场）。";
    if (live) {
      txt += "正在进行：<b>" + esc(live.team1) + " " + live.score1 + " : " + live.score2 + " " + esc(live.team2) + "</b>。";
    } else if (todayRows.length) {
      txt += "今天有 <b>" + todayRows.length + "</b> 场比赛。";
    }
    var upcoming = rows.filter(function (r) { return !r.done; }).sort(function (a, b) { return matchMs(a) - matchMs(b); })[0];
    if (upcoming) {
      txt += "下一场：<b>" + esc(String(upcoming.date).slice(5)) + " " + esc(upcoming.time || "") + " " +
        esc(upcoming.team1) + " vs " + esc(upcoming.team2) + "</b>。";
    }
    txt += "点「复盘」进逐局时间轴；徽标表示该场能查到哪些数据。";
    K.brief("#brief", txt);
  }

  /* ---------- 赛段进程 ---------- */
  function trackLeague() {
    if (curLeagueId) return leagueOf(curLeagueId);
    var pool = scopeRows();
    if (!pool.length) return null;
    var now = Date.now();
    var cur = pool.slice().sort(function (a, b) { return Math.abs(matchMs(a) - now) - Math.abs(matchMs(b) - now); })[0];
    return cur ? leagueOf(cur.leagueId) : null;
  }

  function renderStages() {
    var el = $("#stageTrack");
    var note = $("#stageNote");
    var more = $("#stageMore");
    if (!el) return;
    var lg = trackLeague();
    currentStageInfo = null;
    if (!lg) {
      el.innerHTML = '<div class="sch-recent-empty">暂无赛段数据</div>';
      if (note) note.textContent = "—";
      return;
    }
    var rows = ALL.filter(function (r) { return String(r.leagueId) === String(lg.id) && r.stage; });
    var order = [];
    var by = {};
    rows.forEach(function (r) {
      var key = r.stage;
      if (!by[key]) { by[key] = { key: key, n: 0, done: 0, min: r.date }; order.push(by[key]); }
      var g = by[key];
      g.n++;
      if (r.done) g.done++;
      if (r.date < g.min) g.min = r.date;
    });
    order.sort(function (a, b) { return String(a.min).localeCompare(String(b.min)); });
    var onKey = (order.filter(function (g) { return g.done < g.n; })[0] || {}).key || (order[order.length - 1] || {}).key;
    var onInfo = by[onKey] || null;
    currentStageInfo = onInfo ? { league: lg, stage: onKey, done: onInfo.done, n: onInfo.n } : null;
    if (note) note.textContent = lg.name + " · " + order.length + " 个赛段";
    if (more) more.href = "bracket.html?id=" + encodeURIComponent(lg.id);
    if (!order.length) {
      el.innerHTML = '<div class="sch-recent-empty">该赛事暂无赛段标注</div>';
      return;
    }
    el.innerHTML = order.map(function (g, i) {
      var pct = g.n ? Math.round(g.done / g.n * 100) : 0;
      var isCurrent = g.key === onKey;
      var selected = stageFilter === g.key;
      var stateText = isCurrent ? "当前" : (g.done === g.n ? "已完赛" : (g.done ? "进行中" : "未开始"));
      return '<button type="button" class="sch-step' + (g.done === g.n ? " done" : "") +
        (isCurrent ? " is-current" : "") + (selected ? " on" : "") +
        '" data-stage="' + esc(g.key) + '" aria-pressed="' + (selected ? "true" : "false") + '">' +
        '<span class="sch-step-i">' + String(i + 1).padStart(2, "0") + "</span>" +
        '<span class="sch-step-main"><b>' + esc(K.stageLabel(g.key)) + "</b>" +
        "<em>" + g.done + "/" + g.n + " 场 · " + esc(String(g.min).slice(5)) + " 起</em>" +
        '<span class="sch-step-bar"><i style="width:' + pct + '%"></i></span></span>' +
        '<span class="sch-step-state">' + stateText + "</span></button>";
    }).join("");
  }

  function updateStageMini() {
    var el = $("#stageMini");
    if (!el) return;
    if (!currentStageInfo) {
      el.innerHTML = "<span>赛段进程</span><i><span style=\"width:0\"></span></i><a href=\"bracket.html\">查看 →</a>";
      return;
    }
    var pct = currentStageInfo.n ? Math.round(currentStageInfo.done / currentStageInfo.n * 100) : 0;
    el.innerHTML = "<span><b>" + esc(K.stageLabel(currentStageInfo.stage)) + "</b> " +
      currentStageInfo.done + "/" + currentStageInfo.n + " 场</span>" +
      '<i><span style="width:' + pct + '%"></span></i>' +
      '<a href="bracket.html?id=' + encodeURIComponent(currentStageInfo.league.id) + '">进程 →</a>';
  }

  /* ---------- 最近赛果 ---------- */
  function renderRecent() {
    var el = $("#recentRows");
    if (!el) return;
    var rows = ALL.filter(function (r) { return inScope(r) && r.done; })
      .sort(function (a, b) { return (b.date + b.time).localeCompare(a.date + a.time); })
      .slice(0, 6);
    if (!rows.length) {
      el.innerHTML = '<div class="sch-recent-empty">当前范围暂无已结束比赛</div>';
      return;
    }
    el.innerHTML = rows.map(function (r) {
      var s1 = Number(r.score1 || 0);
      var s2 = Number(r.score2 || 0);
      var mask = K.coverageMask(r.matchId) || 0;
      var cov = [1, 2, 4, 24].filter(function (b) { return mask & b; }).length;
      return '<a class="sch-recent-row" href="match.html?id=' + encodeURIComponent(r.matchId) + '">' +
        '<span class="sch-recent-date">' + esc(String(r.date).slice(5)) + "</span>" +
        '<span class="sch-recent-match"><b class="' + (s1 >= s2 ? "win" : "") + '">' + esc(r.team1) + "</b>" +
        "<em>" + s1 + ":" + s2 + "</em>" +
        '<b class="' + (s2 > s1 ? "win" : "") + '">' + esc(r.team2) + "</b></span>" +
        '<span class="sch-recent-cov">' + cov + "/4</span></a>";
    }).join("");
  }

  /* ---------- 控件同步 ---------- */
  function syncControls() {
    var active = curScope !== "all" || stageFilter || statusFilter || query;
    var reset = $("#resetBtn");
    if (reset) reset.hidden = !active;
    var clear = $("#clearTeam");
    if (clear) clear.hidden = !query;
    var sel = $("#fStatus");
    if (sel) sel.value = statusFilter;
    $$("#statusSeg button").forEach(function (b) {
      var on = (b.getAttribute("data-st") || "") === statusFilter;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    var stageSel = $("#fStage");
    if (stageSel) stageSel.value = stageFilter;
    var lgSel = $("#fLeague");
    if (lgSel) lgSel.value = curLeagueId;
  }

  /* ---------- 交互 ---------- */
  function scrollToResults() {
    var target = $("#list");
    if (!target) return;
    target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }

  function resetAll() {
    curYear = "all";
    curLeagueId = "";
    curScope = "all";
    stageFilter = "";
    statusFilter = "";
    query = "";
    shown = PAGE;
    try { localStorage.setItem("kpl_scope_v1", "all"); } catch (e) {}
    var team = $("#fTeam");
    if (team) team.value = "";
    buildYearRail();
    buildLeagueSelect();
    fillStages();
    renderList();
    renderStages();
    renderRecent();
    updateStageMini();
    syncControls();
    scrollToResults();
  }

  function bindEvents() {
    var rail = $("#yearRail");
    if (rail) {
      rail.addEventListener("click", function (e) {
        var b = e.target.closest(".sch-year");
        if (!b) return;
        var y = b.getAttribute("data-year");
        setScope(y === "all" ? "all" : y, { scroll: false });
      });
      rail.addEventListener("scroll", updateRailButtons, { passive: true });
      rail.addEventListener("wheel", function (e) {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.preventDefault();
          rail.scrollLeft += e.deltaY;
        }
      }, { passive: false });
    }
    var prev = $("#railPrev"), next = $("#railNext");
    if (prev) prev.addEventListener("click", function () { scrollRail(-1); });
    if (next) next.addEventListener("click", function () { scrollRail(1); });

    var stageSel = $("#fStage");
    if (stageSel) stageSel.addEventListener("change", function () {
      stageFilter = stageSel.value;
      shown = PAGE;
      renderList();
      renderStages();
      updateStageMini();
    });

    var statusSeg = $("#statusSeg");
    if (statusSeg) statusSeg.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-st]");
      if (!b) return;
      statusFilter = b.getAttribute("data-st") || "";
      shown = PAGE;
      renderList();
      scrollToResults();
    });
    var statusSel = $("#fStatus");
    if (statusSel) statusSel.addEventListener("change", function () {
      statusFilter = statusSel.value;
      shown = PAGE;
      renderList();
    });

    var team = $("#fTeam");
    if (team) team.addEventListener("input", function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        query = team.value.trim();
        shown = PAGE;
        renderList();
      }, 110);
    });
    var clear = $("#clearTeam");
    if (clear) clear.addEventListener("click", function () {
      var input = $("#fTeam");
      if (input) { input.value = ""; input.focus(); }
      query = "";
      shown = PAGE;
      renderList();
    });

    var reset = $("#resetBtn");
    if (reset) reset.addEventListener("click", resetAll);

    var more = $("#moreBtn");
    if (more) more.addEventListener("click", function () {
      shown += PAGE;
      renderList();
    });

    var list = $("#list");
    if (list) {
      list.addEventListener("click", function (e) {
        if (e.target.closest("a")) return;
        if (e.target.closest("[data-reset]")) { resetAll(); return; }
        var row = e.target.closest(".sch-row[data-href]");
        if (row) location.href = row.getAttribute("data-href");
      });
      list.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " ") return;
        if (e.target.closest("a")) return;
        var row = e.target.closest(".sch-row[data-href]");
        if (!row) return;
        e.preventDefault();
        location.href = row.getAttribute("data-href");
      });
    }

    var stageTrack = $("#stageTrack");
    if (stageTrack) stageTrack.addEventListener("click", function (e) {
      var b = e.target.closest(".sch-step");
      if (!b) return;
      var s = b.getAttribute("data-stage") || "";
      var lg = currentStageInfo && currentStageInfo.league;
      if (lg && String(curScope) !== String(lg.id)) setScope(lg.id, { scroll: false });
      stageFilter = stageFilter === s ? "" : s;
      shown = PAGE;
      renderList();
      renderStages();
      updateStageMini();
      syncControls();
      scrollToResults();
    });

    var recentAll = $("#recentAll");
    if (recentAll) recentAll.addEventListener("click", function (e) {
      e.preventDefault();
      statusFilter = "已结束";
      stageFilter = "";
      query = "";
      var input = $("#fTeam");
      if (input) input.value = "";
      shown = PAGE;
      renderList();
      renderStages();
      scrollToResults();
    });

    var backTop = $("#backTop");
    if (backTop) backTop.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    });

    var toolbar = $("#schToolbar");
    function onScroll() {
      var headerH = (document.getElementById("siteHeader") || {}).offsetHeight || 72;
      if (toolbar) toolbar.classList.toggle("is-stuck", toolbar.getBoundingClientRect().top <= headerH + 1);
      if (backTop) backTop.classList.toggle("show", window.scrollY > 720);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", updateRailButtons);
    onScroll();
  }

  /* ---------- 实时比分覆盖 ---------- */
  function loadLiveScript(cb) {
    var sc = document.createElement("script");
    sc.src = "assets/live.js?ts=" + Date.now();
    sc.onload = function () { cb(window.KPL_LIVE); sc.remove(); };
    sc.onerror = function () { cb(null); sc.remove(); };
    document.head.appendChild(sc);
  }

  function liveRowOf(matchId) {
    if (!liveData) return null;
    return (liveData.today || []).filter(function (x) { return x.matchId === matchId; })[0] ||
      (liveData.matches || []).filter(function (x) { return x.matchId === matchId; })[0] || null;
  }

  function paintLiveRow(row, t) {
    if (!row || !t) return;
    var s1 = Number(t.score1 || 0);
    var s2 = Number(t.score2 || 0);
    var sc = row.querySelector(".sch-score");
    if (sc && (s1 > 0 || s2 > 0 || t.st === 2)) {
      sc.innerHTML = '<b class="' + (s1 > s2 ? "win" : "") + '">' + s1 + "</b><i>:</i>" +
        '<b class="' + (s2 > s1 ? "win" : "") + '">' + s2 + "</b>";
    }
    var status = row.querySelector(".sch-status");
    if (status) {
      if (t.st === 1) status.className = "sch-status live", status.innerHTML = "<i></i>进行中";
      else if (t.st === 2) status.className = "sch-status done", status.textContent = "已结束";
      else status.className = "sch-status next", status.textContent = "未开始";
    }
    row.classList.toggle("is-live", t.st === 1);
    row.classList.toggle("is-done", t.st === 2);
    row.classList.toggle("is-next", t.st !== 1 && t.st !== 2);
    var go = row.querySelector(".sch-go");
    if (go && t.st === 1) {
      row.setAttribute("data-href", "match.html?id=" + encodeURIComponent(t.matchId));
      row.setAttribute("role", "link");
      row.setAttribute("tabindex", "0");
      go.classList.remove("off");
      go.innerHTML = '实时<span class="arr">→</span>';
    }
    var timeSpan = row.querySelector(".sch-time span");
    if (timeSpan) timeSpan.textContent = t.st === 1 ? "LIVE" : (t.st === 2 ? "已完赛" : "待开赛");
  }

  function applyToday() {
    loadLiveScript(function (L) {
      if (!L) return;
      liveData = L;
      var at = $("#liveAt");
      // 只有确实有局在进行时才显示同步时间；否则那串第二位数字是几天前的旧值，会误导。
      var hasLiveNow = ALL.some(isLiveRow);
      var sync = at ? at.closest(".sch-feature-sync") : null;
      if (at) at.textContent = hasLiveNow ? (String(L.updatedAt || "").slice(11, 19) || "") : "";
      if (sync) sync.hidden = !hasLiveNow;
      (L.today || []).forEach(function (t) {
        var row = document.querySelector('.sch-row[data-mid="' + t.matchId + '"]');
        paintLiveRow(row, t);
        var feature = $("#evPoster");
        if (feature && feature.getAttribute("data-mid") === String(t.matchId)) {
          var fs = feature.querySelector(".sch-fscore");
          if (fs && (t.st === 1 || t.st === 2)) {
            fs.innerHTML = "<b>" + Number(t.score1 || 0) + "</b><i>:</i><b>" + Number(t.score2 || 0) + "</b>";
          }
          if (t.st === 1) {
            feature.classList.add("is-live");
            var lab = feature.querySelector(".sch-feature-label");
            if (lab && lab.textContent.indexOf("正在") < 0) {
              lab.innerHTML = '<i class="sch-live-dot"></i>正在进行<em class="sch-feature-kick">LIVE</em>';
            }
          }
        }
      });
    });
  }

  /* ---------- 启动 ---------- */
  readSavedScope();
  buildYearRail();
  buildLeagueSelect();
  fillStages();
  bindEvents();
  renderStats();
  renderFeature();
  renderList();
  renderStages();
  renderRecent();
  updateStageMini();
  syncControls();
  applyToday();
  setInterval(applyToday, 30000);
})();
