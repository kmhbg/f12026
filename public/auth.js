// Gemensam inloggningskontroll för alla sidor. Laddas före sidans eget skript.
// - Skickar till /setup.html vid första start och /login.html om du inte är inloggad.
// - Visar inloggad användare, konto- och utloggningslänk i sidhuvudet.
// - window.F1Auth.ready ger den inloggade användaren.
(function () {
  const PUBLIC_PAGES = ["/login.html", "/setup.html", "/invite.html", "/app-installation.html"];
  const path = window.location.pathname;
  const isPublicPage = PUBLIC_PAGES.includes(path);

  function goLogin() {
    const next = encodeURIComponent(path + window.location.search);
    window.location.replace(`/login.html?next=${next}`);
  }

  // Utgången session mitt i användningen ger 401 från API:et → till inloggningen.
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await originalFetch(input, init);
    const url = typeof input === "string" ? input : input.url;
    if (res.status === 401 && !isPublicPage && /\/api\//.test(url) && !/\/api\/auth\//.test(url)) {
      goLogin();
    }
    return res;
  };

  function renderHeader(user) {
    const actions = document.querySelector(".header-top-actions");
    if (!actions) return;
    const wrap = document.createElement("span");
    wrap.className = "header-user";
    const name = document.createElement("span");
    name.className = "header-user-name";
    name.textContent = user.name;
    wrap.appendChild(name);
    const links = [["Konto", "/account.html"]];
    if (user.role === "admin") links.unshift(["Admin", "/admin.html"]);
    links.forEach(([label, href]) => {
      const a = document.createElement("a");
      a.href = href;
      a.className = "header-cta-pill";
      a.textContent = label;
      wrap.appendChild(a);
    });
    const logout = document.createElement("button");
    logout.type = "button";
    logout.className = "header-cta-pill header-logout";
    logout.textContent = "Logga ut";
    logout.addEventListener("click", async () => {
      await originalFetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      window.location.replace("/login.html");
    });
    wrap.appendChild(logout);
    actions.prepend(wrap);
  }

  const ready = (async () => {
    const res = await originalFetch("/api/auth/me");
    const data = await res.json().catch(() => ({}));
    if (isPublicPage) return data.user || null;
    if (data.needsSetup) {
      window.location.replace("/setup.html");
      return new Promise(() => {});
    }
    if (!data.user) {
      goLogin();
      return new Promise(() => {});
    }
    if (document.body.dataset.requireAdmin === "true" && data.user.role !== "admin") {
      window.location.replace("/index.html");
      return new Promise(() => {});
    }
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => renderHeader(data.user));
    } else {
      renderHeader(data.user);
    }
    return data.user;
  })();

  window.F1Auth = { ready };
})();
