/* 官方记录 / 经济面板：数据来自 assets/record/<matchId>.js（营地战报导出） */
(function () {
  "use strict";

  var CACHE = {};

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtInt(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function kFmt(v) {
    var n = Number(v) || 0;
    if (Math.abs(n) < 1000) return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(Math.round(n));
    return (n > 0 ? "+" : n < 0 ? "−" : "") + (Math.abs(n) / 1000).toFixed(1) + "k";
  }
  function isDark() { return document.documentElement.classList.contains("dark-site"); }
  function teamColors() {
    return isDark() ? { 1: "#6FA5FF", 2: "#FF7184" } : { 1: "#2F5BD7", 2: "#D8384F" };
  }
  function tagClass(tag) {
    return tag === "Buff" ? "buff" : tag === "打龙" ? "dragon" : tag === "推塔" ? "tower" : "equip";
  }
  function actOf(tag) {
    return tag === "推塔" ? "摧毁" : tag === "打龙" ? "击败" : tag === "Buff" ? "击杀" : "购买";
  }
  function lastLabel(tag) {
    return tag === "Buff" ? "击杀buff" : tag === "出装" ? "购买" : "最后一击";
  }
  function phaseOf(t) {
    t = Number(t) || 0;
    if (t < 240) return { key: "early", name: "对线期", range: "0–4′" };
    if (t < 600) return { key: "mid", name: "转线期", range: "4–10′" };
    if (t < 900) return { key: "late", name: "抱团期", range: "10–15′" };
    return { key: "end", name: "决胜期", range: "15′+" };
  }

  function load(matchId, cb) {
    if (CACHE[matchId]) return cb(CACHE[matchId]);
    var s = document.createElement("script");
    s.src = "assets/record/" + encodeURIComponent(matchId) + ".js?v=1";
    s.onload = function () {
      s.remove();
      CACHE[matchId] = window.KPL_RECORD || {};
      cb(CACHE[matchId]);
    };
    s.onerror = function () {
      s.remove();
      CACHE[matchId] = null;
      cb(null);
    };
    document.head.appendChild(s);
  }

  function iconHTML(url, name, size) {
    var initial = esc(String(name || "?").slice(0, 1));
    var img = url
      ? '<img class="rec-ico" src="' + esc(url) + '" alt="" onerror="this.style.display=\'none\'">'
      : "";
    return '<span class="rec-ico-wrap' + (size ? " " + size : "") + '">' +
      '<span class="rec-ico-fallback">' + initial + "</span>" + img + "</span>";
  }

  function filterCounts(records) {
    var c = { all: records.length, Buff: 0, "打龙": 0, "推塔": 0, "出装": 0 };
    records.forEach(function (r) { if (c[r.tag] != null) c[r.tag]++; });
    return c;
  }

  function teamBlock(camp, name, logo, gold, colors, reverse) {
    var color = colors[camp] || colors[1];
    var logoHTML = logo
      ? '<img src="' + esc(logo) + '" alt="" onerror="this.style.display=\'none\'">'
      : '<span class="rec-team-fallback">' + esc(String(name || "?").slice(0, 1)) + "</span>";
    var info = '<div class="rec-team-info"><b>' + esc(name) + "</b><em>终局经济 " +
      fmtInt(gold) + "</em></div>";
    var mark = '<span class="rec-team-logo" style="--tc:' + color + '">' + logoHTML + "</span>";
    return '<div class="rec-team-block' + (reverse ? " right" : "") + '">' +
      (reverse ? info + mark : mark + info) + "</div>";
  }

  function shell(b, teams, colors, opts) {
    var counts = filterCounts(b.records || []);
    var t1 = b.gold && b.gold.camp1, t2 = b.gold && b.gold.camp2;
    return '<div class="rec-panel">' +
      '<div class="rec-head">' +
        '<div class="rec-title"><b>对局记录</b><em>营地战报 · 最后一击与参与名单</em></div>' +
        '<div class="seg rec-tabs" id="recTabs">' +
          '<button type="button" data-tab="record" class="on">记录</button>' +
          '<button type="button" data-tab="economy">经济</button>' +
        "</div>" +
      "</div>" +
      '<div class="rec-teams">' +
        teamBlock(1, teams[1], opts.team1Logo, t1, colors, false) +
        '<div class="rec-final"><span>终局</span><em>VS</em></div>' +
        teamBlock(2, teams[2], opts.team2Logo, t2, colors, true) +
      "</div>" +
      '<div id="recPane-record">' +
        '<div class="rec-toolbar">' +
          '<div class="seg rec-filters" id="recFilters">' +
            filterBtn("all", "全部", counts.all, true) +
            filterBtn("Buff", "Buff", counts.Buff) +
            filterBtn("打龙", "打龙", counts["打龙"]) +
            filterBtn("推塔", "推塔", counts["推塔"]) +
            filterBtn("出装", "出装", counts["出装"]) +
          "</div>" +
          '<span class="rec-hint mono">点击事件查看参与名单</span>' +
        "</div>" +
        '<div class="rec-list" id="recList"></div>' +
      "</div>" +
      '<div id="recPane-economy" hidden>' +
        '<div class="rec-eco-cards" id="recEcoCards"></div>' +
        '<div class="rec-eco-phases"><span style="flex:4">前期 0–4′</span><span style="flex:6">中期 4–10′</span><span style="flex:10">后期 10–20′</span></div>' +
        '<div class="rec-chart" id="recChart"></div>' +
        '<div class="rec-eco-note mono" id="recEcoNote">悬停曲线查看该时刻的经济差与附近事件</div>' +
        '<div class="rec-eco-list" id="recEcoList"></div>' +
      "</div>" +
    "</div>";
  }

  function filterBtn(key, label, count, on) {
    return '<button type="button" data-f="' + key + '"' + (on ? ' class="on"' : "") + ">" +
      label + ' <b>' + count + "</b></button>";
  }

  function eventHTML(r, i, teams, colors, icons, openIdx) {
    var team = teams[r.camp] || ("camp" + r.camp);
    var color = colors[r.camp] || colors[1];
    var parts = r.participants || [];
    var last = parts.filter(function (x) { return x.is_last_hit; })[0];
    var share = last ? Number(last.damage_share) || 0 : 0;
    var isOpen = openIdx === i;
    var lastBadge = r.tag === "出装" ? "" :
      '<span class="rec-badge">' + esc(lastLabel(r.tag)) + "</span>";
    var sub = "";
    if (r.tag === "出装") {
      sub = '<span class="rec-parts">装备节点</span><span class="rec-subnote">仅记录后期保命装</span>';
    } else if (parts.length) {
      var mini = parts.slice(0, 4).map(function (x) {
        return iconHTML((icons && icons[x.hero]) || x.icon, x.hero, "mini");
      }).join("");
      if (parts.length > 4) mini += '<span class="rec-mini-more">+' + (parts.length - 4) + "</span>";
      sub = '<span class="rec-parts">' + parts.length + " 人参与</span>" +
        '<span class="rec-mini">' + mini + "</span>" +
        '<span class="rec-share"><i style="width:' + Math.max(0, Math.min(100, share * 100)) +
          "%;background:" + color + '"></i></span>' +
        '<b class="rec-pct">' + (share * 100).toFixed(1) + "%</b>";
    } else {
      sub = '<span class="rec-parts">无参与名单</span><span class="rec-subnote">仅最后一击</span>';
    }
    return '<div class="rec-event' + (isOpen ? " open" : "") + '">' +
      '<div class="rec-rail"><span class="rec-dot" style="background:' + color + '"></span></div>' +
      '<button type="button" class="rec-card" data-i="' + i + '" aria-expanded="' + (isOpen ? "true" : "false") + '">' +
        '<span class="rec-card-top">' +
          '<span class="rec-time mono">' + esc(r.mmss) + "</span>" +
          '<span class="rec-tag ' + tagClass(r.tag) + '">' + esc(r.tag) + "</span>" +
          '<span class="rec-team-name"><i style="background:' + color + '"></i>' + esc(team) + "</span>" +
          lastBadge +
          '<span class="rec-chev">›</span>' +
        "</span>" +
        '<span class="rec-card-main">' +
          '<span class="rec-hero">' + iconHTML((icons && icons[r.hero]) || r.hero_icon, r.hero) +
            "<b>" + esc(r.hero || "—") + "</b></span>" +
          '<span class="rec-act">' + esc(actOf(r.tag)) + "</span>" +
          '<span class="rec-target">' + esc(r.target || "—") + "</span>" +
        "</span>" +
        '<span class="rec-card-sub">' + sub + "</span>" +
      "</button>" +
      (isOpen ? detailHTML(r, teams, colors, icons) : "") +
    "</div>";
  }

  function detailHTML(r, teams, colors, icons) {
    var parts = r.participants || [];
    var rows = parts.length ? parts.map(function (x) {
      var team = teams[x.camp] || ("camp" + x.camp);
      var teamColor = colors[x.camp] || colors[1];
      var share = Math.max(0, Math.min(100, (Number(x.damage_share) || 0) * 100));
      return '<div class="rec-participant">' +
        '<span class="rec-avatar">' + iconHTML((icons && icons[x.hero]) || x.icon, x.hero) + "</span>" +
        '<span class="rec-p-meta"><b>' + esc(x.hero || "—") + "</b><em>" + esc(team) + "</em></span>" +
        '<span class="rec-p-bar"><i style="width:' + share + "%;background:" + teamColor + '"></i></span>' +
        '<b class="rec-p-pct">' + share.toFixed(1) + "%</b>" +
        (x.is_last_hit ? '<span class="rec-badge">' + esc(lastLabel(r.tag)) + "</span>" : "") +
      "</div>";
    }).join("") : '<div class="rec-empty">该事件没有参与名单，仅记录最后一击。</div>';
    return '<div class="rec-detail">' +
      '<div class="rec-detail-head"><span>参与名单</span>' +
        '<button type="button" class="rec-jump" data-t="' + esc(r.t) + '">在时间轴中查看 →</button></div>' +
      rows +
    "</div>";
  }

  function renderList(b, teams, colors, filter, openIdx, icons) {
    var box = document.getElementById("recList");
    if (!box) return;
    var rows = (b.records || []).filter(function (r) {
      return filter === "all" || r.tag === filter;
    });
    if (!rows.length) {
      box.innerHTML = '<div class="empty-tip">该分类暂无记录</div>';
      return;
    }
    var groups = [];
    rows.forEach(function (r, ri) {
      var p = phaseOf(r.t);
      var g = groups.filter(function (x) { return x.key === p.key; })[0];
      if (!g) { g = { key: p.key, name: p.name, range: p.range, items: [] }; groups.push(g); }
      g.items.push({ r: r, i: ri });
    });
    box.innerHTML = groups.map(function (g) {
      return '<section class="rec-phase">' +
        '<div class="rec-phase-head"><span>' + esc(g.name) + "</span><em>" + esc(g.range) +
          '</em><i>' + g.items.length + " 条</i></div>" +
        '<div class="rec-timeline">' +
          g.items.map(function (it) { return eventHTML(it.r, it.i, teams, colors, icons, openIdx); }).join("") +
        "</div></section>";
    }).join("");

    box.querySelectorAll(".rec-card").forEach(function (btn) {
      function toggle() {
        var i = parseInt(btn.getAttribute("data-i"), 10);
        var next = openIdx === i ? -1 : i;
        renderList(b, teams, colors, filter, next, icons);
        var opened = box.querySelector(".rec-event.open");
        if (opened) opened.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
      btn.addEventListener("click", toggle);
      btn.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); }
      });
    });
    box.querySelectorAll(".rec-jump").forEach(function (btn) {
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        var t = Number(btn.getAttribute("data-t"));
        if (window.KPL_REPLAY && KPL_REPLAY.jumpTo && isFinite(t)) {
          KPL_REPLAY.jumpTo(t / 60);
        }
      });
    });
  }

  function ecoDiffAt(b, t) {
    var pts = (b.economy && b.economy.points) || [];
    if (!pts.length) return 0;
    var i = Math.min(Math.max(0, Math.floor(Number(t) / 30)), pts.length - 1);
    return Number(pts[i].diff) || 0;
  }

  function renderEconomy(b, teams, colors) {
    var pts = (b.economy && b.economy.points) || [];
    var cards = document.getElementById("recEcoCards");
    var chart = document.getElementById("recChart");
    var list = document.getElementById("recEcoList");
    if (!cards || !chart || !list) return;
    if (!pts.length) {
      cards.innerHTML = "";
      chart.innerHTML = '<div class="empty-tip">本局暂无经济序列</div>';
      list.innerHTML = "";
      return;
    }
    var diffs = pts.map(function (p) { return Number(p.diff) || 0; });
    var maxLead = Math.max.apply(null, diffs);
    var maxBehind = Math.min.apply(null, diffs);
    var flips = 0;
    for (var i = 1; i < diffs.length; i++) {
      if ((diffs[i] > 0 && diffs[i - 1] < 0) || (diffs[i] < 0 && diffs[i - 1] > 0)) flips++;
    }
    cards.innerHTML =
      '<div><span>终局经济差</span><b style="color:' + (diffs[diffs.length - 1] >= 0 ? colors[1] : colors[2]) + '">' +
        kFmt(diffs[diffs.length - 1]) + "</b><em>" + (diffs[diffs.length - 1] >= 0 ? teams[1] : teams[2]) + "领先</em></div>" +
      '<div><span>最大领先</span><b style="color:' + colors[1] + '">' + kFmt(maxLead) + "</b><em>" + teams[1] + "</em></div>" +
      '<div><span>最大落后</span><b style="color:' + colors[2] + '">' + kFmt(maxBehind) + "</b><em>" + teams[2] + "</em></div>" +
      '<div><span>领先翻转</span><b>' + flips + " 次</b><em>经济差穿越 0 线</em></div>";

    var maxAbs = Math.max(1000, Math.abs(maxLead), Math.abs(maxBehind));
    var evs = (b.records || []).filter(function (r) { return r.tag === "打龙"; }).map(function (r) {
      return { m: Number(r.t) / 60, label: r.mmss + " " + r.hero + " " + r.target,
               color: colors[r.camp] || colors[1] };
    });
    var chartApi = window.KPL || window.K;
    if (chartApi && chartApi.lineChart) {
      chartApi.lineChart(chart, {
        height: 330,
        yTicks: 4,
        legend: false,
        yDomain: [-(maxAbs * 1.15), maxAbs * 1.15],
        yFmt: kFmt,
        xFmt: function (m) { return Math.round(m) + "′"; },
        refLines: [{ v: 0, label: "均势", color: isDark() ? "#8FA0B8" : "#64738B", opacity: .65 }],
        events: evs,
        series: [
          { name: "经济差", bars: true, color: colors[1],
            barColors: { pos: colors[1], neg: colors[2] }, opacity: .82,
            pts: pts.map(function (p) { return [Number(p.t) / 60, Number(p.diff) || 0]; }) },
          { name: "趋势", color: isDark() ? "#E8EEF7" : "#12203A", width: 1.4,
            opacity: .42, noTip: true,
            pts: pts.map(function (p) { return [Number(p.t) / 60, Number(p.diff) || 0]; }) }
        ],
        onHover: function (d) {
          var note = document.getElementById("recEcoNote");
          if (!note) return;
          var t = Number(d.m) * 60;
          var near = (b.records || []).filter(function (r) {
            return Math.abs(Number(r.t) - t) <= 30;
          }).slice(0, 3);
          note.textContent = "第 " + Math.round(d.m) + " 分钟 · 经济差 " + kFmt(ecoDiffAt(b, t)) +
            (near.length ? " · " + near.map(function (r) { return r.mmss + " " + r.target; }).join(" / ") : "");
        }
      });
    } else {
      chart.innerHTML = '<div class="empty-tip">图表组件未加载</div>';
    }

    var key = (b.records || []).filter(function (r) {
      return r.tag === "打龙" || r.tag === "推塔";
    }).slice(0, 14);
    list.innerHTML = key.length ? key.map(function (r) {
      var diff = ecoDiffAt(b, r.t);
      var perf = diff > 0 ? "领先" : diff < 0 ? "落后" : "持平";
      var team = teams[r.camp] || ("camp" + r.camp);
      return '<div class="rec-eco-row">' +
        '<span class="mono">' + esc(r.mmss) + "</span>" +
        '<span class="rec-tag ' + tagClass(r.tag) + '">' + esc(r.tag) + "</span>" +
        '<span><i class="rec-dot" style="background:' + (colors[r.camp] || colors[1]) + '"></i>' +
          esc(team) + " " + esc(r.hero) + " " + esc(r.target) + "</span>" +
        '<b class="mono">' + kFmt(diff) + "</b>" +
        '<em>' + esc(perf) + "</em>" +
      "</div>";
    }).join("") : '<div class="empty-tip">暂无关键事件</div>';
  }

  function mount(el, opts) {
    if (!el) return;
    opts = opts || {};
    el.innerHTML = '<div class="rec-loading mono">加载营地记录…</div>';
    load(opts.matchId, function (all) {
      var b = all && all[opts.battleId];
      if (!b) { el.innerHTML = ""; el.hidden = true; return; }
      el.hidden = false;
      var teams = { 1: opts.team1 || "蓝方", 2: opts.team2 || "红方" };
      var colors = teamColors();
      var icons = opts.heroIcon || {};
      var state = { tab: "record", filter: "all", open: -1 };
      el.innerHTML = shell(b, teams, colors, opts);

      function renderAll() {
        renderList(b, teams, colors, state.filter, state.open, icons);
      }
      renderAll();
      renderEconomy(b, teams, colors);

      var tabs = document.getElementById("recTabs");
      if (tabs) {
        tabs.addEventListener("click", function (e) {
          var btn = e.target.closest("button"); if (!btn) return;
          state.tab = btn.getAttribute("data-tab") || "record";
          Array.prototype.forEach.call(tabs.children, function (x) { x.classList.toggle("on", x === btn); });
          var rec = document.getElementById("recPane-record");
          var eco = document.getElementById("recPane-economy");
          if (rec) rec.hidden = state.tab !== "record";
          if (eco) eco.hidden = state.tab !== "economy";
        });
      }
      var filters = document.getElementById("recFilters");
      if (filters) {
        filters.addEventListener("click", function (e) {
          var btn = e.target.closest("button"); if (!btn) return;
          state.filter = btn.getAttribute("data-f") || "all";
          state.open = -1;
          Array.prototype.forEach.call(filters.children, function (x) { x.classList.toggle("on", x === btn); });
          renderAll();
        });
      }
    });
  }

  window.KPL_RECORD_UI = { mount: mount };
})();
