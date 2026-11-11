/* Shared replay pages UI: back-to-top + mobile table scroll hint. */
(function () {
  "use strict";

  function mount() {
    if (!document.querySelector(".replay-backtop")) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "replay-backtop";
      b.setAttribute("aria-label", "回到顶部");
      b.textContent = "↑";
      b.addEventListener("click", function () {
        var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
      });
      document.body.appendChild(b);
      function onScroll() { b.classList.toggle("show", window.scrollY > 700); }
      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
    }

    var scanFrame = 0;
    function scanTables() {
      if (scanFrame) return;
      scanFrame = requestAnimationFrame(function () {
        scanFrame = 0;
        Array.prototype.forEach.call(document.querySelectorAll(".rp-node-wrap"), function (w) {
          if (w.dataset.hint === "1") return;
          w.dataset.hint = "1";
          if (w.scrollWidth <= w.clientWidth + 4) return;
          var h = document.createElement("div");
          h.className = "rp-scroll-hint";
          h.textContent = "表格可左右滑动";
          w.insertAdjacentElement("afterend", h);
        });
      });
    }
    scanTables();
    new MutationObserver(scanTables).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
