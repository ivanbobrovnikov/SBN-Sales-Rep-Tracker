async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
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
  [["combined", "Combined", "📊"], ["leaderboard", "Leaderboard", "🏆"], ["cleanup", "Cleanup", "🧹"], ["settings", "Settings", "⚙️"]].forEach(([key, label, icon]) => {
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
}

async function renderCleanup(content) {
  const body = el("div");
  async function load() {
    const data = await api("/api/combined/cleanup-list");
    body.innerHTML = "";
    if (data.errors.length > 0) {
      body.appendChild(el("div", { class: "card", style: "border-color:var(--red)" }, [
        el("div", { style: "color:var(--red);font-size:12.5px", text: `Couldn't reach: ${data.errors.map((e) => `${e.locationName} (${e.error})`).join(", ")}` }),
      ]));
    }
    if (data.jobs.length === 0) { body.appendChild(el("div", { class: "muted", text: "Nothing needs cleanup across any location." })); return; }
    data.jobs.forEach((j) => {
      const priceInput = el("input", { type: "number", placeholder: "Base price", value: j.basePrice || "", style: `max-width:110px;${j.missingPrice ? "" : "display:none"}` });
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
        el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center" }, [priceInput, serviceSelect, saveBtn, walkInBtn, onlineBtn, notice]),
      ]));
    });
  }
  content.appendChild(el("div", { class: "muted", style: "margin-bottom:14px", text: "Every job across every location missing a price, service, or sales rep / walk-in flag. Fixing one here applies directly to that location's own tracker, just like fixing it there." }));
  content.appendChild(body);
  await load();
}

function renderSimplePeriodPicker(onChange) {
  let period = "month";
  const today = new Date().toISOString().slice(0, 10);
  const dayInput = el("input", { type: "date", value: today, style: "display:none" });
  const weekInput = el("input", { type: "date", value: today, style: "display:none" });
  const monthInput = el("input", { type: "month", value: today.slice(0, 7) });
  const yearInput = el("input", { type: "number", value: String(new Date().getFullYear()), style: "display:none;max-width:100px" });
  const customStart = el("input", { type: "date", value: today, style: "display:none;max-width:150px" });
  const customEnd = el("input", { type: "date", value: today, style: "display:none;max-width:150px" });
  const customWrap = el("div", { style: "display:none;gap:8px;align-items:center" }, [
    el("span", { class: "muted", style: "font-size:12px", text: "From" }), customStart, el("span", { class: "muted", style: "font-size:12px", text: "to" }), customEnd,
  ]);
  function currentParams() {
    if (period === "day") return { period, date: dayInput.value };
    if (period === "week") return { period, date: weekInput.value };
    if (period === "year") return { period, date: `${yearInput.value}-01-01` };
    if (period === "custom") return { period, startDate: customStart.value, endDate: customEnd.value };
    return { period: "month", month: monthInput.value };
  }
  function fire() { onChange(currentParams()); }
  const tabs = el("div", { style: "display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap" });
  [["day", "Day"], ["week", "Week"], ["month", "Month"], ["year", "Year"], ["custom", "Custom"]].forEach(([p, label]) => {
    const btn = el("button", { class: "tab-btn" + (p === period ? " active" : "") , text: label });
    btn.addEventListener("click", () => {
      period = p;
      Array.from(tabs.children).forEach((c) => c.classList.remove("active"));
      dayInput.style.display = p === "day" ? "" : "none";
      weekInput.style.display = p === "week" ? "" : "none";
      monthInput.style.display = p === "month" ? "" : "none";
      yearInput.style.display = p === "year" ? "" : "none";
      customWrap.style.display = p === "custom" ? "flex" : "none";
      btn.classList.add("active");
      if (p !== "custom") fire();
    });
    tabs.appendChild(btn);
  });
  [dayInput, weekInput, monthInput, yearInput].forEach((inp) => inp.addEventListener("change", fire));
  [customStart, customEnd].forEach((inp) => inp.addEventListener("change", () => { if (period === "custom") fire(); }));
  const wrap = el("div", { class: "field", style: "max-width:340px" }, [
    el("label", { text: "Time period" }), tabs, dayInput, weekInput, monthInput, yearInput, customWrap,
  ]);
  return { el: wrap, getParams: currentParams };
}

function renderGoalProgress(rep, goal) {
  if (!goal) return null;
  const current = goal.metric === "commission" ? rep.actualCommission : goal.metric === "value" ? rep.closedValue : rep.closeCount;
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
  function buildDetail() {
    detailWrap.innerHTML = "";
    if (showLocationBreakdown && rep.byLocation.length > 0) {
      detailWrap.appendChild(el("div", { class: "muted", style: "font-size:10.5px;font-weight:600;margin-bottom:4px", text: "BY LOCATION" }));
      rep.byLocation.forEach((l) => detailWrap.appendChild(el("div", { class: "row", style: "font-size:12px;margin-bottom:3px" }, [
        el("span", { text: `${l.locationName} — ${l.closeCount} close${l.closeCount !== 1 ? "s" : ""}, ${l.arrivedCount} arrived` }),
        el("span", { class: "mono", text: money(l.closedValue) }),
      ])));
    }
    const services = Object.entries(rep.byService || {});
    if (services.length > 0) {
      detailWrap.appendChild(el("div", { class: "muted", style: "font-size:10.5px;font-weight:600;margin:8px 0 4px", text: "BY SERVICE" }));
      services.forEach(([svc, count]) => detailWrap.appendChild(el("div", { class: "row", style: "font-size:12px;margin-bottom:3px" }, [
        el("span", { text: svc }), el("span", { class: "mono", text: count }),
      ])));
    }
    if (rep.byDayOfWeek) {
      detailWrap.appendChild(el("div", { class: "muted", style: "font-size:10.5px;font-weight:600;margin:8px 0 4px", text: "BY DAY OF WEEK" }));
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
      detailWrap.appendChild(el("div", { style: "color:var(--red);font-size:10.5px;font-weight:600;margin:8px 0 4px", text: "⚠ POSSIBLE DUPLICATES" }));
      rep.possibleDuplicates.forEach((dup) => {
        detailWrap.appendChild(el("div", { style: "font-size:11.5px;margin-bottom:6px;color:var(--red)" }, [
          el("div", { text: dup.customerName }),
          ...dup.entries.map((e) => el("div", { class: "muted", style: "font-size:10.5px;margin-left:8px", text: `${e.locationName} — ${e.car} — ${money(e.basePrice)} — ${formatDateTime(e.date)}` })),
        ]));
      });
    }
    detailWrap.appendChild(el("div", { class: "muted", style: "font-size:10.5px;font-weight:600;margin:8px 0 4px", text: `ALL CLOSES (${rep.closes.length})` }));
    rep.closes.forEach((c) => {
      const statusColor = c.status === "arrived" ? "var(--green)" : c.status === "no_show" ? "var(--red)" : "var(--sub)";
      detailWrap.appendChild(el("div", { class: "row", style: "font-size:11.5px;margin-bottom:3px" }, [
        el("div", {}, [
          el("span", { text: c.car }),
          showLocationBreakdown ? el("span", { class: "muted", text: ` · ${c.locationName}` }) : null,
        ]),
        el("div", { style: "text-align:right" }, [
          el("span", { class: "mono", text: money(c.basePrice) }),
          el("span", { style: `color:${statusColor};margin-left:6px;font-size:10px`, text: c.status }),
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

  return el("div", { class: "card" }, [
    el("div", { class: "row" }, [
      el("div", {}, [
        el("div", { style: "font-weight:500;font-size:16px", text: rep.name }),
        el("div", { class: "muted", style: "font-size:12px", text: `${money(rep.closedValue)} closed value · avg ${money(rep.avgDealSize)}/car` }),
        el("div", { class: "muted", style: "font-size:12px", text: `${rep.arrivedCount} arrived, ${rep.noShowCount} no-show, ${rep.pendingCount} pending · ${Math.round(rep.noShowRate)}% no-show rate` }),
        rep.daysSinceLastClose !== null ? el("div", { style: `font-size:11.5px;margin-top:2px;color:${rep.daysSinceLastClose > 7 ? "var(--red)" : "var(--muted)"}`, text: `Last close: ${rep.daysSinceLastClose} day${rep.daysSinceLastClose !== 1 ? "s" : ""} ago` }) : null,
      ]),
      el("div", { style: "text-align:right" }, [
        el("div", { class: "mono", style: "color:var(--green);font-weight:600;font-size:18px", text: money(rep.actualCommission) }),
        el("div", { class: "muted", style: "font-size:10px", text: "actual commission" }),
        rep.projectedCommission !== rep.actualCommission ? el("div", { class: "muted", style: "font-size:10px", text: `${money(rep.projectedCommission)} if all show` }) : null,
      ]),
    ]),
    renderGoalProgress(rep, goal),
    toggleBtn, detailWrap,
  ]);
}

async function renderCombined(content) {
  const picker = renderSimplePeriodPicker((params) => load(params));
  const locationTabs = el("div", { style: "display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap" });
  const body = el("div");
  let activeLocationFilter = "combined"; // "combined" or a locationId

  let goalsCache = [];
  let currentPeriodType = "month";

  async function load(params) {
    const p = params || picker.getParams();
    currentPeriodType = p.period;
    const qs = new URLSearchParams(p).toString();
    [statsCache, goalsCache] = await Promise.all([
      api(`/api/combined/salesrep-stats?${qs}`),
      api("/api/goals"),
    ]);
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

  function renderBody() {
    body.innerHTML = "";
    if (statsCache.errors.length > 0) {
      body.appendChild(el("div", { class: "card", style: "border-color:var(--red)" }, [
        el("div", { style: "color:var(--red);font-size:12.5px", text: `Couldn't reach: ${statsCache.errors.map((e) => `${e.locationName} (${e.error})`).join(", ")}` }),
        el("div", { class: "muted", style: "font-size:10.5px;margin-top:4px", text: "Numbers below don't include this location until it's reachable again." }),
      ]));
    }
    if (statsCache.perRep.length === 0) { body.appendChild(el("div", { class: "muted", text: "No sales rep activity in this period." })); return; }

    if (activeLocationFilter === "combined") {
      const totalValue = statsCache.perRep.reduce((a, r) => a + r.closedValue, 0);
      const totalCommission = statsCache.perRep.reduce((a, r) => a + r.actualCommission, 0);
      const totalCloses = statsCache.perRep.reduce((a, r) => a + r.closeCount, 0);
      body.appendChild(el("div", { class: "metric-grid" }, [
        el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Total closes" }), el("div", { class: "metric-value", text: totalCloses })]),
        el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Closed value" }), el("div", { class: "metric-value", style: "color:var(--amber)", text: money(totalValue) })]),
        el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Total commission" }), el("div", { class: "metric-value", style: "color:var(--green)", text: money(totalCommission) })]),
      ]));
      statsCache.perRep.forEach((rep) => body.appendChild(renderRepCard(rep, true, goalFor(rep.name))));
    } else {
      // Filter each rep's closes down to just this one location, recompute their
      // location-specific numbers from the same underlying data - no second fetch needed.
      statsCache.perRep.forEach((rep) => {
        const closes = rep.closes.filter((c) => c.locationName === activeLocationFilter);
        if (closes.length === 0) return;
        const arrived = closes.filter((c) => c.status === "arrived");
        const noShow = closes.filter((c) => c.status === "no_show");
        const pending = closes.filter((c) => c.status !== "arrived" && c.status !== "no_show");
        const closedValue = closes.reduce((a, c) => a + c.basePrice, 0);
        const byService = {};
        closes.forEach((c) => { const k = c.baseService || "(not set)"; byService[k] = (byService[k] || 0) + 1; });
        const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const byDayOfWeek = dayNames.map((name) => ({ day: name, count: 0 }));
        closes.forEach((c) => { const d = new Date(c.closedAt); if (!isNaN(d.getTime())) byDayOfWeek[d.getUTCDay()].count += 1; });
        const actualCommission = closes.filter((c) => c.status === "arrived").reduce((a, c) => a + (c.commissionAmount || 0), 0);
        const projectedCommission = closes.reduce((a, c) => a + (c.commissionAmount || 0), 0);
        const filtered = {
          name: rep.name, closeCount: closes.length, closedValue, avgDealSize: closedValue / closes.length,
          arrivedCount: arrived.length, noShowCount: noShow.length, pendingCount: pending.length,
          noShowRate: (arrived.length + noShow.length) > 0 ? (noShow.length / (arrived.length + noShow.length)) * 100 : 0,
          actualCommission, projectedCommission,
          byLocation: [], byService, byDayOfWeek, daysSinceLastClose: null, possibleDuplicates: [], closes,
        };
        body.appendChild(renderRepCard(filtered, false, goalFor(rep.name)));
      });
    }
  }

  content.appendChild(picker.el);
  content.appendChild(locationTabs);
  content.appendChild(body);
  await load();
}

async function renderLeaderboard(app) {
  const wrap = el("div", { style: "background:var(--bg);min-height:100vh;padding:32px 40px" });
  const exitBtn = el("button", { class: "ghost", style: "position:fixed;top:16px;right:16px;z-index:10", onclick: () => { currentTab = "combined"; render(); }, text: "✕ Exit" });
  const clockEl = el("div", { class: "muted mono", style: "font-size:15px" });
  const header = el("div", { style: "display:flex;justify-content:space-between;align-items:baseline;margin-bottom:28px" }, [
    el("div", {}, [
      el("div", { class: "oswald", style: "font-size:34px;font-weight:600;color:var(--chrome);letter-spacing:0.02em", text: "TODAY'S LEADERBOARD" }),
      el("div", { class: "muted", style: "font-size:14px;margin-top:4px", text: "All locations combined" }),
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

  function tickClock() {
    clockEl.textContent = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" });
  }
  tickClock();
  const clockInterval = setInterval(tickClock, 1000);

  const medalFor = (rank) => rank === 0 ? "🥇" : rank === 1 ? "🥈" : rank === 2 ? "🥉" : null;

  async function load() {
    let data;
    try {
      const todayEastern = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      data = await api(`/api/combined/salesrep-stats?period=day&date=${todayEastern}&dateBasis=closed`);
    } catch (e) {
      errorBanner.innerHTML = "";
      errorBanner.appendChild(el("div", { style: "color:var(--red);font-size:16px;margin-bottom:20px", text: "Couldn't load — retrying..." }));
      return;
    }
    errorBanner.innerHTML = "";
    if (data.errors.length > 0) {
      errorBanner.appendChild(el("div", { style: "color:var(--red);font-size:14px;margin-bottom:16px", text: `Not reachable right now: ${data.errors.map((e) => e.locationName).join(", ")}` }));
    }
    const ranked = [...data.perRep].sort((a, b) => b.actualCommission - a.actualCommission);
    list.innerHTML = "";
    if (ranked.length === 0) {
      list.appendChild(el("div", { class: "muted", style: "font-size:20px;text-align:center;margin-top:60px", text: "No closes yet today." }));
      return;
    }
    ranked.forEach((rep, i) => {
      const medal = medalFor(i);
      list.appendChild(el("div", {
        style: `display:flex;align-items:center;gap:24px;padding:20px 24px;margin-bottom:12px;background:${i === 0 ? "var(--cardAlt)" : "var(--card)"};border:0.5px solid ${i === 0 ? "var(--amber)" : "var(--border)"};border-radius:14px`,
      }, [
        el("div", { class: "mono", style: "font-size:32px;font-weight:600;color:var(--muted);width:56px;text-align:center", text: medal || `#${i + 1}` }),
        el("div", { style: "flex:1" }, [
          el("div", { class: "oswald", style: "font-size:26px;font-weight:600;color:var(--text)", text: rep.name }),
          el("div", { class: "muted", style: "font-size:14px;margin-top:2px", text: `${rep.closeCount} close${rep.closeCount !== 1 ? "s" : ""} today · ${rep.arrivedCount} arrived` }),
        ]),
        el("div", { style: "text-align:right" }, [
          el("div", { class: "mono", style: "font-size:30px;font-weight:600;color:var(--amber)", text: money(rep.closedValue) }),
          el("div", { class: "muted", style: "font-size:11px;letter-spacing:0.03em;margin-top:-2px", text: "CLOSED VALUE" }),
          el("div", { class: "mono", style: "font-size:18px;font-weight:500;color:var(--green);margin-top:6px", text: money(rep.actualCommission) }),
          el("div", { class: "muted", style: "font-size:11px;letter-spacing:0.03em", text: "COMMISSION (CARS THAT SHOWED)" }),
        ]),
      ]));
    });
  }

  await load();
  window._leaderboardInterval = setInterval(load, 30000);

  // Clean up the clock interval if the user navigates away - the main render() already
  // clears _leaderboardInterval, this just also stops the once-a-second clock tick.
  exitBtn.addEventListener("click", () => clearInterval(clockInterval));
}

boot();
