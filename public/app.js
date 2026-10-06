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
}

async function renderCleanup(content) {
  const body = el("div");
  let latestCleanupRequestId = 0;
  async function load() {
    const thisRequestId = ++latestCleanupRequestId;
    const data = await api("/api/combined/cleanup-list");
    if (thisRequestId !== latestCleanupRequestId) return;
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

  function tickClock() {
    clockEl.textContent = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" });
  }
  tickClock();
  const clockInterval = setInterval(tickClock, 1000);

  const medalFor = (rank) => rank === 0 ? "🥇" : rank === 1 ? "🥈" : rank === 2 ? "🥉" : null;

  let latestLeaderboardRequestId = 0;
  async function load() {
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
  window._leaderboardInterval = setInterval(load, 30000);

  // Clean up the clock interval if the user navigates away - the main render() already
  // clears _leaderboardInterval, this just also stops the once-a-second clock tick.
  exitBtn.addEventListener("click", () => clearInterval(clockInterval));
}

boot();
