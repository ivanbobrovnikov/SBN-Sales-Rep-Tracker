// The deal-closed banner's styling travels WITH the page code, so it can't be left unstyled if an older style.css is served.
(function installBannerStyles() {
  if (document.getElementById("banner-css")) return;
  const style = document.createElement("style");
  style.id = "banner-css";
  style.textContent = `/* "Deal closed!" announcement on the leaderboard TV */
@keyframes dealSlide { from { transform: translateY(-120%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
.deal-banner { margin: 16px auto 0; max-width: 920px; padding: 18px 28px; border-radius: 16px; text-align: center; color: #fff;
  background: linear-gradient(90deg, #1b7a3c, #2fbf5f); font-size: 30px; font-weight: 600; letter-spacing: 0.01em;
  box-shadow: 0 10px 34px rgba(0, 0, 0, 0.5); animation: dealSlide 0.45s ease-out; }`;
  document.head.appendChild(style);
})();

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || "Something went wrong."); err.data = data; err.status = res.status; throw err; }
  return data;
}

function money(n) { return "$" + (Math.round((n || 0) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "text") node.textContent = v;
    else if (k === "onclick") node.addEventListener("click", v);
    else if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  });
  children.forEach((c) => { if (c) node.appendChild(c); });
  return node;
}

function formatDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

let session = { loggedIn: false, needsSetup: false };
let currentTab = "combined";
let statsCache = null;

async function boot() {
  session = await api("/api/session");
  render();
}

function stopLeaderboardPolling() {
  if (window._leaderboardInterval) { clearInterval(window._leaderboardInterval); window._leaderboardInterval = null; }
  if (window._rokuTimer) { clearInterval(window._rokuTimer); window._rokuTimer = null; }
}

function render() {
  stopLeaderboardPolling();
  const app = document.getElementById("app");
  app.innerHTML = "";
  document.querySelectorAll(".bottom-tabs").forEach((n) => n.remove());

  if (!session.loggedIn) {
    renderLogin(app);
    return;
  }

  if (currentTab === "leaderboard") {
    renderLeaderboard(app);
    return;
  }

  app.appendChild(el("div", { class: "header" }, [
    el("div", { class: "title oswald", text: "SBN Combined Rep Tracker" }),
  ]));

  const content = el("div", {});
  app.appendChild(content);
  renderPage(content);

  const bar = el("div", { class: "bottom-tabs" });
  [["combined", "Combined", "📊"], ["audit", "Audit", "🧾"], ["leaderboard", "Leaderboard", "🏆"], ["cleanup", "Cleanup", "🧹"], ["settings", "Settings", "⚙️"]].forEach(([key, label, icon]) => {
    bar.appendChild(el("button", {
      class: "bottom-tab" + (currentTab === key ? " active" : ""),
      onclick: () => { currentTab = key; render(); },
    }, [
      el("div", { class: "tab-icon", text: icon }),
      el("div", { text: label }),
    ]));
  });
  document.body.appendChild(bar);
}

function renderLogin(app) {
  const wrap = el("div", { style: "max-width:340px;margin:80px auto;padding:0 16px" });
  wrap.appendChild(el("div", { class: "title oswald", style: "margin-bottom:20px;text-align:center", text: "SBN Combined Rep Tracker" }));
  const passInput = el("input", { type: "password", placeholder: session.needsSetup ? "Create a password" : "Password" });
  const notice = el("div", { class: "notice" });
  const submit = async () => {
    try {
      if (session.needsSetup) await api("/api/setup/owner-password", { method: "POST", body: JSON.stringify({ password: passInput.value }) });
      else await api("/api/login", { method: "POST", body: JSON.stringify({ password: passInput.value }) });
      session.loggedIn = true;
      render();
    } catch (e) {
      notice.textContent = e.message;
      notice.style.color = "var(--red)";
    }
  };
  passInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  wrap.appendChild(el("div", { class: "field" }, [
    el("label", { text: session.needsSetup ? "Set a password for this tool" : "Password" }),
    passInput,
  ]));
  wrap.appendChild(el("button", { class: "primary", style: "width:100%", onclick: submit, text: session.needsSetup ? "Set password" : "Log in" }));
  wrap.appendChild(notice);
  app.appendChild(wrap);
}

function renderPage(content) {
  if (currentTab === "combined") return renderCombined(content);
  if (currentTab === "audit") return renderAudit(content);
  if (currentTab === "cleanup") return renderCleanup(content);
  if (currentTab === "settings") return renderSettings(content);
}

async function renderSettings(content) {
  const list = el("div", { style: "margin-bottom:16px" });
  async function loadList() {
    const locs = await api("/api/locations");
    list.innerHTML = "";
    if (locs.length === 0) list.appendChild(el("div", { class: "muted", text: "No locations added yet." }));
    locs.forEach((loc) => {
      list.appendChild(el("div", { class: "card row" }, [
        el("div", {}, [
          el("div", { style: "font-weight:500", text: loc.name }),
          el("div", { class: "muted", style: "font-size:12px", text: loc.url }),
        ]),
        el("button", { class: "icon-danger", onclick: async () => { await api(`/api/locations/${loc.id}`, { method: "DELETE" }); statsCache = null; loadList(); }, text: "Remove" }),
      ]));
    });
  }

  const nameInput = el("input", { placeholder: "Location name (e.g. NJ, Philly, Sunrise)" });
  const urlInput = el("input", { placeholder: "https://your-tracker.up.railway.app" });
  const secretInput = el("input", { placeholder: "That location's CROSS_LOCATION_SECRET" });
  const notice = el("div", { class: "notice" });

  content.appendChild(el("div", { class: "muted", style: "margin-bottom:12px", text: "LOCATIONS BEING COMBINED" }));
  content.appendChild(list);
  content.appendChild(el("div", { class: "card" }, [
    el("div", { style: "font-weight:500;margin-bottom:10px", text: "Add a location" }),
    el("div", { class: "field" }, [el("label", { text: "Name" }), nameInput]),
    el("div", { class: "field" }, [el("label", { text: "Tracker URL" }), urlInput]),
    el("div", { class: "field" }, [el("label", { text: "Cross-location secret" }), secretInput]),
    el("div", { class: "muted", style: "font-size:11px;margin-bottom:10px", text: "This is that location's own CROSS_LOCATION_SECRET environment variable - not its GHL webhook secret." }),
    el("button", { class: "primary", onclick: async () => {
      if (!nameInput.value.trim() || !urlInput.value.trim() || !secretInput.value.trim()) { notice.textContent = "All three fields are required."; notice.style.color = "var(--red)"; return; }
      try {
        await api("/api/locations", { method: "POST", body: JSON.stringify({ name: nameInput.value, url: urlInput.value, secret: secretInput.value }) });
        nameInput.value = ""; urlInput.value = ""; secretInput.value = "";
        notice.textContent = "Added ✓"; notice.style.color = "var(--green)";
        statsCache = null;
        loadList();
      } catch (e) {
        notice.textContent = e.message; notice.style.color = "var(--red)";
      }
    }, text: "Add location" }),
    notice,
  ]));

  await loadList();

  // ---------- Sales Goals ----------
  content.appendChild(el("div", { class: "muted", style: "margin:24px 0 12px", text: "SALES GOALS" }));
  const goalsList = el("div", { style: "margin-bottom:16px" });
  const repSelect = el("select", {});
  const metricSelect = el("select", {}, [
    el("option", { value: "commission", text: "Commission ($)" }),
    el("option", { value: "value", text: "Closed value ($)" }),
    el("option", { value: "closes", text: "Number of closes" }),
  ]);
  const cadenceSelect = el("select", {}, [
    el("option", { value: "week", text: "Weekly" }),
    el("option", { value: "month", text: "Monthly" }),
  ]);
  const targetInput = el("input", { type: "number", placeholder: "Target" });
  const goalNotice = el("div", { class: "notice" });

  async function loadGoals() {
    // Pull real rep names from a broad stats fetch, so the dropdown can't have a typo
    // that silently fails to match anyone on the Combined page later.
    let repNames = [];
    try {
      const stats = await api("/api/combined/salesrep-stats?period=year&date=" + new Date().getFullYear() + "-01-01");
      repNames = stats.perRep.map((r) => r.name);
    } catch (e) { /* if stats can't load, the dropdown just stays empty - goal creation will still work once it can */ }
    repSelect.innerHTML = "";
    if (repNames.length === 0) repSelect.appendChild(el("option", { value: "", text: "No reps found yet" }));
    repNames.forEach((name) => repSelect.appendChild(el("option", { value: name, text: name })));

    const goals = await api("/api/goals");
    goalsList.innerHTML = "";
    if (goals.length === 0) goalsList.appendChild(el("div", { class: "muted", text: "No goals set yet." }));
    const metricLabel = { commission: "commission", value: "closed value", closes: "closes" };
    goals.forEach((g) => {
      goalsList.appendChild(el("div", { class: "card row" }, [
        el("span", { style: "font-size:13px", text: `${g.repName} — ${g.cadence === "week" ? "Weekly" : "Monthly"} ${metricLabel[g.metric]}: ${g.metric === "closes" ? g.target : money(g.target)}` }),
        el("button", { class: "icon-danger", onclick: async () => { await api(`/api/goals/${g.id}`, { method: "DELETE" }); loadGoals(); }, text: "Remove" }),
      ]));
    });
  }

  content.appendChild(goalsList);
  content.appendChild(el("div", { class: "card" }, [
    el("div", { style: "font-weight:500;margin-bottom:10px", text: "Set a goal" }),
    el("div", { class: "field" }, [el("label", { text: "Sales rep" }), repSelect]),
    el("div", { class: "field" }, [el("label", { text: "Metric" }), metricSelect]),
    el("div", { class: "field" }, [el("label", { text: "Cadence" }), cadenceSelect]),
    el("div", { class: "field" }, [el("label", { text: "Target" }), targetInput]),
    el("button", { class: "primary", onclick: async () => {
      if (!repSelect.value || !targetInput.value) { goalNotice.textContent = "Pick a rep and enter a target."; goalNotice.style.color = "var(--red)"; return; }
      try {
        await api("/api/goals", { method: "POST", body: JSON.stringify({ repName: repSelect.value, metric: metricSelect.value, cadence: cadenceSelect.value, target: targetInput.value }) });
        targetInput.value = "";
        goalNotice.textContent = "Saved ✓"; goalNotice.style.color = "var(--green)";
        loadGoals();
      } catch (e) { goalNotice.textContent = e.message; goalNotice.style.color = "var(--red)"; }
    }, text: "Set goal" }),
    goalNotice,
  ]));
  await loadGoals();

  // ---- Rep sounds ----
  content.appendChild(el("div", { class: "muted", style: "margin:24px 0 12px", text: "REP SOUNDS" }));
  const repSoundsBox = el("div", { class: "card" });
  content.appendChild(repSoundsBox);
  async function loadRepSounds() {
    let reps = [], assigned = [], sounds = [];
    try {
      const r = await api("/api/combined/salesreps"), seen = new Map();
      r.locations.forEach((l) => (l.salesReps || []).forEach((s) => { const k = repKeyOf(s.name); if (k && !seen.has(k)) seen.set(k, String(s.name).trim().replace(/\s+/g, " ")); }));   // the same person at two locations is one rep
      reps = Array.from(seen.values()).sort((x, y) => x.localeCompare(y));
    } catch (e) { /* locations unreachable: the list just stays empty */ }
    try { assigned = await api("/api/rep-sounds"); } catch (e) { /* none yet */ }
    try { sounds = await api("/api/sounds"); } catch (e) { /* none yet */ }
    const choiceOf = (name) => { const a = assigned.find((x) => x.key === repKeyOf(name)); if (!a) return "default"; if (DEAL_SOUNDS[a.choice]) return a.choice; return sounds.some((s) => "custom:" + s.id === a.choice) ? a.choice : "default"; };
    while (repSoundsBox.firstChild) repSoundsBox.removeChild(repSoundsBox.firstChild);
    repSoundsBox.appendChild(el("div", { class: "muted", style: "font-size:12.5px;margin-bottom:12px", text: "When a rep closes a deal, their sound plays on the leaderboard instead of the usual one. Reps left on Default use whatever each screen is set to. A screen set to Off stays silent." }));
    if (reps.length === 0) repSoundsBox.appendChild(el("div", { class: "muted", text: "No reps found yet. They show up here once your locations are connected and have sales reps." }));
    reps.forEach((name) => {
      const sel = el("select", { style: "flex:1;min-width:150px" });
      sel.appendChild(el("option", { value: "default", text: "Default (the screen's choice)" }));
      Object.entries(DEAL_SOUNDS).forEach(([k, d]) => sel.appendChild(el("option", { value: k, text: d.name })));
      if (sounds.length) { const g = document.createElement("optgroup"); g.label = "My sounds"; sounds.forEach((s) => g.appendChild(el("option", { value: "custom:" + s.id, text: "🎵 " + s.name }))); sel.appendChild(g); }
      sel.value = choiceOf(name);
      let saved = sel.value;
      const status = el("span", { style: "font-size:11.5px;min-width:64px;text-align:right" });
      const play = el("button", { class: "ghost", style: "padding:2px 10px", title: "Hear it", text: "▶", onclick: () => wakeDealAudio(() => previewRepSound(sel.value)) });
      const showPlay = () => { play.style.visibility = sel.value === "default" ? "hidden" : "visible"; };
      showPlay();
      sel.addEventListener("change", async () => {
        try {
          await api("/api/rep-sounds", { method: "PUT", body: JSON.stringify({ name, choice: sel.value }) });
          saved = sel.value; status.textContent = "Saved ✓"; status.style.color = "var(--green)"; showPlay();
          if (sel.value !== "default") wakeDealAudio(() => previewRepSound(sel.value));   // so you hear what you just chose
        } catch (e) { sel.value = saved; showPlay(); status.textContent = "Not saved"; status.style.color = "var(--red)"; }
      });
      repSoundsBox.appendChild(el("div", { style: "margin-bottom:12px" }, [
        el("div", { style: "font-size:13px;margin-bottom:4px", text: name }),
        el("div", { class: "row", style: "gap:6px;align-items:center" }, [sel, play, status]),
      ]));
    });
    if (reps.length && sounds.length === 0) repSoundsBox.appendChild(el("div", { class: "muted", style: "font-size:11.5px", text: "Want your own sounds in this list? Add them from the 🔊 panel on the Leaderboard (bottom-right)." }));
  }
  loadRepSounds();

  // ---- Rep photos ----
  content.appendChild(el("div", { class: "muted", style: "margin:24px 0 12px", text: "REP PHOTOS" }));
  const photosBox = el("div", { class: "card" });
  content.appendChild(photosBox);
  const initialsOf = (name) => { const w = String(name).trim().split(/\s+/).filter(Boolean).map((x) => Array.from(x)[0]); return (w.length > 1 ? w[0] + w[w.length - 1] : (w[0] || "?")).toUpperCase(); };
  // `msg` is shown AFTER the list is redrawn (a message written before the redraw would land on the old, discarded copy)
  async function loadRepPhotos(msg) {
    let reps = [], photos = [];
    try {
      const r = await api("/api/combined/salesreps"), seen = new Map();
      r.locations.forEach((l) => (l.salesReps || []).forEach((s) => { const k = repKeyOf(s.name); if (k && !seen.has(k)) seen.set(k, String(s.name).trim().replace(/\s+/g, " ")); }));
      reps = Array.from(seen.values()).sort((x, y) => x.localeCompare(y));
    } catch (e) { /* locations unreachable: the list just stays empty */ }
    try { photos = await api("/api/rep-photos"); } catch (e) { /* none yet */ }
    while (photosBox.firstChild) photosBox.removeChild(photosBox.firstChild);
    const note = el("div", { style: "font-size:12.5px;min-height:16px;margin-bottom:10px", class: "muted" });
    const say = (text, color) => { note.textContent = text; note.style.color = color || "var(--sub)"; };
    photosBox.appendChild(el("div", { class: "muted", style: "font-size:12.5px;margin-bottom:10px", text: "A photo for each rep, shown in the circle next to their name on the Roku TV (a rep without one shows their initials). Pick a picture, line their face up in the circle, and save. The TV picks up changes within about 15 seconds." }));
    photosBox.appendChild(note);
    if (reps.length === 0) photosBox.appendChild(el("div", { class: "muted", text: "No reps found yet. They show up here once your locations are connected and have sales reps." }));
    reps.forEach((name) => {
      const mine = photos.find((p) => p.key === repKeyOf(name));
      const holder = el("div");
      const fileInput = el("input", { type: "file", accept: "image/*", style: "display:none" });
      const thumb = mine
        ? el("img", { src: "/api/rep-photos/" + mine.id, alt: name, style: "width:56px;height:56px;border-radius:50%;object-fit:cover;flex:none" })
        : el("div", { style: "width:56px;height:56px;border-radius:50%;background:var(--panel);display:flex;align-items:center;justify-content:center;font-weight:600;flex:none", text: initialsOf(name) });
      const head = el("div", { class: "row", style: "gap:12px;align-items:center" }, [thumb, el("div", { style: "flex:1;font-size:14px", text: name }),
        el("button", { class: "ghost", text: mine ? "Change" : "Add photo", onclick: () => fileInput.click() })]);
      if (mine) head.appendChild(el("button", { class: "ghost", text: "Remove", onclick: async () => {
        if (!confirm(`Remove ${name}'s photo? The TV goes back to showing their initials.`)) return;
        try { await api("/api/rep-photos?name=" + encodeURIComponent(name), { method: "DELETE" }); await loadRepPhotos({ text: `Removed ${name}'s photo.`, color: "var(--amber)" }); } catch (e) { say(e.message || "Couldn't remove it.", "var(--red)"); }
      } }));
      fileInput.addEventListener("change", () => { const f = fileInput.files && fileInput.files[0]; if (f) openPhotoEditor(holder, name, f, say); fileInput.value = ""; });
      photosBox.appendChild(el("div", { style: "margin-bottom:14px" }, [head, fileInput, holder]));
    });
    if (msg) say(msg.text, msg.color);
  }
  // The editor: shows the picture in the circle it will have on the TV, with sliders to zoom and move it. The result is cut into a circle and shrunk to a
  // small PNG here in the browser before it is sent, so what the tracker stores is always tiny.
  async function openPhotoEditor(holder, name, file, say) {
    while (holder.firstChild) holder.removeChild(holder.firstChild);
    if (file.size > 25 * 1024 * 1024) { say("That picture is very large (over 25 MB). Pick a smaller one.", "var(--red)"); return; }
    let img;
    try { img = await createImageBitmap(file); } catch (e) {
      try { img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); }); }
      catch (e2) { say("This browser couldn't read that picture. Try a JPEG or PNG.", "var(--red)"); return; }
    }
    const w = img.width, h = img.height;
    if (!w || !h || Math.min(w, h) < 64) { say("That picture is too small (it needs to be at least 64 pixels across).", "var(--red)"); return; }
    say("", "var(--sub)");
    const state = { zoom: 1, px: 0, py: h > w ? -0.4 : 0 };      // a tall picture starts a little toward the top, where faces usually are
    const draw = (canvas, N) => {
      const ctx = canvas.getContext("2d"); ctx.clearRect(0, 0, N, N); ctx.save(); ctx.beginPath(); ctx.arc(N / 2, N / 2, N / 2, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
      const s = Math.min(w, h) / state.zoom, x0 = (w - s) * (0.5 + state.px / 2), y0 = (h - s) * (0.5 + state.py / 2);
      ctx.drawImage(img, x0, y0, s, s, 0, 0, N, N); ctx.restore();
    };
    const preview = el("canvas", { width: "200", height: "200", style: "width:160px;height:160px;flex:none;border-radius:50%;background:var(--panel)" });
    draw(preview, 200);
    const slider = (label, key, min, max) => {
      const input = el("input", { type: "range", min: String(min), max: String(max), step: "0.01", value: String(state[key]), style: "width:100%", "data-slider": key });
      input.addEventListener("input", () => { state[key] = Number(input.value); draw(preview, 200); });
      return el("div", { style: "margin:4px 0" }, [el("div", { class: "muted", style: "font-size:11.5px", text: label }), input]);
    };
    const buttons = el("div", { class: "row", style: "gap:8px;margin-top:8px" }, [
      el("button", { class: "primary", text: "Save photo", onclick: async (ev) => {
        const btn = ev.currentTarget; btn.disabled = true;
        try {
          const out = document.createElement("canvas"); out.width = 168; out.height = 168; draw(out, 168);
          const blob = await new Promise((res) => out.toBlob(res, "image/png"));
          if (!blob || blob.size > 280 * 1024) throw new Error("That picture came out too large. Try a simpler one.");
          const r = await fetch("/api/rep-photos?name=" + encodeURIComponent(name), { method: "PUT", headers: { "Content-Type": "image/png" }, body: blob, credentials: "same-origin" });
          if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || "Couldn't save the photo."); }
          await loadRepPhotos({ text: `Saved ✓ ${name}'s photo. The TV picks it up within about 15 seconds.`, color: "var(--green)" });
        } catch (e) { say(e.message || "Couldn't save the photo.", "var(--red)"); btn.disabled = false; }
      } }),
      el("button", { class: "ghost", text: "Cancel", onclick: () => { while (holder.firstChild) holder.removeChild(holder.firstChild); say("", "var(--sub)"); } }),
    ]);
    holder.appendChild(el("div", { class: "row", style: "gap:14px;align-items:center;margin-top:10px;flex-wrap:wrap" }, [preview, el("div", { style: "flex:1;min-width:180px" }, [slider("Zoom in", "zoom", 1, 4), slider("Move left or right", "px", -1, 1), slider("Move up or down", "py", -1, 1)])]));
    holder.appendChild(buttons);
  }
  loadRepPhotos();

  // ---- Roku TV ----
  content.appendChild(el("div", { class: "muted", style: "margin:24px 0 12px", text: "ROKU TV" }));
  const rokuBox = el("div", { class: "card" });
  content.appendChild(rokuBox);
  // `msg` is a message to show AFTER the box has been redrawn (a message written before the redraw would land on the old, discarded copy)
  async function loadRoku(msg) {
    let tv, sounds = [];
    try { tv = await api("/api/tv"); } catch (e) { rokuBox.textContent = "Couldn't load the Roku settings."; return; }
    try { sounds = await api("/api/sounds"); } catch (e) { /* none yet */ }
    while (rokuBox.firstChild) rokuBox.removeChild(rokuBox.firstChild);
    const note = el("div", { style: "font-size:12.5px;margin-top:8px;min-height:16px", class: "muted" });
    const say = (text, color) => { note.textContent = text; note.style.color = color || "var(--sub)"; };
    rokuBox.appendChild(el("div", { class: "muted", style: "font-size:12.5px;margin-bottom:12px", text: "Show the leaderboard on a Roku TV with its own small app: the same ranking, the same Deal closed banners and the same sounds. After the one-time setup below it needs no computer, phone or cable." }));
    rokuBox.appendChild(el("div", { style: "font-size:13px;margin-bottom:10px", text: tv.hasKey ? `A Roku app is set up (made ${formatDateTime(tv.createdAt)}). Downloading a new one replaces it, so the old one stops working.` : "No Roku app is set up yet." }));
    rokuBox.appendChild(el("button", { class: "primary", text: "Download the Roku app", onclick: async () => {
      if (tv.hasKey && !confirm("This makes a NEW app and cancels the old one: the app on your Roku stops working until you install the new one. Continue?")) return;
      say("Building the app...");
      try {
        const res = await fetch("/api/tv/package", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", credentials: "same-origin" });
        if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || "Couldn't build the app."); }
        const url = URL.createObjectURL(await res.blob());
        const link = document.createElement("a"); link.href = url; link.download = "SBN-Leaderboard-Roku.zip"; document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        await loadRoku({ text: "Downloaded SBN-Leaderboard-Roku.zip ✓ Now follow the steps below to put it on your Roku.", color: "var(--green)" });
      } catch (e) { say(e.message || "Couldn't build the app.", "var(--red)"); }
    } }));
    rokuBox.appendChild(note);

    // is the TV alive, and what does it say it is doing (its model, which sound it tried, whether that worked)
    if (window._rokuTimer) { clearInterval(window._rokuTimer); window._rokuTimer = null; }
    if (tv.hasKey) {
      const ago = (iso) => { const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 60 ? `${s} second${s === 1 ? "" : "s"} ago` : s < 3600 ? `${Math.round(s / 60)} minute${Math.round(s / 60) === 1 ? "" : "s"} ago` : `${Math.round(s / 3600)} hour${Math.round(s / 3600) === 1 ? "" : "s"} ago`; };
      const statusLine = el("div", { style: "font-size:13px;margin:14px 0 6px" });
      const reportsBox = el("div", { style: "margin:4px 0 2px" });
      const paintStatus = (st) => {
        const fresh = st.lastSeenAt && Date.now() - Date.parse(st.lastSeenAt) < 45000;
        statusLine.textContent = st.lastSeenAt ? `${fresh ? "●" : "○"} The TV checked in ${ago(st.lastSeenAt)}` : "○ The TV hasn't checked in yet (it checks every 15 seconds once the app is open)";
        statusLine.style.color = fresh ? "var(--green)" : "var(--amber)";
        while (reportsBox.firstChild) reportsBox.removeChild(reportsBox.firstChild);
        if (st.reports && st.reports.length) {
          reportsBox.appendChild(el("div", { class: "muted", style: "font-size:11px;letter-spacing:0.04em;margin-bottom:4px", text: "WHAT THE TV REPORTS (NEWEST FIRST)" }));
          st.reports.forEach((r) => reportsBox.appendChild(el("div", { style: "font-size:11.5px;margin-bottom:2px;color:" + (/error|fail|timeout/.test(r.event) ? "var(--amber)" : "var(--sub)") }, [
            el("span", { class: "muted", text: new Date(r.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }) + "  " }), el("span", { style: "font-weight:600", text: r.event + "  " }), el("span", { text: r.detail })])));
        }
      };
      paintStatus(tv);
      rokuBox.appendChild(statusLine);
      // which sound to test: any built-in one, or one of your own that is ready for the Roku
      const testSel = el("select", { style: "width:100%;margin:10px 0 8px" });
      Object.entries(DEAL_SOUNDS).forEach(([k, d]) => testSel.appendChild(el("option", { value: k, text: "Test sound: " + d.name })));
      sounds.filter((s) => s.tvReady).forEach((s) => testSel.appendChild(el("option", { value: "custom:" + s.id, text: "Test sound: 🎵 " + s.name })));
      rokuBox.appendChild(testSel);
      rokuBox.appendChild(el("button", { class: "ghost", text: "Play a test sound on the TV", onclick: async () => {
        try { await api("/api/tv/test-sound", { method: "POST", body: JSON.stringify({ key: testSel.value }) }); say("Asked the TV to play a test sound. It picks that up within about 15 seconds: look for a blue banner and listen. Then see what the TV reports below.", "var(--green)"); } catch (e) { say(e.message || "Couldn't ask the TV.", "var(--red)"); }
      } }));
      // all six one after another, far enough apart (the TV checks every 15 seconds) that it sees each one separately
      const allBtn = el("button", { class: "ghost", style: "margin-left:8px", text: "Test all six built-in sounds", onclick: async () => {
        allBtn.disabled = true;
        const keys = Object.keys(DEAL_SOUNDS), gap = window.TV_TEST_GAP_MS || 18000;
        try {
          for (let i = 0; i < keys.length; i++) {
            if (!document.body.contains(note)) return;          // you left this page: stop
            say(`Testing ${i + 1} of ${keys.length}: ${DEAL_SOUNDS[keys[i]].name}. Listen for it, and watch the list below. This takes about two minutes: keep this page open.`, "var(--green)");
            await api("/api/tv/test-sound", { method: "POST", body: JSON.stringify({ key: keys[i] }) });
            if (i < keys.length - 1) await new Promise((r) => setTimeout(r, gap));
          }
          say("All six have been sent. Each should show sound_ok in the list below once the TV has played it. Tell me which ones did not.", "var(--green)");
        } catch (e) { say(e.message || "Couldn't ask the TV.", "var(--red)"); } finally { allBtn.disabled = false; }
      } });
      rokuBox.appendChild(allBtn);
      rokuBox.appendChild(reportsBox);
      window._rokuTimer = setInterval(async () => {
        if (!document.body.contains(statusLine)) { clearInterval(window._rokuTimer); window._rokuTimer = null; return; }
        try { paintStatus(await api("/api/tv")); } catch (e) { /* offline for a moment */ }
      }, 8000);
    }

    // the sound the TV plays for a deal when the rep has none of their own, and how loud
    const ready = sounds.filter((s) => s.tvReady);
    const sel = el("select", { style: "width:100%;margin-bottom:8px" });
    const opt = (v, t) => el("option", { value: v, text: t });
    sel.appendChild(opt("random", "Random 🎲 (all sounds)"));
    Object.entries(DEAL_SOUNDS).forEach(([k, d]) => sel.appendChild(opt(k, d.name)));
    if (ready.length) { const g = document.createElement("optgroup"); g.label = "My sounds (ready for the Roku)"; g.appendChild(opt("custom-random", "Random: just my sounds 🎲")); ready.forEach((s) => g.appendChild(opt("custom:" + s.id, "🎵 " + s.name))); sel.appendChild(g); }
    sel.appendChild(opt("off", "Off (silent)"));
    sel.value = tv.settings.defaultSound; if (sel.value !== tv.settings.defaultSound) sel.value = "random";
    const vol = el("select", { style: "width:100%;margin-bottom:8px" }, [opt("low", "Volume: low"), opt("medium", "Volume: medium"), opt("high", "Volume: high")]);
    vol.value = tv.settings.volume;
    const saveSetting = async (body) => { try { await api("/api/tv/settings", { method: "PUT", body: JSON.stringify(body) }); say("Saved ✓", "var(--green)"); } catch (e) { loadRoku({ text: e.message || "Not saved.", color: "var(--red)" }); } };
    sel.addEventListener("change", () => saveSetting({ defaultSound: sel.value }));
    vol.addEventListener("change", () => saveSetting({ volume: vol.value }));
    rokuBox.appendChild(el("div", { class: "muted", style: "font-size:11px;letter-spacing:0.04em;margin:14px 0 4px", text: "SOUND ON THE TV" }));
    rokuBox.appendChild(el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:6px", text: "Reps with their own sound (see REP SOUNDS above) get theirs. Everyone else gets this. Off keeps the TV silent." }));
    rokuBox.appendChild(sel); rokuBox.appendChild(vol);
    // some TVs are silent with one way of playing sounds and fine with the other
    const method = el("select", { style: "width:100%;margin-bottom:8px" }, [opt("auto", "Try both ways (recommended)"), opt("player", "Audio player only"), opt("effects", "Sound-effects player only")]);
    method.value = tv.settings.soundMethod || "auto";
    method.addEventListener("change", () => saveSetting({ soundMethod: method.value }));
    rokuBox.appendChild(el("div", { class: "muted", style: "font-size:11px;letter-spacing:0.04em;margin:14px 0 4px", text: "HOW THE TV PLAYS SOUNDS" }));
    rokuBox.appendChild(el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:6px", text: "If you can't hear anything, press Play a test sound on the TV, then try the other choices here. The volume above only applies to the sound-effects player." }));
    rokuBox.appendChild(method);
    // confetti is the one effect that could look choppy on a basic Roku, so it has an off switch
    const confetti = el("select", { style: "width:100%;margin-bottom:8px" }, [opt("on", "Confetti: on"), opt("off", "Confetti: off")]);
    confetti.value = tv.settings.confetti === false ? "off" : "on";
    confetti.addEventListener("change", () => saveSetting({ confetti: confetti.value === "on" }));
    rokuBox.appendChild(el("div", { class: "muted", style: "font-size:11px;letter-spacing:0.04em;margin:14px 0 4px", text: "CONFETTI" }));
    rokuBox.appendChild(el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:6px", text: "Confetti falls across the TV with every Deal closed banner. If your TV ever looks choppy while it falls, turn it off." }));
    rokuBox.appendChild(confetti);

    // the owner's own sounds need a Roku copy; this makes it for the ones uploaded before the Roku app existed
    if (sounds.length) {
      const waiting = sounds.filter((s) => !s.tvReady);
      rokuBox.appendChild(el("div", { class: "muted", style: "font-size:12.5px;margin-top:6px", text: `${ready.length} of your ${sounds.length} own sounds ${ready.length === 1 ? "is" : "are"} ready for the Roku.` }));
      if (waiting.length) {
        const prog = el("div", { class: "muted", style: "font-size:12px;margin-top:6px;min-height:16px" });
        rokuBox.appendChild(el("button", { class: "ghost", style: "margin-top:8px", text: `Get my ${waiting.length} other sound${waiting.length === 1 ? "" : "s"} ready for the Roku`, onclick: async () => {
          const ctx = dealAudioContext();
          if (!ctx) { prog.textContent = "This browser can't prepare sounds."; return; }
          let done = 0, failed = 0;
          for (const s of waiting) {
            prog.textContent = `Preparing ${done + failed + 1} of ${waiting.length}: ${s.name}...`;
            let ok = false;
            try { const r = await fetch(`/api/sounds/${s.id}/file`, { credentials: "same-origin" }); ok = await prepareForRoku(s.id, await decodeDealAudio(ctx, await r.arrayBuffer())); } catch (e) { ok = false; }
            if (ok) done += 1; else failed += 1;
          }
          await loadRoku({ text: failed ? `${done} ready. ${failed} couldn't be converted (this browser couldn't read the file).` : `All ${done} are ready for the Roku ✓`, color: failed ? "var(--amber)" : "var(--green)" });
        } }));
        rokuBox.appendChild(prog);
      }
    }

    // the one-time setup on the Roku
    rokuBox.appendChild(el("div", { class: "muted", style: "font-size:11px;letter-spacing:0.04em;margin:16px 0 6px", text: "PUTTING THE APP ON YOUR ROKU (ONE TIME, ABOUT 10 MINUTES)" }));
    const steps = [
      "Press Download the Roku app above and keep the file it saves (SBN-Leaderboard-Roku.zip).",
      "On the Roku remote press, quickly: Home three times, Up twice, Right, Left, Right, Left, Right. The Roku's Developer Settings screen appears.",
      "Write down the IP address it shows. Choose Enable installer and restart, accept the agreement, and make up a password (write it down). The Roku restarts.",
      "On this computer (on the same Wi-Fi as the Roku) open a new browser tab and go to http://THE-IP-ADDRESS. Sign in with the username rokudev and your password.",
      "Press Upload, choose the zip file, then Install. The leaderboard starts on the TV.",
    ];
    steps.forEach((t, i) => rokuBox.appendChild(el("div", { style: "font-size:12.5px;margin-bottom:5px;display:flex;gap:8px" }, [el("span", { class: "muted", style: "min-width:18px", text: `${i + 1}.` }), el("span", { text: t })])));
    rokuBox.appendChild(el("div", { class: "muted", style: "font-size:11.5px;margin-top:8px", text: "A Roku can hold only one app installed this way at a time. If the power goes out, open SBN Leaderboard from the Roku home screen again. If a TV's power-saving setting turns it off after a few hours, switch that off in the TV's settings." }));
    if (tv.hasKey) rokuBox.appendChild(el("button", { class: "icon-danger", style: "margin-top:12px", text: "Turn the Roku app off", onclick: async () => {
      if (!confirm("Turn the Roku app off? The leaderboard on your Roku stops working until you download and install a new app.")) return;
      try { await api("/api/tv/key", { method: "DELETE" }); await loadRoku({ text: "The Roku app is turned off.", color: "var(--amber)" }); } catch (e) { say(e.message || "Couldn't do that.", "var(--red)"); }
    } }));
    if (msg) say(msg.text, msg.color);
  }
  loadRoku();

  // ---- Password ----
  content.appendChild(el("div", { class: "muted", style: "margin:24px 0 12px", text: "PASSWORD" }));
  const pwWarn = el("div", { style: "display:none;font-size:12.5px;color:var(--amber);border:0.5px solid var(--amber);border-radius:8px;padding:8px 10px;margin-bottom:12px", text: "⚠ The RESET_OWNER_PASSWORD variable is still set in Railway. While it's there, it puts that password back every time this tool restarts, undoing what you set here. Delete it in Railway → Variables." });
  const pwCurrent = el("input", { type: "password", placeholder: "Current password", autocomplete: "current-password" });
  const pwNew = el("input", { type: "password", placeholder: "New password (at least 4 characters)", autocomplete: "new-password" });
  const pwNew2 = el("input", { type: "password", placeholder: "New password again", autocomplete: "new-password" });
  const pwOthers = el("input", { type: "checkbox", style: "width:auto;margin-right:8px" });
  const pwNotice = el("div", { class: "notice" });
  content.appendChild(el("div", { class: "card" }, [
    pwWarn,
    el("div", { class: "field" }, [el("label", { text: "Current password" }), pwCurrent]),
    el("div", { class: "field" }, [el("label", { text: "New password" }), pwNew]),
    el("div", { class: "field" }, [el("label", { text: "New password again" }), pwNew2]),
    el("label", { style: "display:flex;align-items:center;font-size:13px;margin:4px 0 12px;cursor:pointer" }, [pwOthers, el("span", { text: "Also log out every other device (the leaderboard TV will need to log in again)" })]),
    el("button", { class: "primary", onclick: async () => {
      const bad = (t) => { pwNotice.textContent = t; pwNotice.style.color = "var(--red)"; };
      if (!pwCurrent.value) return bad("Enter your current password.");
      if (pwNew.value.length < 4) return bad("The new password must be at least 4 characters.");
      if (pwNew.value !== pwNew2.value) return bad("The two new passwords don't match.");
      try {
        const r = await api("/api/change-password", { method: "POST", body: JSON.stringify({ currentPassword: pwCurrent.value, newPassword: pwNew.value, logOutOthers: pwOthers.checked }) });
        pwCurrent.value = ""; pwNew.value = ""; pwNew2.value = ""; pwOthers.checked = false;
        pwNotice.textContent = "Password changed ✓" + (r.loggedOutOthers ? " Every other device has been logged out." : " Devices that are already logged in stay logged in."); pwNotice.style.color = "var(--green)";
      } catch (e) { bad(e.message); }
    }, text: "Change password" }),
    pwNotice,
  ]));
  api("/api/password-status").then((s) => { if (s.resetVariableSet) pwWarn.style.display = "block"; }).catch(() => {});
}

async function renderCleanup(content) {
  const body = el("div");
  // Suspected reschedules (a booking whose customer already has an earlier unfinished one for the same car) and the
  // ones already left out. The button works at that booking's own location.
  let pendingMsg = null;
  async function flip(c, fields, okText, ask) {
    if (ask && !confirm(ask)) return;
    const key = Object.keys(fields)[0];
    try {
      const res = await api("/api/combined/job-edit", { method: "POST", body: JSON.stringify({ locationId: c.locationId, saleId: c.saleId, ...fields }) });
      pendingMsg = (!res.applied || !res.applied.includes(key))
        ? { ok: false, text: `${c.locationName} needs the latest tracker update before this can be used there.` }
        : { ok: true, text: okText };
    } catch (e) { pendingMsg = { ok: false, text: e.message || "Couldn't change that." }; }
    load();
  }
  // Merge two bookings of the same customer into one job (the earlier one is kept). Can't be undone from here.
  async function mergeCand(c) {
    if (!confirm(`Merge these into ONE job?\n\nKept: the EARLIER job (${c.earlier.car}, ${formatDateTime(c.earlier.date)}), with its original closing time, rep and history, moved to the new appointment day.\nRemoved: the newer duplicate shown here.\n\nThis can't be undone from the app. Edit History at ${c.locationName} records it.`)) return;
    try {
      await api("/api/combined/job-merge", { method: "POST", body: JSON.stringify({ locationId: c.locationId, saleId: c.saleId, earlierId: c.earlier.id }) });
      pendingMsg = { ok: true, text: "Merged into one job. It keeps its original closing time." };
    } catch (e) { pendingMsg = { ok: false, text: e.message || "Couldn't merge these." }; }
    load();
  }
  function renderRescheduleSections(data) {
    const cands = data.possibleReschedules || [], left = data.leftOut || [], merged = data.recentMerges || [];
    if (cands.length > 0) {
      body.appendChild(el("div", { class: "card", style: "border-color:var(--amber)" }, [
        el("div", { class: "muted", style: "margin-bottom:6px", text: `LOOKS LIKE A RESCHEDULE: counted as a new close (${cands.length})` }),
        el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:4px", text: "Each booking below belongs to a customer who already had an earlier, unfinished booking for the same car. That usually means a reschedule that got counted as a new sale. Choose what's true:" }),
        el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:8px;line-height:1.5" }, [
          el("div", { text: "• Reschedule: don't count: keeps both jobs, takes the new one off closing activity. The rep is still paid when the client shows up." }),
          el("div", { text: "• Merge into one job: combines the two into the earlier job, which keeps its original closing time." }),
          el("div", { text: "• Not a reschedule: it's a real new sale. Stop suggesting it." }),
        ]),
        ...cands.map((c) => el("div", { style: "padding:8px 0;border-top:0.5px solid var(--border)" }, [
          el("div", { class: "row", style: "align-items:flex-start" }, [
            el("div", {}, [
              el("div", { style: "font-weight:500", text: c.car }),
              el("div", { class: "muted", style: "font-size:11.5px", text: `${c.repName}${c.customerName ? " · " + c.customerName : ""} · ${c.locationName}` }),
              el("div", { class: "muted", style: "font-size:11.5px", text: `NEW, counted as a close: closed ${formatDateTime(c.closedAt)} · car scheduled ${formatDateTime(c.date)}` }),
              el("div", { style: "font-size:11.5px;color:var(--amber)", text: `EARLIER, same customer and car: ${c.earlier.car} · ${formatDateTime(c.earlier.date)} · ${c.earlier.status}` }),
            ]),
            el("div", { class: "mono", style: "color:var(--amber)", text: money(c.basePrice) }),
          ]),
          el("div", { style: "display:flex;gap:8px;margin-top:6px;flex-wrap:wrap" }, [
            el("button", { class: "primary", style: "font-size:12px;padding:6px 12px", text: "↻ Reschedule: don't count", onclick: () => flip(c, { isReschedule: true }, "Left out of closing activity. It's still paid when the client shows up.", "Mark this as a reschedule?\n\nIt will be left out of the closing numbers (the Audit tab, the leaderboard, Combined and Statistics), because it's the same deal moved to a new day, not a new sale.\n\nBoth jobs stay. It stays fully in Payroll: the rep is still paid commission when the client shows up. You can undo this any time.") }),
            c.canMerge === false ? null : el("button", { class: "ghost", style: "font-size:12px", text: "Merge into one job", onclick: () => mergeCand(c) }),
            el("button", { class: "ghost", style: "font-size:12px", text: "Not a reschedule", onclick: () => flip(c, { rescheduleDismissed: true }, "Kept as a real new close. It won't be suggested again.", "Keep this as a real new close? It won't be suggested again.") }),
          ]),
          c.canMerge === false ? el("div", { class: "muted", style: "font-size:11px;margin-top:4px", text: "This one has already arrived or been paid, so it can't be merged. Use the first button." }) : null,
        ])),
      ]));
    }
    if (left.length > 0) {
      const n = left.length;
      const list = el("div", { style: "display:none;margin-top:6px" }, left.map((c) => el("div", { class: "row", style: "padding:6px 0;border-top:0.5px solid var(--border);align-items:flex-start" }, [
        el("div", {}, [
          el("div", { text: c.car }),
          el("div", { class: "muted", style: "font-size:11px", text: `${c.repName}${c.customerName ? " · " + c.customerName : ""} · ${c.locationName} · closed ${formatDateTime(c.closedAt)}${c.auto ? " · flagged automatically (the title says rescheduled)" : ""}` }),
        ]),
        el("div", { style: "text-align:right" }, [
          el("div", { class: "mono", style: "color:var(--amber)", text: money(c.basePrice) }),
          el("button", { class: "ghost", style: "font-size:11px;padding:3px 9px;margin-top:4px", text: "Count as a close", onclick: () => flip(c, { isReschedule: false }, "Counted as a close again.") }),
        ]),
      ])));
      const label = (open) => `${open ? "▾" : "▸"} ↻ ${n} rescheduled booking${n !== 1 ? "s" : ""} left out of closing activity (still paid when the client shows)`;
      const toggle = el("button", { class: "ghost", style: "width:100%;text-align:left;font-size:12px;color:var(--amber)", text: label(false), onclick: () => {
        const open = list.style.display !== "none";
        list.style.display = open ? "none" : "block";
        toggle.textContent = label(!open);
      } });
      body.appendChild(el("div", { class: "card" }, [toggle, list]));
    }
    if (merged.length > 0) {
      const n = merged.length;
      const list = el("div", { style: "display:none;margin-top:6px" }, [
        el("div", { class: "muted", style: "font-size:11px;margin-bottom:4px", text: "A merge keeps the older job (with its original closing time) and removes the newer duplicate. This list is just a record." },),
        ...merged.map((m) => el("div", { style: "padding:6px 0;border-top:0.5px solid var(--border)" }, [
          el("div", { style: "font-size:12.5px", text: `${m.car || "(job)"}${m.customerName ? " · " + m.customerName : ""} · ${m.locationName}` }),
          el("div", { class: "muted", style: "font-size:11px", text: `Moved from ${m.fromDate} to ${m.toDate} · merged ${formatDateTime(m.mergedAt)} by ${m.actor || "unknown"}` }),
        ])),
      ]);
      const label = (open) => `${open ? "▾" : "▸"} ${n} job${n !== 1 ? "s" : ""} merged in the last 2 weeks`;
      const toggle = el("button", { class: "ghost", style: "width:100%;text-align:left;font-size:12px", text: label(false), onclick: () => {
        const open = list.style.display !== "none";
        list.style.display = open ? "none" : "block";
        toggle.textContent = label(!open);
      } });
      body.appendChild(el("div", { class: "card" }, [toggle, list]));
    }
  }

  let latestCleanupRequestId = 0;
  async function load() {
    const thisRequestId = ++latestCleanupRequestId;
    const data = await api("/api/combined/cleanup-list");
    if (thisRequestId !== latestCleanupRequestId) return;
    body.innerHTML = "";
    if (pendingMsg) { body.appendChild(el("div", { class: "notice " + (pendingMsg.ok ? "ok" : "err"), text: pendingMsg.text })); pendingMsg = null; }
    if (data.errors.length > 0) {
      body.appendChild(el("div", { class: "card", style: "border-color:var(--red)" }, [
        el("div", { style: "color:var(--red);font-size:12.5px", text: `Couldn't reach: ${data.errors.map((e) => `${e.locationName} (${e.error})`).join(", ")}` }),
      ]));
    }
    renderRescheduleSections(data);
    if (data.jobs.length === 0) { body.appendChild(el("div", { class: "muted", text: "Nothing needs cleanup across any location." })); return; }
    data.jobs.forEach((j) => {
      // The shop fills a price in by itself whenever the title has one, so a row only reaches here for a price when the title has
      // none, or the price was deliberately set to $0. In that second case the title's price is offered, ready to save.
      const priceInput = el("input", { type: "number", placeholder: "Base price", value: j.basePrice || (j.missingPrice && j.titlePrice) || "", style: `max-width:110px;${j.missingPrice ? "" : "display:none"}` });
      const serviceSelect = el("select", { style: `max-width:140px;${j.missingService ? "" : "display:none"}` }, [
        el("option", { value: "", text: "Service..." }),
        el("option", { value: "Window Tint", text: "Window Tint" }),
        el("option", { value: "Ceramic Coating", text: "Ceramic Coating" }),
        el("option", { value: "PPF", text: "PPF" }),
      ]);
      const notice = el("span", { class: "muted", style: "font-size:11px" });
      const saveBtn = el("button", { class: "primary", style: "font-size:12px;padding:6px 12px", onclick: async () => {
        const fix = {};
        if (j.missingPrice && priceInput.value) fix.basePrice = priceInput.value;
        if (j.missingService && serviceSelect.value) fix.baseService = serviceSelect.value;
        if (Object.keys(fix).length === 0) { notice.textContent = "Nothing to save."; notice.style.color = "var(--red)"; return; }
        try {
          await api("/api/combined/cleanup-fix", { method: "POST", body: JSON.stringify({ locationId: j.locationId, saleId: j.id, ...fix }) });
          load();
        } catch (e) {
          notice.textContent = e.message; notice.style.color = "var(--red)";
        }
      }, text: "Save" });
      const walkInBtn = j.missingRep ? el("button", { class: "ghost", style: "font-size:12px", onclick: async () => {
        await api("/api/combined/cleanup-fix", { method: "POST", body: JSON.stringify({ locationId: j.locationId, saleId: j.id, isWalkIn: true }) });
        load();
      }, text: "Mark walk-in" }) : null;
      const onlineBtn = j.missingRep ? el("button", { class: "ghost", style: "font-size:12px", onclick: async () => {
        await api("/api/combined/cleanup-fix", { method: "POST", body: JSON.stringify({ locationId: j.locationId, saleId: j.id, isOnlineBooking: true }) });
        load();
      }, text: "Mark online booking" }) : null;
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row", style: "margin-bottom:8px" }, [
          el("div", {}, [
            el("div", { style: "font-weight:500", text: j.car }),
            el("div", { class: "muted", style: "font-size:12px", text: `${formatDateTime(j.date)}${j.customerName ? " · " + j.customerName : ""}` }),
          ]),
          el("span", { class: "pill", text: j.locationName }),
        ]),
        el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:8px", text: [j.missingPrice ? "Missing price" : null, j.missingService ? "Missing service" : null, j.missingRep ? "Missing rep/walk-in flag" : null].filter(Boolean).join(" · ") }),
        j.missingPrice && j.titlePrice ? el("div", { style: "font-size:11.5px;color:var(--green);margin-bottom:6px", text: `The title says $${Number(j.titlePrice).toFixed(2)}. It's filled in below, so you can just save.` }) : null,
        el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center" }, [priceInput, serviceSelect, saveBtn, walkInBtn, onlineBtn, notice]),
      ]));
    });
  }
  content.appendChild(el("div", { class: "muted", style: "margin-bottom:14px", text: "Every job across every location missing a price, service, or sales rep / walk-in flag. Fixing one here applies directly to that location's own tracker, just like fixing it there. Prices are filled in by themselves from the title (like $644-$50), even for jobs already done, so a job only shows up here for a price when its title has none." }));
  content.appendChild(body);
  await load();
}

// Today's calendar date in Eastern time. The shops run on Eastern, but toISOString() is UTC,
// which rolls over to "tomorrow" around 8pm Eastern - so a picker built on it opened the Day
// view on an empty future date every evening.
function easternToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// Pay periods are 14 days, Thursday through Wednesday, repeating every two weeks - the same
// schedule the shops' own Payroll uses. It's anchored on a Wednesday that ENDS a period (Aug 26,
// 2026), so Sep 24 - Oct 7 is followed by Oct 8 - Oct 21, then Oct 22 - Nov 4, and so on. A
// period rolls over at the end of its last day, Eastern time.
const PAY_PERIOD_END_ANCHOR = "2026-08-26";
const DAY_MS = 86400000;
const noonMs = (ymd) => Date.parse(ymd + "T12:00:00Z"); // noon sidesteps any day-boundary or DST ambiguity
const toYmd = (ms) => new Date(ms).toISOString().slice(0, 10);
function shiftYmd(ymd, days) { return toYmd(noonMs(ymd) + days * DAY_MS); }
function payPeriodEndFor(ymd) {
  const daysFromAnchor = Math.round((noonMs(ymd) - noonMs(PAY_PERIOD_END_ANCHOR)) / DAY_MS);
  return shiftYmd(PAY_PERIOD_END_ANCHOR, Math.ceil(daysFromAnchor / 14) * 14);
}
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function prettyRange(startYmd, endYmd) {
  const fmt = (ymd, withYear) => { const [y, m, d] = ymd.split("-").map(Number); return `${MONTH_ABBR[m - 1]} ${d}${withYear ? `, ${y}` : ""}`; };
  return startYmd.slice(0, 4) === endYmd.slice(0, 4) ? `${fmt(startYmd)} – ${fmt(endYmd, true)}` : `${fmt(startYmd, true)} – ${fmt(endYmd, true)}`;
}

function renderSimplePeriodPicker(onChange, initialPeriod = "payperiod") {
  let period = initialPeriod;
  const today = easternToday();
  let payEnd = payPeriodEndFor(today);
  const dayInput = el("input", { type: "date", value: today, style: "display:none" });
  const weekInput = el("input", { type: "date", value: today, style: "display:none" });
  const monthInput = el("input", { type: "month", value: today.slice(0, 7), style: "display:none" });
  const yearInput = el("input", { type: "number", value: today.slice(0, 4), style: "display:none;max-width:100px" });

  // Pay period: the period containing today, with back/forward arrows (never past the current one).
  const payLabel = el("span", { style: "font-size:13px;flex:1;text-align:center" });
  const payPrev = el("button", { class: "ghost", text: "◀", "aria-label": "Previous pay period" });
  const payNext = el("button", { class: "ghost", text: "▶", "aria-label": "Next pay period" });
  const payWrap = el("div", { style: "display:flex;gap:8px;align-items:center" }, [payPrev, payLabel, payNext]);
  function renderPayLabel() {
    const currentEnd = payPeriodEndFor(easternToday());
    payLabel.textContent = prettyRange(shiftYmd(payEnd, -13), payEnd) + (payEnd === currentEnd ? " · current" : "");
    payNext.disabled = payEnd >= currentEnd;
  }
  renderPayLabel();

  // Custom starts out on the current pay period so it opens on something meaningful.
  const customStart = el("input", { type: "date", value: shiftYmd(payEnd, -13), style: "max-width:150px" });
  const customEnd = el("input", { type: "date", value: payEnd, style: "max-width:150px" });
  const customWrap = el("div", { style: "display:none;gap:8px;align-items:center;flex-wrap:wrap" }, [
    el("span", { class: "muted", style: "font-size:12px", text: "From" }), customStart, el("span", { class: "muted", style: "font-size:12px", text: "to" }), customEnd,
  ]);
  const customNotice = el("div", { class: "muted", style: "display:none;font-size:12px;margin-top:6px" });

  function currentParams() {
    if (period === "payperiod") return { period: "payperiod", date: payEnd };
    if (period === "day") return { period, date: dayInput.value };
    if (period === "week") return { period, date: weekInput.value };
    if (period === "year") return { period, date: `${yearInput.value}-01-01` };
    if (period === "custom") return { period, startDate: customStart.value, endDate: customEnd.value };
    return { period: "month", month: monthInput.value };
  }
  function fire() { onChange(currentParams()); }

  // A custom range is checked before it's sent: a backwards or half-empty range used to come
  // back as a blank "No sales rep activity" with no clue why.
  function fireCustom() {
    const problem = !customStart.value || !customEnd.value ? "Pick both dates." : customStart.value > customEnd.value ? "The end date is before the start date." : null;
    customNotice.style.display = "";
    customNotice.textContent = problem || `Showing ${prettyRange(customStart.value, customEnd.value)}`;
    customNotice.style.color = problem ? "var(--red)" : "var(--muted)";
    if (!problem) fire();
  }

  function showFor(p) {
    dayInput.style.display = p === "day" ? "" : "none";
    weekInput.style.display = p === "week" ? "" : "none";
    monthInput.style.display = p === "month" ? "" : "none";
    yearInput.style.display = p === "year" ? "" : "none";
    payWrap.style.display = p === "payperiod" ? "flex" : "none";
    customWrap.style.display = p === "custom" ? "flex" : "none";
    customNotice.style.display = p === "custom" ? "" : "none";
  }
  const tabs = el("div", { style: "display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap" });
  [["payperiod", "Pay period"], ["day", "Day"], ["week", "Week"], ["month", "Month"], ["year", "Year"], ["custom", "Custom"]].forEach(([p, label]) => {
    const btn = el("button", { class: "tab-btn" + (p === period ? " active" : ""), text: label });
    btn.addEventListener("click", () => {
      period = p;
      Array.from(tabs.children).forEach((c) => c.classList.remove("active"));
      showFor(p);
      btn.classList.add("active");
      if (p === "payperiod") renderPayLabel();
      if (p === "custom") fireCustom(); else fire(); // Custom now loads straight away too, instead of waiting for a date change
    });
    tabs.appendChild(btn);
  });
  payPrev.addEventListener("click", () => { payEnd = shiftYmd(payEnd, -14); renderPayLabel(); fire(); });
  payNext.addEventListener("click", () => { if (payEnd < payPeriodEndFor(easternToday())) { payEnd = shiftYmd(payEnd, 14); renderPayLabel(); fire(); } });
  [dayInput, weekInput, monthInput, yearInput].forEach((inp) => inp.addEventListener("change", fire));
  [customStart, customEnd].forEach((inp) => inp.addEventListener("change", () => { if (period === "custom") fireCustom(); }));
  const wrap = el("div", { class: "field", style: "max-width:400px" }, [
    el("label", { text: "Time period" }), tabs, dayInput, weekInput, monthInput, yearInput, payWrap, customWrap, customNotice,
  ]);
  showFor(period);
  return { el: wrap, getParams: currentParams };
}

// Deals CLOSED and cars ARRIVED are two genuinely different questions, so Combined shows both
// side by side, exactly like the leaderboard: what a rep closed in the period (by close date, no
// matter what day the car comes in) and what actually arrived in the period (by appointment
// date - the cars that earn real commission, matching each shop's own Payroll).
function renderGoalProgress(rep, goal) {
  if (!goal) return null;
  // Closes and value goals count deals actually closed in the period; commission goals count
  // real commission from cars that showed.
  const current = goal.metric === "commission" ? rep.actualCommission : goal.metric === "value" ? rep.closing.value : rep.closing.count;
  const pct = Math.min(100, Math.round((current / goal.target) * 100));
  const displayCurrent = goal.metric === "closes" ? current : money(current);
  const displayTarget = goal.metric === "closes" ? goal.target : money(goal.target);
  return el("div", { style: "margin-top:8px;padding-top:8px;border-top:0.5px solid var(--border)" }, [
    el("div", { class: "row", style: "margin-bottom:4px" }, [
      el("span", { class: "muted", style: "font-size:11px", text: `${goal.cadence === "week" ? "Weekly" : "Monthly"} goal` }),
      el("span", { class: "muted", style: "font-size:11px", text: `${displayCurrent} / ${displayTarget}` }),
    ]),
    el("div", { style: "background:var(--panel);border-radius:6px;height:10px;overflow:hidden" }, [
      el("div", { style: `background:${pct >= 100 ? "var(--green)" : "var(--cyan)"};height:100%;width:${pct}%` }),
    ]),
  ]);
}

function renderRepCard(rep, showLocationBreakdown, goal) {
  const detailWrap = el("div", { style: "display:none;margin-top:10px" });
  const sectionLabel = (text, extra) => el("div", { class: "muted", style: `font-size:10.5px;font-weight:600;margin:8px 0 4px;${extra || ""}`, text });
  function buildDetail() {
    detailWrap.innerHTML = "";
    if (showLocationBreakdown && rep.closing.closes.length > 0) {
      const byLoc = {};
      rep.closing.closes.forEach((c) => { const l = (byLoc[c.locationName] = byLoc[c.locationName] || { count: 0, value: 0 }); l.count += 1; l.value += c.basePrice; });
      detailWrap.appendChild(sectionLabel("CLOSED BY LOCATION"));
      Object.entries(byLoc).forEach(([name, l]) => detailWrap.appendChild(el("div", { class: "row", style: "font-size:12px;margin-bottom:3px" }, [
        el("span", { text: `${name} — ${l.count} closed` }), el("span", { class: "mono", text: money(l.value) }),
      ])));
    }
    if (showLocationBreakdown && rep.byLocation.length > 0) {
      detailWrap.appendChild(sectionLabel("APPOINTMENTS BY LOCATION"));
      rep.byLocation.forEach((l) => detailWrap.appendChild(el("div", { class: "row", style: "font-size:12px;margin-bottom:3px" }, [
        el("span", { text: `${l.locationName} — ${l.closeCount} appointment${l.closeCount !== 1 ? "s" : ""}, ${l.arrivedCount} arrived` }),
        el("span", { class: "mono", text: money(l.closedValue) }),
      ])));
    }
    const services = Object.entries(rep.byService || {});
    if (services.length > 0) {
      detailWrap.appendChild(sectionLabel("BY SERVICE"));
      services.forEach(([svc, count]) => detailWrap.appendChild(el("div", { class: "row", style: "font-size:12px;margin-bottom:3px" }, [
        el("span", { text: svc }), el("span", { class: "mono", text: count }),
      ])));
    }
    if (rep.byDayOfWeek) {
      detailWrap.appendChild(sectionLabel("BY DAY OF WEEK"));
      const maxCount = Math.max(1, ...rep.byDayOfWeek.map((d) => d.count));
      rep.byDayOfWeek.forEach((d) => {
        detailWrap.appendChild(el("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:2px" }, [
          el("span", { class: "muted", style: "font-size:11px;width:70px", text: d.day.slice(0, 3) }),
          el("div", { style: "flex:1;background:var(--panel);border-radius:4px;height:12px;position:relative" }, [
            el("div", { style: `background:var(--cyan);height:100%;border-radius:4px;width:${(d.count / maxCount) * 100}%` }),
          ]),
          el("span", { class: "mono", style: "font-size:11px;width:20px;text-align:right", text: d.count }),
        ]));
      });
    }
    if (rep.possibleDuplicates && rep.possibleDuplicates.length > 0) {
      detailWrap.appendChild(sectionLabel("⚠ POSSIBLE DUPLICATES", "color:var(--red)"));
      rep.possibleDuplicates.forEach((dup) => {
        detailWrap.appendChild(el("div", { style: "font-size:11.5px;margin-bottom:6px;color:var(--red)" }, [
          el("div", { text: dup.customerName }),
          ...dup.entries.map((e) => el("div", { class: "muted", style: "font-size:10.5px;margin-left:8px", text: `${e.locationName} — ${e.car} — ${money(e.basePrice)} — ${formatDateTime(e.date)}` })),
        ]));
      });
    }
    const statusColorFor = (st) => (st === "arrived" ? "var(--green)" : st === "no_show" ? "var(--red)" : "var(--sub)");

    // Every deal closed in the period, with when it was closed and when the car comes in.
    detailWrap.appendChild(sectionLabel(`CLOSED IN THIS PERIOD (${rep.closing.closes.length})`));
    if (rep.closing.closes.length === 0) detailWrap.appendChild(el("div", { class: "muted", style: "font-size:11.5px", text: "Nothing closed in this period." }));
    rep.closing.closes.forEach((c) => {
      const commText = c.status === "arrived" ? `+${money(c.commissionAmount)} earned` : `${money(c.commissionAmount)} if it shows`;
      detailWrap.appendChild(el("div", { style: "margin-bottom:6px" }, [
        el("div", { class: "row", style: "font-size:11.5px" }, [
          el("div", {}, [el("span", { text: c.car }), showLocationBreakdown ? el("span", { class: "muted", text: ` · ${c.locationName}` }) : null]),
          el("div", { style: "text-align:right" }, [
            el("span", { class: "mono", text: money(c.basePrice) }),
            el("span", { style: `color:${statusColorFor(c.status)};margin-left:6px;font-size:10px`, text: c.status }),
          ]),
        ]),
        el("div", { class: "muted", style: "font-size:10.5px", text: `Closed ${formatDateTime(c.closedAt)} · ${c.duringHours ? "in-hours" : "after-hours"} · car scheduled ${formatDateTime(c.date)} · ${commText}` }),
      ]));
    });

    // Every appointment landing in the period - the arrivals are what earn real commission.
    detailWrap.appendChild(sectionLabel(`APPOINTMENTS IN THIS PERIOD (${rep.closes.length})`));
    if (rep.closes.length === 0) detailWrap.appendChild(el("div", { class: "muted", style: "font-size:11.5px", text: "No appointments in this period." }));
    rep.closes.forEach((c) => {
      detailWrap.appendChild(el("div", { class: "row", style: "font-size:11.5px;margin-bottom:3px" }, [
        el("div", {}, [
          el("span", { text: c.car }),
          showLocationBreakdown ? el("span", { class: "muted", text: ` · ${c.locationName}` }) : null,
          c.isReschedule ? el("span", { style: "color:var(--amber);font-size:10px;margin-left:6px", text: "↻ reschedule" }) : null,
        ]),
        el("div", { style: "text-align:right" }, [
          el("span", { class: "mono", text: money(c.basePrice) }),
          el("span", { style: `color:${statusColorFor(c.status)};margin-left:6px;font-size:10px`, text: c.status }),
          c.status === "arrived" ? el("span", { class: "mono", style: "color:var(--green);margin-left:6px;font-size:10.5px", text: `+${money(c.commissionAmount)}` }) : null,
        ]),
      ]));
    });
  }
  buildDetail();
  const toggleBtn = el("button", { class: "ghost", style: "width:100%;text-align:left;font-size:12px;margin-top:6px", onclick: () => {
    const showing = detailWrap.style.display !== "none";
    detailWrap.style.display = showing ? "none" : "block";
    toggleBtn.textContent = showing ? "▸ See full breakdown" : "▾ Hide breakdown";
  } }, [el("span", { text: "▸ See full breakdown" })]);

  const avgPerDeal = rep.closing.count ? rep.closing.value / rep.closing.count : 0;
  const statBlock = (label, big, bigColor, caption, sub, subLabel, subColor, extraStyle) => el("div", { style: `flex:1;min-width:130px;${extraStyle || ""}` }, [
    el("div", { class: "muted", style: "font-size:10.5px;letter-spacing:0.03em", text: label }),
    el("div", { class: "mono", style: `font-size:22px;font-weight:600;color:${bigColor};margin-top:2px`, text: big }),
    el("div", { class: "muted", style: "font-size:11px", text: caption }),
    el("div", { class: "mono", style: `font-size:16px;font-weight:600;color:${subColor};margin-top:4px`, text: sub }),
    el("div", { class: "muted", style: "font-size:10.5px", text: subLabel }),
  ]);

  return el("div", { class: "card" }, [
    el("div", { style: "font-weight:500;font-size:16px;margin-bottom:8px", text: rep.name }),
    el("div", { style: "display:flex;gap:16px;flex-wrap:wrap" }, [
      statBlock("CLOSED", `${rep.closing.count}`, "var(--cyan)", rep.closing.count ? `deal${rep.closing.count !== 1 ? "s" : ""} · avg ${money(avgPerDeal)}` : "no deals closed", money(rep.closing.value), "closed value", "var(--amber)", "border-right:1px solid var(--border);padding-right:12px"),
      statBlock("ARRIVED", `${rep.arrivedCount}`, "var(--amber)", `car${rep.arrivedCount !== 1 ? "s" : ""} that showed`, money(rep.actualCommission), "actual commission", "var(--green)"),
    ]),
    el("div", { class: "muted", style: "font-size:12px;margin-top:8px", text: rep.closeCount > 0
      ? `${rep.closeCount} appointment${rep.closeCount !== 1 ? "s" : ""} in this period · ${rep.arrivedCount} arrived, ${rep.noShowCount} no-show, ${rep.pendingCount} pending · ${Math.round(rep.noShowRate)}% no-show rate`
      : "No appointments landing in this period" }),
    rep.closeCount > 0 && rep.projectedCommission !== rep.actualCommission ? el("div", { class: "muted", style: "font-size:11px", text: `${money(rep.projectedCommission)} commission if everyone scheduled shows` }) : null,
    rep.daysSinceLastClose !== null ? el("div", { style: `font-size:11.5px;margin-top:2px;color:${rep.daysSinceLastClose > 7 ? "var(--red)" : "var(--muted)"}`, text: `Last close: ${rep.daysSinceLastClose} day${rep.daysSinceLastClose !== 1 ? "s" : ""} ago` }) : null,
    renderGoalProgress(rep, goal),
    toggleBtn, detailWrap,
  ]);
}

async function renderCombined(content) {
  const picker = renderSimplePeriodPicker((params) => load(params));
  const locationTabs = el("div", { style: "display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap" });
  const body = el("div");
  let activeLocationFilter = "combined"; // "combined" or a location name

  let goalsCache = [];
  let closedCache = null;
  let currentPeriodType = "month";
  let latestRequestId = 0;

  async function load(params) {
    const p = params || picker.getParams();
    const thisRequestId = ++latestRequestId;
    const qs = new URLSearchParams(p).toString();
    let newStats, newClosed, newGoals;
    try {
      // Two views of the same period, fetched together: what's scheduled to land in it
      // (matches Payroll) and what was actually closed in it (matches the leaderboard).
      [newStats, newClosed, newGoals] = await Promise.all([
        api(`/api/combined/salesrep-stats?${qs}`),
        api(`/api/combined/salesrep-stats?${qs}&dateBasis=closed`),
        api("/api/goals"),
      ]);
    } catch (e) {
      if (thisRequestId !== latestRequestId) return;
      body.innerHTML = "";
      body.appendChild(el("div", { class: "card", style: "border-color:var(--red)" }, [
        el("div", { style: "color:var(--red);font-size:12.5px", text: `Couldn't load: ${e.message || "something went wrong"}. Change the period or reload to try again.` }),
      ]));
      return;
    }
    // If a newer request has started since this one began, a faster response already
    // rendered more current data - discard this now-stale result instead of overwriting it.
    if (thisRequestId !== latestRequestId) return;
    currentPeriodType = p.period;
    statsCache = newStats;
    closedCache = newClosed;
    goalsCache = newGoals;
    renderLocationTabs();
    renderBody();
  }

  function goalFor(repName) {
    // Goals only exist as weekly or monthly - only shown when actually viewing that
    // matching period, since a goal's progress doesn't mean anything against a different range.
    if (currentPeriodType !== "week" && currentPeriodType !== "month") return null;
    return goalsCache.find((g) => g.repName === repName && g.cadence === currentPeriodType);
  }

  function renderLocationTabs() {
    locationTabs.innerHTML = "";
    const options = [["combined", "Combined"], ...statsCache.locationsQueried.map((name) => [name, name])];
    options.forEach(([key, label]) => {
      locationTabs.appendChild(el("button", {
        class: "tab-btn" + (activeLocationFilter === key ? " active" : ""),
        onclick: () => { activeLocationFilter = key; renderLocationTabs(); renderBody(); },
        text: label,
      }));
    });
  }

  const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  // Appointment-side numbers worked out from a list of appointments - used for a single
  // location, and for a rep who closed deals but has no appointment landing in the period.
  function apptViewFrom(name, closes) {
    const arrived = closes.filter((c) => c.status === "arrived");
    const noShow = closes.filter((c) => c.status === "no_show");
    const pending = closes.filter((c) => c.status !== "arrived" && c.status !== "no_show");
    const closedValue = sum(closes, (c) => c.basePrice);
    const byService = {};
    closes.forEach((c) => { const k = c.baseService || "(not set)"; byService[k] = (byService[k] || 0) + 1; });
    const byDayOfWeek = dayNames.map((d) => ({ day: d, count: 0 }));
    closes.forEach((c) => { const d = new Date(c.closedAt); if (!isNaN(d.getTime())) byDayOfWeek[d.getUTCDay()].count += 1; });
    return {
      name, closeCount: closes.length, closedValue, avgDealSize: closes.length ? closedValue / closes.length : 0,
      arrivedCount: arrived.length, noShowCount: noShow.length, pendingCount: pending.length,
      noShowRate: (arrived.length + noShow.length) > 0 ? (noShow.length / (arrived.length + noShow.length)) * 100 : 0,
      actualCommission: sum(arrived, (c) => c.commissionAmount || 0), projectedCommission: sum(closes, (c) => c.commissionAmount || 0),
      byLocation: [], byService, byDayOfWeek, daysSinceLastClose: null, possibleDuplicates: [], closes,
    };
  }

  // One entry per rep who has ANYTHING in the period at the chosen location - a deal closed
  // (even for a car coming in next month) or a car arriving (even from an old deal).
  function buildViews() {
    const loc = activeLocationFilter === "combined" ? null : activeLocationFilter;
    const inLoc = (c) => !loc || c.locationName === loc;
    const names = [...new Set([...statsCache.perRep.map((r) => r.name), ...closedCache.perRep.map((r) => r.name)])];
    const views = [];
    names.forEach((name) => {
      const a = statsCache.perRep.find((r) => r.name === name);
      const c = closedCache.perRep.find((r) => r.name === name);
      const apptCloses = (a ? a.closes : []).filter(inLoc);
      const closedCloses = (c ? c.closes : []).filter(inLoc);
      if (apptCloses.length === 0 && closedCloses.length === 0) return;
      const view = !loc && a ? { ...a } : apptViewFrom(name, apptCloses);
      view.closing = { count: closedCloses.length, value: sum(closedCloses, (x) => x.basePrice), projectedCommission: sum(closedCloses, (x) => x.commissionAmount || 0), closes: closedCloses };
      if (view.daysSinceLastClose === null || view.daysSinceLastClose === undefined) {
        const latest = closedCloses.map((x) => new Date(x.closedAt).getTime()).filter((t) => !isNaN(t)).sort((x, y) => y - x)[0];
        view.daysSinceLastClose = latest ? Math.floor((Date.now() - latest) / 86400000) : null;
      }
      views.push(view);
    });
    // Same order as the leaderboard: biggest closed value, then most deals, then commission.
    return views.sort((x, y) => y.closing.value - x.closing.value || y.closing.count - x.closing.count || y.actualCommission - x.actualCommission || x.name.localeCompare(y.name));
  }

  function renderBody() {
    body.innerHTML = "";
    const errs = [...statsCache.errors, ...closedCache.errors].filter((e, i, all) => all.findIndex((x) => x.locationName === e.locationName) === i);
    if (errs.length > 0) {
      body.appendChild(el("div", { class: "card", style: "border-color:var(--red)" }, [
        el("div", { style: "color:var(--red);font-size:12.5px", text: `Couldn't reach: ${errs.map((e) => `${e.locationName} (${e.error})`).join(", ")}` }),
        el("div", { class: "muted", style: "font-size:10.5px;margin-top:4px", text: "Numbers below don't include this location until it's reachable again." }),
      ]));
    }
    const views = buildViews();
    if (views.length === 0) { body.appendChild(el("div", { class: "muted", text: "No sales rep activity in this period." })); return; }

    const totalDeals = sum(views, (v) => v.closing.count);
    const totalClosedValue = sum(views, (v) => v.closing.value);
    const totalArrived = sum(views, (v) => v.arrivedCount);
    const totalCommission = sum(views, (v) => v.actualCommission);
    body.appendChild(el("div", { class: "metric-grid" }, [
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Deals closed" }), el("div", { class: "metric-value", style: "color:var(--cyan)", text: totalDeals })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Closed value" }), el("div", { class: "metric-value", style: "color:var(--amber)", text: money(totalClosedValue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Cars arrived" }), el("div", { class: "metric-value", text: totalArrived })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Commission earned" }), el("div", { class: "metric-value", style: "color:var(--green)", text: money(totalCommission) })]),
    ]));
    body.appendChild(el("div", { class: "muted", style: "font-size:11px;margin:-8px 0 14px", text: "Closed = deals closed in this period, whatever day the car comes in. Arrived = cars that showed in this period and the commission they earned (matches each shop's Payroll)." }));
    views.forEach((v) => body.appendChild(renderRepCard(v, activeLocationFilter === "combined", goalFor(v.name))));
  }

  content.appendChild(picker.el);
  content.appendChild(locationTabs);
  content.appendChild(body);
  await load();
}

// ---------- Audit: every deal closed in a period, car by car - and fixable ----------
// Eastern wall-clock time as "YYYY-MM-DDTHH:mm": the format a datetime-local box wants, and what the
// shops read back as Eastern time.
function etWall(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const AUDIT_SERVICES = ["Window Tint", "Ceramic Coating", "PPF"];
const AUDIT_STATUSES = [["pending", "Pending"], ["arrived", "Arrived"], ["no_show", "No-show"], ["cancelled", "Cancelled"]];
const AUDIT_SELECT_STYLE = "max-width:100%;background:var(--panel);border:0.5px solid var(--border);border-radius:7px;color:var(--text);padding:6px 8px;font-size:13px";

async function renderAudit(content) {
  const picker = renderSimplePeriodPicker((params) => load(params), "day");
  const flash = el("div", { class: "notice", style: "margin:0 0 10px" });
  const locationTabs = el("div", { style: "display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap" });
  const addWrap = el("div");
  const body = el("div");
  let data = null, repsInfo = [], activeLocation = "combined", latestRequestId = 0, lastParams = null;

  const say = (text, ok = true) => { flash.className = "notice " + (ok ? "ok" : "err"); flash.textContent = text; };
  const repsFor = (locationId) => repsInfo.find((l) => l.locationId === locationId) || { salesReps: [] };
  const fieldRow = (label, control) => el("div", { style: "display:flex;gap:8px;align-items:center;margin-bottom:6px;flex-wrap:wrap" }, [el("span", { class: "muted", style: "font-size:11.5px;min-width:118px", text: label }), control]);
  const sum = (list, f) => list.reduce((a, x) => a + f(x), 0);

  async function loadReps() { try { repsInfo = (await api("/api/combined/salesreps")).locations; } catch (e) { repsInfo = []; } }

  async function load(params) {
    const p = params || lastParams || picker.getParams();
    lastParams = p;
    const thisId = ++latestRequestId;
    let fresh;
    try {
      fresh = await api(`/api/combined/salesrep-stats?${new URLSearchParams(p).toString()}&dateBasis=closed`);
    } catch (e) {
      if (thisId !== latestRequestId) return;
      body.innerHTML = "";
      body.appendChild(el("div", { class: "card", style: "border-color:var(--red)" }, [el("div", { style: "color:var(--red);font-size:12.5px", text: `Couldn't load: ${e.message || "something went wrong"}. Change the period or reload to try again.` })]));
      return;
    }
    if (thisId !== latestRequestId) return; // a newer request already won - drop this stale answer
    data = fresh;
    renderLocationTabs();
    renderBody();
  }

  function renderLocationTabs() {
    locationTabs.innerHTML = "";
    [["combined", "All locations"], ...data.locationsQueried.map((n) => [n, n])].forEach(([key, label]) => {
      locationTabs.appendChild(el("button", { class: "tab-btn" + (activeLocation === key ? " active" : ""), onclick: () => { activeLocation = key; renderLocationTabs(); renderBody(); }, text: label }));
    });
  }

  function closesInView() {
    const rows = [];
    data.perRep.forEach((r) => r.closes.forEach((c) => { if (activeLocation === "combined" || c.locationName === activeLocation) rows.push({ ...c, repName: r.name }); }));
    return rows;
  }

  function renderBody() {
    body.innerHTML = "";
    if (data.errors && data.errors.length > 0) {
      body.appendChild(el("div", { class: "card", style: "border-color:var(--red)" }, [
        el("div", { style: "color:var(--red);font-size:12.5px", text: `Couldn't reach: ${data.errors.map((e) => `${e.locationName} (${e.error})`).join(", ")}` }),
        el("div", { class: "muted", style: "font-size:10.5px;margin-top:4px", text: "Those closes aren't in the list below until it's reachable again." }),
      ]));
    }
    const rows = closesInView();
    body.appendChild(el("div", { class: "metric-grid" }, [
      ["Deals closed", rows.length, "var(--cyan)"], ["Closed value", money(sum(rows, (c) => c.basePrice)), "var(--amber)"],
      ["Commission if all show", money(sum(rows, (c) => c.commissionAmount || 0)), "var(--green)"],
      ["Earned so far", money(sum(rows.filter((c) => c.status === "arrived"), (c) => c.commissionAmount || 0)), "var(--green)"],
    ].map(([label, value, color]) => el("div", { class: "metric" }, [el("div", { class: "metric-label", text: label }), el("div", { class: "metric-value", style: `color:${color}`, text: value })]))));
    body.appendChild(el("div", { class: "muted", style: "font-size:11px;margin:-8px 0 14px", text: "Every deal closed in this period, by when it was closed, whatever day the car comes in. Tap Edit on any line to fix it, or ↻ if it's really a reschedule (it stays paid when the client shows). Jobs with no sales rep are in Cleanup." }));
    if (rows.length === 0) { body.appendChild(el("div", { class: "muted", text: "Nothing closed in this period." })); const l = renderLeftOut(); if (l) body.appendChild(l); return; }

    const byRep = {};
    rows.forEach((c) => { (byRep[c.repName] = byRep[c.repName] || []).push(c); });
    Object.entries(byRep)
      .map(([name, list]) => ({ name, list: list.sort((a, b) => (a.closedAt < b.closedAt ? -1 : 1)), value: sum(list, (c) => c.basePrice) }))
      .sort((a, b) => b.value - a.value || b.list.length - a.list.length || a.name.localeCompare(b.name))
      .forEach((g) => body.appendChild(renderGroup(g)));
    const leftEl = renderLeftOut();
    if (leftEl) body.appendChild(leftEl);
  }

  // Marks (or un-marks) a booking as a reschedule at its own location. The shop says which fields it applied, so a
  // location that hasn't been updated yet (it would silently ignore this) gets a clear message instead.
  async function setReschedule(c, flag) {
    if (!confirm(flag ? "Mark this as a reschedule?\n\nIt will be left out of the closing numbers (this tab, the leaderboard, Combined and Statistics), because it's the same deal moved to a new day, not a new sale.\n\nIt stays fully in Payroll: the rep is still paid commission when the client shows up. You can undo this any time." : "Count this as a close again?")) return;
    try {
      const res = await api("/api/combined/job-edit", { method: "POST", body: JSON.stringify({ locationId: c.locationId, saleId: c.id, isReschedule: flag }) });
      if (!res.applied || !res.applied.includes("isReschedule")) { say(`${c.locationName} needs the latest tracker update before this can be used there.`, false); return; }
      await load();
      say(flag ? "Left out of closing activity. It's still paid when the client shows up." : "Counted as a close again.");
    } catch (e) { say(e.message || "Couldn't change that.", false); }
  }

  // The bookings marked as reschedules in this period, so nothing is ever hidden without a way back.
  function renderLeftOut() {
    const left = (data.leftOut || []).filter((x) => activeLocation === "combined" || x.locationName === activeLocation);
    if (left.length === 0) return null;
    const n = left.length;
    const label = (open) => `${open ? "▾" : "▸"} ↻ ${n} rescheduled booking${n !== 1 ? "s" : ""} left out of closing activity (still paid when the client shows)`;
    const list = el("div", { style: "display:none;margin-top:8px" }, left.map((c) => el("div", { style: "padding:8px 0;border-top:0.5px solid var(--border)" }, [
      el("div", { class: "row", style: "align-items:flex-start" }, [
        el("div", {}, [
          el("div", { style: "font-size:13px;font-weight:500", text: c.car }),
          el("div", { class: "muted", style: "font-size:11px", text: [c.repName, c.customerName, c.locationName].filter(Boolean).join(" · ") }),
          el("div", { class: "muted", style: "font-size:10.5px", text: `Closed ${formatDateTime(c.closedAt)} · car scheduled ${formatDateTime(c.date)}` }),
          c.auto ? el("div", { style: "font-size:10.5px;color:var(--amber)", text: "Flagged automatically: the title says rescheduled" }) : null,
        ]),
        el("div", { class: "mono", style: "font-size:13px", text: money(c.basePrice) }),
      ]),
      el("button", { class: "ghost", style: "font-size:11px;padding:3px 9px;margin-top:6px", text: "Count as a close", onclick: () => setReschedule(c, false) }),
    ])));
    const toggle = el("button", { class: "ghost", style: "width:100%;text-align:left;font-size:12px;color:var(--amber)", text: label(false), onclick: () => {
      const open = list.style.display !== "none";
      list.style.display = open ? "none" : "block";
      toggle.textContent = label(!open);
    } });
    return el("div", { class: "card" }, [toggle, list]);
  }

  function renderGroup(g) {
    const rowsWrap = el("div");
    g.list.forEach((c) => rowsWrap.appendChild(renderRow(c)));
    const projected = sum(g.list, (c) => c.commissionAmount || 0);
    const earned = sum(g.list.filter((c) => c.status === "arrived"), (c) => c.commissionAmount || 0);
    const toggle = el("button", { class: "ghost", style: "font-size:11px;padding:3px 9px", text: "Hide", onclick: () => {
      const hidden = rowsWrap.style.display === "none";
      rowsWrap.style.display = hidden ? "" : "none";
      toggle.textContent = hidden ? "Hide" : "Show";
    } });
    return el("div", { class: "card" }, [
      el("div", { class: "row" }, [
        el("div", {}, [
          el("div", { style: "font-weight:500;font-size:16px", text: g.name }),
          el("div", { class: "muted", style: "font-size:12px", text: `${g.list.length} deal${g.list.length !== 1 ? "s" : ""} closed · ${money(g.value)} · ${money(projected)} if all show · ${money(earned)} earned` }),
        ]),
        toggle,
      ]),
      rowsWrap,
    ]);
  }

  function renderRow(c) {
    const slot = el("div");
    const statusColor = c.status === "arrived" ? "var(--green)" : c.status === "no_show" ? "var(--red)" : "var(--sub)";
    const commText = c.status === "arrived" ? `+${money(c.commissionAmount)} earned` : c.status === "no_show" ? "no-show, earns nothing" : c.status === "cancelled" ? "cancelled" : `${money(c.commissionAmount)} if it shows`;
    const editBtn = el("button", { class: "ghost", style: "font-size:11px;padding:3px 9px", text: "Edit", onclick: () => {
      if (slot.firstChild) { slot.innerHTML = ""; return; }
      buildEditor(c, slot);
    } });
    return el("div", { style: "padding:9px 0;border-top:0.5px solid var(--border);margin-top:8px" }, [
      el("div", { class: "row", style: "align-items:flex-start" }, [
        el("div", {}, [
          el("div", { style: "font-size:13.5px;font-weight:500", text: c.car }),
          el("div", { class: "muted", style: "font-size:11.5px", text: [c.customerName, c.locationName].filter(Boolean).join(" · ") }),
        ]),
        el("div", { style: "text-align:right" }, [
          el("div", { class: "mono", style: "font-size:14px", text: money(c.basePrice) }),
          el("div", { style: `font-size:10.5px;color:${statusColor}`, text: c.status }),
        ]),
      ]),
      el("div", { class: "muted", style: "font-size:11px;margin-top:3px", text: `Closed ${formatDateTime(c.closedAt)} · ${c.duringHours ? "in-hours" : "after-hours"} · car scheduled ${formatDateTime(c.date)} · ${commText}` }),
      el("div", { style: "margin-top:6px;display:flex;gap:8px;flex-wrap:wrap" }, [
        editBtn,
        el("button", { class: "ghost", style: "font-size:11px;padding:3px 9px", text: "↻ Reschedule: don't count", onclick: () => setReschedule(c, true) }),
      ]),
      slot,
    ]);
  }

  function buildEditor(c, slot) {
    const info = repsFor(c.locationId);
    const panel = el("div", { style: "margin-top:8px;padding:10px 12px;background:var(--panel);border:0.5px solid var(--border);border-radius:8px" });
    slot.appendChild(panel);
    if (info.needsUpdate) {
      panel.appendChild(el("div", { style: "color:var(--red);font-size:12.5px", text: `${c.locationName} needs the latest tracker update before jobs can be edited from here.` }));
      return;
    }
    const closedIn = el("input", { type: "datetime-local", value: etWall(c.closedAt), style: "max-width:210px" });
    const dateIn = el("input", { type: "datetime-local", value: etWall(c.date), style: "max-width:210px" });
    const carIn = el("input", { type: "text", value: c.car, style: "max-width:100%" });
    const priceIn = el("input", { type: "number", step: "0.01", min: "0", value: c.basePrice, style: "max-width:130px" });
    const svcOptions = [...new Set([...AUDIT_SERVICES, c.baseService].filter(Boolean))];
    const svcIn = el("select", { style: AUDIT_SELECT_STYLE }, [el("option", { value: "", text: "(not set)" }), ...svcOptions.map((v) => el("option", { value: v, text: v }))]);
    svcIn.value = c.baseService || "";
    const statusIn = el("select", { style: AUDIT_SELECT_STYLE }, AUDIT_STATUSES.map(([v, t]) => el("option", { value: v, text: t })));
    statusIn.value = c.status;
    const currentRep = info.salesReps.find((r) => r.name === c.repName);
    const repIn = el("select", { style: AUDIT_SELECT_STYLE }, [
      ...(currentRep ? [] : [el("option", { value: "", text: `${c.repName} (unchanged)` })]),
      ...info.salesReps.map((r) => el("option", { value: r.id, text: r.name })),
      el("option", { value: "__walkin__", text: "Walk-in (no rep commission)" }),
      el("option", { value: "__online__", text: "Online booking (no rep)" }),
    ]);
    repIn.value = currentRep ? currentRep.id : "";
    const msg = el("div", { style: "font-size:12px;margin-top:6px" });
    const saveBtn = el("button", { class: "primary", text: "Save", onclick: async () => {
      const changes = {};
      if (closedIn.value && closedIn.value !== etWall(c.closedAt)) changes.closedAt = closedIn.value;
      if (dateIn.value && dateIn.value !== etWall(c.date)) changes.date = dateIn.value;
      if (carIn.value.trim() && carIn.value.trim() !== c.car) changes.car = carIn.value.trim();
      if (priceIn.value !== "" && parseFloat(priceIn.value) !== c.basePrice) changes.basePrice = priceIn.value;
      if (svcIn.value && svcIn.value !== (c.baseService || "")) changes.baseService = svcIn.value;
      if (statusIn.value !== c.status) changes.status = statusIn.value;
      if (repIn.value && repIn.value !== (currentRep ? currentRep.id : "")) {
        if (repIn.value === "__walkin__") changes.isWalkIn = true;
        else if (repIn.value === "__online__") changes.isOnlineBooking = true;
        else changes.salesRepId = repIn.value;
      }
      if (Object.keys(changes).length === 0) { msg.style.color = "var(--sub)"; msg.textContent = "Nothing changed."; return; }
      saveBtn.disabled = true; msg.style.color = "var(--sub)"; msg.textContent = "Saving…";
      try {
        await api("/api/combined/job-edit", { method: "POST", body: JSON.stringify({ locationId: c.locationId, saleId: c.id, ...changes }) });
        await load();
        const stillHere = closesInView().some((x) => x.id === c.id && x.locationId === c.locationId);
        say(stillHere ? "Saved." : "Saved. That job no longer falls in this view; check its new date, rep or status.");
      } catch (e) {
        saveBtn.disabled = false; msg.style.color = "var(--red)"; msg.textContent = e.message || "Couldn't save.";
      }
    } });
    panel.appendChild(el("div", { class: "muted", style: "font-size:11px;margin-bottom:8px", text: "Times are Eastern. Changing the closing time changes which day it counts on and whether the in-hours or after-hours rate applies." }));
    panel.appendChild(fieldRow("Closed at", closedIn));
    panel.appendChild(fieldRow("Car scheduled", dateIn));
    panel.appendChild(fieldRow("Title", carIn));
    panel.appendChild(fieldRow("Price", priceIn));
    panel.appendChild(fieldRow("Service", svcIn));
    panel.appendChild(fieldRow("Sales rep", repIn));
    panel.appendChild(fieldRow("Status", statusIn));
    panel.appendChild(el("div", { style: "display:flex;gap:8px;margin-top:8px" }, [saveBtn, el("button", { class: "ghost", text: "Cancel", onclick: () => { slot.innerHTML = ""; } })]));
    panel.appendChild(msg);
  }

  function toggleAddForm() {
    if (addWrap.firstChild) { addWrap.innerHTML = ""; return; }
    if (repsInfo.length === 0) { say("Couldn't load your locations just now. Reload and try again.", false); return; }
    const card = el("div", { class: "card" });
    const locSel = el("select", { style: AUDIT_SELECT_STYLE }, repsInfo.map((l) => el("option", { value: l.locationId, text: l.locationName })));
    const customerIn = el("input", { type: "text", placeholder: "Customer name", style: "max-width:100%" });
    const carIn = el("input", { type: "text", placeholder: "Car / title, e.g. FK 2020 Tesla Model 3 Full Tint", style: "max-width:100%" });
    const apptIn = el("input", { type: "datetime-local", style: "max-width:210px" });
    const closedIn = el("input", { type: "datetime-local", value: etWall(new Date().toISOString()), style: "max-width:210px" });
    const priceIn = el("input", { type: "number", step: "0.01", min: "0", placeholder: "0.00", style: "max-width:130px" });
    const svcSel = el("select", { style: AUDIT_SELECT_STYLE }, [el("option", { value: "", text: "(not set)" }), ...AUDIT_SERVICES.map((v) => el("option", { value: v, text: v }))]);
    const statusSel = el("select", { style: AUDIT_SELECT_STYLE }, [["pending", "Pending"], ["arrived", "Arrived"], ["no_show", "No-show"]].map(([v, t]) => el("option", { value: v, text: t })));
    const repSel = el("select", { style: AUDIT_SELECT_STYLE });
    const msg = el("div", { style: "font-size:12px;margin-top:8px" });
    const extra = el("div", { style: "margin-top:6px" });
    function fillReps() {
      const info = repsFor(locSel.value);
      repSel.innerHTML = "";
      [el("option", { value: "", text: "Choose a sales rep…" }), ...info.salesReps.map((r) => el("option", { value: r.id, text: r.name })),
        el("option", { value: "__walkin__", text: "Walk-in (no rep commission)" }), el("option", { value: "__online__", text: "Online booking (no rep)" })].forEach((o) => repSel.appendChild(o));
      msg.style.color = "var(--red)";
      msg.textContent = info.needsUpdate ? `${info.locationName} needs the latest tracker update before jobs can be added from here.` : "";
    }
    locSel.addEventListener("change", fillReps);
    fillReps();
    const bad = (t) => { msg.style.color = "var(--red)"; msg.textContent = t; };
    async function submit(force) {
      extra.innerHTML = "";
      if (!carIn.value.trim()) return bad("Enter the car / title.");
      if (!apptIn.value) return bad("Enter the appointment date and time.");
      if (!repSel.value) return bad("Choose a sales rep, or Walk-in / Online booking.");
      const payload = { locationId: locSel.value, customerName: customerIn.value.trim(), car: carIn.value.trim(), date: apptIn.value, closedAt: closedIn.value || undefined, basePrice: priceIn.value, baseService: svcSel.value, status: statusSel.value, force: !!force };
      if (repSel.value === "__walkin__") payload.isWalkIn = true; else if (repSel.value === "__online__") payload.isOnlineBooking = true; else payload.salesRepId = repSel.value;
      msg.style.color = "var(--sub)"; msg.textContent = "Adding…";
      try {
        const res = await api("/api/combined/job-add", { method: "POST", body: JSON.stringify(payload) });
        addWrap.innerHTML = "";
        await load();
        const inView = closesInView().some((x) => x.id === res.id);
        say(inView ? "Added. It's in the list below." : "Added. Its closing time falls outside this period, so switch the period to see it.");
      } catch (e) {
        if (e.data && e.data.duplicate) {
          bad(e.message);
          extra.appendChild(el("button", { class: "ghost", text: "Add anyway", onclick: () => submit(true) }));
        } else bad(e.message || "Couldn't add that job.");
      }
    }
    card.appendChild(el("div", { style: "font-weight:500;margin-bottom:4px", text: "Add a missing job" }));
    card.appendChild(el("div", { class: "muted", style: "font-size:11px;margin-bottom:10px", text: "Only for a job that never reached the tracker. Set the closing time to when the deal was actually closed; that decides the day it counts on and the commission rate." }));
    card.appendChild(fieldRow("Location", locSel));
    card.appendChild(fieldRow("Customer", customerIn));
    card.appendChild(fieldRow("Title", carIn));
    card.appendChild(fieldRow("Car scheduled", apptIn));
    card.appendChild(fieldRow("Closed at", closedIn));
    card.appendChild(fieldRow("Price", priceIn));
    card.appendChild(fieldRow("Service", svcSel));
    card.appendChild(fieldRow("Sales rep", repSel));
    card.appendChild(fieldRow("Status", statusSel));
    card.appendChild(el("div", { style: "display:flex;gap:8px;margin-top:8px" }, [el("button", { class: "primary", text: "Add job", onclick: () => submit(false) }), el("button", { class: "ghost", text: "Cancel", onclick: () => { addWrap.innerHTML = ""; } })]));
    card.appendChild(msg);
    card.appendChild(extra);
    addWrap.appendChild(card);
  }

  content.appendChild(picker.el);
  content.appendChild(locationTabs);
  content.appendChild(el("div", { style: "margin-bottom:12px" }, [el("button", { class: "ghost", text: "＋ Add a missing job", onclick: toggleAddForm })]));
  content.appendChild(addWrap);
  content.appendChild(flash);
  content.appendChild(body);
  await Promise.all([loadReps(), load()]);
}

// ---- DEAL SOUNDS: DATA START ----
// The funny sound that plays when a "Deal closed!" banner pops up. Made in the browser from simple tones and noise, so there are no audio files to
// host, load, or worry about owning. Each voice is one sound layered on the others: type (a wave shape, or "noise"), when it starts (at), how long it lasts
// (dur), how loud (gain), its pitch (freq, sliding to freqEnd), an optional wobble (vibrato), an optional band-pass "nasal" filter, and decay (rings out like a bell).
// Each sound also has a level that evens out how loud it is next to the others (worked out from the rendered audio), so "Random" never blasts one and whispers the next.
const DEAL_SOUNDS = {
  chaching: { name: "Cha-ching 💰", level: 1.86, voices: [
    { type: "noise", at: 0, dur: 0.07, gain: 0.5, bandpass: 2800 },
    { type: "triangle", at: 0.08, dur: 1.0, gain: 0.4, freq: 2093, decay: true },
    { type: "triangle", at: 0.16, dur: 1.2, gain: 0.32, freq: 2637, decay: true },
    { type: "sine", at: 0.08, dur: 0.9, gain: 0.15, freq: 4186, decay: true },
  ] },
  airhorn: { name: "Air horn 📯", level: 0.69, voices: [
    ...[0, 0.32].flatMap((at) => [
      { type: "sawtooth", at, dur: 0.26, gain: 0.26, freq: 466, freqEnd: 440 },
      { type: "sawtooth", at, dur: 0.26, gain: 0.26, freq: 474, freqEnd: 446 },
      { type: "square", at, dur: 0.26, gain: 0.1, freq: 932 },
    ]),
    { type: "sawtooth", at: 0.64, dur: 0.8, gain: 0.26, freq: 466, freqEnd: 420 },
    { type: "sawtooth", at: 0.64, dur: 0.8, gain: 0.26, freq: 474, freqEnd: 426 },
    { type: "square", at: 0.64, dur: 0.8, gain: 0.1, freq: 932, freqEnd: 840 },
  ] },
  kazoo: { name: "Kazoo fanfare 🎺", level: 1.79, voices: [[523, 0, 0.13], [659, 0.15, 0.13], [784, 0.3, 0.13], [1047, 0.45, 0.55]].map(([freq, at, dur]) => (
    { type: "sawtooth", at, dur, gain: 0.22, freq, vibrato: { rate: 24, depth: 9 }, bandpass: 1400 })) },
  boing: { name: "Boing 🪀", level: 0.45, voices: [
    { type: "sine", at: 0, dur: 0.28, gain: 0.5, freq: 160, freqEnd: 820, vibrato: { rate: 16, depth: 45 } },
    { type: "sine", at: 0.26, dur: 0.5, gain: 0.45, freq: 820, freqEnd: 240, vibrato: { rate: 14, depth: 55 } },
  ] },
  party: { name: "Party horn 🎉", level: 1.22, voices: [
    { type: "square", at: 0, dur: 0.18, gain: 0.18, freq: 740, freqEnd: 1180, bandpass: 1800 },
    ...[523, 659, 784, 1047].map((freq) => ({ type: "triangle", at: 0.24, dur: 0.75, gain: 0.12, freq, release: 0.25 })),   // a held "ta-da" chord
  ] },
  duck: { name: "Duck quack 🦆", level: 1.48, voices: [0, 0.3].map((at) => (
    { type: "sawtooth", at, dur: 0.17, gain: 0.4, freq: 760, freqEnd: 300, bandpass: 1200, vibrato: { rate: 38, depth: 25 } })) },
};
const DEAL_VOLUMES = { low: 0.25, medium: 0.55, high: 0.95 };
// ---- DEAL SOUNDS: DATA END ----

// ---- DEAL SOUNDS: CUSTOM LEVEL START ----
// Sounds the owner uploads come in at every loudness there is, so each one gets a level that brings it to the same average loudness as the built-in
// sounds (without its loudest moment ever passing 92% of full scale at HIGH volume). Silence at the start and end is ignored when measuring.
const MAX_CUSTOM_SECONDS = 12;
const CUSTOM_TARGET_RMS = 0.0708;
function customSoundLevel(channels) {
  const n = channels[0].length;
  let peak = 0, first = -1, last = -1;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let c = 0; c < channels.length; c++) { const v = Math.abs(channels[c][i]); if (v > m) m = v; }
    if (m > peak) peak = m;
    if (m > 0.002) { if (first < 0) first = i; last = i; }
  }
  if (first < 0) return { silent: true, level: 1, peak, rms: 0 };
  let sum = 0, count = 0;
  for (let i = first; i <= last; i++) for (let c = 0; c < channels.length; c++) { sum += channels[c][i] * channels[c][i]; count += 1; }
  const rms = Math.sqrt(sum / count);
  const level = Math.max(0.05, Math.min(CUSTOM_TARGET_RMS / (rms * DEAL_VOLUMES.medium), 0.92 / (DEAL_VOLUMES.high * peak), 8));   // loudness is matched AT MEDIUM volume, like the built-in sounds
  return { silent: false, level, peak, rms };
}
// ---- DEAL SOUNDS: CUSTOM LEVEL END ----

// ---- DEAL SOUNDS: ROKU WAV START ----
// The Roku plays WAV files, so each of the owner's own sounds also gets a Roku copy: a 16-bit mono WAV at 22,050 Hz, brought to the same loudness as the
// built-in sounds (so one clip never blasts while another whispers) and never longer than the limit. The browser makes it, because a browser can read
// any audio format; the tracker only checks it and keeps it.
const TV_WAV_RATE = 22050, TV_TARGET_RMS = 0.14, TV_PEAK_CAP = 0.92;
function makeTvWav(channels, srcRate) {
  const total = channels[0].length, seconds = Math.min(total / srcRate, MAX_CUSTOM_SECONDS), n = Math.floor(seconds * TV_WAV_RATE);
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * srcRate / TV_WAV_RATE, i0 = Math.floor(pos), f = pos - i0;
    let s = 0;
    for (let c = 0; c < channels.length; c++) { const d = channels[c], x = d[i0] || 0, y = d[Math.min(i0 + 1, d.length - 1)] || 0; s += x + (y - x) * f; }
    mono[i] = s / channels.length;
  }
  let peak = 0, first = -1, last = -1;
  for (let i = 0; i < n; i++) { const m = Math.abs(mono[i]); if (m > peak) peak = m; if (m > 0.002) { if (first < 0) first = i; last = i; } }
  if (first < 0) return { silent: true, bytes: null };
  let sum = 0;
  for (let i = first; i <= last; i++) sum += mono[i] * mono[i];
  const rms = Math.sqrt(sum / (last - first + 1)), gain = Math.max(0.05, Math.min(TV_TARGET_RMS / rms, TV_PEAK_CAP / peak, 8));
  const fade = Math.min(Math.round(0.008 * TV_WAV_RATE), n >> 1);
  const bytes = new Uint8Array(44 + n * 2), v = new DataView(bytes.buffer);
  const tag = (o, str) => { for (let i = 0; i < str.length; i++) bytes[o + i] = str.charCodeAt(i); };
  tag(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); tag(8, "WAVE"); tag(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, TV_WAV_RATE, true); v.setUint32(28, TV_WAV_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    let x = mono[i] * gain;
    if (i < fade) x *= i / fade; else if (n - 1 - i < fade) x *= (n - 1 - i) / fade;       // a few thousandths of a second of fade at each end, so there is no click
    v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x * 32767))), true);
  }
  return { silent: false, bytes, gain };
}
// ---- DEAL SOUNDS: ROKU WAV END ----
// Makes the Roku copy of an already-decoded sound and sends it to the tracker. true if the tracker accepted it.
async function prepareForRoku(id, audioBuffer) {
  try {
    const channels = [];
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) channels.push(audioBuffer.getChannelData(c));
    const w = makeTvWav(channels, audioBuffer.sampleRate);
    if (!w.bytes) return false;
    const r = await fetch(`/api/sounds/${id}/tv-wav`, { method: "PUT", headers: { "Content-Type": "audio/wav" }, body: w.bytes, credentials: "same-origin" });
    return r.ok;
  } catch (e) { return false; }
}

// Browsers refuse to play sound until the person has tapped or clicked the page once, so the sound system is only woken up by a tap.
let dealAudio = null;
const dealCustom = { list: [], buffers: new Map(), pending: new Map(), current: null };   // the owner's own sounds: the list, the ones ready to play, the ones being fetched, the one playing now
const dealRepSounds = new Map();                 // each rep's own sound: rep name (lowercase, single spaces) -> "chaching" ... or "custom:<id>"; reps not in here use the screen's choice
const repKeyOf = (name) => String(name || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
function applyRepSoundList(list) { dealRepSounds.clear(); list.forEach((r) => dealRepSounds.set(r.key, r.choice)); }
// The sound a rep is set to, or null (use the screen's choice) if they have none, or theirs has since been deleted.
function repChoiceFor(repName) {
  const c = dealRepSounds.get(repKeyOf(repName));
  if (!c) return null;
  if (DEAL_SOUNDS[c]) return c;
  return c.indexOf("custom:") === 0 && dealCustom.list.some((s) => "custom:" + s.id === c) ? c : null;
}
// Wakes the sound system (this needs a tap) and then runs `then`. Used by Settings, outside the leaderboard.
function wakeDealAudio(then) {
  const ctx = dealAudioContext();
  if (!ctx) return;
  const done = () => { if (ctx.state === "running" && then) then(); };
  if (ctx.state === "running") { done(); return; }
  Promise.resolve(ctx.resume()).then(done, done);
}
async function previewRepSound(choice) {
  if (choice.indexOf("custom:") === 0) await loadCustomBuffer(choice.slice(7));
  playDealSound(choice, loadDealSoundPrefs().volume);
}
function dealAudioContext() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!dealAudio) { try { dealAudio = new AC(); } catch (e) { return null; } }
  return dealAudio;
}
function loadDealSoundPrefs() {
  let choice = "random", volume = "medium";
  try {
    const c = localStorage.getItem("dealSoundChoice"), v = localStorage.getItem("dealSoundVolume");
    if (c && (c === "off" || c === "random" || c === "custom-random" || DEAL_SOUNDS[c] || /^custom:[a-f0-9]{16}$/.test(c))) choice = c;
    if (v && DEAL_VOLUMES[v] != null) volume = v;
  } catch (e) { /* storage blocked: the defaults are fine */ }
  return { choice, volume };
}
function saveDealSoundPrefs(p) { try { localStorage.setItem("dealSoundChoice", p.choice); localStorage.setItem("dealSoundVolume", p.volume); } catch (e) { /* nothing to do */ } }
const readDealFile = (file) => file.arrayBuffer ? file.arrayBuffer() : new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = reject; fr.readAsArrayBuffer(file); });
function decodeDealAudio(ctx, arrayBuffer) {     // works with both the promise and the older callback form of decodeAudioData
  return new Promise((resolve, reject) => { try { const p = ctx.decodeAudioData(arrayBuffer, resolve, reject); if (p && typeof p.then === "function") p.then(resolve, reject); } catch (e) { reject(e); } });
}
function analyseCustomBuffer(buf) {
  const limit = Math.min(buf.length, Math.floor(MAX_CUSTOM_SECONDS * buf.sampleRate)), channels = [];
  for (let c = 0; c < buf.numberOfChannels; c++) { const ch = buf.getChannelData(c); channels.push(ch.subarray ? ch.subarray(0, limit) : ch.slice(0, limit)); }
  return customSoundLevel(channels);
}
// Fetches one of the owner's sounds and gets it ready to play (needs the sound system awake, i.e. after the first tap).
function loadCustomBuffer(id) {
  if (dealCustom.buffers.has(id)) return Promise.resolve(dealCustom.buffers.get(id));
  if (dealCustom.pending.has(id)) return dealCustom.pending.get(id);
  const ctx = dealAudio;
  if (!ctx) return Promise.resolve(null);
  const p = (async () => {
    try {
      const r = await fetch(`/api/sounds/${id}/file`, { credentials: "same-origin" });
      if (!r.ok) return null;
      const buf = await decodeDealAudio(ctx, await r.arrayBuffer());
      const info = analyseCustomBuffer(buf);
      if (info.silent) return null;
      const entry = { buffer: buf, level: info.level, seconds: buf.duration };
      dealCustom.buffers.set(id, entry);
      return entry;
    } catch (e) { return null; } finally { dealCustom.pending.delete(id); }
  })();
  dealCustom.pending.set(id, p);
  return p;
}
function stopCustomPlayback() {
  const c = dealCustom.current;
  if (!c) return;
  dealCustom.current = null;
  try { c.src.stop(); } catch (e) { /* it had already finished */ }
}
function playCustomSound(id, volumeKey) {
  const ctx = dealAudio, entry = dealCustom.buffers.get(id);
  if (!ctx || ctx.state !== "running" || !entry) return false;
  stopCustomPlayback();                           // a new banner cuts off a clip that is still playing
  const t0 = ctx.currentTime + 0.02, dur = Math.min(entry.seconds, MAX_CUSTOM_SECONDS);
  const vol = (DEAL_VOLUMES[volumeKey] != null ? DEAL_VOLUMES[volumeKey] : DEAL_VOLUMES.medium) * entry.level;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t0);
  if (entry.seconds > MAX_CUSTOM_SECONDS) { g.gain.setValueAtTime(vol, t0 + dur - 0.4); g.gain.linearRampToValueAtTime(0.0001, t0 + dur); }   // never longer than the limit: fade out at the end
  g.connect(ctx.destination);
  const src = ctx.createBufferSource();
  src.buffer = entry.buffer; src.connect(g);
  src.start(t0); src.stop(t0 + dur + 0.05);
  dealCustom.current = { src, g };
  src.onended = () => { try { g.disconnect(); } catch (e) { /* already gone */ } if (dealCustom.current && dealCustom.current.src === src) dealCustom.current = null; };
  return true;
}
// Plays one sound if the browser has allowed sound; returns which one played, or false.
function playDealSound(choice, volumeKey) {
  const ctx = dealAudioContext();
  if (!ctx || ctx.state !== "running") return false;
  stopCustomPlayback();
  const builtIn = Object.keys(DEAL_SOUNDS);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const customReady = dealCustom.list.filter((s) => dealCustom.buffers.has(s.id)).map((s) => "custom:" + s.id);
  let key = choice;
  if (choice === "random") key = pick(builtIn.concat(customReady));            // Random includes the owner's own sounds
  else if (choice === "custom-random") key = customReady.length ? pick(customReady) : pick(builtIn);
  if (typeof key === "string" && key.indexOf("custom:") === 0) {
    if (playCustomSound(key.slice(7), volumeKey)) return key;
    loadCustomBuffer(key.slice(7));               // not ready yet (or it was deleted): get it for next time, and play a built-in this once so the banner is never silent
    key = pick(builtIn);
  }
  const def = DEAL_SOUNDS[key];
  if (!def) return false;
  const master = ctx.createGain();
  master.gain.value = (DEAL_VOLUMES[volumeKey] != null ? DEAL_VOLUMES[volumeKey] : DEAL_VOLUMES.medium) * (def.level || 1);
  master.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.02;
  let last = 0;
  def.voices.forEach((v) => {
    const start = t0 + v.at, end = start + v.dur, attack = v.attack || 0.01, release = v.release || 0.08;
    last = Math.max(last, v.at + v.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(v.gain, start + attack);
    if (v.decay) g.gain.exponentialRampToValueAtTime(0.0001, end);                        // bells ring out
    else { g.gain.setValueAtTime(v.gain, Math.max(start + attack, end - release)); g.gain.linearRampToValueAtTime(0.0001, end); }
    let src;
    if (v.type === "noise") {
      const len = Math.max(1, Math.ceil(ctx.sampleRate * v.dur));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate), data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      src = ctx.createBufferSource(); src.buffer = buf;
    } else {
      src = ctx.createOscillator(); src.type = v.type;
      src.frequency.setValueAtTime(v.freq, start);
      if (v.freqEnd) src.frequency.exponentialRampToValueAtTime(v.freqEnd, end);
      if (v.vibrato) {
        const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
        lfo.frequency.value = v.vibrato.rate; lfoGain.gain.value = v.vibrato.depth;
        lfo.connect(lfoGain); lfoGain.connect(src.frequency);
        lfo.start(start); lfo.stop(end + 0.05);
      }
    }
    if (v.bandpass) { const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = v.bandpass; src.connect(f); f.connect(g); } else src.connect(g);
    g.connect(master);
    src.start(start); src.stop(end + 0.05);
  });
  setTimeout(() => { try { master.disconnect(); } catch (e) { /* already gone */ } }, (last + 0.4) * 1000);
  return key;
}

async function renderLeaderboard(app) {
  const wrap = el("div", { style: "background:var(--bg);min-height:100vh;padding:32px 40px" });
  const exitBtn = el("button", { class: "ghost", style: "position:fixed;top:16px;right:16px;z-index:10", onclick: () => { currentTab = "combined"; render(); }, text: "✕ Exit" });
  const clockEl = el("div", { class: "muted mono", style: "font-size:15px" });
  const header = el("div", { style: "display:flex;justify-content:space-between;align-items:baseline;margin-bottom:28px" }, [
    el("div", {}, [
      el("div", { class: "oswald", style: "font-size:34px;font-weight:600;color:var(--chrome);letter-spacing:0.02em", text: "TODAY'S LEADERBOARD" }),
      el("div", { class: "muted", style: "font-size:14px;margin-top:4px", text: "All locations combined \u00B7 ranked by total value closed today" }),
    ]),
    clockEl,
  ]);
  const list = el("div", {});
  const errorBanner = el("div", {});
  wrap.appendChild(exitBtn);
  wrap.appendChild(header);
  wrap.appendChild(errorBanner);
  wrap.appendChild(list);
  app.appendChild(wrap);
  // Where "Deal closed!" announcements slide in, above everything else on the TV.
  const bannerLayer = el("div", { style: "position:fixed;top:0;left:0;right:0;z-index:20;pointer-events:none;padding:0 24px" });
  wrap.appendChild(bannerLayer);

  // ---- the deal sound: its on-screen control, bottom-right ----
  const soundPrefs = loadDealSoundPrefs();
  const soundSupported = !!(window.AudioContext || window.webkitAudioContext);
  const clearKids = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };
  const soundHint = el("div", { style: "display:none;font-size:12.5px;color:var(--amber);background:var(--panel);border:0.5px solid var(--amber);border-radius:8px;padding:6px 10px;max-width:300px;text-align:right", text: "🔇 Tap anywhere once to turn the deal sound on (browsers need one tap)" });
  const soundPanel = el("div", { style: "display:none;background:var(--panel);border:0.5px solid var(--border);border-radius:10px;padding:12px;width:290px;max-height:70vh;overflow-y:auto" });
  const soundBtn = el("button", { class: "ghost", style: "font-size:13px" });
  const choiceSel = el("select", { style: "width:100%;margin-bottom:8px" });
  const volumeSel = el("select", { style: "width:100%;margin-bottom:8px" }, [el("option", { value: "low", text: "Volume: low" }), el("option", { value: "medium", text: "Volume: medium" }), el("option", { value: "high", text: "Volume: high" })]);
  const testBtn = el("button", { class: "ghost", style: "width:100%", text: "▶ Test the sound" });
  const customList = el("div", { style: "margin-top:6px" });
  const customStatus = el("div", { style: "font-size:11.5px;margin-top:6px;min-height:14px;color:var(--sub)" });
  const fileInput = el("input", { type: "file", accept: "audio/*,.mp3,.wav,.ogg,.m4a,.aac,.webm,.flac", style: "display:none" });
  const addBtn = el("button", { class: "ghost", style: "width:100%", text: "➕ Add my own sound…" });
  volumeSel.value = soundPrefs.volume;
  const audioRunning = () => !!(dealAudio && dealAudio.state === "running");
  const customNameOf = (choice) => { const s = dealCustom.list.find((x) => "custom:" + x.id === choice); return s ? s.name : null; };
  function choiceLabel() {
    const c = soundPrefs.choice;
    if (c === "random") return "Random 🎲";
    if (c === "custom-random") return "Random: my sounds 🎲";
    if (c.indexOf("custom:") === 0) return "🎵 " + (customNameOf(c) || "my sound");
    return DEAL_SOUNDS[c].name;
  }
  function rebuildChoiceOptions() {
    clearKids(choiceSel);
    const opt = (v, t) => el("option", { value: v, text: t });
    choiceSel.appendChild(opt("random", "Random 🎲 (all sounds)"));
    Object.entries(DEAL_SOUNDS).forEach(([k, d]) => choiceSel.appendChild(opt(k, d.name)));
    if (dealCustom.list.length) {
      const g = document.createElement("optgroup"); g.label = "My sounds";
      g.appendChild(opt("custom-random", "Random: just my sounds 🎲"));
      dealCustom.list.forEach((s) => g.appendChild(opt("custom:" + s.id, "🎵 " + s.name)));
      choiceSel.appendChild(g);
    }
    choiceSel.appendChild(opt("off", "Off (silent)"));
    choiceSel.value = soundPrefs.choice;
  }
  function refreshSoundUi() {
    const on = soundPrefs.choice !== "off";
    soundBtn.textContent = !on ? "🔇 Deal sound: off" : `🔊 Deal sound: ${choiceLabel()}`;
    soundHint.style.display = on && !audioRunning() ? "block" : "none";
  }
  function say(text, color) { customStatus.textContent = text; customStatus.style.color = color || "var(--sub)"; }
  // Gets the sounds that might be needed ready ahead of time, so the first banner after a tap isn't waiting on a download.
  function prefetchCustom() {
    if (!dealAudio) return;
    const c = soundPrefs.choice;
    const ids = new Set(c.indexOf("custom:") === 0 ? [c.slice(7)] : (c === "random" || c === "custom-random") ? dealCustom.list.map((s) => s.id) : []);
    dealRepSounds.forEach((choice) => { if (choice.indexOf("custom:") === 0) ids.add(choice.slice(7)); });   // and the clips any rep is set to
    ids.forEach((id) => loadCustomBuffer(id));
  }
  // Wakes the sound up (needs a tap), then runs `then` once it is awake.
  function wakeSound(then) {
    const ctx = dealAudioContext();
    if (!ctx) return;
    const done = () => { refreshSoundUi(); if (audioRunning()) { prefetchCustom(); if (then) then(); } };
    if (ctx.state === "running") { done(); return; }
    Promise.resolve(ctx.resume()).then(done, done);
  }
  async function preview() {
    if (soundPrefs.choice === "off") return;       // "Off" means silent, including Test
    if (soundPrefs.choice.indexOf("custom:") === 0) await loadCustomBuffer(soundPrefs.choice.slice(7));
    else if (soundPrefs.choice === "custom-random") await Promise.all(dealCustom.list.map((s) => loadCustomBuffer(s.id)));
    playDealSound(soundPrefs.choice, soundPrefs.volume);
  }
  function renderCustomList() {
    clearKids(customList);
    if (!dealCustom.list.length) { customList.appendChild(el("div", { class: "muted", style: "font-size:12px", text: "No sounds of your own yet." })); return; }
    dealCustom.list.forEach((s) => customList.appendChild(el("div", { class: "row", style: "gap:6px;margin-bottom:4px;align-items:center" }, [
      el("span", { style: "flex:1;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap", text: "🎵 " + s.name }),
      el("button", { class: "ghost", style: "padding:2px 8px;font-size:12px", title: "Play it", text: "▶", onclick: () => wakeSound(async () => { await loadCustomBuffer(s.id); playCustomSound(s.id, soundPrefs.volume); }) }),
      el("button", { class: "ghost", style: "padding:2px 8px;font-size:12px", title: "Delete it", text: "🗑", onclick: async () => {
        if (!confirm(`Delete “${s.name}”?`)) return;
        try { await api(`/api/sounds/${s.id}`, { method: "DELETE" }); say(`Deleted “${s.name}”.`); await refreshCustomSounds(); } catch (e) { say(e.message || "Couldn't delete that.", "var(--red)"); }
      } }),
    ])));
  }
  function applyCustomList(list) {
    const sig = (l) => JSON.stringify(l.map((s) => [s.id, s.name]));
    const changed = sig(list) !== sig(dealCustom.list);
    dealCustom.list = list;
    Array.from(dealCustom.buffers.keys()).forEach((id) => { if (!list.some((s) => s.id === id)) dealCustom.buffers.delete(id); });
    const c = soundPrefs.choice;
    if ((c.indexOf("custom:") === 0 && !list.some((s) => "custom:" + s.id === c)) || (c === "custom-random" && !list.length)) { soundPrefs.choice = "random"; saveDealSoundPrefs(soundPrefs); }   // the sound it was set to is gone
    if (changed) { rebuildChoiceOptions(); renderCustomList(); }
    refreshSoundUi();
    prefetchCustom();
  }
  async function refreshCustomSounds() {
    try { applyCustomList(await api("/api/sounds")); } catch (e) { /* offline for a moment: keep what we have */ }
  }
  async function refreshRepSounds() {
    try { applyRepSoundList(await api("/api/rep-sounds")); prefetchCustom(); } catch (e) { /* offline for a moment: keep what we have */ }
  }
  const refreshAllSounds = () => refreshCustomSounds().then(refreshRepSounds);   // the list of clips first, so a rep's choice can be checked against it
  async function addCustomSound(file) {
    const bad = "var(--red)";
    if (!file) return;
    if (file.size === 0) return say("That file is empty.", bad);
    if (file.size > 3 * 1024 * 1024) return say(`That file is ${(file.size / 1048576).toFixed(1)} MB. Please keep it under 3 MB.`, bad);
    const ctx = dealAudioContext();
    if (!ctx) return say("This browser can't play custom sounds.", bad);
    say("Checking the sound…");
    let buf;
    try { buf = await decodeDealAudio(ctx, await readDealFile(file)); } catch (e) { return say("That file couldn't be read as sound. Try an MP3 or WAV.", bad); }
    if (buf.duration > MAX_CUSTOM_SECONDS + 0.05) return say(`That clip is ${buf.duration.toFixed(1)} seconds long. Please use one under ${MAX_CUSTOM_SECONDS} seconds, so it finishes before the banner goes away.`, bad);
    const info = analyseCustomBuffer(buf);
    if (info.silent) return say("That clip is silent.", bad);
    say("Saving…");
    const name = file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 40) || "My sound";
    let saved;
    try {
      const r = await fetch(`/api/sounds?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return say(d.error || "Couldn't save that sound.", bad);
      saved = d;
    } catch (e) { return say("Couldn't save that sound. Check the connection and try again.", bad); }
    dealCustom.buffers.set(saved.id, { buffer: buf, level: info.level, seconds: buf.duration });   // already decoded: no need to fetch it again
    dealCustom.list = dealCustom.list.concat([saved]);
    soundPrefs.choice = "custom:" + saved.id; saveDealSoundPrefs(soundPrefs);
    rebuildChoiceOptions(); renderCustomList(); refreshSoundUi();
    say(`Added “${saved.name}” ✓ and switched to it.`, "var(--green)");
    wakeSound(() => playCustomSound(saved.id, soundPrefs.volume));
    prepareForRoku(saved.id, buf).then((ok) => {                    // and its Roku copy, quietly in the background
      if (!ok) return;
      const entry = dealCustom.list.find((x) => x.id === saved.id);
      if (entry) entry.tvReady = true;
      say(`Added “${saved.name}” ✓ and switched to it. It's ready for the Roku too.`, "var(--green)");
    });
  }
  rebuildChoiceOptions(); renderCustomList();
  choiceSel.addEventListener("change", () => { soundPrefs.choice = choiceSel.value; saveDealSoundPrefs(soundPrefs); refreshSoundUi(); if (soundPrefs.choice !== "off") wakeSound(preview); });
  volumeSel.addEventListener("change", () => { soundPrefs.volume = volumeSel.value; saveDealSoundPrefs(soundPrefs); wakeSound(preview); });
  testBtn.addEventListener("click", () => wakeSound(preview));
  addBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => { const f = fileInput.files && fileInput.files[0]; fileInput.value = ""; addCustomSound(f); });
  soundBtn.addEventListener("click", () => { soundPanel.style.display = soundPanel.style.display === "none" ? "block" : "none"; });
  soundPanel.appendChild(choiceSel); soundPanel.appendChild(volumeSel); soundPanel.appendChild(testBtn);
  soundPanel.appendChild(el("div", { style: "margin-top:12px;border-top:0.5px solid var(--border);padding-top:10px" }, [
    el("div", { class: "muted", style: "font-size:11px;letter-spacing:0.04em;margin-bottom:4px", text: "MY OWN SOUNDS" }),
    customList, addBtn, fileInput, customStatus,
    el("div", { class: "muted", style: `font-size:11px;margin-top:4px`, text: `MP3, WAV, OGG or M4A · up to ${MAX_CUSTOM_SECONDS} seconds · 3 MB. Saved on the server, so every screen can use them.` }),
  ]));
  soundPanel.appendChild(el("div", { class: "muted", style: "font-size:11px;margin-top:10px", text: "Plays each time a Deal closed banner pops up. Which sound is chosen is saved on this screen." }));
  const unlockEvents = ["pointerdown", "keydown", "touchstart", "click"];
  function unlockSound() {
    if (!wrap.isConnected) { unlockEvents.forEach((e) => document.removeEventListener(e, unlockSound, true)); return; }
    if (soundPrefs.choice !== "off") wakeSound();
  }
  if (soundSupported) {
    unlockEvents.forEach((e) => document.addEventListener(e, unlockSound, true));
    wrap.appendChild(el("div", { style: "position:fixed;right:16px;bottom:16px;z-index:25;display:flex;flex-direction:column;align-items:flex-end;gap:8px" }, [soundPanel, soundHint, soundBtn]));
    refreshSoundUi();
    refreshAllSounds();
  }
  // The sound for a deal: the rep's own if they have one, otherwise this screen's choice. A screen set to Off stays silent for everyone.
  function playBannerSound(repName) {
    if (!soundSupported || soundPrefs.choice === "off") return;
    const choice = repChoiceFor(repName) || soundPrefs.choice;
    if (!playDealSound(choice, soundPrefs.volume)) refreshSoundUi();   // not allowed to play yet: the "tap once" note stays up
  }

  function tickClock() {
    clockEl.textContent = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" });
  }
  tickClock();
  const clockInterval = setInterval(tickClock, 1000);

  const medalFor = (rank) => rank === 0 ? "🥇" : rank === 1 ? "🥈" : rank === 2 ? "🥉" : null;

  // ---- "Deal closed!" banner ----
  // Announces a deal in front of the whole sales office the moment it shows up. Only a genuinely FRESH close counts:
  // whatever is already on the board when the TV opens (or reloads) is just the starting point, and anything closed
  // more than ~20 minutes ago - a bulk import, the owner correcting a closing time, a job added after the fact - is
  // never announced. A close with no price yet waits until it has one, so the banner never says "$0".
  const FRESH_MS = 20 * 60 * 1000;
  const seenCloses = new Set();
  const bannerQueue = [];
  let baselineTaken = false, bannerBusy = false;
  function showNextBanner() {
    if (bannerBusy || bannerQueue.length === 0) return;
    bannerBusy = true;
    const c = bannerQueue.shift();
    const more = bannerQueue.length;
    const node = el("div", { class: "deal-banner" }, [
      el("div", { style: "font-size:15px;letter-spacing:0.14em;opacity:0.9", text: "🔔 DEAL CLOSED" }),
      el("div", { text: `${c.repName} just closed ${money(c.basePrice)}` }),
      el("div", { style: "font-size:18px;font-weight:400;opacity:0.95", text: [c.baseService || c.car, c.locationName].filter(Boolean).join(" · ") + (more ? `   (+${more} more)` : "") }),
    ]);
    bannerLayer.appendChild(node);
    playBannerSound(c.repName);        // the funny sound, once for each banner that pops up (the rep's own if they have one)
    setTimeout(() => { node.remove(); bannerBusy = false; showNextBanner(); }, window.DEAL_BANNER_MS || 9000);
  }
  function announceNewCloses(closingData) {
    const all = closingData.perRep.flatMap((r) => r.closes.map((c) => ({ ...c, repName: r.name })));
    const keyOf = (c) => `${c.locationId}:${c.id}`;
    if (!baselineTaken) { all.forEach((c) => seenCloses.add(keyOf(c))); baselineTaken = true; return; }
    all.filter((c) => !seenCloses.has(keyOf(c))).forEach((c) => {
      if (!(Date.now() - Date.parse(c.closedAt) <= FRESH_MS)) { seenCloses.add(keyOf(c)); return; } // old or undated: quietly noted
      if (!(c.basePrice > 0)) return; // fresh but no price yet: check again on the next refresh
      seenCloses.add(keyOf(c));
      bannerQueue.push(c);
    });
    showNextBanner();
  }

  let latestLeaderboardRequestId = 0;
  async function load() {
    if (soundSupported) refreshAllSounds();        // sounds (and which rep has which) changed from another device show up here within a refresh or two
    const thisRequestId = ++latestLeaderboardRequestId;
    let closingData, arrivalData;
    try {
      const todayEastern = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      // Two genuinely different questions, fetched separately: what they're closing
      // today (regardless of when it's scheduled), and what's actually arrived today
      // (real commission, only counting cars physically at the shop).
      [closingData, arrivalData] = await Promise.all([
        api(`/api/combined/salesrep-stats?period=day&date=${todayEastern}&dateBasis=closed`),
        api(`/api/combined/salesrep-stats?period=day&date=${todayEastern}`),
      ]);
    } catch (e) {
      if (thisRequestId !== latestLeaderboardRequestId) return;
      errorBanner.innerHTML = "";
      errorBanner.appendChild(el("div", { style: "color:var(--red);font-size:16px;margin-bottom:20px", text: "Couldn't load — retrying..." }));
      return;
    }
    if (thisRequestId !== latestLeaderboardRequestId) return;
    announceNewCloses(closingData);
    errorBanner.innerHTML = "";
    const allErrors = [...closingData.errors, ...arrivalData.errors];
    if (allErrors.length > 0) {
      errorBanner.appendChild(el("div", { style: "color:var(--red);font-size:14px;margin-bottom:16px", text: `Not reachable right now: ${[...new Set(allErrors.map((e) => e.locationName))].join(", ")}` }));
    }

    // Merge both by rep name into one row each - every rep who appears in either list
    // gets a row, defaulting to zero on whichever side they have no activity on.
    const byName = {};
    closingData.perRep.forEach((r) => { byName[r.name] = byName[r.name] || {}; byName[r.name].closing = r; });
    arrivalData.perRep.forEach((r) => { byName[r.name] = byName[r.name] || {}; byName[r.name].arrival = r; });
    const merged = Object.entries(byName).map(([name, { closing, arrival }]) => ({
      name,
      closeCount: closing ? closing.closeCount : 0,
      closedValue: closing ? closing.closedValue : 0,
      arrivedCount: arrival ? arrival.arrivedCount : 0,
      actualCommission: arrival ? arrival.actualCommission : 0,
    }));
    // Ranked by the total VALUE they closed today - not by commission, and not by how many deals.
    // A tie on value goes to whoever closed more deals. Anyone with nothing closed today (only
    // cars arriving from earlier deals) sorts below everyone who closed, ordered among themselves
    // by what actually showed.
    const ranked = merged.sort((a, b) =>
      b.closedValue - a.closedValue || b.closeCount - a.closeCount || b.actualCommission - a.actualCommission || a.name.localeCompare(b.name));

    list.innerHTML = "";
    if (ranked.length === 0) {
      list.appendChild(el("div", { class: "muted", style: "font-size:20px;text-align:center;margin-top:60px", text: "No activity yet today." }));
      return;
    }
    ranked.forEach((rep, i) => {
      const medal = medalFor(i);
      list.appendChild(el("div", {
        style: `display:flex;align-items:center;gap:24px;padding:20px 24px;margin-bottom:12px;background:${i === 0 ? "var(--cardAlt)" : "var(--card)"};border:0.5px solid ${i === 0 ? "var(--amber)" : "var(--border)"};border-radius:14px`,
      }, [
        el("div", { class: "mono", style: "font-size:32px;font-weight:600;color:var(--muted);width:56px;text-align:center", text: medal || `#${i + 1}` }),
        el("div", { style: "flex:1", }, [
          el("div", { class: "oswald", style: "font-size:26px;font-weight:600;color:var(--text)", text: rep.name }),
        ]),
        el("div", { style: "text-align:center;width:180px;border-right:1px solid var(--border);padding-right:20px" }, [
          el("div", { class: "muted", style: "font-size:11px;letter-spacing:0.03em", text: "CLOSING TODAY" }),
          el("div", { class: "mono", style: "font-size:24px;font-weight:600;color:var(--cyan);margin-top:2px", text: money(rep.closedValue) }),
          el("div", { class: "mono", style: "font-size:15px;color:var(--chrome)", text: `${rep.closeCount} deal${rep.closeCount !== 1 ? "s" : ""}` }),
        ]),
        el("div", { style: "text-align:right;width:200px" }, [
          el("div", { class: "muted", style: "font-size:11px;letter-spacing:0.03em", text: "ARRIVED TODAY" }),
          el("div", { class: "mono", style: "font-size:24px;font-weight:600;color:var(--amber);margin-top:2px", text: `${rep.arrivedCount}` }),
          el("div", { class: "mono", style: "font-size:18px;font-weight:600;color:var(--green)", text: money(rep.actualCommission) }),
        ]),
      ]));
    });
  }

  await load();
  window._leaderboardInterval = setInterval(load, window.LEADERBOARD_POLL_MS || 15000);

  // Clean up the clock interval if the user navigates away - the main render() already
  // clears _leaderboardInterval, this just also stops the once-a-second clock tick.
  exitBtn.addEventListener("click", () => { clearInterval(clockInterval); unlockEvents.forEach((e) => document.removeEventListener(e, unlockSound, true)); stopCustomPlayback(); });
}

boot();
