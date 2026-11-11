/* 赛事进程 · 页面逻辑（2026-11-03）
   数据仍来自既有 KPL_SCHEDULE_ALL / K.leagueInfo / K.leagueStandings。 */
(function () {
  "use strict";

  var K = window.KPL;
  if (!K) return;
  K.init();

  var $ = function (s, root) { return (root || document).querySelector(s); };
  var $$ = function (s, root) { return Array.prototype.slice.call((root || document).querySelectorAll(s)); };
  var ALL = window.KPL_SCHEDULE_ALL || [];
  var STAGE_LIMIT = 24;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var curId = "";
  var selectedStage = 0;
  var stageShown = STAGE_LIMIT;

  /* ---------- 工具 ---------- */
  function esc(v) { return K.esc(v); }
  function md(d) { return String(d || "").slice(5).replace("-", "."); }
  function matchMs(r) {
    var t = Date.parse(r.date + "T" + (r.time || "17:00") + ":00");
    return isNaN(t) ? Date.parse(r.date + "T12:00:00") : t;
  }
  function isLiveRow(r) { return !r.done && (r.st === 1 || K.isLive(r)); }
  function stageName(s) { return s.label || "未标注赛段"; }
  function initialOf(name) {
    var s = String(name || "?").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
    return (s.slice(0, 1) || "?").toUpperCase();
  }
  function usableIcon(icon) {
    if (!icon) return "";
    // 官方接口对缺图标战队会回一个通用 team.png，它是空图，不能再让文字垫在下面。
    if (/\/team\/team\.png(?:$|\?)/.test(icon)) return "";
    return icon;
  }
  function logoHTML(name, icon, cls) {
    icon = usableIcon(icon);
    var initial = esc(initialOf(name));
    return '<span class="br-logo' + (cls ? " " + cls : "") + (icon ? "" : " is-fallback") +
      '" data-initial="' + initial + '">' +
      (icon ? '<img src="' + esc(icon) + '" alt="" loading="lazy" ' +
        'onerror="this.parentNode.classList.add(\'is-fallback\');this.remove()">' : "") +
      "</span>";
  }
  function iconOf(L2, team) {
    var hit = L2.rows.filter(function (r) {
      return (r.team1 === team && r.icon1) || (r.team2 === team && r.icon2);
    })[0];
    if (!hit) return "";
    return hit.team1 === team ? (hit.icon1 || "") : (hit.icon2 || "");
  }
  function hrefOf(r) {
    var known = r.team1 && r.team2 && r.team1 !== "待定" && r.team2 !== "待定";
    if (r.hasDetail || isLiveRow(r) || r.st === 1) {
      return { href: "match.html?id=" + encodeURIComponent(r.matchId), label: isLiveRow(r) ? "实时" : "复盘", external: false };
    }
    if (!r.done && known) {
      return { href: "h2h.html?a=" + encodeURIComponent(r.team1) + "&b=" + encodeURIComponent(r.team2), label: "交手", external: false };
    }
    if (r.video) return { href: r.video, label: "回放", external: true };
    return { href: "", label: r.done ? "—" : "待赛", external: false };
  }
  function countTo(el, target, delay) {
    if (!el) return;
    if (reduce) { el.textContent = K.fmtInt(target); return; }
    setTimeout(function () {
      var t0 = null;
      var dur = 760;
      function frame(ts) {
        if (!t0) t0 = ts || performance.now();
        var k = Math.min(1, ((ts || performance.now()) - t0) / dur);
        var eased = 1 - Math.pow(1 - k, 3);
        el.textContent = K.fmtInt(Math.round(target * eased));
        if (k < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }, delay || 0);
  }

  /* ---------- 赛事列表 ---------- */
  function buildOptions() {
    var byId = {};
    ALL.forEach(function (r) {
      if (!r.leagueId) return;
      var o = byId[r.leagueId] || (byId[r.leagueId] = {
        id: String(r.leagueId),
        name: String(r.leagueName || r.leagueId),
        year: String(r.year || String(r.date || "").slice(0, 4)),
        last: ""
      });
      var key = String(r.date || "");
      if (key > o.last) o.last = key;
    });
    return Object.keys(byId).map(function (k) { return byId[k]; })
      .sort(function (a, b) {
        return String(b.last).localeCompare(String(a.last)) || String(a.name).localeCompare(String(b.name));
      });
  }
  var OPTS = buildOptions();
  var optIndex = {};
  OPTS.forEach(function (o, i) { optIndex[o.id] = i; });

  function fillSel() {
    var sel = $("#brSel");
    if (!sel) return;
    var groups = {};
    OPTS.forEach(function (o) { (groups[o.year] = groups[o.year] || []).push(o); });
    var html = "";
    Object.keys(groups).sort(function (a, b) { return Number(b) - Number(a); }).forEach(function (y) {
      html += '<optgroup label="' + y + ' 年">';
      groups[y].forEach(function (o) {
        html += '<option value="' + esc(o.id) + '">' + esc(o.name) + "</option>";
      });
      html += "</optgroup>";
    });
    sel.innerHTML = html;
  }

  function setUrl(id) {
    try { history.replaceState(null, "", "bracket.html?id=" + encodeURIComponent(id)); } catch (e) {}
  }

  function updatePager(id) {
    var i = optIndex[id];
    var prev = $("#brPrev");
    var next = $("#brNext");
    if (prev) prev.disabled = !(i > 0);
    if (next) next.disabled = !(i >= 0 && i < OPTS.length - 1);
  }

  /* ---------- 顶部 KPI ---------- */
  function renderKpis(L2) {
    countTo($("#kStages"), L2.stages.length, 0);
    countTo($("#kTeams"), L2.teamN, 50);
    countTo($("#kDone"), L2.doneN, 100);
    countTo($("#kTotal"), L2.total, 150);
  }

  /* ---------- 赛事卡 ---------- */
  function finalMatch(L2) {
    return L2.rows.slice().sort(function (a, b) {
      return (a.date + a.time).localeCompare(b.date + b.time);
    }).filter(function (r) { return r.done; }).pop();
  }

  function renderChampion(L2) {
    var last = finalMatch(L2);
    var icon = iconOf(L2, L2.champion);
    return '<div class="br-champion">' + logoHTML(L2.champion, icon) +
      "<div><span>CHAMPION · 冠军</span><b>" + esc(L2.champion) + "</b>" +
      (last ? "<em>决赛 " + esc(md(last.date)) + " · " + esc(last.team1) + " " +
        Number(last.score1 || 0) + " : " + Number(last.score2 || 0) + " " + esc(last.team2) + "</em>" : "") +
      "</div></div>";
  }

  function renderNow(L2) {
    var stage = L2.stages[L2.nowIdx];
    if (!stage) {
      var last = finalMatch(L2);
      if (last) {
        return '<div class="br-now"><div class="br-now-top"><span>全部赛段已结束</span></div>' +
          '<div class="br-now-next">最近结果 <b>' + esc(last.team1) + " " + Number(last.score1 || 0) +
          " : " + Number(last.score2 || 0) + " " + esc(last.team2) + "</b></div></div>";
      }
      return '<div class="br-now"><div class="br-now-next">暂无赛段数据</div></div>';
    }
    var pct = stage.n ? Math.round(stage.doneN / stage.n * 100) : 0;
    var next = L2.next;
    var live = next && isLiveRow(next);
    var nextHTML = "";
    if (next) {
      var h = hrefOf(next);
      var action = h.href ? ' <a href="' + h.href + '"' + (h.external ? ' target="_blank" rel="noopener"' : "") + ">" + h.label + " →</a>" : "";
      nextHTML = '<div class="br-now-next">' + (live ? "正在进行" : "下一场") + " · <b>" +
        esc(md(next.date) + " " + (next.time || "")) + "</b> " +
        esc(next.team1) + (live ? " " + Number(next.score1 || 0) + " : " + Number(next.score2 || 0) + " " : " vs ") +
        esc(next.team2) + action + "</div>";
    } else {
      nextHTML = '<div class="br-now-next">该赛事已无待进行比赛，完整赛果见 <a href="schedule.html">赛程中心 →</a></div>';
    }
    return '<div class="br-now' + (live ? " is-live" : "") + '">' +
      '<div class="br-now-top"><span>' + (live ? '<i class="br-live-dot"></i>' : "") + "当前赛段</span>" +
      "<b>" + esc(stageName(stage)) + "</b><em>" + stage.doneN + "/" + stage.n + " 场</em></div>" +
      '<div class="br-now-bar"><i style="width:' + pct + '%"></i></div>' +
      nextHTML + "</div>";
  }

  function renderEvent(L2) {
    $("#brName").textContent = L2.name;
    $("#brMeta").innerHTML =
      "<span><b>" + esc(md(L2.from)) + " — " + esc(md(L2.to)) + "</b></span>" +
      "<i>·</i><span>" + L2.teamN + " 支战队</span>" +
      "<i>·</i><span>已完赛 <b>" + L2.doneN + "</b> / " + L2.total + " 场</span>" +
      "<i>·</i><span>" + (L2.nowIdx >= 0 ? "当前 <b>" + esc(stageName(L2.stages[L2.nowIdx])) + "</b>" : "全部赛段已结束") + "</span>";
    $("#brFocus").innerHTML = L2.champion ? renderChampion(L2) : renderNow(L2);
    var ev = $("#brEvent");
    if (ev) ev.classList.toggle("is-live", !!(L2.next && isLiveRow(L2.next)));
    var cta = $("#brToBracket");
    if (cta) {
      cta.textContent = "查看赛事进程";
      cta.setAttribute("href", "#brBracketSec");
    }
  }

  /* ---------- 赛段轨：所有赛段都可以查看 ---------- */
  function renderRail(L2) {
    var note = $("#brRailNote");
    var view = L2.stages[selectedStage];
    if (note) note.textContent = L2.stages.length + " 个赛段" + (view ? " · 正在查看 " + stageName(view) : " · 暂无赛段");
    var rail = $("#brRail");
    if (!rail) return;
    rail.innerHTML = L2.stages.map(function (s, i) {
      var pct = s.n ? Math.round(s.doneN / s.n * 100) : 0;
      var current = i === L2.nowIdx;
      var selected = i === selectedStage;
      var cls = "br-stage" + (s.done ? " is-done" : "") + (current ? " is-now" : "") + (selected ? " is-selected" : "");
      var state = s.done ? "已结束" : (current ? "当前" : "未开始");
      return '<button type="button" class="' + cls + '" data-stage="' + i + '"' +
        (current ? ' aria-current="step"' : "") + ' title="查看该赛段比赛">' +
        '<span class="br-stage-top"><span class="br-stage-no">' + String(i + 1).padStart(2, "0") + "</span>" +
        '<span class="br-stage-state">' + state + "</span></span>" +
        '<span class="br-stage-name">' + esc(stageName(s)) + "</span>" +
        '<span class="br-stage-date">' + esc(md(s.from) + (s.to !== s.from ? " — " + md(s.to) : "")) + "</span>" +
        '<span class="br-stage-bar"><i style="width:' + pct + '%"></i></span>' +
        '<span class="br-stage-meta"><b>' + s.doneN + "/" + s.n + " 场</b><span>" + pct + "%</span></span></button>";
    }).join("");
    var active = rail.querySelector(".br-stage.is-selected");
    if (active) {
      var left = active.offsetLeft - rail.clientWidth / 2 + active.offsetWidth / 2;
      rail.scrollLeft = Math.max(0, left);
    }
    updateRailButtons();
  }

  function updateRailButtons() {
    var rail = $("#brRail");
    var prev = $("#brRailPrev");
    var next = $("#brRailNext");
    if (!rail || !prev || !next) return;
    var over = rail.scrollWidth > rail.clientWidth + 4;
    prev.style.display = over ? "" : "none";
    next.style.display = over ? "" : "none";
    prev.disabled = !over || rail.scrollLeft <= 2;
    next.disabled = !over || rail.scrollLeft >= rail.scrollWidth - rail.clientWidth - 2;
  }

  function scrollRail(dir) {
    var rail = $("#brRail");
    if (!rail) return;
    rail.scrollBy({ left: dir * 300, behavior: reduce ? "auto" : "smooth" });
  }

  /* ---------- 比赛卡 ---------- */
  function matchCard(r, i) {
    var tbd = r.team1 === "待定" || r.team2 === "待定" || !r.team1 || !r.team2;
    var live = isLiveRow(r);
    var done = !!r.done;
    var status = live ? "live" : (done ? "done" : "next");
    var statusText = live ? "进行中" : (done ? "已结束" : "未开始");
    var meta = esc(md(r.date) + " " + (r.time || "")) + " · BO" + (r.bo || 5);
    var h = tbd ? { href: "", label: "待定", external: false } : hrefOf(r);
    var action = h.href
      ? '<span class="br-match-go">' + h.label + " →</span>"
      : '<span class="br-match-go">' + (tbd ? "待定" : h.label) + "</span>";
    var top = '<span class="br-match-meta">' + meta + '<span class="br-status ' + status + '">' +
      (live ? "<i></i>" : "") + statusText + "</span>" + action + "</span>";
    var delay = ' style="animation-delay:' + Math.min(i * 20, 260) + 'ms"';

    if (tbd) {
      return '<div class="br-match is-tbd"' + delay + ">" + top +
        '<span class="br-match-team"><b>待定</b><span class="br-score">—</span></span>' +
        '<span class="br-match-team"><b>待定</b><span class="br-score">—</span></span></div>';
    }
    var s1 = Number(r.score1 || 0);
    var s2 = Number(r.score2 || 0);
    var w1 = done && s1 > s2;
    var w2 = done && s2 > s1;
    var shown1 = done || live ? s1 : "—";
    var shown2 = done || live ? s2 : "—";
    var inner = top +
      '<span class="br-match-team' + (w1 ? " is-win" : "") + (w2 ? " is-lose" : "") + '">' +
      logoHTML(r.team1, r.icon1) + "<b>" + esc(r.team1) + '</b><span class="br-score">' + shown1 + "</span></span>" +
      '<span class="br-match-team' + (w2 ? " is-win" : "") + (w1 ? " is-lose" : "") + '">' +
      logoHTML(r.team2, r.icon2) + "<b>" + esc(r.team2) + '</b><span class="br-score">' + shown2 + "</span></span>";
    var cls = "br-match" + (live ? " is-live" : "") + (done ? " is-done" : "") + (h.href ? "" : " is-static");
    if (!h.href) return '<div class="' + cls + '" data-mid="' + esc(r.matchId) + '"' + delay + ">" + inner + "</div>";
    return '<a class="' + cls + '" data-mid="' + esc(r.matchId) + '" href="' + h.href + '"' +
      (h.external ? ' target="_blank" rel="noopener"' : "") + delay + ">" + inner + "</a>";
  }

  /* ---------- 选中赛段的比赛网格 ---------- */
  function defaultStage(L2) {
    return L2.nowIdx >= 0 ? L2.nowIdx : Math.max(0, L2.stages.length - 1);
  }

  function renderStageView(L2) {
    var kicker = $("#brStageKicker");
    var name = $("#brStageName");
    var meta = $("#brStageMeta");
    var bar = $("#brStageBar");
    var grid = $("#brMatchGrid");
    var more = $("#brStageMore");
    var prev = $("#brStagePrev");
    var next = $("#brStageNext");
    var stage = L2.stages[selectedStage];
    if (!stage) {
      if (kicker) kicker.textContent = "STAGE";
      if (name) name.textContent = "暂无赛段数据";
      if (meta) meta.textContent = "";
      if (bar) bar.style.width = "0%";
      if (grid) grid.innerHTML = '<div class="br-empty"><b>该赛事暂无赛段数据</b><span>完整比赛与比分可以到 <a href="schedule.html">赛程中心</a> 查看。</span></div>';
      if (more) more.hidden = true;
      if (prev) prev.disabled = true;
      if (next) next.disabled = true;
      return;
    }
    var pct = stage.n ? Math.round(stage.doneN / stage.n * 100) : 0;
    if (kicker) kicker.textContent = "STAGE " + String(selectedStage + 1).padStart(2, "0");
    if (name) name.textContent = stageName(stage);
    if (meta) {
      meta.textContent = md(stage.from) + (stage.to !== stage.from ? " — " + md(stage.to) : "") +
        " · " + stage.n + " 场 · " + (stage.done ? "已结束" : stage.doneN + "/" + stage.n + " 完成");
    }
    if (bar) bar.style.width = pct + "%";
    if (prev) prev.disabled = selectedStage <= 0;
    if (next) next.disabled = selectedStage >= L2.stages.length - 1;

    var matches = stage.rows.slice().sort(function (a, b) {
      return (a.date + (a.time || "")).localeCompare(b.date + (b.time || ""));
    });
    if (!matches.length) {
      grid.innerHTML = '<div class="br-empty"><b>该赛段暂无比赛</b></div>';
      if (more) more.hidden = true;
      return;
    }
    var shown = Math.min(stageShown, matches.length);
    grid.innerHTML = matches.slice(0, shown).map(matchCard).join("");
    if (more) {
      more.hidden = shown >= matches.length;
      more.textContent = "显示更多（已显示 " + shown + " / " + matches.length + "）";
    }
    var note = $("#brNote");
    if (note) {
      note.innerHTML = "按官方赛段归组；同一赛段内按时间排列。切换上方赛段可以查看其他赛段。" +
        "<b>不推断</b>官方未公布的对阵关系——完整赛程与比分以官方发布为准。";
    }
  }

  function selectStage(i, scroll) {
    var L2 = K.leagueInfo(curId);
    if (!L2 || !L2.stages[i]) return;
    selectedStage = i;
    stageShown = STAGE_LIMIT;
    renderRail(L2);
    renderStageView(L2);
    if (scroll !== false) {
      var t = $("#brBracketSec");
      if (t) t.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    }
  }

  function moveStage(delta) {
    selectStage(selectedStage + delta, true);
  }

  /* ---------- 积分榜 ---------- */
  function renderStandings(L2) {
    var title = $("#stTitle");
    if (title) title.textContent = K.leagueShortName(L2.name) + " · 赛事积分榜";
    var box = $("#brStandings");
    if (!box) return;
    var rows = K.leagueStandings(L2.id);
    if (!rows.length) {
      box.innerHTML = '<div class="br-empty"><b>暂无已结束的比赛</b><span>积分榜只统计已结束的大场，比赛结束后自动更新。</span></div>';
      return;
    }
    var head = '<div class="br-stand-head"><span>#</span><span>战队</span><span>大场</span>' +
      "<span>净胜局</span><span>单局胜率</span><span>已完赛</span></div>";
    var body = rows.map(function (t, i) {
      var diff = Number(t.diff || 0);
      var diffTxt = (diff > 0 ? "+" : "") + diff;
      var diffCls = diff > 0 ? "is-pos" : (diff < 0 ? "is-neg" : "is-zero");
      var wr = Math.max(0, Math.min(100, Number(t.wr || 0) * 100));
      return '<div class="br-stand-row' + (i < 3 ? " is-top" : "") + '">' +
        '<span class="br-rank' + (i < 3 ? " r" + (i + 1) : "") + '">' + (i + 1) + "</span>" +
        '<span class="br-stand-team">' + logoHTML(t.team, t.icon) +
        '<a href="team.html?id=' + encodeURIComponent(t.team) + '">' + esc(t.team) + "</a></span>" +
        '<span class="br-stand-record" data-m="' + t.m + '">' + t.w + "-" + t.l + "</span>" +
        '<span class="br-stand-diff ' + diffCls + '">' + diffTxt + "</span>" +
        '<span class="br-stand-wr"><span class="bar"><i style="width:' + wr.toFixed(1) + '%"></i></span>' +
        "<em>" + K.pct(t.wr, 1) + "</em></span>" +
        '<span class="br-stand-m">' + t.m + "</span></div>";
    }).join("");
    box.innerHTML = head + body +
      '<div class="br-stand-foot">共 <b>' + L2.doneN + "</b> 场已结束比赛计入本表 · " +
      "这是本站按「大场胜场 → 净胜局 → 单局胜率」自算的展示排序，<b>不是官方积分</b>。</div>";
  }

  /* ---------- 赛制与口径 ---------- */
  function renderRules(L2) {
    var box = $("#brRules");
    if (!box) return;
    var chips = L2.stages.map(function (s) {
      var bo = s.rows[0] && s.rows[0].bo ? " · BO" + s.rows[0].bo : "";
      return '<span class="br-rule-chip"><b>' + esc(stageName(s)) + "</b><em>" +
        esc(md(s.from) + (s.to !== s.from ? " — " + md(s.to) : "")) + " · " + s.n + " 场" + bo + "</em></span>";
    }).join("");
    box.innerHTML = '<div class="br-rule-stages">' + (chips || '<span class="br-rule-chip"><b>暂无赛段</b></span>') + "</div>" +
      '<ol class="br-rule-list">' +
      "<li><b>赛段与对阵</b>：以官方发布的赛程为准，本页按官方字段自动归组，不根据赛果推断未公布的对阵关系。</li>" +
      "<li><b>积分榜</b>：本站按「大场胜场 → 净胜局 → 单局胜率」自算，不是官方积分；部分赛事另有积分或晋级规则。</li>" +
      "<li><b>待定</b>：表示官方对阵尚未确定；比赛结束后，赛程与对阵会自动更新。</li>" +
      "<li><b>数据来源</b>：比分与状态来自官方赛程接口，随比赛进程刷新。口径与更新方式见 <a href=\"about.html\">数据说明</a>。</li>" +
      "</ol>";
  }

  /* ---------- 主渲染 ---------- */
  function render(id) {
    var L2 = K.leagueInfo(id);
    curId = id;
    var sel = $("#brSel");
    if (sel) sel.value = id;
    updatePager(id);
    if (!L2) {
      $("#brName").textContent = "未找到该赛事";
      $("#brMeta").innerHTML = "";
      $("#brFocus").innerHTML = '<div class="br-now-next">换一个赛事，或回到 <a href="schedule.html">赛程中心</a>。</div>';
      $("#brRail").innerHTML = "";
      $("#brStageName").textContent = "未找到该赛事";
      $("#brStageMeta").textContent = "";
      $("#brMatchGrid").innerHTML = "";
      $("#brStandings").innerHTML = "";
      $("#brRules").innerHTML = "";
      return;
    }
    selectedStage = defaultStage(L2);
    stageShown = STAGE_LIMIT;
    document.title = L2.name + " 赛事进程 · KPL赛研";
    renderKpis(L2);
    renderEvent(L2);
    renderRail(L2);
    renderStageView(L2);
    renderStandings(L2);
    renderRules(L2);
  }

  function activate(id, scrollTop) {
    if (!OPTS.some(function (o) { return o.id === id; })) return;
    setUrl(id);
    render(id);
    if (scrollTop || window.scrollY > 180) {
      window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    }
  }

  function move(delta) {
    var i = optIndex[curId];
    if (i == null) return;
    var t = i + delta;
    if (t < 0 || t >= OPTS.length) return;
    activate(OPTS[t].id, true);
  }

  /* ---------- 交互 ---------- */
  function bind() {
    var sel = $("#brSel");
    if (sel) sel.addEventListener("change", function () { activate(sel.value, true); });
    var prev = $("#brPrev");
    var next = $("#brNext");
    if (prev) prev.addEventListener("click", function () { move(-1); });
    if (next) next.addEventListener("click", function () { move(1); });

    var rail = $("#brRail");
    if (rail) {
      rail.addEventListener("click", function (e) {
        var b = e.target.closest(".br-stage");
        if (!b) return;
        selectStage(Number(b.getAttribute("data-stage")), true);
      });
      rail.addEventListener("scroll", updateRailButtons, { passive: true });
      rail.addEventListener("wheel", function (e) {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
          e.preventDefault();
          rail.scrollLeft += e.deltaY;
        }
      }, { passive: false });
    }
    var railPrev = $("#brRailPrev");
    var railNext = $("#brRailNext");
    if (railPrev) railPrev.addEventListener("click", function () { scrollRail(-1); });
    if (railNext) railNext.addEventListener("click", function () { scrollRail(1); });

    var stagePrev = $("#brStagePrev");
    var stageNext = $("#brStageNext");
    if (stagePrev) stagePrev.addEventListener("click", function () { moveStage(-1); });
    if (stageNext) stageNext.addEventListener("click", function () { moveStage(1); });

    var more = $("#brStageMore");
    if (more) more.addEventListener("click", function () {
      stageShown += STAGE_LIMIT;
      var L2 = K.leagueInfo(curId);
      if (L2) renderStageView(L2);
    });

    var toBracket = $("#brToBracket");
    if (toBracket) toBracket.addEventListener("click", function (e) {
      e.preventDefault();
      var t = document.querySelector(toBracket.getAttribute("href") || "#brBracketSec");
      if (t) t.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    });

    var backTop = $("#brBackTop");
    if (backTop) backTop.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    });
    function onScroll() {
      if (backTop) backTop.classList.toggle("show", window.scrollY > 720);
      updateRailButtons();
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", updateRailButtons);
    onScroll();
  }

  /* ---------- 启动 ---------- */
  fillSel();
  var q = new URLSearchParams(location.search);
  var requested = q.get("id");
  var initial = requested && optIndex[requested] != null
    ? requested
    : (optIndex[K.currentLeagueId()] != null ? K.currentLeagueId() : (OPTS[0] && OPTS[0].id));
  if (!initial) {
    render("");
    return;
  }
  render(initial);
  if (initial !== requested) setUrl(initial);
  bind();
  var hash = String(location.hash || "").match(/^#stage-(\d+)$/);
  if (hash) selectStage(Number(hash[1]), true);
})();
