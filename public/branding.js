// Appnamn och säsong från servern (APP_NAME, SEASON_YEAR), så att HTML-sidorna
// inte har gruppens namn eller årtal hårdkodat. HTML:en innehåller standardvärdena.
(function () {
  const DEFAULT_NAME = "F1tting";
  const DEFAULT_YEAR = "2026";

  function logoHtml(name) {
    const escape = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    return /^F1/i.test(name)
      ? `<span class="logo-f1">${escape(name.slice(0, 2))}</span><span class="logo-rest">${escape(name.slice(2)).replace(/^ /, "&nbsp;")}</span>`
      : `<span class="logo-rest">${escape(name)}</span>`;
  }

  function apply({ appName, seasonYear }) {
    const name = String(appName || DEFAULT_NAME);
    const year = String(seasonYear || DEFAULT_YEAR);
    const swap = (text) => text.replace(/F1tting|F1 Betting/g, name).replace(new RegExp(DEFAULT_YEAR, "g"), year);

    document.title = swap(document.title);
    document.querySelectorAll(".header-tag").forEach((el) => {
      el.textContent = `Säsong ${year} · ${name}`;
    });
    document.querySelectorAll(".logo-mark, .footer-logo-mark").forEach((el) => {
      el.innerHTML = logoHtml(name);
    });
    document.querySelectorAll(".site-logo").forEach((el) => el.setAttribute("aria-label", `${name} startsida`));
    document.querySelectorAll(".footer-copy, .footer-download-title").forEach((el) => {
      el.textContent = swap(el.textContent);
    });
  }

  fetch("/api/config")
    .then((r) => (r.ok ? r.json() : null))
    .then((config) => {
      if (!config) return;
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => apply(config));
      else apply(config);
    })
    .catch(() => {});
})();
