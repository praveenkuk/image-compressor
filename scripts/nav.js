// Mobile menu toggle and tap-to-open Tools dropdown (all pages)
(function () {
  var bar = document.querySelector(".topbar");
  var toggle = document.querySelector(".menu-toggle");
  if (!bar || !toggle) return;

  function setOpen(open) {
    bar.classList.toggle("nav-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  }

  toggle.addEventListener("click", function () {
    setOpen(!bar.classList.contains("nav-open"));
  });

  // Tools dropdown: open on tap for touch screens (hover still works on desktop)
  document.querySelectorAll(".nav-menu-button").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      var menu = btn.closest(".nav-menu");
      var open = !menu.classList.contains("is-open");
      menu.classList.toggle("is-open", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  });

  document.addEventListener("click", function (e) {
    if (!bar.contains(e.target)) {
      setOpen(false);
      document.querySelectorAll(".nav-menu.is-open").forEach(function (m) { m.classList.remove("is-open"); });
    }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") setOpen(false);
  });

  bar.querySelectorAll(".nav a").forEach(function (a) {
    a.addEventListener("click", function () { setOpen(false); });
  });
})();
