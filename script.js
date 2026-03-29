(function () {
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  var CHANNEL_NAMES = ["Intro", "Profile", "Expertise", "Projects", "Experience", "Education", "Contact"];

  function updateChannelReadout(index) {
    var numEl = document.getElementById("scopeChNum");
    var nameEl = document.getElementById("scopeChName");
    var n = Math.max(0, Math.min(CHANNEL_NAMES.length - 1, index));
    if (numEl) numEl.textContent = String(n + 1);
    if (nameEl) nameEl.textContent = CHANNEL_NAMES[n];
  }

  function applyScopeChannelIndex(index) {
    if (typeof window.setScopeChannel === "function") {
      window.setScopeChannel(index);
    } else if (document.body) {
      document.body.setAttribute("data-scope-active", String(index));
    }
  }

  var scopeScheduled = false;
  function updateScopeChannel() {
    scopeScheduled = false;
    var vh = window.innerHeight;
    var sections = document.querySelectorAll("[data-scope-channel]");
    if (!sections.length) return;

    var bestIdx = 0;
    var bestScore = -1;
    var i;
    for (i = 0; i < sections.length; i++) {
      var el = sections[i];
      var r = el.getBoundingClientRect();
      var visibleTop = Math.max(0, r.top);
      var visibleBottom = Math.min(vh, r.bottom);
      var visible = Math.max(0, visibleBottom - visibleTop);
      var mid = (r.top + r.bottom) * 0.5;
      var centerDist = Math.abs(mid - vh * 0.45);
      var score = visible * (1 - Math.min(1, centerDist / (vh * 0.65)));
      if (score > bestScore) {
        bestScore = score;
        bestIdx = parseInt(el.getAttribute("data-scope-channel"), 10) || 0;
      }
    }

    applyScopeChannelIndex(bestIdx);
    updateChannelReadout(bestIdx);
  }

  function scheduleScopeChannel() {
    if (scopeScheduled) return;
    scopeScheduled = true;
    requestAnimationFrame(updateScopeChannel);
  }

  window.addEventListener("scroll", scheduleScopeChannel, { passive: true });
  window.addEventListener("resize", scheduleScopeChannel, { passive: true });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateScopeChannel);
  } else {
    updateScopeChannel();
  }

  document.addEventListener("scope:channel", function (e) {
    if (e.detail && typeof e.detail.index === "number") {
      updateChannelReadout(e.detail.index);
    }
  });

  var header = document.querySelector(".site-header");
  function onScroll() {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 24);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  var menuBtn = document.getElementById("menuBtn");
  var nav = document.getElementById("nav");
  if (menuBtn && nav) {
    menuBtn.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      menuBtn.classList.toggle("is-open", open);
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
      menuBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    });
    nav.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", function () {
        nav.classList.remove("is-open");
        menuBtn.classList.remove("is-open");
        menuBtn.setAttribute("aria-expanded", "false");
        menuBtn.setAttribute("aria-label", "Open menu");
      });
    });
  }

  var reveals = document.querySelectorAll("[data-reveal]");
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add("is-visible");
            io.unobserve(e.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );
    reveals.forEach(function (el) {
      io.observe(el);
    });
  } else {
    reveals.forEach(function (el) {
      el.classList.add("is-visible");
    });
  }
})();
