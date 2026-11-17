// Keeps the page's colour-scheme and theme-color tags (set in base.html) in step
// with the chosen theme, so Safari's bars and the browser's own controls match the
// page after a change in Settings, not only on the next load.
(function () {
  "use strict";
  const DARK = "#070605";
  const LIGHT = "#f2f0ea";

  function meta(name, attrs) {
    const el = document.createElement("meta");
    el.name = name;
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.head.appendChild(el);
  }

  function sync() {
    const theme = document.body.dataset.theme;
    document.head.querySelectorAll('meta[name="theme-color"], meta[name="color-scheme"]').forEach((m) => m.remove());
    if (theme === "dark" || theme === "light") {
      meta("color-scheme", { content: theme });
      meta("theme-color", { content: theme === "dark" ? DARK : LIGHT });
    } else {
      meta("color-scheme", { content: "dark light" });
      meta("theme-color", { media: "(prefers-color-scheme: dark)", content: DARK });
      meta("theme-color", { media: "(prefers-color-scheme: light)", content: LIGHT });
    }
  }

  let last = document.body.dataset.theme;
  new MutationObserver(() => {
    if (document.body.dataset.theme === last) return;
    last = document.body.dataset.theme;
    sync();
  }).observe(document.body, { attributes: true, attributeFilter: ["data-theme"] });
})();
