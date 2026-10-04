// Formulär för inloggning, första start, inbjudan och lösenordsbyte.
(function () {
  const $ = (id) => document.getElementById(id);
  const page = document.body.dataset.page;

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Något gick fel");
    return data;
  }

  function nextUrl() {
    const next = new URLSearchParams(window.location.search).get("next") || "/index.html";
    return next.startsWith("/") && !next.startsWith("//") ? next : "/index.html";
  }

  function bind(formId, handler) {
    const form = $(formId);
    if (!form) return;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const status = $("form-status");
      status.textContent = "";
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await handler(new FormData(form));
      } catch (err) {
        status.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });
  }

  function checkRepeat(fd) {
    if (fd.get("password") !== fd.get("password2")) throw new Error("Lösenorden matchar inte");
  }

  if (page === "login" || page === "setup") {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (page === "setup") {
          // Registreringen är öppen så länge appen saknar admin, även för inloggade.
          if (!d.needsSetup) window.location.replace(d.user ? nextUrl() : "/login.html");
          else if (d.setupTokenRequired) {
            $("setup-token-field").classList.remove("hidden");
            $("setupToken").required = true;
          }
        } else if (d.needsSetup) window.location.replace("/setup.html");
        else if (d.user) window.location.replace(nextUrl());
      });
  }

  if (page === "login") {
    bind("login-form", async (fd) => {
      await postJson("/api/auth/login", { username: fd.get("username"), password: fd.get("password") });
      window.location.replace(nextUrl());
    });
  }

  if (page === "setup") {
    bind("setup-form", async (fd) => {
      checkRepeat(fd);
      await postJson("/api/auth/setup", {
        name: fd.get("name"),
        username: fd.get("username"),
        password: fd.get("password"),
        setupToken: fd.get("setupToken") || undefined
      });
      window.location.replace("/admin.html");
    });
  }

  if (page === "invite") {
    const token = window.location.hash.slice(1);
    fetch(`/api/auth/invite/${encodeURIComponent(token)}`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) {
          $("invite-intro").textContent = d.error || "Länken är ogiltig.";
          $("invite-form").classList.add("hidden");
          return;
        }
        $("invite-intro").textContent = `Hej ${d.user.name}! Välj ett lösenord. Ditt användarnamn är "${d.user.id}".`;
      });
    bind("invite-form", async (fd) => {
      checkRepeat(fd);
      await postJson(`/api/auth/invite/${encodeURIComponent(token)}`, { password: fd.get("password") });
      window.location.replace("/index.html");
    });
  }

  if (page === "account") {
    window.F1Auth.ready.then((user) => {
      $("account-name").textContent = `${user.name} (${user.id})`;
    });
    bind("password-form", async (fd) => {
      checkRepeat(fd);
      await postJson("/api/auth/password", { currentPassword: fd.get("current"), newPassword: fd.get("password") });
      $("form-status").textContent = "Lösenordet är bytt.";
    });
  }
})();
