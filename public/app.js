const el = (tag, attrs = {}, children = []) => {
  const e = document.createElement(tag);
  // Every button defaults to type="button" unless explicitly overridden. Without this, a
  // plain <button> defaults to type="submit" — which some mobile browsers treat as an
  // implicit form action even with no real <form> on the page, causing exactly the
  // "jumps back to the start" behavior when tapping something.
  if (tag === "button" && !("type" in attrs)) e.setAttribute("type", "button");
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === "text") e.textContent = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  });
  (Array.isArray(children) ? children : [children]).forEach((c) => c && e.appendChild(c));
  return e;
};
// Must match BUILD in server.js - the header compares the two and flags a half-updated deploy.
const UI_BUILD = "2026-10-03-cash-menu";

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
function pct(n) { return isFinite(n) ? Math.round(n) + "%" : "0%"; }
function formatDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Reusable Day / Week / Month / Year selector. Calls onChange({period, date, month}) whenever it changes.
function nextOrTodayTuesday(fromDateStr) {
  const d = new Date(fromDateStr + "T00:00:00Z");
  const day = d.getUTCDay(); // 0=Sun ... 2=Tue
  const diff = (2 - day + 7) % 7;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// The real payroll cycle is anchored to Tuesday, August 25, 2026 — every 14 days from
// there, forever (Sept 8, Sept 22, Oct 6, ...). A free date-picker let you accidentally
// land on a Tuesday that doesn't align with that cadence (e.g. Sept 1, which is a real
// Tuesday but only 7 days after the anchor, not 14) — this stepper makes that impossible.
const PAY_PERIOD_ANCHOR = "2026-08-25";
// Sales reps run a genuinely different cadence — Thursday morning through the following
// Wednesday night, one calendar day offset from the tech/manager cycle above. Same 14-day
// length, just shifted, so this gets its own anchor rather than reusing the one above.
const SALES_PAY_PERIOD_ANCHOR = "2026-08-26";
function nearestValidPayPeriodEnd(referenceDateStr, anchorOverride) {
  const anchor = new Date((anchorOverride || PAY_PERIOD_ANCHOR) + "T00:00:00Z");
  const ref = new Date(referenceDateStr + "T00:00:00Z");
  let n = Math.max(1, Math.ceil((ref - anchor) / (1000 * 60 * 60 * 24 * 14)));
  let end = new Date(anchor);
  end.setUTCDate(end.getUTCDate() + 14 * n);
  while (end < ref) { n++; end = new Date(anchor); end.setUTCDate(end.getUTCDate() + 14 * n); }
  return end.toISOString().slice(0, 10);
}

function renderPeriodPicker(onChange, defaultPeriod = "month", payPeriodAnchor) {
  let period = defaultPeriod;
  const today = new Date().toISOString().slice(0, 10);
  const vis = (key) => (period === key ? "" : "display:none");
  const dayInput = el("input", { type: "date", value: today, style: vis("day") });
  const weekInput = el("input", { type: "date", value: today, style: vis("week") });
  const monthInput = el("input", { type: "month", value: today.slice(0, 7), style: vis("month") });
  const yearInput = el("input", { type: "number", value: String(new Date().getFullYear()), style: vis("year") + ";max-width:100px" });
  let payPeriodEnd = nearestValidPayPeriodEnd(today, payPeriodAnchor);
  const payPeriodLabel = el("div", { class: "muted", style: `font-size:11.5px;${vis("payperiod")}` });
  const payPeriodStepper = el("div", { style: `display:flex;gap:8px;align-items:center;${vis("payperiod")}` });
  const customStartInput = el("input", { type: "date", value: today, style: "max-width:150px" });
  const customEndInput = el("input", { type: "date", value: today, style: "max-width:150px" });
  const customWrap = el("div", { style: `display:flex;gap:8px;align-items:center;flex-wrap:wrap;${vis("custom")}` }, [
    el("span", { class: "muted", style: "font-size:12px", text: "From" }), customStartInput,
    el("span", { class: "muted", style: "font-size:12px", text: "to" }), customEndInput,
  ]);

  function shiftPayPeriod(deltaDays) {
    const d = new Date(payPeriodEnd + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + deltaDays);
    payPeriodEnd = d.toISOString().slice(0, 10);
    updatePayPeriodLabel();
    fire();
  }

  function formatPlainDate(dateStr) {
    // Formats a "YYYY-MM-DD" calendar date directly, with zero timezone conversion —
    // this is a plain date, not a real instant, so it should never shift based on
    // whatever timezone the browser happens to be in.
    const [y, m, d] = dateStr.split("-").map(Number);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${months[m - 1]} ${d}`;
  }
  function updatePayPeriodLabel() {
    const end = new Date(payPeriodEnd + "T00:00:00Z");
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 13); // matches the server's non-overlapping 14-day span exactly
    const fmt = (d) => formatPlainDate(d.toISOString().slice(0, 10)); // read the calendar date straight from UTC, never through local-timezone display
    payPeriodLabel.textContent = `Covers ${fmt(start)} – ${fmt(end)} (payroll processed ${fmt(end)})`;
  }

  function currentParams() {
    if (period === "day") return { period, date: dayInput.value };
    if (period === "week") return { period, date: weekInput.value };
    if (period === "year") return { period, date: `${yearInput.value}-01-01` };
    if (period === "payperiod") return { period, date: payPeriodEnd };
    if (period === "custom") return { period, startDate: customStartInput.value, endDate: customEndInput.value };
    return { period: "month", month: monthInput.value };
  }
  function fire() { onChange(currentParams()); }

  payPeriodStepper.appendChild(el("button", { class: "tab-btn", onclick: () => shiftPayPeriod(-14), text: "◀ Prev" }));
  payPeriodStepper.appendChild(el("button", { class: "tab-btn", onclick: () => { payPeriodEnd = nearestValidPayPeriodEnd(today); updatePayPeriodLabel(); fire(); }, text: "Current" }));
  payPeriodStepper.appendChild(el("button", { class: "tab-btn", onclick: () => shiftPayPeriod(14), text: "Next ▶" }));

  const periodTabs = el("div", { style: "display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap" });
  [["day", "Day"], ["week", "Week"], ["month", "Month"], ["year", "Year"], ["payperiod", "Pay period"], ["custom", "Custom"]].forEach(([p, label]) => {
    const btn = el("button", {
      class: "tab-btn" + (p === period ? " active" : ""),
      text: label,
    });
    btn.addEventListener("click", () => {
      period = p;
      Array.from(periodTabs.children).forEach((c) => c.classList.remove("active"));
      dayInput.style.display = p === "day" ? "" : "none";
      weekInput.style.display = p === "week" ? "" : "none";
      monthInput.style.display = p === "month" ? "" : "none";
      yearInput.style.display = p === "year" ? "" : "none";
      payPeriodStepper.style.display = p === "payperiod" ? "flex" : "none";
      payPeriodLabel.style.display = p === "payperiod" ? "" : "none";
      customWrap.style.display = p === "custom" ? "flex" : "none";
      if (p === "payperiod") updatePayPeriodLabel();
      btn.classList.add("active");
      if (p !== "custom") fire(); // custom waits for both dates - fired by its own inputs below instead
    });
    periodTabs.appendChild(btn);
  });

  [dayInput, weekInput, monthInput, yearInput].forEach((inp) => inp.addEventListener("change", fire));
  [customStartInput, customEndInput].forEach((inp) => inp.addEventListener("change", () => { if (period === "custom") fire(); }));
  if (period === "payperiod") updatePayPeriodLabel();

  const wrap = el("div", { class: "field", style: "max-width:320px" }, [
    el("label", { text: "Time period" }),
    periodTabs,
    dayInput, weekInput, monthInput, yearInput, payPeriodStepper,
    payPeriodLabel, customWrap,
  ]);
  return { el: wrap, getParams: currentParams };
}

let session = { role: null };
let currentTab = localStorage.getItem("lastTab") || "jobs";

async function boot() {
  session = await api("/api/session");
  render();
}

function render() {
  const app = document.getElementById("app");
  app.innerHTML = "";

  if (!session.role) {
    app.appendChild(renderLoginScreen());
    return;
  }

  const roleLabel = session.role === "owner" ? "Owner" : session.role === "manager" ? "Manager" : session.role === "sales" ? "Sales" : "Employee";
  app.appendChild(el("div", { class: "header" }, [
    el("img", { class: "logo", src: "/logo.png", alt: "SBN Auto Styling" }),
    el("div", { style: "flex:1;min-width:0" }, [
      el("div", { class: "title oswald", text: "SBN Autostyling Tracker" }),
      el("div", { class: "subtitle", text: `Window tint · PPF · Ceramic coating — ${session.shopLocation || ""}` }),
      (() => {
        // Shows which release this screen is, and goes red if the server is on a different one.
        // A network hiccup alone never triggers the warning - only a real answer that doesn't match.
        const line = el("div", { class: "muted", style: "font-size:9.5px;margin-top:1px", text: `build ${UI_BUILD}` });
        fetch("/api/version", { cache: "no-store" })
          .then(async (r) => { let v = null; if (r.ok) { try { v = await r.json(); } catch (e) {} } return { reached: true, v }; })
          .catch(() => ({ reached: false }))
          .then(({ reached, v }) => {
            if (!reached || (v && v.build === UI_BUILD)) return;
            line.style.color = "var(--red)";
            line.textContent = `\u26A0 screen ${UI_BUILD} \u00B7 server ${v && v.build ? v.build : "OLD"} \u2014 update both files`;
          });
        return line;
      })(),
    ]),
    el("div", { style: "text-align:right;flex-shrink:0" }, [
      el("div", { style: "font-size:12.5px;font-weight:500", text: session.name || "Owner" }),
      el("div", { class: "muted", style: "font-size:10px;text-transform:uppercase;letter-spacing:0.04em", text: roleLabel }),
      el("button", { class: "ghost", style: "font-size:10px;padding:3px 8px;margin-top:3px", onclick: async () => { await api("/api/logout", { method: "POST" }); await boot(); }, text: "Log out" }),
    ]),
  ]));

  const content = el("div", { id: "content" });
  app.appendChild(content);
  app.appendChild(renderBottomNav());
  if (session.role === "owner") renderOwnerTabContent(content);
  else if (session.role === "manager") renderManagerTabContent(content);
  else if (session.role === "sales") renderSalesTabContent(content);
  else renderEmployeeTabContent(content);
}

function renderLoginScreen() {
  const inner = session.ownerPinSet ? renderLogin() : renderOwnerSetup();
  return el("div", { style: "min-height:78vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px" }, [
    el("img", { src: "/logo.png", alt: "SBN Auto Styling", style: "height:64px;width:auto;margin-bottom:10px" }),
    el("div", { style: "text-align:center;margin-bottom:28px" }, [
      el("div", { class: "muted", style: "font-size:11px;letter-spacing:0.12em;text-transform:uppercase", text: "Shop Management Tracker" }),
    ]),
    inner,
  ]);
}

function renderOwnerSetup() {
  const pinInput = el("input", { type: "password", placeholder: "Choose a PIN (4+ digits)" });
  const notice = el("div", { class: "notice" });
  return el("div", { class: "card", style: "max-width:360px;width:100%;border-top:2px solid var(--amber)" }, [
    el("div", { style: "font-size:11.5px;color:var(--sub);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:14px;text-align:center", text: "First-time setup" }),
    el("div", { class: "field" }, [el("label", { text: "Create the owner PIN" }), pinInput]),
    el("button", { class: "primary", style: "width:100%;margin-top:6px", onclick: async () => {
      try { await api("/api/setup/owner-pin", { method: "POST", body: JSON.stringify({ pin: pinInput.value }) }); await boot(); }
      catch (e) { notice.className = "notice err"; notice.textContent = e.message; }
    }, text: "Set PIN & continue" }),
    notice,
  ]);
}

function renderLogin() {
  const pinInput = el("input", { type: "password", placeholder: "PIN" });
  const notice = el("div", { class: "notice" });
  const submit = async () => {
    try { session = await api("/api/login", { method: "POST", body: JSON.stringify({ pin: pinInput.value }) }); render(); }
    catch (e) { notice.className = "notice err"; notice.textContent = e.message; }
  };
  pinInput.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  return el("div", { class: "card", style: "max-width:340px;width:100%;border-top:2px solid var(--amber)" }, [
    el("div", { class: "field" }, [el("label", { text: "Enter your PIN" }), pinInput]),
    el("button", { class: "primary", style: "width:100%;margin-top:6px", onclick: submit, text: "Log in" }),
    notice,
  ]);
}

const TAB_ICONS = {
  "owner-summary": "📊", "owner-payroll": "💵", "owner-sales": "🗓", "manager-jobs": "🚗",
  "owner-serviced": "✅", "owner-audit": "🕐", "owner-edit-history": "📝",
  "owner-cleanup": "🧹", "owner-attendance": "✅", "owner-search": "🔍", "owner-team": "🧰",
  "owner-managers": "🧑‍💼", "owner-salesreps": "🤝", "owner-test": "🛠",
  "manager-performance": "📈", "sales-schedule": "📋", "sales-fullschedule": "🗓",
  "sales-performance": "📈", "schedule": "🗓", "performance": "📈",
};

function renderBottomNav() {
  let allTabs, primaryKeys;
  if (session.role === "owner") {
    allTabs = [["owner-summary", "Dashboard"], ["owner-payroll", "Payroll"], ["owner-sales", "All jobs"], ["manager-jobs", "Job status"], ["owner-serviced", "Serviced Cars"], ["owner-arrived", "Cars Arrived"], ["owner-unpaid", "Unpaid Arrivals"], ["owner-audit", "Commission Audit"], ["owner-edit-history", "Edit History"], ["owner-cash", "Cash & Expenses"], ["owner-cleanup", "Cleanup"], ["owner-attendance", "Attendance"], ["owner-search", "Search"], ["owner-team", "Employees"], ["owner-managers", "Managers"], ["owner-salesreps", "Sales Reps"], ["owner-test", "Test tool"]];
    primaryKeys = ["owner-summary", "manager-jobs", "owner-sales", "owner-payroll"];
  } else if (session.role === "manager") {
    allTabs = [["manager-jobs", "Job status"], ["owner-unpaid", "Unpaid Arrivals"], ["owner-cleanup", "Cleanup"], ["owner-attendance", "Attendance"], ["owner-search", "Search"], ["owner-team", "Employees"], ["manager-cash", "Cash Log"], ["manager-performance", "My performance"]];
    primaryKeys = ["manager-jobs", "owner-attendance", "owner-search", "manager-performance"];
  } else if (session.role === "sales") {
    allTabs = [["sales-schedule", "My Bookings"], ["sales-fullschedule", "Full Schedule"], ["sales-performance", "My Performance"]];
    primaryKeys = allTabs.map((t) => t[0]);
  } else {
    allTabs = [["schedule", "Schedule"], ["performance", "My performance"]];
    primaryKeys = allTabs.map((t) => t[0]);
  }

  // A tab saved from a previous session might belong to a different role (someone else
  // logged in on this same phone) - fall back to this role's default rather than land on
  // something invalid or blank.
  if (!allTabs.some((t) => t[0] === currentTab)) {
    currentTab = allTabs[0][0];
    localStorage.setItem("lastTab", currentTab);
  }

  const primaryTabs = primaryKeys.map((k) => allTabs.find((t) => t[0] === k));
  const moreTabs = allTabs.filter((t) => !primaryKeys.includes(t[0]));

  const bar = el("div", { class: "bottom-tabs" });
  primaryTabs.forEach(([key, label]) => {
    bar.appendChild(el("button", {
      class: "bottom-tab" + (currentTab === key ? " active" : ""),
      onclick: () => { currentTab = key; localStorage.setItem("lastTab", currentTab); render(); },
    }, [
      el("div", { class: "tab-icon", text: TAB_ICONS[key] || "•" }),
      el("div", { text: label }),
    ]));
  });
  if (moreTabs.length) {
    const isMoreActive = moreTabs.some((t) => t[0] === currentTab);
    bar.appendChild(el("button", {
      class: "bottom-tab" + (isMoreActive ? " active" : ""),
      onclick: () => openMoreSheet(moreTabs),
    }, [
      el("div", { class: "tab-icon", text: "☰" }),
      el("div", { text: "More" }),
    ]));
  }
  return bar;
}

function closeMoreSheet() {
  document.querySelectorAll(".more-sheet, .more-sheet-backdrop").forEach((n) => n.remove());
}

function openMoreSheet(moreTabs) {
  const backdrop = el("div", { class: "more-sheet-backdrop", onclick: closeMoreSheet });
  const sheet = el("div", { class: "more-sheet" }, moreTabs.map(([key, label]) =>
    el("button", {
      class: "more-sheet-item" + (currentTab === key ? " active" : ""),
      onclick: () => { currentTab = key; localStorage.setItem("lastTab", currentTab); closeMoreSheet(); render(); },
      text: label,
    })
  ));
  document.body.appendChild(backdrop);
  document.body.appendChild(sheet);
}

// ---------------- Employee views ----------------
async function renderEmployeeTabContent(content) {
  if (currentTab === "performance") return renderPerformance(content);
  return renderSchedule(content);
}

// Full schedule — every booked job, every employee sees the same list. Clicking any car
// lets you log an upsell on it, regardless of whether you're the one assigned to work it.
// Who worked the car (employeeNames) is a manager-entered record now, shown for context only.
// No base price or total sale $ shown here — that stays owner/manager-only.
async function renderSchedule(content) {
  const { cols, wrap, clearAll } = makeServiceColumns();
  const emptyMsg = el("div", { class: "muted", style: "display:none", text: "Nothing booked on this day." });
  const tipWidgetWrap = el("div", { style: "margin-bottom:14px" });
  const nav = renderDayNav((params) => load(params));
  async function load(params) {
    const p = params || nav.getParams();
    const qs = new URLSearchParams(p).toString();
    const jobs = await api(`/api/my/jobs?${qs}`);
    tipWidgetWrap.innerHTML = "";
    tipWidgetWrap.appendChild(renderTipWidget(jobs, () => load()));
    clearAll();
    emptyMsg.style.display = jobs.length === 0 ? "" : "none";
    if (jobs.length === 0) return;
    jobs.sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((job) => {
      const upsellList = el("div", { style: "margin-bottom:6px" }, (job.upsells || []).map((u) =>
        el("span", { class: "pill", text: `${u.name} — ${money(u.price)} (${u.attributedToName})` })
      ));
      const upsellForm = renderUpsellForm(job.id, () => load());
      const photoGrid = renderPhotoGrid(job, () => load());
      const notesSection = renderNotesSection(job, () => load());
      const { cardStyle, badge } = cancelledTreatment(job.status);
      const statusLabel = job.status === "arrived" ? "Arrived" : job.status === "no_show" ? "No-show" : job.status === "cancelled" ? "Cancelled" : job.status === "unconfirmed" ? "Unconfirmed" : "Upcoming";
      cols[serviceColumnFor(job.baseService)].appendChild(el("div", { class: "card", style: cardStyle }, [
        el("div", { class: "row", style: "margin-bottom:8px" }, [
          el("div", {}, [
            el("div", { style: "font-weight:500" }, [el("span", { text: job.car }), badge]),
            el("div", { class: "muted", text: `${formatDateTime(job.date)} · ${job.baseService || "no service set"}` }),
            (job.customerName || job.customerPhone) ? el("div", { class: "muted", text: `${job.customerName || ""}${job.customerPhone ? " · " + job.customerPhone : ""}` }) : null,
            el("div", { class: "muted", text: `Worked by: ${job.employeeNames}` }),
          ]),
          el("div", { style: "text-decoration:none", class: "muted", text: statusLabel }),
        ]),
        el("div", { style: "border-top:0.5px solid var(--border);padding-top:8px" }, [upsellList, upsellForm]),
        photoGrid,
        notesSection,
      ]));
    });
  }
  content.appendChild(tipWidgetWrap);
  content.appendChild(nav.el);
  content.appendChild(wrap);
  content.appendChild(emptyMsg);
  await load();
}

const PHOTO_SLOT_DEFS = [["walkaround", "Walk-Around Video"]];
function isVideoFile(filename) {
  return /\.(mp4|mov|webm|m4v|avi)$/i.test(filename || "");
}

// Before/after walk-around clip - shared by Manager Job Status and Tech Schedule, so a
// tech can record it from either place. One clip per stage, video or photo, instead of a
// dozen separate stills.
// Shared note log - tech, manager, and owner can all see and add to it. Same reusable
// pattern as the photo grid, so it's identical wherever it shows up.
// Full-screen in-app image viewer with a real close button — used for receipts and
// anything else that just needs "show this picture," without navigating away to a raw
// image URL, which some mobile browsers (especially a site added to the home screen)
// leave you stuck on with no visible way back.
function showImageModal(url, title) {
  const overlay = el("div", {
    style: "position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px",
    onclick: (e) => { if (e.target === overlay) document.body.removeChild(overlay); },
  }, [
    el("div", { style: "width:100%;max-width:500px;display:flex;justify-content:space-between;align-items:center;margin-bottom:12px" }, [
      el("div", { style: "color:#fff;font-size:14px;font-weight:500", text: title || "Receipt" }),
      el("button", { class: "primary", style: "padding:8px 16px", onclick: () => document.body.removeChild(overlay), text: "✕ Close" }),
    ]),
    el("img", { src: url, style: "max-width:100%;max-height:80vh;border-radius:8px;object-fit:contain" }),
  ]);
  document.body.appendChild(overlay);
}

// Shared tip widget - pick a car from today's jobs, amount auto-splits evenly among
// whoever's assigned to it (the server figures out who, this just sends saleId + amount).
function renderTipWidget(jobs, onDone) {
  const select = el("select", {}, [
    el("option", { value: "", text: "Pick a car..." }),
    ...jobs.map((j) => el("option", { value: j.id, text: `${j.car}${j.customerName ? " — " + j.customerName : ""}` })),
  ]);
  const whoLabel = el("div", { class: "muted", style: "font-size:11.5px;margin:6px 0" });
  const amountInput = el("input", { type: "number", placeholder: "Tip amount", style: "max-width:140px" });
  const notice = el("div", { class: "muted", style: "font-size:11.5px;margin-top:6px" });
  select.addEventListener("change", () => {
    const job = jobs.find((j) => j.id === select.value);
    whoLabel.textContent = job ? `Splits among: ${[job.employeeNames, job.managerHelperNames].filter(Boolean).join(", ") || "Unassigned"}` : "";
  });
  const saveBtn = el("button", { class: "primary", onclick: async () => {
    if (!select.value) { notice.textContent = "Pick a car first."; notice.style.color = "var(--red)"; return; }
    if (!amountInput.value || parseFloat(amountInput.value) <= 0) { notice.textContent = "Enter a real amount."; notice.style.color = "var(--red)"; return; }
    try {
      const r = await api("/api/manager/tips", { method: "POST", body: JSON.stringify({ saleId: select.value, amount: amountInput.value }) });
      notice.textContent = `Saved — split ${r.tip.split.length} way${r.tip.split.length !== 1 ? "s" : ""} ✓`;
      notice.style.color = "var(--green)";
      select.value = ""; amountInput.value = ""; whoLabel.textContent = "";
      onDone();
    } catch (e) {
      notice.textContent = e.message || "Something went wrong.";
      notice.style.color = "var(--red)";
    }
  }, text: "Save tip" });
  return el("div", { class: "card" }, [
    el("div", { style: "font-weight:500;margin-bottom:8px", text: "Log a tip" }),
    select, whoLabel,
    el("div", { style: "display:flex;gap:8px;align-items:center;margin-top:6px" }, [amountInput, saveBtn]),
    notice,
  ]);
}

// Clears a container and holds its height stable while the caller repopulates it right
// after — without this, the container briefly collapses to near-zero height the instant
// it's emptied, and the browser's native scroll behavior snaps back to the top during
// that gap. Call this right before rebuilding any list from scratch.
function clearHeightLocked(container) {
  const currentHeight = container.offsetHeight;
  if (currentHeight > 0) container.style.minHeight = currentHeight + "px";
  container.innerHTML = "";
  requestAnimationFrame(() => requestAnimationFrame(() => { container.style.minHeight = ""; }));
}

function renderNotesSection(job, onDone) {
  const notesList = el("div", { style: "margin-bottom:8px" }, (job.notes || []).map((n) => el("div", { class: "row", style: "font-size:12.5px;margin-bottom:6px;align-items:flex-start" }, [
    el("div", {}, [
      el("div", { text: n.text }),
      el("div", { class: "muted", style: "font-size:10.5px", text: `${n.authorName} · ${formatDateTime(n.timestamp)}` }),
    ]),
    el("button", { class: "icon-danger", style: "font-size:10px;padding:2px 6px", onclick: async () => { await api(`/api/sales/${job.id}/notes/${n.id}`, { method: "DELETE" }); onDone(); }, text: "✕" }),
  ])));
  const noteInput = el("input", { placeholder: "Add a note...", style: "flex:1" });
  const addBtn = el("button", { class: "ghost", onclick: async () => {
    if (!noteInput.value.trim()) return;
    await api(`/api/sales/${job.id}/notes`, { method: "POST", body: JSON.stringify({ text: noteInput.value }) });
    noteInput.value = "";
    onDone();
  }, text: "Add" });
  return el("div", { style: "border-top:0.5px solid var(--border);padding-top:8px;margin-top:8px" }, [
    el("div", { class: "muted", style: "font-size:11px;margin-bottom:6px;font-weight:600;letter-spacing:0.03em", text: "NOTES" }),
    notesList,
    el("div", { style: "display:flex;gap:6px" }, [noteInput, addBtn]),
  ]);
}

function renderPhotoGrid(job, onDone) {
  function stageSection(stage, label) {
    const photos = (job.photos && job.photos[stage]) || {};
    const filename = photos.walkaround;
    let content;
    if (filename) {
      const mediaEl = isVideoFile(filename)
        ? el("video", { src: `/api/photos/${filename}`, controls: "true", style: "width:100%;max-width:260px;border-radius:8px;border:0.5px solid var(--border);display:block" })
        : el("img", { src: `/api/photos/${filename}`, style: "width:100%;max-width:260px;border-radius:8px;border:0.5px solid var(--border);display:block" });
      content = el("div", { style: "position:relative;display:inline-block" }, [
        mediaEl,
        el("button", {
          class: "icon-danger", style: "position:absolute;top:-8px;right:-8px;width:22px;height:22px;padding:0;font-size:12px;border-radius:50%;line-height:1",
          onclick: async () => { await api(`/api/sales/${job.id}/photos/${stage}/walkaround`, { method: "DELETE" }); onDone(); },
          text: "✕",
        }),
      ]);
    } else {
      const statusLabel = el("div", { style: "font-size:10px", text: "Tap to record or upload" });
      const fileInput = el("input", { type: "file", accept: "video/*,image/*", style: "display:none" });
      const tile = el("div", {
        style: "width:130px;height:95px;border:1px dashed var(--border);border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;color:var(--muted);gap:4px",
        onclick: () => fileInput.click(),
      }, [el("div", { style: "font-size:24px", text: "🎥" }), statusLabel, fileInput]);
      fileInput.addEventListener("change", async () => {
        if (!fileInput.files[0]) return;
        statusLabel.textContent = "Uploading...";
        const formData = new FormData();
        formData.append("stage", stage);
        formData.append("slot", "walkaround");
        formData.append("photo", fileInput.files[0]);
        try {
          const res = await fetch(`/api/sales/${job.id}/photos`, { method: "POST", body: formData, credentials: "same-origin" });
          if (!res.ok) throw new Error();
          onDone();
        } catch (e) {
          statusLabel.textContent = "Upload failed - tap to retry";
        }
      });
      content = tile;
    }
    return el("div", { style: "margin-bottom:10px" }, [
      el("div", { class: "muted", style: "font-size:11px;margin-bottom:4px;font-weight:600;letter-spacing:0.03em", text: label.toUpperCase() }),
      content,
    ]);
  }
  return el("div", { style: "border-top:0.5px solid var(--border);padding-top:8px;margin-top:8px" }, [stageSection("before", "Before"), stageSection("after", "After")]);
}

function renderUpsellForm(jobId, onDone) {
  const nameInput = el("input", { placeholder: "Upsell (e.g. Headlight tint)" });
  const priceInput = el("input", { type: "number", placeholder: "Price", style: "max-width:100px" });
  const notice = el("div", { class: "notice" });
  return el("div", { style: "display:flex;gap:8px;margin-top:10px;align-items:center" }, [
    nameInput, priceInput,
    el("button", { class: "ghost", onclick: async () => {
      try {
        await api(`/api/sales/${jobId}/upsells`, { method: "POST", body: JSON.stringify({ name: nameInput.value, price: priceInput.value }) });
        onDone();
      } catch (e) { notice.className = "notice err"; notice.textContent = e.message; }
    }, text: "Add upsell" }),
    notice,
  ]);
}

async function renderPerformance(content) {
  const body = el("div");
  const picker = renderPeriodPicker((params) => load(params), "month");
  async function load(params) {
    const p = params || picker.getParams();
    const qs = new URLSearchParams(p).toString();
    const stats = await api(`/api/my/performance?${qs}`);
    clearHeightLocked(body);
    body.appendChild(el("div", { class: "metric-grid" }, [
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Your upsell revenue" }), el("div", { class: "metric-value mono", style: "color:var(--cyan)", text: money(stats.upsellRevenue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Cars worked" }), el("div", { class: "metric-value mono", text: stats.cars })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Attach rate" }), el("div", { class: "metric-value mono", text: pct(stats.attachRate) })]),
      stats.commissionRate > 0 ? el("div", { class: "metric" }, [el("div", { class: "metric-label", text: `Est. commission (${stats.commissionRate}%)` }), el("div", { class: "metric-value mono", style: "color:var(--green)", text: money(stats.commission) })]) : null,
    ]));
    if (stats.top && stats.top.length) {
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "margin-bottom:8px", text: "STRONG SUIT" }),
        ...stats.top.map((t) => el("div", { class: "row", style: "margin-bottom:4px" }, [el("span", { text: t.name }), el("span", { class: "mono muted", text: `${t.count}x · ${money(t.revenue)}` })])),
      ]));
    }
    if (stats.growthArea) {
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "margin-bottom:8px", text: "GROWTH AREA" }),
        el("div", { class: "row" }, [el("span", { text: stats.growthArea.name }), el("span", { class: "mono muted", text: `${stats.growthArea.count}x · ${money(stats.growthArea.revenue)}` })]),
      ]));
    }
    if (stats.walkInCommissionRate > 0 || stats.walkInClosedCount > 0) {
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "margin-bottom:8px", text: "WALK-INS YOU CLOSED" }),
        el("div", { class: "row", style: "margin-bottom:4px" }, [el("span", { class: "muted", text: "Closed this period" }), el("span", { class: "mono", text: stats.walkInClosedCount })]),
        el("div", { class: "row", style: "margin-bottom:4px" }, [el("span", { class: "muted", text: "Arrived and paid" }), el("span", { class: "mono", style: "color:var(--green)", text: stats.walkInArrivedPaidCount })]),
        stats.walkInCommissionRate > 0
          ? el("div", { class: "row", style: "border-top:0.5px solid var(--border);padding-top:8px;margin-top:4px" }, [
              el("span", { class: "muted", text: `Commission (${stats.walkInCommissionRate}%, only on arrived + paid)` }),
              el("span", { class: "mono", style: "color:var(--green);font-weight:600", text: money(stats.walkInCommission) }),
            ])
          : el("div", { class: "muted", style: "font-size:11px;border-top:0.5px solid var(--border);padding-top:8px;margin-top:4px", text: "No walk-in commission rate set for you yet." }),
      ]));
    }
    if (stats.tipDetails !== undefined && stats.tipDetails.length > 0) {
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row" }, [
          el("span", { class: "muted", style: "margin-bottom:8px", text: `TIPS (${stats.tipDetails.length} CAR${stats.tipDetails.length !== 1 ? "S" : ""})` }),
          el("span", { class: "mono", style: "color:var(--green);font-weight:600", text: money(stats.tipsTotal) }),
        ]),
        el("div", { style: "margin-top:4px" }, stats.tipDetails.map((t) => el("div", { class: "row", style: "font-size:11px;margin-bottom:3px" }, [
          el("span", { class: "muted", text: `${t.car} — ${money(t.totalAmount)} (split ${t.splitCount} way${t.splitCount !== 1 ? "s" : ""})` }),
          el("span", { class: "mono", text: money(t.yourShare) }),
        ]))),
      ]));
    }
    if (stats.payType) {
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "margin-bottom:8px", text: stats.payType === "salary" ? `BASE PAY — SALARY ($${stats.salaryPerPeriod}/period)` : stats.payType === "hourly" ? `BASE PAY — HOURLY ($${stats.hourlyRate}/hr)` : `CAR COMMISSION (${stats.carCommissionRate}% PER CAR)` }),
        el("div", { class: "row" }, [
          el("span", { class: "muted", text: stats.payType === "salary" ? `${stats.basePay.daysPresent} full day(s), ${stats.basePay.daysHalf} half day(s), ${stats.basePay.daysAbsent} absent` : stats.payType === "hourly" ? `${stats.basePay.hoursCounted.toFixed(1)} hours worked` : `${(stats.basePay.carDetails || []).length} car(s) arrived + paid` }),
          el("span", { class: "mono", style: "color:var(--green);font-weight:600", text: money(stats.basePay.amount) }),
        ]),
        stats.payType === "commission" && (stats.basePay.carDetails || []).length > 0
          ? el("div", { style: "margin-top:6px" }, stats.basePay.carDetails.map((c) => el("div", { class: "row", style: "font-size:11px;margin-bottom:3px" }, [
              el("span", { class: "muted", text: `${c.car} — ${money(c.basePrice)} (split ${c.splitCount} way${c.splitCount !== 1 ? "s" : ""})` }),
              el("span", { class: "mono", text: money(c.yourShare) }),
            ])))
          : null,
      ]));
    }
    body.appendChild(el("div", { class: "card" }, [
      el("div", { class: "row" }, [
        el("span", { style: "font-weight:600;font-size:14px", text: "Total owed to you" }),
        el("span", { class: "mono", style: "color:var(--amber);font-weight:700;font-size:18px", text: money(stats.totalPay) }),
      ]),
    ]));
  }
  content.appendChild(picker.el);
  content.appendChild(body);
  await load();
}

// ---------------- Owner views ----------------
async function renderManagerTabContent(content) {
  if (currentTab === "owner-search") return renderSearch(content);
  if (currentTab === "owner-attendance") return renderAttendance(content);
  if (currentTab === "owner-cleanup") return renderCleanup(content);
  if (currentTab === "owner-team") return renderOwnerTeam(content);
  if (currentTab === "manager-cash") return renderCashLog(content);
  if (currentTab === "owner-unpaid") return renderUnpaidArrived(content);
  if (currentTab === "manager-performance") return renderManagerPerformance(content);
  return renderManagerJobs(content);
}

async function renderSalesTabContent(content) {
  if (currentTab === "sales-performance") return renderSalesPerformance(content);
  if (currentTab === "sales-fullschedule") return renderSalesFullSchedule(content);
  return renderSalesSchedule(content);
}

async function renderOwnerTabContent(content) {
  if (currentTab === "owner-sales") return renderOwnerSales(content);
  if (currentTab === "owner-serviced") return renderServicedCars(content);
  if (currentTab === "owner-arrived") return renderCarsArrived(content);
  if (currentTab === "owner-audit") return renderCommissionAudit(content);
  if (currentTab === "owner-edit-history") return renderEditHistory(content);
  if (currentTab === "owner-cash") return renderOwnerCash(content);
  if (currentTab === "owner-unpaid") return renderUnpaidArrived(content);
  if (currentTab === "owner-payroll") return renderOwnerPayroll(content);
  if (currentTab === "owner-team") return renderOwnerTeam(content);
  if (currentTab === "owner-managers") return renderOwnerManagers(content);
  if (currentTab === "owner-salesreps") return renderOwnerSalesReps(content);
  if (currentTab === "owner-attendance") return renderAttendance(content);
  if (currentTab === "owner-cleanup") return renderCleanup(content);
  if (currentTab === "manager-jobs") return renderManagerJobs(content);
  if (currentTab === "owner-search") return renderSearch(content);
  if (currentTab === "owner-test") return renderTestTool(content);
  return renderOwnerSummary(content);
}

// Payroll — every person's own upsells grouped together, their commission owed, and the
// shop-wide combined total for comparison. This is the page built specifically for running pay.
async function renderOwnerPayroll(content) {
  const body = el("div");
  const picker = renderPeriodPicker((params) => load(params), "payperiod");
  const payrollEmployees = await api("/api/employees");
  const payrollManagers = await api("/api/managers");
  const payrollSalesReps = await api("/api/salesreps");

  function personCard(p, subtitle) {
    const rowsList = (p.individualUpsells || []).length
      ? p.individualUpsells.map((u) => {
          const nameInput = el("input", { value: u.name, style: "max-width:130px;font-size:12px" });
          const priceInput = el("input", { type: "number", value: u.price, style: "max-width:70px;font-size:12px" });
          const creditSelect = el("select", {
            style: "max-width:150px;font-size:11px;background:var(--panel);border:0.5px solid var(--border);border-radius:6px;color:var(--sub);padding:2px 4px",
            onchange: async (e) => {
              const [creditType, creditId] = e.target.value ? e.target.value.split("::") : ["none", ""];
              await api(`/api/sales/${u.saleId}/upsells/${u.id}`, { method: "PATCH", body: JSON.stringify({ creditType, creditId }) });
              load();
            },
          }, [
            el("option", { value: "", text: "Unassigned" }),
            ...payrollEmployees.map((e) => el("option", { value: `employee::${e.id}`, text: `Tech: ${e.name}`, ...(u.employeeId === e.id ? { selected: "true" } : {}) })),
            ...payrollManagers.map((m) => el("option", { value: `manager::${m.id}`, text: `Manager: ${m.name}`, ...(u.managerId === m.id ? { selected: "true" } : {}) })),
            ...payrollSalesReps.map((r) => el("option", { value: `salesrep::${r.id}`, text: `Rep: ${r.name}`, ...(u.salesRepId === r.id ? { selected: "true" } : {}) })),
          ]);
          return el("div", { class: "row", style: "margin-bottom:6px;align-items:center;flex-wrap:wrap;gap:4px" }, [
            el("div", { style: "min-width:0" }, [
              nameInput,
              el("div", { class: "muted", style: "font-size:10px", text: `${u.car || ""} · ${formatDateTime(u.date)}` }),
            ]),
            priceInput, creditSelect,
            el("button", { class: "ghost", style: "font-size:10px;padding:3px 7px", onclick: async () => {
              await api(`/api/sales/${u.saleId}/upsells/${u.id}`, { method: "PATCH", body: JSON.stringify({ name: nameInput.value, price: priceInput.value }) });
              load();
            }, text: "Save" }),
            el("button", { class: "icon-danger", style: "padding:3px 7px", onclick: async () => {
              await api(`/api/sales/${u.saleId}/upsells/${u.id}`, { method: "DELETE" });
              load();
            }, text: "✕" }),
          ]);
        })
      : [el("div", { class: "muted", style: "font-size:12.5px", text: "No upsells logged in this period." })];

    const count = (p.individualUpsells || []).length;
    const rowsWrap = el("div", { style: "display:none;padding-top:8px" }, rowsList);
    const toggleBtn = el("button", {
      class: "ghost", style: "width:100%;text-align:left;font-size:12.5px", onclick: () => {
        const showing = rowsWrap.style.display !== "none";
        rowsWrap.style.display = showing ? "none" : "block";
        toggleBtn.textContent = showing ? `▸ ${count} upsell${count !== 1 ? "s" : ""} logged — tap to view/edit` : `▾ Hide upsells`;
      },
      text: count ? `▸ ${count} upsell${count !== 1 ? "s" : ""} logged — tap to view/edit` : "No upsells logged in this period",
    });
    const upsellSection = count ? [toggleBtn, rowsWrap] : [toggleBtn];

    return el("div", { class: "card" }, [
      el("div", { class: "row", style: "margin-bottom:2px" }, [
        el("div", { class: "oswald", style: "font-size:15px", text: p.name }),
        el("div", { class: "mono", style: "color:var(--cyan);font-size:16px", text: money(p.upsellRevenue) }),
      ]),
      el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:10px", text: subtitle }),
      el("div", { style: "border-top:0.5px solid var(--border);padding-top:8px;margin-bottom:8px" }, upsellSection),
      p.commissionRate > 0
        ? el("div", { class: "row", style: "border-top:0.5px solid var(--border);padding-top:8px" }, [
            el("span", { class: "muted", style: "font-size:12.5px", text: `Upsell commission (${p.commissionRate}%)` }),
            el("span", { class: "mono", style: "color:var(--green);font-weight:600", text: money(p.commission) }),
          ])
        : el("div", { class: "muted", style: "font-size:11.5px;border-top:0.5px solid var(--border);padding-top:8px", text: "No upsell commission rate set for this person." }),
      (p.walkInClosedCount > 0 || p.walkInCommissionRate > 0)
        ? el("div", { style: "border-top:0.5px solid var(--border);padding-top:8px;margin-top:6px" }, [
            el("div", { class: "row" }, [
              el("span", { class: "muted", style: "font-size:12.5px", text: `Walk-in revenue (${p.walkInArrivedPaidCount} arrived+paid)` }),
              el("span", { class: "mono", style: "color:var(--amber)", text: money(p.walkInRevenue) }),
            ]),
            el("div", { class: "row", style: "margin-top:2px" }, [
              el("span", { class: "muted", style: "font-size:12.5px", text: `Walk-in close commission (${p.walkInCommissionRate}%, ${p.walkInArrivedPaidCount} arrived+paid of ${p.walkInClosedCount} closed)` }),
              el("span", { class: "mono", style: "color:var(--green);font-weight:600", text: money(p.walkInCommission) }),
            ]),
            (() => {
              const walkInWrap = el("div", { style: "display:none;margin-top:6px" }, (p.walkInDetails || []).map((w) => el("div", { class: "row", style: "font-size:11.5px;margin-bottom:3px" }, [
                el("div", {}, [
                  el("div", { text: w.car }),
                  el("div", { class: "muted", style: "font-size:10px", text: `${formatDateTime(w.date)}${w.customerName ? " · " + w.customerName : ""}` }),
                ]),
                el("div", { style: "text-align:right" }, [
                  el("div", { class: "mono", style: "color:var(--amber)", text: money(w.basePrice) }),
                  el("div", { style: `font-size:10px;color:${w.status === "arrived" && w.paid ? "var(--green)" : w.status === "no_show" ? "var(--red)" : "var(--sub)"}`, text: w.status === "arrived" ? (w.paid ? "Arrived, paid" : "Arrived, unpaid") : w.status === "no_show" ? "No-show" : "Pending" }),
                  w.commissionAmount > 0 ? el("div", { class: "mono", style: "font-size:10px;color:var(--green)", text: `+${money(w.commissionAmount)}` }) : null,
                ]),
              ])));
              const walkInToggle = el("button", {
                class: "ghost", style: "width:100%;text-align:left;font-size:11.5px;margin-top:4px", onclick: () => {
                  const showing = walkInWrap.style.display !== "none";
                  walkInWrap.style.display = showing ? "none" : "block";
                  walkInToggle.textContent = showing ? "▸ See walk-ins closed" : "▾ Hide walk-ins";
                },
              }, [el("span", { text: (p.walkInDetails || []).length > 0 ? "▸ See walk-ins closed" : "No walk-ins this period" })]);
              if ((p.walkInDetails || []).length === 0) walkInToggle.disabled = true;
              return el("div", {}, [walkInToggle, walkInWrap]);
            })(),
          ])
        : null,
      p.payType
        ? el("div", { style: "border-top:0.5px solid var(--border);padding-top:8px;margin-top:6px" }, [
            el("div", { class: "row" }, [
              el("span", { class: "muted", style: "font-size:12.5px", text: p.payType === "salary" ? `Base pay (salary, $${p.salaryPerPeriod}/period)` : p.payType === "hourly" ? `Base pay (hourly, $${p.hourlyRate}/hr)` : `Car commission (${p.carCommissionRate}% per car)` }),
              el("span", { class: "mono", style: "color:var(--green);font-weight:600", text: money(p.basePay.amount) }),
            ]),
            p.payType === "commission"
              ? (() => {
                  const carsWrap = el("div", { style: "display:none;margin-top:6px" }, (p.basePay.carDetails || []).map((c) => el("div", { class: "row", style: "font-size:11px;margin-bottom:3px" }, [
                    el("span", { class: "muted", text: `${c.car} — ${money(c.basePrice)} (split ${c.splitCount} way${c.splitCount !== 1 ? "s" : ""})` }),
                    el("span", { class: "mono", text: money(c.yourShare) }),
                  ])));
                  const toggleBtn = el("button", { class: "ghost", style: "width:100%;text-align:left;font-size:10.5px;margin-top:2px", onclick: () => {
                    const showing = carsWrap.style.display !== "none";
                    carsWrap.style.display = showing ? "none" : "block";
                    toggleBtn.textContent = showing ? `▸ See which cars (${(p.basePay.carDetails || []).length})` : "▾ Hide cars";
                  } }, [el("span", { text: (p.basePay.carDetails || []).length > 0 ? `▸ See which cars (${p.basePay.carDetails.length})` : "No arrived+paid cars yet" })]);
                  if ((p.basePay.carDetails || []).length === 0) toggleBtn.disabled = true;
                  return el("div", {}, [toggleBtn, carsWrap]);
                })()
              : el("div", { class: "muted", style: "font-size:10.5px;margin-top:2px", text: p.payType === "salary"
                  ? `${p.basePay.daysPresent} full day(s), ${p.basePay.daysHalf} half day(s), ${p.basePay.daysAbsent} absent`
                  : `${p.basePay.hoursCounted.toFixed(1)} hours worked`
                }),
          ])
        : el("div", { class: "muted", style: "font-size:11px;border-top:0.5px solid var(--border);padding-top:8px;margin-top:6px", text: "No base pay type set (Employees/Managers tab)." }),
      p.tipDetails !== undefined
        ? el("div", { style: "border-top:0.5px solid var(--border);padding-top:8px;margin-top:6px" }, [
            el("div", { class: "row" }, [
              el("span", { class: "muted", style: "font-size:12.5px", text: `Tips (${p.tipDetails.length} car${p.tipDetails.length !== 1 ? "s" : ""})` }),
              el("span", { class: "mono", style: "color:var(--green);font-weight:600", text: money(p.tipsTotal) }),
            ]),
            p.tipDetails.length > 0
              ? el("div", { style: "margin-top:4px" }, p.tipDetails.map((t) => el("div", { class: "row", style: "font-size:11px;margin-bottom:2px" }, [
                  el("span", { class: "muted", text: `${t.car} (split ${t.splitCount} way${t.splitCount !== 1 ? "s" : ""})` }),
                  el("span", { class: "mono", text: money(t.yourShare) }),
                ])))
              : null,
          ])
        : null,
      el("div", { class: "row", style: "border-top:1px solid var(--border);padding-top:8px;margin-top:8px" }, [
        el("span", { style: "font-weight:600;font-size:13px", text: "Total owed" }),
        el("span", { class: "mono", style: "color:var(--amber);font-weight:700;font-size:16px", text: money(p.totalPay) }),
      ]),
    ]);
  }

  async function load(params) {
    const p = params || picker.getParams();
    const qs = new URLSearchParams(p).toString();
    const d = await api(`/api/owner/payroll?${qs}`);
    clearHeightLocked(body);

    body.appendChild(el("div", { class: "metric-grid" }, [
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Combined upsell revenue — everyone" }), el("div", { class: "metric-value mono", style: "color:var(--cyan)", text: money(d.shopTotalUpsellRevenue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Total commission owed" }), el("div", { class: "metric-value mono", style: "color:var(--green)", text: money(d.employees.reduce((a, e) => a + e.commission + e.walkInCommission, 0) + d.managers.reduce((a, m) => a + m.commission + m.walkInCommission, 0) + (d.salesReps || []).reduce((a, r) => a + r.commission, 0)) })]),
    ]));

    body.appendChild(el("div", { class: "muted", style: "margin:16px 0 8px;font-size:11.5px;letter-spacing:0.04em", text: "EMPLOYEES — EACH PERSON'S OWN UPSELLS" }));
    if (d.employees.length === 0) body.appendChild(el("div", { class: "muted", text: "No employees added yet." }));
    d.employees.forEach((e) => body.appendChild(personCard(e, `${e.carsWorked} car${e.carsWorked !== 1 ? "s" : ""} worked · ${e.upsellCount} upsell${e.upsellCount !== 1 ? "s" : ""} sold`)));

    if (d.managers.length > 0) {
      body.appendChild(el("div", { class: "muted", style: "margin:16px 0 8px;font-size:11.5px;letter-spacing:0.04em", text: "MANAGERS — EACH PERSON'S OWN UPSELLS" }));
      d.managers.forEach((m) => body.appendChild(personCard(m, `${m.upsellCount} upsell${m.upsellCount !== 1 ? "s" : ""} sold`)));
    }
  }

  // Sales reps run a different pay period entirely (Thursday through the following
  // Wednesday, not the Tuesday-to-Tuesday cycle above) — so this is a fully separate
  // section with its own stepper, not sharing the picker above at all.
  const salesRepBody = el("div");
  const salesRepPicker = renderPeriodPicker((params) => loadSalesReps(params), "payperiod", SALES_PAY_PERIOD_ANCHOR);
  async function loadSalesReps(params) {
    const p = params || salesRepPicker.getParams();
    const qs = new URLSearchParams(p).toString();
    const d = await api(`/api/owner/payroll?${qs}`);
    clearHeightLocked(salesRepBody);
    if (!d.salesReps || d.salesReps.length === 0) { salesRepBody.appendChild(el("div", { class: "muted", text: "No sales reps added yet." })); return; }
    d.salesReps.forEach((r) => {
      salesRepBody.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row", style: "margin-bottom:2px" }, [
          el("div", { class: "oswald", style: "font-size:15px", text: r.name }),
          el("div", { class: "mono", style: "color:var(--amber);font-size:16px", text: money(r.showedValue) }),
        ]),
        el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:4px", text: `${r.totalBooked} booked · ${r.showedCount} showed (no-shows earn nothing)` }),
        r.noShowCount > 0
          ? el("div", { class: "muted", style: `font-size:11.5px;margin-bottom:6px;color:${r.noShowRate >= 20 ? "var(--red)" : "var(--sub)"}`, text: `${r.noShowCount} no-show${r.noShowCount !== 1 ? "s" : ""} — ${Math.round(r.noShowRate)}% no-show rate` })
          : el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:6px", text: "0 no-shows" }),
        (() => {
          const detailWrap = el("div", { style: "display:none;margin-bottom:10px" });
          if (r.arrivedDetails.length > 0) {
            detailWrap.appendChild(el("div", { class: "muted", style: "font-size:10.5px;font-weight:600;margin-top:6px;margin-bottom:4px", text: "ARRIVED" }));
            r.arrivedDetails.forEach((j) => detailWrap.appendChild(el("div", { class: "row", style: "font-size:11.5px;margin-bottom:3px" }, [
              el("span", {}, [el("span", { text: j.car }), el("span", { class: "muted", text: ` · ${formatDateTime(j.date)}` })]),
              el("span", { class: "mono", style: "color:var(--green)", text: `${money(j.basePrice)} → +${money(j.commissionAmount)}` }),
            ])));
          }
          if (r.noShowDetails.length > 0) {
            detailWrap.appendChild(el("div", { class: "muted", style: "font-size:10.5px;font-weight:600;margin-top:8px;margin-bottom:4px", text: "NO-SHOW" }));
            r.noShowDetails.forEach((j) => detailWrap.appendChild(el("div", { class: "row", style: "font-size:11.5px;margin-bottom:3px" }, [
              el("span", { style: "color:var(--red)" }, [el("span", { text: j.car }), el("span", { class: "muted", text: ` · ${formatDateTime(j.date)}` })]),
              el("span", { class: "mono", style: "color:var(--red)", text: money(j.basePrice) }),
            ])));
          }
          const toggleBtn = el("button", { class: "ghost", style: "width:100%;text-align:left;font-size:11.5px;margin-bottom:6px", onclick: () => {
            const showing = detailWrap.style.display !== "none";
            detailWrap.style.display = showing ? "none" : "block";
            toggleBtn.textContent = showing ? "▸ See who arrived / no-showed" : "▾ Hide details";
          }, text: (r.arrivedDetails.length + r.noShowDetails.length) > 0 ? "▸ See who arrived / no-showed" : "No resolved appointments yet" });
          if ((r.arrivedDetails.length + r.noShowDetails.length) === 0) toggleBtn.disabled = true;
          return el("div", {}, [toggleBtn, detailWrap]);
        })(),
        r.commissionRate > 0
          ? el("div", { style: "border-top:0.5px solid var(--border);padding-top:8px" }, [
              el("div", { class: "row" }, [
                el("span", { class: "muted", style: "font-size:12.5px", text: "Commission owed" }),
                el("span", { class: "mono", style: "color:var(--green);font-weight:600", text: money(r.commission) }),
              ]),
              el("div", { class: "muted", style: "font-size:10.5px;margin-top:2px", text: `${r.duringHoursCount} in-hours sale${r.duringHoursCount !== 1 ? "s" : ""} @ ${r.commissionRate}% + ${r.afterHoursCount} after-hours sale${r.afterHoursCount !== 1 ? "s" : ""} @ ${r.afterHoursCommissionRate}% — calculated per sale, not a flat rate` }),
            ])
          : el("div", { class: "muted", style: "font-size:11.5px;border-top:0.5px solid var(--border);padding-top:8px", text: "No commission rate set for this person." }),
        (r.duplicateWarnings || []).length > 0
          ? el("div", { style: "margin-top:10px;padding:10px;border:1px solid var(--red);border-radius:var(--radius);background:var(--fill-danger, rgba(242,88,95,0.08))" }, [
              el("div", { style: "font-size:12px;font-weight:600;color:var(--red);margin-bottom:6px", text: `⚠ ${r.duplicateWarnings.length} possible duplicate job(s) — same real customer appears more than once, both counted toward the commission above` }),
              ...r.duplicateWarnings.map((w) => el("div", { class: "row", style: "font-size:11.5px;margin-bottom:2px" }, [
                el("span", {}, [el("span", { text: w.car }), el("span", { class: "muted", text: ` · ${formatDateTime(w.date)}` })]),
                el("span", { class: "mono", style: "color:var(--red)", text: `+${money(w.commissionAmount)}` }),
              ])),
              el("div", { class: "muted", style: "font-size:10.5px;margin-top:6px", text: "Check Test Tool → \"Check for duplicate jobs\" to review and remove the extra one." }),
            ])
          : null,
      ]));
    });
  }
  content.appendChild(picker.el);
  content.appendChild(body);
  content.appendChild(el("div", { class: "muted", style: "margin:20px 0 8px;font-size:11.5px;letter-spacing:0.04em;border-top:0.5px solid var(--border);padding-top:16px", text: "SALES REPS — SEPARATE PAY PERIOD (THU–WED)" }));
  content.appendChild(salesRepPicker.el);
  content.appendChild(salesRepBody);
  await load();
  await loadSalesReps();
}

function openPrintableReport(title, s, periodLabel) {
  const win = window.open("", "_blank");
  const rowsEmp = s.perEmployee.map((e) => `<tr><td>${e.name}</td><td>${e.cars}</td><td>${money(e.upsellRevenue)}</td></tr>`).join("");
  const rowsMgr = (s.perManager || []).map((m) => `<tr><td>${m.name}</td><td>${money(m.upsellRevenue)}</td></tr>`).join("");
  const rowsLb = s.leaderboard.map((r) => `<tr><td>${r.upsell}</td><td>${r.employee}</td><td>${r.count}</td><td>${money(r.revenue)}</td></tr>`).join("");
  win.document.write(`
    <html><head><title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; color: #111; padding: 30px; }
      h1 { font-size: 20px; margin-bottom: 2px; }
      .sub { color: #666; font-size: 13px; margin-bottom: 20px; }
      .metrics { display: flex; gap: 24px; margin-bottom: 24px; flex-wrap: wrap; }
      .metric { border: 1px solid #ddd; border-radius: 6px; padding: 10px 16px; }
      .metric-label { font-size: 11px; color: #666; text-transform: uppercase; }
      .metric-value { font-size: 20px; font-weight: 600; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px; }
      th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #ddd; }
      th { color: #666; font-weight: 600; }
      h2 { font-size: 14px; margin: 20px 0 8px; }
    </style></head>
    <body>
      <h1>SBN Autostyling Tracker — ${title}</h1>
      <div class="sub">${periodLabel}</div>
      <div class="metrics">
        <div class="metric"><div class="metric-label">Total revenue</div><div class="metric-value">${money(s.totalRevenue)}</div></div>
        <div class="metric"><div class="metric-label">Total upsell revenue</div><div class="metric-value">${money(s.totalUpsellRevenue)}</div></div>
        <div class="metric"><div class="metric-label">Walk-in revenue</div><div class="metric-value">${money(s.walkInRevenue)}</div></div>
        <div class="metric"><div class="metric-label">Upsell % of revenue</div><div class="metric-value">${pct(s.upsellPercentOfRevenue)}</div></div>
        <div class="metric"><div class="metric-label">Cars serviced</div><div class="metric-value">${s.carCount}</div></div>
      </div>
      <h2>Per-employee breakdown</h2>
      <table><tr><th>Employee</th><th>Cars worked</th><th>Upsell revenue</th></tr>${rowsEmp}</table>
      ${rowsMgr ? `<h2>Manager upsells</h2><table><tr><th>Manager</th><th>Upsell revenue</th></tr>${rowsMgr}</table>` : ""}
      <h2>Upsell leaderboard</h2>
      <table><tr><th>Upsell</th><th>Employee</th><th>Times sold</th><th>Revenue</th></tr>${rowsLb}</table>
    </body></html>
  `);
  win.document.close();
  setTimeout(() => win.print(), 300);
}

  const cloudStatus = el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:16px" });
  const cloudStatusText = el("span", {});
  async function loadCloudStatus() {
    try {
      const s = await api("/api/owner/backup-status");
      if (!s.configured) {
        cloudStatusText.textContent = "☁ Automatic cloud backup: not set up yet.";
        cloudStatusText.style.color = "var(--sub)";
      } else if (s.last && s.last.ok) {
        cloudStatusText.textContent = `☁ Automatic cloud backup: last succeeded ${formatDateTime(s.last.time)}`;
        cloudStatusText.style.color = "var(--green)";
      } else if (s.last) {
        cloudStatusText.textContent = `☁ Automatic cloud backup: last attempt failed — ${s.last.error}`;
        cloudStatusText.style.color = "var(--red)";
      } else {
        cloudStatusText.textContent = "☁ Automatic cloud backup: configured, waiting for first run.";
        cloudStatusText.style.color = "var(--sub)";
      }
    } catch (e) {}
  }
  const backupNowBtn = el("button", { class: "ghost", style: "margin-left:8px", text: "Test now", onclick: async () => {
    backupNowBtn.textContent = "Testing...";
    await api("/api/owner/backup-now", { method: "POST" });
    await loadCloudStatus();
    backupNowBtn.textContent = "Test now";
  } });
  cloudStatus.appendChild(cloudStatusText);
  cloudStatus.appendChild(backupNowBtn);

  const revenueStartInput = el("input", { type: "date" });
  const revenueStartNotice = el("span", { class: "muted", style: "font-size:11.5px" });
  async function loadRevenueStart() {
    const r = await api("/api/owner/revenue-start-date");
    if (r.revenueStartDate) {
      revenueStartInput.value = r.revenueStartDate;
      revenueStartNotice.textContent = `Currently tracking revenue from ${r.revenueStartDate} onward. Everything before that is excluded from every total, but still fully visible in All Jobs.`;
    } else {
      revenueStartNotice.textContent = "No cutoff set — every job ever entered counts toward revenue.";
    }
  }
  const revenueStartRow = el("div", { class: "card", style: "max-width:520px;margin-bottom:14px" }, [
    el("div", { class: "muted", style: "margin-bottom:8px", text: "REVENUE TRACKING START DATE — jobs before this date are excluded from every revenue and commission total everywhere, but stay completely visible in All Jobs, Search, and the schedule with their real prices intact. Nothing ever gets deleted or altered." }),
    el("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" }, [
      revenueStartInput,
      el("button", { class: "primary", onclick: async () => {
        await api("/api/owner/revenue-start-date", { method: "POST", body: JSON.stringify({ date: revenueStartInput.value }) });
        await loadRevenueStart();
        load();
      }, text: "Set cutoff" }),
      el("button", { class: "ghost", onclick: async () => {
        await api("/api/owner/revenue-start-date", { method: "POST", body: JSON.stringify({ date: null }) });
        revenueStartInput.value = "";
        await loadRevenueStart();
        load();
      }, text: "Clear cutoff" }),
    ]),
    revenueStartNotice,
  ]);

  async function renderOwnerSummary(content) {
  const body = el("div");
  const picker = renderPeriodPicker((params) => load(params), "month");
  let lastSummary = null, lastQs = "";
  const actions = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px" }, [
    el("button", { class: "ghost", text: "Print report", onclick: () => { if (lastSummary) openPrintableReport("Dashboard report", lastSummary, lastQs); } }),
    el("a", { href: "#", class: "ghost", style: "text-decoration:none;display:inline-block", text: "Export CSV", onclick: (e) => { e.preventDefault(); window.location.href = `/api/owner/export/csv?${lastQs}`; } }),
    el("a", { href: "/api/owner/backup", class: "ghost", style: "text-decoration:none;display:inline-block", text: "Download full backup" }),
  ]);
  async function load(params) {
    const p = params || picker.getParams();
    const qs = new URLSearchParams(p).toString();
    lastQs = qs;
    const s = await api(`/api/owner/summary?${qs}`);
    lastSummary = s;
    clearHeightLocked(body);
    body.appendChild(el("div", { class: "metric-grid" }, [
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Total revenue" }), el("div", { class: "metric-value mono", style: "color:var(--amber)", text: money(s.totalRevenue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Total upsell revenue" }), el("div", { class: "metric-value mono", style: "color:var(--cyan)", text: money(s.totalUpsellRevenue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Walk-in revenue" }), el("div", { class: "metric-value mono", style: "color:var(--sub)", text: money(s.walkInRevenue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Upsell % of revenue" }), el("div", { class: "metric-value mono", text: pct(s.upsellPercentOfRevenue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Shop attach rate" }), el("div", { class: "metric-value mono", text: pct(s.attachRate) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Cars serviced" }), el("div", { class: "metric-value mono", text: s.carCount })]),
    ]));
    const empTable = el("table", {}, [
      el("tr", {}, [el("th", { text: "Employee" }), el("th", { text: "Cars worked" }), el("th", { text: "Their upsell revenue" })]),
      ...s.perEmployee.map((e) => el("tr", {}, [el("td", { text: e.name }), el("td", { class: "mono", text: e.cars }), el("td", { class: "mono", style: "color:var(--cyan)", text: money(e.upsellRevenue) })])),
    ]);
    body.appendChild(el("div", { class: "card" }, [
      el("div", { class: "muted", style: "margin-bottom:10px", text: "PER-EMPLOYEE BREAKDOWN" }),
      el("div", { class: "muted", style: "margin-bottom:10px;font-size:11.5px", text: "Cars worked counts every job a tech was part of, including tag-teamed ones. Upsell revenue only counts what that person personally logged." }),
      empTable,
    ]));

    if (s.perManager && s.perManager.length > 0) {
      const mgrTable = el("table", {}, [
        el("tr", {}, [el("th", { text: "Manager" }), el("th", { text: "Their upsell revenue" })]),
        ...s.perManager.map((m) => el("tr", {}, [el("td", { text: m.name }), el("td", { class: "mono", style: "color:var(--cyan)", text: money(m.upsellRevenue) })])),
      ]);
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "margin-bottom:10px", text: "MANAGER UPSELLS" }),
        mgrTable,
      ]));
    }

    if (s.perSalesRep && s.perSalesRep.length > 0) {
      const repTable = el("table", {}, [
        el("tr", {}, [el("th", { text: "Sales rep" }), el("th", { text: "Booked" }), el("th", { text: "Showed" }), el("th", { text: "Showed value" }), el("th", { text: "Commission" })]),
        ...s.perSalesRep.map((r) => el("tr", {}, [
          el("td", { text: r.name }), el("td", { class: "mono", text: r.totalBooked }), el("td", { class: "mono", style: "color:var(--green)", text: r.showedCount }),
          el("td", { class: "mono", style: "color:var(--amber)", text: money(r.showedValue) }), el("td", { class: "mono", style: "color:var(--green)", text: money(r.commission) }),
        ])),
      ]);
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "margin-bottom:10px", text: "SALES REP PERFORMANCE" }),
        el("div", { class: "muted", style: "margin-bottom:10px;font-size:11.5px", text: "Commission is on the base sale, only counted once a manager marks it arrived — no-shows earn nothing." }),
        repTable,
      ]));
    }

    const lbTable = el("table", {}, [
      el("tr", {}, [el("th", { text: "Upsell" }), el("th", { text: "Employee" }), el("th", { text: "Times sold" }), el("th", { text: "Revenue" })]),
      ...s.leaderboard.map((r) => el("tr", {}, [el("td", { text: r.upsell }), el("td", { class: "muted", text: r.employee }), el("td", { class: "mono", text: r.count }), el("td", { class: "mono", style: "color:var(--cyan)", text: money(r.revenue) })])),
    ]);
    body.appendChild(el("div", { class: "card" }, [el("div", { class: "muted", style: "margin-bottom:10px", text: "UPSELL LEADERBOARD BY EMPLOYEE" }), s.leaderboard.length ? lbTable : el("div", { class: "muted", text: "No upsells logged yet in this period." })]));

    body.appendChild(el("div", { class: "card" }, [
      el("div", { class: "muted", style: "margin-bottom:10px", text: "BOOKING PIPELINE — what's coming vs. what's already happened" }),
      el("div", { class: "metric-grid" }, [
        el("div", { class: "metric" }, [el("div", { class: "metric-label", text: `Booked, not shown yet (${s.bookedNotShownCount})` }), el("div", { class: "metric-value mono", style: "color:var(--sub)", text: money(s.bookedNotShownValue) })]),
        el("div", { class: "metric" }, [el("div", { class: "metric-label", text: `Shown up (${s.shownUpCount})` }), el("div", { class: "metric-value mono", style: "color:var(--green)", text: money(s.shownUpValue) })]),
      ]),
      el("div", { class: "muted", style: "font-size:11px;margin-top:8px", text: "\"Shown up\" counts the moment a car arrives, even before it's paid. \"Total revenue\" above is decided purely by payment — cash, card, or both — regardless of whether the service has been marked complete yet." }),
    ]));

    const unpaidArrived = await api("/api/manager/unpaid-arrived");
    const unpaidTotal = unpaidArrived.reduce((a, j) => a + (j.total || 0), 0);
    if (unpaidArrived.length > 0) {
      body.appendChild(el("div", {
        class: "card", style: "cursor:pointer;border-color:var(--amber)",
        onclick: () => { currentTab = "owner-unpaid"; localStorage.setItem("lastTab", currentTab); render(); },
      }, [
        el("div", { class: "row" }, [
          el("div", { class: "muted", text: `⚠ ${unpaidArrived.length} job${unpaidArrived.length !== 1 ? "s" : ""} showed up but haven't been marked paid — this is the gap you're seeing between Shown Up and Total Revenue` }),
          el("div", { class: "mono", style: "color:var(--amber);font-weight:600", text: money(unpaidTotal) }),
        ]),
        el("div", { class: "muted", style: "font-size:10.5px;margin-top:4px", text: "Tap to view and mark paid" }),
      ]));
    }
  }
  content.appendChild(picker.el);
  content.appendChild(actions);
  content.appendChild(revenueStartRow);
  content.appendChild(cloudStatus);
  content.appendChild(body);
  await load();
  await loadCloudStatus();
  await loadRevenueStart();
}

function sameLocalDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}
function jobStatusColors(s) {
  if (s.status === "cancelled") return { bg: "var(--borderSoft)", border: "var(--muted)", text: "var(--muted)" };
  if (s.status === "arrived") return { bg: "#173404", border: "var(--green)", text: "var(--green)" };
  if (s.status === "no_show") return { bg: "#501313", border: "var(--red)", text: "var(--red)" };
  return { bg: "var(--cyanDim)", border: "var(--cyan)", text: "var(--cyan)" };
}
function serviceAbbrev(baseService) {
  if (!baseService) return "";
  const s = baseService.toLowerCase();
  if (s.includes("ceramic")) return "CC";
  if (s.includes("tint")) return "WT";
  if (s.includes("ppf")) return "PPF";
  return baseService.slice(0, 3).toUpperCase();
}

// Week view — a real time-of-day grid, same visual language across all three calendar levels.
function renderWeekGrid(sales) {
  const startHour = 7, endHour = 19;
  const first = sales.length ? new Date(sales[0].date) : new Date();
  const day = first.getDay();
  const monday = new Date(first); monday.setDate(first.getDate() - ((day + 6) % 7)); monday.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });
  const today = new Date();
  const gridHeight = (endHour - startHour) * 44;

  const header = el("div", { style: "display:grid;grid-template-columns:44px repeat(7,1fr);gap:0;font-size:11px;margin-bottom:2px" }, [
    el("div", {}),
    ...days.map((d) => el("div", {
      style: `text-align:center;padding:6px 2px;${sameLocalDay(d, today) ? "background:var(--cardAlt);border-radius:6px 6px 0 0;color:var(--amber);font-weight:500" : "color:var(--sub)"}`,
      text: d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }),
    })),
  ]);

  const axis = el("div", { style: `display:grid;grid-template-rows:repeat(${(endHour - startHour) / 2},88px)` });
  for (let h = startHour; h < endHour; h += 2) {
    axis.appendChild(el("div", { class: "muted", style: "font-size:10px;padding-top:2px", text: h === 12 ? "12pm" : h > 12 ? `${h - 12}pm` : `${h}am` }));
  }

  const grid = el("div", { style: `display:grid;grid-template-columns:44px repeat(7,minmax(90px,1fr));gap:0;border-top:0.5px solid var(--border)` }, [axis]);
  days.forEach((d) => {
    const col = el("div", { style: `position:relative;height:${gridHeight}px;border-left:0.5px solid var(--borderSoft)` });
    sales.filter((s) => sameLocalDay(new Date(s.date), d)).forEach((s) => {
      const jd = new Date(s.date);
      const hourFrac = Math.max(startHour, Math.min(endHour, jd.getHours() + jd.getMinutes() / 60));
      const top = ((hourFrac - startHour) / (endHour - startHour)) * gridHeight;
      const c = jobStatusColors(s);
      const timeLabel = jd.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      col.appendChild(el("div", {
        style: `position:absolute;top:${top}px;left:2px;right:2px;background:${c.bg};border-left:3px solid ${c.border};border-radius:4px;padding:3px 5px;font-size:10px;cursor:default`,
        text: `${serviceAbbrev(s.baseService)} · ${s.car}`,
      }, [el("div", { style: `color:${c.text};font-size:9.5px`, text: timeLabel })]));
    });
    grid.appendChild(col);
  });

  return el("div", { style: "background:var(--panel);border-radius:12px;padding:14px;overflow-x:auto" }, [header, grid]);
}

// Month view — a day-grid (30 tiny time-grids would be unreadable), using the same colored
// chip language as the week view for visual consistency.
function renderMonthGrid(sales, monthStr) {
  const [y, m] = monthStr.split("-").map(Number);
  const firstOfMonth = new Date(y, m - 1, 1);
  const startOffset = firstOfMonth.getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(y, m - 1, d));
  const today = new Date();

  const header = el("div", { style: "display:grid;grid-template-columns:repeat(7,1fr);gap:1px;font-size:11px;margin-bottom:4px" },
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => el("div", { class: "muted", style: "text-align:center;padding:4px", text: d })));

  const grid = el("div", { style: "display:grid;grid-template-columns:repeat(7,1fr);grid-auto-rows:76px;gap:1px;background:var(--borderSoft)" });
  cells.forEach((d) => {
    if (!d) { grid.appendChild(el("div", { style: "background:var(--panel)" })); return; }
    const dayJobs = sales.filter((s) => sameLocalDay(new Date(s.date), d));
    const isToday = sameLocalDay(d, today);
    const cell = el("div", { style: `background:${isToday ? "var(--cardAlt)" : "var(--panel)"};padding:4px;${isToday ? "border:1px solid var(--amber)" : ""}` }, [
      el("div", { style: `font-size:10px;${isToday ? "color:var(--amber);font-weight:500" : "color:var(--sub)"}`, text: d.getDate() }),
    ]);
    dayJobs.slice(0, 2).forEach((s) => {
      const c = jobStatusColors(s);
      const jd = new Date(s.date);
      const timeLabel = jd.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      cell.appendChild(el("div", { style: `background:${c.bg};border-radius:3px;padding:1px 4px;font-size:9.5px;color:${c.text};margin-top:2px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis`, text: `${serviceAbbrev(s.baseService)} ${s.car} ${timeLabel}` }));
    });
    if (dayJobs.length > 2) cell.appendChild(el("div", { class: "muted", style: "font-size:9px;margin-top:1px", text: `+${dayJobs.length - 2} more` }));
    grid.appendChild(cell);
  });

  return el("div", { style: "background:var(--panel);border-radius:12px;padding:14px;overflow-x:auto" }, [header, grid]);
}

// Year view — a density heatmap, the only readable way to show 365 days at once. Same
// amber-intensity language as the mockup: darker means more jobs that day.
function renderYearGrid(sales, yearStr) {
  const year = parseInt(yearStr, 10);
  const countsByDay = {};
  sales.forEach((s) => {
    const d = new Date(s.date);
    if (d.getFullYear() !== year) return;
    const key = `${d.getMonth()}-${d.getDate()}`;
    countsByDay[key] = (countsByDay[key] || 0) + 1;
  });
  const maxCount = Math.max(1, ...Object.values(countsByDay));
  const shades = ["var(--borderSoft)", "#4A3A22", "#854F0B", "#412402"];
  function shadeFor(count) {
    if (!count) return shades[0];
    const ratio = count / maxCount;
    if (ratio > 0.66) return shades[3];
    if (ratio > 0.33) return shades[2];
    return shades[1];
  }
  const months = el("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px" });
  for (let m = 0; m < 12; m++) {
    const daysInMonth = new Date(year, m + 1, 0).getDate();
    const monthLabel = new Date(year, m, 1).toLocaleDateString(undefined, { month: "short" });
    const dayGrid = el("div", { style: "display:grid;grid-template-columns:repeat(7,1fr);gap:2px" });
    for (let d = 1; d <= daysInMonth; d++) {
      const count = countsByDay[`${m}-${d}`] || 0;
      dayGrid.appendChild(el("div", { style: `aspect-ratio:1;background:${shadeFor(count)};border-radius:2px` }));
    }
    months.appendChild(el("div", {}, [el("div", { style: "font-size:11.5px;color:var(--amber);margin-bottom:4px", text: monthLabel }), dayGrid]));
  }
  const legend = el("div", { style: "display:flex;align-items:center;gap:6px;font-size:10px;margin-top:14px", class: "muted" }, [
    el("span", { text: "Fewer jobs" }),
    ...shades.map((s) => el("div", { style: `width:12px;height:12px;background:${s};border-radius:2px` })),
    el("span", { text: "More jobs" }),
  ]);
  return el("div", { style: "background:var(--panel);border-radius:12px;padding:14px" }, [months, legend]);
}

// Serviced Cars — only work that's actually been completed, regardless of payment status.
// Distinct from All Jobs (which shows the full schedule/pipeline) and from the Dashboard's
// stricter "Total Revenue" (which also requires paid).
// Commission Audit — every appointment attributed to any sales rep, any status, with the
// exact moment it closed and why it got the rate it did. This is the shop-wide answer to
// "how can I be sure this is accurate" — no manual checking required.
// Edit History — who changed a price, service, or sales rep, and when. Every entry is
// server-recorded at the moment the change happens; nothing here can be altered after
// the fact from the client side.
// Manager Cash Log — log entries, see only your own history. Never shows shop-wide
// totals; that's the owner's view specifically, on purpose.
// Shared entry-logging form - used by both the manager's Cash Log and the owner's Cash &
// Expenses page, so logging works identically for everyone regardless of role.
function renderCashEntryForm(onSaved) {
  const CATEGORIES = ["Customer Payment", "Supplies", "Tools", "Misc", "Other"];
  let selectedType = "cashOut";
  const amountInput = el("input", { type: "number", placeholder: "0.00", style: "max-width:140px" });
  const categorySelect = el("select", {}, CATEGORIES.map((c) => el("option", { value: c, text: c })));
  const noteInput = el("input", { placeholder: "What was it for?", style: "width:100%" });
  const onlineCheck = el("input", { type: "checkbox" });
  const receiptInput = el("input", { type: "file", accept: "image/*", style: "display:none" });
  const receiptLabel = el("span", { class: "muted", style: "font-size:12px", text: "No receipt attached" });
  let pendingReceiptFile = null;
  receiptInput.addEventListener("change", () => {
    pendingReceiptFile = receiptInput.files[0] || null;
    receiptLabel.textContent = pendingReceiptFile ? pendingReceiptFile.name : "No receipt attached";
  });

  const typeBtns = {};
  function updateFieldVisibility() {
    const isDeposit = selectedType === "bankDeposit";
    categoryField.style.display = isDeposit ? "none" : "";
    onlineField.style.display = isDeposit ? "none" : "";
    noteLabel.textContent = isDeposit ? "Reference / notes (optional)" : "What was it for";
    receiptBtn.textContent = isDeposit ? "Attach bank deposit receipt" : "Attach receipt";
  }
  function typeBtn(value, label) {
    const btn = el("button", {
      class: "tab-btn" + (value === selectedType ? " active" : ""),
      style: "flex:1",
      onclick: () => {
        selectedType = value;
        Object.values(typeBtns).forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        updateFieldVisibility();
      },
      text: label,
    });
    typeBtns[value] = btn;
    return btn;
  }

  const categoryField = el("div", { class: "field" }, [el("label", { text: "Category" }), categorySelect]);
  const onlineField = el("div", { style: "display:flex;align-items:center;gap:8px;margin:8px 0" }, [onlineCheck, el("span", { style: "font-size:13px", text: "Bought online" })]);
  const receiptBtn = el("button", { class: "ghost", onclick: () => receiptInput.click(), text: "Attach receipt" });
  const noteLabel = el("label", { text: "What was it for" });
  updateFieldVisibility();

  return el("div", { class: "card" }, [
    el("div", { style: "font-weight:500;margin-bottom:10px", text: "Log an expense" }),
    el("div", { style: "display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap" }, [
      typeBtn("cashOut", "Cash out"), typeBtn("cardExpense", "Card expense"), typeBtn("cashIn", "Cash in"), typeBtn("bankDeposit", "Bank Deposit"),
    ]),
    el("div", { class: "field" }, [el("label", { text: "Amount" }), amountInput]),
    categoryField,
    el("div", { class: "field" }, [noteLabel, noteInput]),
    onlineField,
    el("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:12px" }, [
      receiptBtn,
      receiptLabel, receiptInput,
    ]),
    el("button", { class: "primary", onclick: async () => {
      if (!amountInput.value || parseFloat(amountInput.value) <= 0) { alert("Enter a real amount first."); return; }
      const entry = await api("/api/manager/cash-entries", { method: "POST", body: JSON.stringify({
        type: selectedType, amount: amountInput.value, category: categorySelect.value, note: noteInput.value, isOnline: onlineCheck.checked,
      }) });
      if (pendingReceiptFile) {
        const formData = new FormData();
        formData.append("receipt", pendingReceiptFile);
        await fetch(`/api/manager/cash-entries/${entry.id}/receipt`, { method: "POST", body: formData, credentials: "same-origin" });
      }
      amountInput.value = ""; noteInput.value = ""; onlineCheck.checked = false; pendingReceiptFile = null; receiptLabel.textContent = "No receipt attached";
      onSaved();
    }, text: "Save entry" }),
  ]);
}

// The exact gap between "Shown up" and "Total revenue" on the dashboard, made visible
// directly instead of making someone notice the two numbers don't match and go hunting.
// Every job here showed up but was never marked paid — a quick mark-paid button resolves
// it right from this list.
async function renderUnpaidArrived(content) {
  const unpaidBody = el("div");
  const unmarkedBody = el("div", { style: "display:none" });
  const summary = el("div", { class: "card" });

  async function loadUnpaid() {
    const jobs = await api("/api/manager/unpaid-arrived");
    clearHeightLocked(unpaidBody);
    const totalAtStake = jobs.reduce((a, j) => a + (j.total || 0), 0);
    summary.innerHTML = "";
    summary.appendChild(el("div", { class: "row" }, [
      el("span", { class: "muted", style: "font-size:13px", text: `${jobs.length} job${jobs.length !== 1 ? "s" : ""} showed up but haven't been marked paid` }),
      el("span", { class: "mono", style: "color:var(--amber);font-weight:600", text: money(totalAtStake) }),
    ]));
    if (jobs.length === 0) { unpaidBody.appendChild(el("div", { class: "muted", text: "Nothing outstanding — every arrived job is marked paid." })); return; }
    jobs.forEach((j) => {
      unpaidBody.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row", style: "margin-bottom:8px" }, [
          el("div", {}, [
            el("div", { style: "font-weight:500", text: j.car }),
            el("div", { class: "muted", style: "font-size:12.5px", text: `${formatDateTime(j.date)}${j.customerName ? " · " + j.customerName : ""}${j.customerPhone ? " · " + j.customerPhone : ""}` }),
            el("div", { class: "muted", style: "font-size:12.5px", text: `${j.baseService || "no service set"} · ${j.employeeNames}` }),
          ]),
          el("div", { class: "mono", style: "color:var(--amber);font-size:16px;font-weight:600", text: money(j.total) }),
        ]),
        el("div", { style: "display:flex;gap:8px;justify-content:flex-end" }, [
          el("button", { class: "primary", onclick: async () => { await api(`/api/manager/jobs/${j.id}`, { method: "PATCH", body: JSON.stringify({ paidCash: true }) }); loadUnpaid(); }, text: "Mark paid — Cash" }),
          el("button", { class: "primary", onclick: async () => { await api(`/api/manager/jobs/${j.id}`, { method: "PATCH", body: JSON.stringify({ paidCard: true }) }); loadUnpaid(); }, text: "Mark paid — Card" }),
        ]),
      ]));
    });
  }

  // A genuinely different problem - appointments from today or any day before that were
  // never marked with ANY outcome at all, almost always meaning someone forgot to record
  // what happened. Deliberately excludes future bookings, which correctly haven't
  // happened yet and shouldn't be flagged.
  async function loadUnmarked() {
    const jobs = await api("/api/manager/unmarked-appointments");
    clearHeightLocked(unmarkedBody);
    if (jobs.length === 0) { unmarkedBody.appendChild(el("div", { class: "muted", text: "Nothing unmarked — every past appointment has a real outcome recorded." })); return; }
    unmarkedBody.appendChild(el("div", { class: "muted", style: "margin-bottom:10px", text: `${jobs.length} appointment${jobs.length !== 1 ? "s" : ""} from today or earlier with no recorded outcome — not arrived, no-show, cancelled, or completed.` }));
    jobs.forEach((j) => {
      unmarkedBody.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row", style: "margin-bottom:8px" }, [
          el("div", {}, [
            el("div", { style: "font-weight:500", text: j.car }),
            el("div", { class: "muted", style: "font-size:12.5px", text: `${formatDateTime(j.date)}${j.customerName ? " · " + j.customerName : ""}${j.customerPhone ? " · " + j.customerPhone : ""}` }),
            el("div", { class: "muted", style: "font-size:12.5px", text: `${j.baseService || "no service set"} · ${j.employeeNames}` }),
          ]),
          el("div", { class: "mono", style: "color:var(--amber);font-size:16px;font-weight:600", text: money(j.basePrice) }),
        ]),
        el("div", { style: "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap" }, [
          el("button", { class: "primary", onclick: async () => { await api(`/api/manager/jobs/${j.id}`, { method: "PATCH", body: JSON.stringify({ status: "arrived" }) }); loadUnmarked(); }, text: "Mark Arrived" }),
          el("button", { class: "ghost", onclick: async () => { await api(`/api/manager/jobs/${j.id}`, { method: "PATCH", body: JSON.stringify({ status: "no_show" }) }); loadUnmarked(); }, text: "Mark No-show" }),
          el("button", { class: "ghost", onclick: async () => { await api(`/api/manager/jobs/${j.id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) }); loadUnmarked(); }, text: "Mark Cancelled" }),
        ]),
      ]));
    });
  }

  const tabBar = el("div", { style: "display:flex;gap:6px;margin-bottom:14px" });
  const unpaidTab = el("button", { class: "tab-btn active", onclick: () => {
    unpaidTab.classList.add("active"); unmarkedTab.classList.remove("active");
    unpaidBody.style.display = ""; unmarkedBody.style.display = "none";
    summary.style.display = "";
  }, text: "Unpaid Arrivals" });
  const unmarkedTab = el("button", { class: "tab-btn", onclick: () => {
    unmarkedTab.classList.add("active"); unpaidTab.classList.remove("active");
    unmarkedBody.style.display = ""; unpaidBody.style.display = "none";
    summary.style.display = "none";
  }, text: "Needs Status (Today & Before)" });
  tabBar.appendChild(unpaidTab); tabBar.appendChild(unmarkedTab);

  content.appendChild(el("div", { class: "muted", style: "margin-bottom:10px", text: "Every job that showed up but hasn't been marked paid yet — this is exactly why \"Shown up\" and \"Total revenue\" won't always match on the dashboard." }));
  content.appendChild(tabBar);
  content.appendChild(summary);
  content.appendChild(unpaidBody);
  content.appendChild(unmarkedBody);
  await loadUnpaid();
  await loadUnmarked();
}

async function renderCashLog(content) {
  const listEl = el("div", { style: "margin-top:16px" });

  async function loadMine() {
    const mine = await api("/api/my/cash-entries");
    clearHeightLocked(listEl);
    listEl.appendChild(el("div", { class: "muted", style: "margin-bottom:8px", text: "YOUR RECENT ENTRIES" }));
    if (mine.length === 0) { listEl.appendChild(el("div", { class: "muted", text: "Nothing logged yet." })); return; }
    mine.forEach((e) => {
      const typeLabel = e.type === "cashIn" ? "Cash in" : e.type === "cashOut" ? "Cash out" : e.type === "bankDeposit" ? "Bank Deposit" : "Card expense";
      const typeColor = e.type === "cashIn" ? "var(--green)" : "var(--red)";
      listEl.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row" }, [
          el("div", {}, [
            el("div", { style: "font-weight:500", text: `${e.category}${e.isOnline ? " · Online" : ""}` }),
            el("div", { class: "muted", style: "font-size:12.5px", text: (e.note || "(no description)") + (e.autoFromJob ? " · from Job Status" : "") }),
            el("div", { class: "muted", style: "font-size:11px", text: formatDateTime(e.timestamp) }),
          ]),
          el("div", { style: "text-align:right" }, [
            el("div", { style: `color:${typeColor};font-size:12px;font-weight:600`, text: typeLabel }),
            el("div", { class: "mono", style: "font-weight:600", text: money(e.amount) }),
          ]),
        ]),
        el("div", { style: "display:flex;gap:8px;margin-top:6px;justify-content:flex-end" }, [
          e.receiptPhoto ? el("button", { class: "ghost", style: "font-size:10px;padding:3px 7px", onclick: () => showImageModal(`/api/photos/${e.receiptPhoto}`, "Receipt"), text: "View receipt" }) : null,
          el("button", { class: "icon-danger", style: "font-size:10px;padding:3px 7px", onclick: async () => { await api(`/api/manager/cash-entries/${e.id}`, { method: "DELETE" }); loadMine(); }, text: "Delete" }),
        ]),
      ]));
    });
  }

  content.appendChild(renderCashEntryForm(loadMine));
  content.appendChild(listEl);
  await loadMine();
}

// Owner Cash & Expenses — full visibility across every manager, real totals, editable.
async function renderOwnerCash(content) {
  const body = el("div");
  const picker = renderPeriodPicker((params) => load(params), "month");
  async function load(params) {
    const p = params || picker.getParams();
    const qs = new URLSearchParams(p).toString();
    const d = await api(`/api/owner/cash-entries?${qs}`);
    clearHeightLocked(body);
    body.appendChild(el("div", { class: "metric-grid" }, [
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Cash in (from customers)" }), el("div", { class: "metric-value mono", style: "color:var(--green)", text: money(d.totalCashIn) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Cash out" }), el("div", { class: "metric-value mono", style: "color:var(--red)", text: money(d.totalCashOut) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Card expenses" }), el("div", { class: "metric-value mono", style: "color:var(--red)", text: money(d.totalCardExpense) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Bank deposits" }), el("div", { class: "metric-value mono", style: "color:var(--amber)", text: money(d.totalBankDeposits) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Net cash on hand" }), el("div", { class: "metric-value mono", style: `color:${d.netCash >= 0 ? "var(--green)" : "var(--red)"}`, text: money(d.netCash) })]),
    ]));
    if (d.byCategory.length) {
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "margin-bottom:8px", text: "BY CATEGORY" }),
        ...d.byCategory.map((c) => el("div", { class: "row", style: "font-size:13px;margin-bottom:4px" }, [
          el("span", { text: c.category }), el("span", { class: "mono", text: money(c.total) }),
        ])),
      ]));
    }
    body.appendChild(el("div", { class: "muted", style: "margin:14px 0 8px", text: "ALL ENTRIES" }));
    if (d.entries.length === 0) body.appendChild(el("div", { class: "muted", text: "Nothing logged in this period." }));
    d.entries.forEach((e) => {
      const typeLabel = e.type === "cashIn" ? "Cash in" : e.type === "cashOut" ? "Cash out" : e.type === "bankDeposit" ? "Bank Deposit" : "Card expense";
      const typeColor = e.type === "cashIn" ? "var(--green)" : "var(--red)";
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row" }, [
          el("div", {}, [
            el("div", { style: "font-weight:500", text: `${e.category}${e.isOnline ? " · Online" : ""}` }),
            el("div", { class: "muted", style: "font-size:12.5px", text: (e.note || "(no description)") + (e.autoFromJob ? " · from Job Status" : "") }),
            el("div", { class: "muted", style: "font-size:11px", text: `${e.enteredByName} · ${formatDateTime(e.timestamp)}` }),
          ]),
          el("div", { style: "text-align:right" }, [
            el("div", { style: `color:${typeColor};font-size:12px;font-weight:600`, text: typeLabel }),
            el("div", { class: "mono", style: "font-weight:600", text: money(e.amount) }),
          ]),
        ]),
        el("div", { style: "display:flex;gap:8px;margin-top:6px;justify-content:flex-end" }, [
          e.receiptPhoto ? el("button", { class: "ghost", style: "font-size:10px;padding:3px 7px", onclick: () => showImageModal(`/api/photos/${e.receiptPhoto}`, "Receipt"), text: "View receipt" }) : null,
          el("button", { class: "icon-danger", style: "font-size:10px;padding:3px 7px", onclick: async () => { await api(`/api/manager/cash-entries/${e.id}`, { method: "DELETE" }); load(); }, text: "Delete" }),
        ]),
      ]));
    });
  }
  content.appendChild(renderCashEntryForm(load));
  content.appendChild(picker.el);
  content.appendChild(body);
  await load();
}

async function renderEditHistory(content) {
  const body = el("div");
  async function load() {
    const entries = await api("/api/owner/audit-log");
    clearHeightLocked(body);
    if (entries.length === 0) { body.appendChild(el("div", { class: "muted", text: "No edits recorded yet." })); return; }
    entries.forEach((e) => {
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row" }, [
          el("div", {}, [
            el("div", { style: "font-weight:500", text: e.car || "(unknown car)" }),
            el("div", { class: "muted", style: "font-size:12px", text: `${e.field} changed by ${e.actor}` }),
            el("div", { class: "muted", style: "font-size:11px", text: formatDateTime(e.timestamp) }),
          ]),
          el("div", { style: "text-align:right;font-size:13px" }, [
            el("div", { class: "muted", style: "text-decoration:line-through", text: e.oldValue === null || e.oldValue === "" ? "(empty)" : String(e.oldValue) }),
            el("div", { style: "color:var(--green);font-weight:600", text: String(e.newValue) }),
          ]),
        ]),
      ]));
    });
  }
  content.appendChild(el("div", { class: "muted", style: "margin-bottom:12px", text: "Every price, service, and sales rep change made through the app, most recent first." }));
  content.appendChild(body);
  await load();
}

async function renderCommissionAudit(content) {
  const body = el("div");
  const picker = renderPeriodPicker((params) => load(params), "payperiod", SALES_PAY_PERIOD_ANCHOR);

  // Repair tool for historical data imported before the closedAt fix existed.
  const repairStageId = el("input", { placeholder: "Booked stage ID (from Test 2 in Test Tool)", style: "max-width:280px" });
  const repairLog = el("div", { style: "margin-top:8px;max-height:180px;overflow-y:auto" });
  const repairStatus = el("div", { class: "muted", style: "font-size:11.5px;margin-top:6px" });
  async function loadRepairStatus() {
    const s = await api("/api/owner/ghl-repair-closedat-status");
    repairStatus.textContent = s.cursorSet ? `In progress — ${s.totalFixedSoFar} fixed so far.` : s.totalFixedSoFar > 0 ? `Done — ${s.totalFixedSoFar} total fixed.` : "Not started.";
  }
  let repairRunning = false;
  async function runRepair(stopBtn, startBtn) {
    repairRunning = true; stopBtn.style.display = "inline-block"; startBtn.disabled = true;
    while (repairRunning) {
      let r;
      try {
        r = await api("/api/owner/ghl-repair-closedat", { method: "POST", body: JSON.stringify({ stageId: repairStageId.value.trim(), dryRun: false, batchSize: 15 }) });
      } catch (e) { repairLog.appendChild(el("div", { style: "color:var(--red);font-size:12px", text: `Error: ${e.message} — stopped.` })); break; }
      repairLog.appendChild(el("div", { style: "font-size:12px", text: `Batch done — fixed ${r.fixed}, already correct ${r.alreadyCorrect}, no match ${r.noMatchingJob}, total fixed: ${r.totalFixedSoFar}` }));
      await loadRepairStatus();
      if (!r.hasMore) { repairLog.appendChild(el("div", { style: "color:var(--green);font-size:12px;font-weight:600", text: "✓ All done." })); break; }
      await new Promise((res) => setTimeout(res, 500));
    }
    repairRunning = false; stopBtn.style.display = "none"; startBtn.disabled = false;
  }
  content.appendChild(el("div", { class: "card" }, [
    el("div", { class: "muted", style: "margin-bottom:8px", text: "REPAIR HISTORICAL TIMES — fixes closedAt on jobs already imported before this bug was caught. Only touches the timestamp; price, status, and attribution stay exactly as-is. Safe to re-run." }),
    repairStageId,
    (() => {
      const startBtn = el("button", { class: "primary", style: "margin-top:8px;background:var(--green)" });
      const stopBtn = el("button", { class: "icon-danger", style: "margin-top:8px;margin-left:8px;display:none" });
      startBtn.textContent = "Repair all"; startBtn.onclick = () => runRepair(stopBtn, startBtn);
      stopBtn.textContent = "Stop"; stopBtn.onclick = () => { repairRunning = false; };
      const resetBtn = el("button", { class: "icon-danger", style: "margin-top:8px;margin-left:8px", onclick: async () => {
        if (!confirm("Reset repair progress? You'll start over from the beginning next time.")) return;
        await api("/api/owner/ghl-repair-closedat-reset", { method: "POST" });
        await loadRepairStatus();
      }, text: "Reset progress" });
      return el("div", {}, [startBtn, stopBtn, resetBtn]);
    })(),
    repairStatus, repairLog,
  ]));
  loadRepairStatus();

  async function load(params) {
    const p = params || picker.getParams();
    const qs = new URLSearchParams(p).toString();
    const rows = await api(`/api/owner/commission-audit?${qs}`);
    clearHeightLocked(body);

    // Closing activity — how much got closed in this period, regardless of what day the
    // appointment itself is scheduled for. A deal closed today for an appointment two
    // weeks out shows up here, even though it won't show up in the list below at all
    // (that list tracks appointments happening in this period, a different question).
    const activity = await api(`/api/owner/closing-activity?${qs}`);
    body.appendChild(el("div", { class: "card" }, [
      el("div", { class: "muted", style: "margin-bottom:8px", text: "CLOSING ACTIVITY — deals actually closed in this period, regardless of when the appointment is scheduled for" }),
      el("div", { class: "metric-grid" }, [
        el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Total closes" }), el("div", { class: "metric-value mono", text: activity.totalCloses })]),
        el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Total value closed" }), el("div", { class: "metric-value mono", style: "color:var(--amber)", text: money(activity.totalValue) })]),
        el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Projected commission" }), el("div", { class: "metric-value mono", style: "color:var(--green)", text: money(activity.totalProjectedCommission) })]),
      ]),
      activity.perRep.length > 0
        ? el("div", { style: "margin-top:8px" }, activity.perRep.map((r) => {
            const closesWrap = el("div", { style: "display:none;margin-top:6px;padding-left:8px;border-left:2px solid var(--border)" }, r.closes.map((c) => el("div", { class: "row", style: "font-size:11.5px;margin-bottom:4px" }, [
              el("div", {}, [
                el("div", { text: c.car || "(no car)" }),
                el("div", { class: "muted", style: "font-size:10.5px", text: `Scheduled: ${formatDateTime(c.date)}` }),
                el("div", { class: "muted", style: "font-size:10.5px", text: `Closed: ${formatDateTime(c.closedAt)}${c.customerName ? " · " + c.customerName : ""}` }),
              ]),
              el("div", { style: "text-align:right" }, [
                c.missingPrice
                  ? el("div", { class: "mono", style: "color:var(--red);font-weight:600", text: "$0 — fix in Cleanup" })
                  : el("div", { class: "mono", style: "color:var(--amber)", text: money(c.basePrice) }),
                el("div", { class: "muted", style: "font-size:10px", text: c.status === "arrived" ? "Arrived" : c.status === "no_show" ? "No-show" : "Pending" }),
              ]),
            ])));
            const toggleBtn = el("button", {
              class: "ghost", style: "width:100%;text-align:left;font-size:12.5px;margin-bottom:2px", onclick: () => {
                const showing = closesWrap.style.display !== "none";
                closesWrap.style.display = showing ? "none" : "block";
                toggleBtn.textContent = "";
                toggleBtn.appendChild(el("span", { text: showing ? "▸ " : "▾ " }));
                toggleBtn.appendChild(el("span", { text: `${r.name} — ${r.closeCount} close${r.closeCount !== 1 ? "s" : ""} (${r.arrivedCount} arrived, ${r.pendingCount} pending, ${r.noShowCount} no-show)` }));
              },
            }, [el("span", { text: "▸ " }), el("span", { text: `${r.name} — ${r.closeCount} close${r.closeCount !== 1 ? "s" : ""} (${r.arrivedCount} arrived, ${r.pendingCount} pending, ${r.noShowCount} no-show)` })]);
            return el("div", { style: "margin-bottom:6px" }, [
              el("div", { class: "row" }, [
                toggleBtn,
                el("div", { style: "text-align:right;white-space:nowrap" }, [
                  el("div", { class: "mono", style: "color:var(--amber);font-size:11.5px", text: `Value: ${money(r.totalValue)}` }),
                  el("div", { class: "mono", style: "color:var(--green);font-size:11.5px", text: `Comm: ${money(r.projectedCommission)}` }),
                ]),
              ]),
              closesWrap,
            ]);
          }))
        : null,
      el("div", { class: "muted", style: "font-size:10.5px;margin-top:6px", text: "\"Projected\" assumes the deal holds — actual commission still only pays out once the customer shows, tracked below and on Payroll." }),
    ]));

    if (rows.length === 0) { body.appendChild(el("div", { class: "muted", text: "No sales rep-attributed appointments in this period." })); return; }
    const totalCommission = rows.reduce((a, r) => a + r.commissionAmount, 0);
    body.appendChild(el("div", { class: "muted", style: "margin:16px 0 8px;font-size:11.5px;letter-spacing:0.04em", text: "APPOINTMENTS SCHEDULED — PROJECTED COMMISSION IF EVERYONE SHOWS" }));
    body.appendChild(el("div", { class: "metric-grid" }, [
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Appointments" }), el("div", { class: "metric-value mono", text: rows.length })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Total projected commission" }), el("div", { class: "metric-value mono", style: "color:var(--green)", text: money(totalCommission) })]),
    ]));
    body.appendChild(el("div", { class: "muted", style: "font-size:10.5px;margin-bottom:8px", text: "Assumes every appointment below shows up as scheduled — a no-show or reschedule will change this from what actually gets paid. Payroll always reflects the real, current total based on who has actually arrived." }));
    // Grouped by sales rep, each with its own subtotal, sorted chronologically within the group.
    const grouped = {};
    rows.forEach((r) => { (grouped[r.salesRepName] = grouped[r.salesRepName] || []).push(r); });
    Object.entries(grouped).sort((a, b) => a[0].localeCompare(b[0])).forEach(([repName, repRows]) => {
      const repCommission = repRows.reduce((a, r) => a + r.commissionAmount, 0);
      const listWrap = el("div", { style: "display:none;margin-top:6px" });
      const toggleBtn = el("button", {
        class: "ghost", style: "width:100%;text-align:left;font-size:12px;font-weight:600;letter-spacing:0.03em;margin:16px 0 2px", onclick: () => {
          const showing = listWrap.style.display !== "none";
          listWrap.style.display = showing ? "none" : "block";
          toggleBtn.textContent = `${showing ? "▸" : "▾"} ${repName.toUpperCase()} — ${repRows.length} appointment${repRows.length !== 1 ? "s" : ""}, ${money(repCommission)} projected`;
        },
      }, [el("span", { text: `▸ ${repName.toUpperCase()} — ${repRows.length} appointment${repRows.length !== 1 ? "s" : ""}, ${money(repCommission)} projected` })]);
      body.appendChild(toggleBtn);
      repRows.sort((a, b) => (a.closedAtRaw < b.closedAtRaw ? 1 : -1)).forEach((r) => {
        const statusLabel = r.status === "arrived" ? "Arrived" : r.status === "no_show" ? "No-show" : "Upcoming";
        const statusColor = r.status === "arrived" ? "var(--green)" : r.status === "no_show" ? "var(--red)" : "var(--sub)";
        const d2 = new Date(r.closedAtRaw);
        const pad = (n) => String(n).padStart(2, "0");
        const localValue = isNaN(d2.getTime()) ? "" : `${d2.getFullYear()}-${pad(d2.getMonth() + 1)}-${pad(d2.getDate())}T${pad(d2.getHours())}:${pad(d2.getMinutes())}`;
        const closedAtInput = el("input", { type: "datetime-local", value: localValue, style: "max-width:190px;font-size:11px" });
        const saveClosedAtBtn = el("button", { class: "ghost", style: "font-size:10px;padding:3px 7px", onclick: async () => {
          if (!closedAtInput.value) return;
          await api(`/api/manager/jobs/${r.saleId}`, { method: "PATCH", body: JSON.stringify({ closedAt: closedAtInput.value }) });
          load();
        }, text: "Save" });
        listWrap.appendChild(el("div", { class: "card" }, [
          el("div", { class: "row" }, [
            el("div", {}, [
              el("div", { style: "font-weight:500", text: r.car }),
              el("div", { class: "muted", style: "font-size:12.5px", text: r.customerName || "" }),
              el("div", { class: "muted", style: "font-size:11.5px", text: `Closed: ${r.closedAtEastern} — ${r.duringHours ? "in-hours" : "after-hours"} (${r.rateApplied}%)` }),
              el("div", { style: "display:flex;gap:6px;align-items:center;margin-top:4px" }, [closedAtInput, saveClosedAtBtn]),
            ]),
            el("div", { style: "text-align:right" }, [
              el("div", { style: `color:${statusColor};font-size:12px;font-weight:600`, text: statusLabel }),
              el("div", { class: "mono", style: "color:var(--amber);font-size:14px", text: money(r.basePrice) }),
              el("div", { class: "mono", style: "color:var(--green);font-size:12px", text: `+${money(r.commissionAmount)} projected` }),
            ]),
          ]),
        ]));
      });
      body.appendChild(listWrap);
    });
  }
  content.appendChild(picker.el);
  content.appendChild(body);
  await load();
}

async function renderServicedCars(content) {
  const body = el("div");
  const picker = renderPeriodPicker((params) => load(params), "day");

  async function load(params) {
    const p = params || picker.getParams();
    const qs = new URLSearchParams(p).toString();
    const sales = await api(`/api/owner/serviced-cars?${qs}`);
    clearHeightLocked(body);
    if (sales.length === 0) { body.appendChild(el("div", { class: "muted", text: "No cars completed in this period." })); return; }
    const totalValue = sales.reduce((a, s) => a + s.total, 0);
    body.appendChild(el("div", { class: "metric-grid" }, [
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Cars serviced" }), el("div", { class: "metric-value mono", text: sales.length })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Combined value" }), el("div", { class: "metric-value mono", style: "color:var(--amber)", text: money(totalValue) })]),
    ]));

    // Grouped by sales rep - walk-ins and online bookings get their own group too, so
    // nothing gets silently dropped from the breakdown.
    const grouped = {};
    sales.forEach((s) => {
      const key = s.salesRepName || (s.isWalkIn ? "Walk-in (no rep)" : s.isOnlineBooking ? "Online Booking" : "Unassigned");
      (grouped[key] = grouped[key] || []).push(s);
    });
    Object.entries(grouped).sort((a, b) => b[1].length - a[1].length).forEach(([repName, repSales]) => {
      const repValue = repSales.reduce((a, s) => a + s.total, 0);
      body.appendChild(el("div", { class: "muted", style: "margin:16px 0 6px;font-size:12px;font-weight:600;letter-spacing:0.03em", text: `${repName.toUpperCase()} — ${repSales.length} car${repSales.length !== 1 ? "s" : ""}, ${money(repValue)}` }));
      repSales.sort((a, b) => (a.date < b.date ? 1 : -1)).forEach((s) => {
        body.appendChild(el("div", { class: "card" }, [
          el("div", { class: "row" }, [
            el("div", {}, [
              el("div", { style: "font-weight:500", text: `${s.car}${s.syncedFromGHL ? " 🔗" : ""}` }),
              el("div", { class: "muted", text: `${formatDateTime(s.date)}${s.customerName ? " · " + s.customerName : ""}` }),
              el("div", { class: "muted", style: "font-size:12.5px", text: `${s.employeeNames || "Unassigned"} · ${s.baseService || "no service set"}` }),
            ]),
            el("div", { style: "text-align:right" }, [
              el("div", { class: "mono", style: "color:var(--amber);font-size:16px;font-weight:600", text: money(s.total) }),
              s.paid ? el("div", { class: "muted", style: "font-size:11px", text: `Paid — ${s.paymentMethod === "cash" ? "Cash" : "Card"}` }) : el("div", { class: "muted", style: "font-size:11px;color:var(--red)", text: "Unpaid" }),
            ]),
          ]),
        ]));
      });
    });
  }
  content.appendChild(picker.el);
  content.appendChild(body);
  await load();
}

// A genuinely separate question from Serviced Cars - a car can arrive without the work
// being finished yet. Same layout, different underlying meaning.
async function renderCarsArrived(content) {
  const body = el("div");
  const picker = renderPeriodPicker((params) => load(params), "day");
  async function load(params) {
    const p = params || picker.getParams();
    const qs = new URLSearchParams(p).toString();
    const sales = await api(`/api/owner/cars-arrived?${qs}`);
    clearHeightLocked(body);
    if (sales.length === 0) { body.appendChild(el("div", { class: "muted", text: "No cars arrived in this period." })); return; }
    const totalValue = sales.reduce((a, s) => a + s.total, 0);
    body.appendChild(el("div", { class: "metric-grid" }, [
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Cars arrived" }), el("div", { class: "metric-value mono", text: sales.length })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Combined value" }), el("div", { class: "metric-value mono", style: "color:var(--amber)", text: money(totalValue) })]),
    ]));
    const grouped = {};
    sales.forEach((s) => {
      const key = s.salesRepName || (s.isWalkIn ? "Walk-in (no rep)" : s.isOnlineBooking ? "Online Booking" : "Unassigned");
      (grouped[key] = grouped[key] || []).push(s);
    });
    Object.entries(grouped).sort((a, b) => b[1].length - a[1].length).forEach(([repName, repSales]) => {
      const repValue = repSales.reduce((a, s) => a + s.total, 0);
      body.appendChild(el("div", { class: "muted", style: "margin:16px 0 6px;font-size:12px;font-weight:600;letter-spacing:0.03em", text: `${repName.toUpperCase()} — ${repSales.length} car${repSales.length !== 1 ? "s" : ""}, ${money(repValue)}` }));
      repSales.sort((a, b) => (a.date < b.date ? 1 : -1)).forEach((s) => {
        body.appendChild(el("div", { class: "card" }, [
          el("div", { class: "row" }, [
            el("div", {}, [
              el("div", { style: "font-weight:500", text: `${s.car}${s.syncedFromGHL ? " 🔗" : ""}` }),
              el("div", { class: "muted", text: `${formatDateTime(s.date)}${s.customerName ? " · " + s.customerName : ""}` }),
              el("div", { class: "muted", style: "font-size:12.5px", text: `${s.employeeNames || "Unassigned"} · ${s.baseService || "no service set"}${s.completed ? " · Service complete" : " · Still in progress"}` }),
            ]),
            el("div", { style: "text-align:right" }, [
              el("div", { class: "mono", style: "color:var(--amber);font-size:16px;font-weight:600", text: money(s.total) }),
              s.paid ? el("div", { class: "muted", style: "font-size:11px", text: `Paid — ${s.paymentMethod === "cash" ? "Cash" : "Card"}` }) : el("div", { class: "muted", style: "font-size:11px;color:var(--red)", text: "Unpaid" }),
            ]),
          ]),
        ]));
      });
    });
  }
  content.appendChild(picker.el);
  content.appendChild(body);
  await load();
}

async function renderOwnerSales(content) {
  const body = el("div");
  const dayColsSetup = makeServiceColumns(); // built once - keeps whatever tab you had selected across every reload
  const picker = renderPeriodPicker((params) => load(params), "day");
  const employees = await api("/api/employees");
  const managersList = await api("/api/managers");
  const salesRepsList = await api("/api/salesreps");
  async function load(params) {
    const p = params || picker.getParams();
    const qs = new URLSearchParams(p).toString();
    const sales = await api(`/api/owner/sales?${qs}`);

    if (p.period !== "day") {
      dayColsSetup.wrap.style.display = "none";
      body.style.display = "";
      clearHeightLocked(body);
      if (sales.length === 0) { body.appendChild(el("div", { class: "muted", text: "No jobs in this period." })); return; }
      if (p.period === "week") { body.appendChild(renderWeekGrid(sales)); return; }
      if (p.period === "month") { body.appendChild(renderMonthGrid(sales, p.month)); return; }
      if (p.period === "year") { body.appendChild(renderYearGrid(sales, p.date.slice(0, 4))); return; }
      // pay period and anything else falls through to the flat agenda list below, using body as the mount target
    } else {
      // Day view specifically gets split into service columns; clearing just the cards
      // (not rebuilding the tab bar) is what actually keeps your selected filter in place.
      clearHeightLocked(body);
      body.style.display = sales.length === 0 ? "" : "none";
      dayColsSetup.clearAll();
      dayColsSetup.wrap.style.display = sales.length === 0 ? "none" : "";
      if (sales.length === 0) { body.appendChild(el("div", { class: "muted", text: "No jobs in this period." })); return; }
    }
    const dayCols = p.period === "day" ? dayColsSetup.cols : null;
    const mountTarget = body;

    sales.sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((s) => {
      const cancelled = s.status === "cancelled";
      const statusLabel = cancelled ? "Cancelled" : s.status === "arrived" ? "Arrived" : s.status === "no_show" ? "No-show" : s.status === "unconfirmed" ? "Unconfirmed" : "Upcoming";
      const statusColor = cancelled ? "var(--red)" : s.status === "arrived" ? "var(--green)" : s.status === "no_show" ? "var(--red)" : s.status === "unconfirmed" ? "var(--amber)" : "var(--sub)";
      const d = new Date(s.date);
      const timeOnly = isNaN(d.getTime()) ? "—" : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      const dateOnly = isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });

      const priceInput = el("input", { type: "number", value: s.basePrice, style: "max-width:80px;text-align:right;font-family:monospace;font-size:12px" });
      const priceRow = el("div", { style: "display:flex;align-items:center;gap:5px;justify-content:flex-end" }, [
        el("span", { class: "muted", style: "font-size:11px", text: "Base:" }), priceInput,
        el("button", { class: "ghost", style: "font-size:10px;padding:2px 6px", onclick: async () => { await api(`/api/manager/jobs/${s.id}`, { method: "PATCH", body: JSON.stringify({ basePrice: priceInput.value }) }); load(); }, text: "Save" }),
      ]);

      const upsellRows = (s.upsells || []).map((u) => {
        const nameInput = el("input", { value: u.name, style: "max-width:130px;font-size:11.5px" });
        const priceI = el("input", { type: "number", value: u.price, style: "max-width:70px;font-size:11.5px" });
        const creditSelect = el("select", {
          style: "max-width:150px;font-size:11px;background:var(--panel);border:0.5px solid var(--border);border-radius:6px;color:var(--sub);padding:2px 4px",
          onchange: async (e) => {
            const [creditType, creditId] = e.target.value ? e.target.value.split("::") : ["none", ""];
            await api(`/api/sales/${s.id}/upsells/${u.id}`, { method: "PATCH", body: JSON.stringify({ creditType, creditId }) });
            load();
          },
        }, [
          el("option", { value: "", text: "Unassigned" }),
          ...employees.map((e) => el("option", { value: `employee::${e.id}`, text: `Tech: ${e.name}`, ...(u.employeeId === e.id ? { selected: "true" } : {}) })),
          ...managersList.map((m) => el("option", { value: `manager::${m.id}`, text: `Manager: ${m.name}`, ...(u.managerId === m.id ? { selected: "true" } : {}) })),
          ...salesRepsList.map((r) => el("option", { value: `salesrep::${r.id}`, text: `Rep: ${r.name}`, ...(u.salesRepId === r.id ? { selected: "true" } : {}) })),
        ]);
        return el("div", { style: "display:flex;align-items:center;gap:5px;margin-top:4px;flex-wrap:wrap" }, [
          nameInput, priceI, creditSelect,
          el("button", { class: "ghost", style: "font-size:10px;padding:2px 6px", onclick: async () => {
            await api(`/api/sales/${s.id}/upsells/${u.id}`, { method: "PATCH", body: JSON.stringify({ name: nameInput.value, price: priceI.value }) });
            load();
          }, text: "Save" }),
          el("button", { class: "icon-danger", style: "padding:2px", onclick: async () => { await api(`/api/sales/${s.id}/upsells/${u.id}`, { method: "DELETE" }); load(); }, text: "✕" }),
        ]);
      });

      const photoToggleWrap = el("div", { style: "display:none" });
      const photoToggleBtn = el("button", { class: "ghost", style: "font-size:10px;padding:3px 7px", onclick: () => {
        const showing = photoToggleWrap.style.display !== "none";
        photoToggleWrap.style.display = showing ? "none" : "block";
        photoToggleBtn.textContent = showing ? "📷 Photos" : "📷 Hide";
      }, text: "📷 Photos" });

      const notesToggleWrap = el("div", { style: "display:none" });
      const notesToggleBtn = el("button", { class: "ghost", style: "font-size:10px;padding:3px 7px", onclick: () => {
        const showing = notesToggleWrap.style.display !== "none";
        notesToggleWrap.style.display = showing ? "none" : "block";
        notesToggleBtn.textContent = showing ? "📝 Notes" : "📝 Hide";
      }, text: `📝 Notes${(s.notes || []).length ? ` (${s.notes.length})` : ""}` });

      const editToggleWrap = el("div", { style: "display:none;margin-top:8px" });
      const editToggleBtn = el("button", { class: "ghost", style: "font-size:10px;padding:3px 7px", onclick: () => {
        const showing = editToggleWrap.style.display !== "none";
        editToggleWrap.style.display = showing ? "none" : "block";
        editToggleBtn.textContent = showing ? "✎ Edit" : "✎ Hide";
      }, text: "✎ Edit" });
      (() => {
        const d2 = new Date(s.date);
        const pad = (n) => String(n).padStart(2, "0");
        const localValue = isNaN(d2.getTime()) ? "" : `${d2.getFullYear()}-${pad(d2.getMonth() + 1)}-${pad(d2.getDate())}T${pad(d2.getHours())}:${pad(d2.getMinutes())}`;
        const dtInput = el("input", { type: "datetime-local", value: localValue, style: "max-width:200px" });
        const repSelect = el("select", { style: "max-width:200px" }, [
          el("option", { value: "", text: "Assign a sales rep..." }),
          ...salesRepsList.map((r) => el("option", { value: r.id, text: r.name, ...(s.salesRepId === r.id ? { selected: "true" } : {}) })),
          el("option", { value: "__online__", text: "Online Booking (website, no rep)", ...(s.isOnlineBooking ? { selected: "true" } : {}) }),
        ]);
        const carInput = el("input", { value: s.car || "", style: "max-width:220px" });
        editToggleWrap.appendChild(el("div", { style: "border-top:0.5px solid var(--border);padding-top:8px" }, [
          el("div", { class: "muted", style: "font-size:11px;margin-bottom:4px", text: "Car / Title — GHL doesn't tell us if this gets edited after booking" }),
          el("div", { style: "display:flex;gap:6px;align-items:center;margin-bottom:10px" }, [
            carInput,
            el("button", { class: "ghost", onclick: async () => { if (!carInput.value.trim()) return; await api(`/api/manager/jobs/${s.id}`, { method: "PATCH", body: JSON.stringify({ car: carInput.value }) }); load(); }, text: "Save" }),
          ]),
          el("div", { class: "muted", style: "font-size:11px;margin-bottom:4px", text: "Date / time" }),
          el("div", { style: "display:flex;gap:6px;align-items:center;margin-bottom:10px" }, [
            dtInput,
            el("button", { class: "ghost", onclick: async () => { if (!dtInput.value) return; await api(`/api/manager/jobs/${s.id}`, { method: "PATCH", body: JSON.stringify({ date: dtInput.value }) }); load(); }, text: "Save" }),
          ]),
          el("div", { class: "muted", style: "font-size:11px;margin-bottom:4px", text: `Sales rep (currently: ${s.salesRepName || "Unassigned"})` }),
          el("div", {}, [
            repSelect,
            (() => { repSelect.addEventListener("change", async (e) => {
              if (!e.target.value) return;
              if (e.target.value === "__online__") { await api(`/api/manager/jobs/${s.id}`, { method: "PATCH", body: JSON.stringify({ isOnlineBooking: true }) }); load(); return; }
              await api(`/api/manager/jobs/${s.id}`, { method: "PATCH", body: JSON.stringify({ salesRepId: e.target.value }) });
              load();
            }); return null; })(),
          ]),
        ]));
      })();

      (dayCols ? dayCols[serviceColumnFor(s.baseService)] : body).appendChild(el("div", { class: "card" }, [
        el("div", { style: `display:flex;gap:12px;align-items:flex-start;${cancelled ? "opacity:0.55" : ""}` }, [
        el("div", { style: "min-width:64px;text-align:center;background:var(--cardAlt);border-radius:7px;padding:8px 4px;flex-shrink:0" }, [
          el("div", { class: "mono", style: "font-size:14px;font-weight:600", text: timeOnly }),
          el("div", { class: "muted", style: "font-size:10px", text: dateOnly }),
        ]),
        el("div", { style: "flex:1;min-width:0" }, [
          el("div", { style: `font-weight:500;${cancelled ? "text-decoration:line-through" : ""}`, text: `${s.car}${s.syncedFromGHL ? " 🔗" : ""}` }),
          el("div", { class: "muted", style: "font-size:12.5px", text: `${s.employeeNames || "Unassigned"} · ${s.baseService || "no service set"}` }),
          upsellRows.length ? el("div", { style: "margin-top:4px" }, upsellRows) : null,
        ]),
        el("div", { style: "text-align:right;flex-shrink:0" }, [
          el("div", { style: `color:${statusColor};font-size:12px;font-weight:600;margin-bottom:4px`, text: statusLabel }),
          priceRow,
          !cancelled && s.upsellTotal > 0 ? el("div", { class: "muted", style: "font-size:11px;margin-top:2px", text: `Upsells: ${money(s.upsellTotal)}` }) : null,
          el("div", { class: "mono", style: `color:${cancelled ? "var(--red)" : "var(--amber)"};font-size:16px;font-weight:600;margin-top:2px`, text: cancelled ? "—" : `Total: ${money(s.total)}` }),
          s.paid ? el("div", { class: "muted", style: "font-size:11px", text: `Paid — ${s.paymentMethod === "cash" ? "Cash" : "Card"}` }) : el("div", { class: "muted", style: "font-size:11px", text: cancelled ? "" : "Unpaid" }),
          el("div", { style: "display:flex;gap:6px;margin-top:6px;justify-content:flex-end" }, [
            photoToggleBtn, notesToggleBtn, editToggleBtn,
            el("button", { class: "ghost", style: "font-size:10px;padding:3px 7px", onclick: () => navigator.clipboard.writeText(s.id), text: "Copy ID" }),
            el("button", { class: "icon-danger", onclick: async () => { await api(`/api/sales/${s.id}`, { method: "DELETE" }); load(); }, text: "Delete" }),
          ]),
        ]),
        ]),
        photoToggleWrap,
        notesToggleWrap,
        editToggleWrap,
      ]));
      photoToggleWrap.appendChild(renderPhotoGrid(s, load));
      notesToggleWrap.appendChild(renderNotesSection(s, load));
    });
  }
  content.appendChild(picker.el);
  content.appendChild(dayColsSetup.wrap);
  content.appendChild(body);
  await load();
}

async function renderOwnerTeam(content) {
  const nameInput = el("input", { placeholder: "Name" });
  const pinInput = el("input", { type: "text", placeholder: "PIN (4+ digits)", style: "max-width:140px" });
  const rateInput = el("input", { type: "number", placeholder: "Upsell commission %", style: "max-width:150px" });
  const walkInRateInput = el("input", { type: "number", placeholder: "Walk-in close %", style: "max-width:140px" });
  const notice = el("div", { class: "notice" });
  const list = el("div");

  async function loadList() {
    const employees = await api("/api/employees");
    clearHeightLocked(list);
    employees.forEach((e) => {
      const rate = el("input", { type: "number", value: e.commissionRate, style: "max-width:70px" });
      rate.addEventListener("change", () => api(`/api/employees/${e.id}`, { method: "PATCH", body: JSON.stringify({ commissionRate: rate.value }) }));
      const walkInRate = el("input", { type: "number", value: e.walkInCommissionRate || 0, style: "max-width:70px" });
      walkInRate.addEventListener("change", () => api(`/api/employees/${e.id}`, { method: "PATCH", body: JSON.stringify({ walkInCommissionRate: walkInRate.value }) }));
      const newPinInput = el("input", { type: "text", placeholder: "New PIN", style: "max-width:100px" });
      const resetNotice = el("span", { class: "muted", style: "font-size:11px" });

      const payTypeSelect = el("select", { style: "max-width:110px" }, [
        el("option", { value: "", text: "Not set", ...(!e.payType ? { selected: "true" } : {}) }),
        el("option", { value: "salary", text: "Salary", ...(e.payType === "salary" ? { selected: "true" } : {}) }),
        el("option", { value: "hourly", text: "Hourly", ...(e.payType === "hourly" ? { selected: "true" } : {}) }),
        el("option", { value: "commission", text: "Commission", ...(e.payType === "commission" ? { selected: "true" } : {}) }),
      ]);
      const salaryInput = el("input", { type: "number", placeholder: "$ per period", value: e.salaryPerPeriod || "", style: `max-width:110px;${e.payType === "salary" ? "" : "display:none"}` });
      const hourlyInput = el("input", { type: "number", placeholder: "$ per hour", value: e.hourlyRate || "", style: `max-width:90px;${e.payType === "hourly" ? "" : "display:none"}` });
      const carCommissionInput = el("input", { type: "number", placeholder: "% per car", value: e.carCommissionRate || "", style: `max-width:90px;${e.payType === "commission" ? "" : "display:none"}` });
      payTypeSelect.addEventListener("change", async () => {
        salaryInput.style.display = payTypeSelect.value === "salary" ? "" : "none";
        hourlyInput.style.display = payTypeSelect.value === "hourly" ? "" : "none";
        carCommissionInput.style.display = payTypeSelect.value === "commission" ? "" : "none";
        await api(`/api/employees/${e.id}`, { method: "PATCH", body: JSON.stringify({ payType: payTypeSelect.value || null }) });
      });
      salaryInput.addEventListener("change", () => api(`/api/employees/${e.id}`, { method: "PATCH", body: JSON.stringify({ salaryPerPeriod: salaryInput.value }) }));
      hourlyInput.addEventListener("change", () => api(`/api/employees/${e.id}`, { method: "PATCH", body: JSON.stringify({ hourlyRate: hourlyInput.value }) }));
      carCommissionInput.addEventListener("change", () => api(`/api/employees/${e.id}`, { method: "PATCH", body: JSON.stringify({ carCommissionRate: carCommissionInput.value }) }));

      list.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row", style: "margin-bottom:8px" }, [
          el("div", { style: "flex:1;font-weight:500", text: e.name }),
          el("button", { class: "icon-danger", onclick: async () => { await api(`/api/employees/${e.id}`, { method: "DELETE" }); loadList(); }, text: "Remove" }),
        ]),
        el("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px" }, [
          el("span", { class: "muted", style: "font-size:11.5px", text: "Upsell:" }), rate, el("span", { class: "muted", style: "font-size:11.5px", text: "%" }),
          el("span", { class: "muted", style: "font-size:11.5px;margin-left:6px", text: "Walk-in close:" }), walkInRate, el("span", { class: "muted", style: "font-size:11.5px", text: "%" }),
        ]),
        el("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px" }, [
          el("span", { class: "muted", style: "font-size:11.5px", text: "Base pay:" }), payTypeSelect, salaryInput, hourlyInput, carCommissionInput,
        ]),
        el("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" }, [
          newPinInput,
          el("button", { class: "ghost", onclick: async () => {
            if (!newPinInput.value.trim()) return;
            await api(`/api/employees/${e.id}`, { method: "PATCH", body: JSON.stringify({ pin: newPinInput.value.trim() }) });
            newPinInput.value = ""; resetNotice.textContent = "PIN reset ✓"; resetNotice.style.color = "var(--green)";
            setTimeout(() => { resetNotice.textContent = ""; }, 2500);
          }, text: "Reset PIN" }),
          resetNotice,
        ]),
      ]));
    });
  }

  content.appendChild(el("div", { class: "card" }, [
    el("div", { class: "muted", style: "margin-bottom:10px", text: "ADD EMPLOYEE — give them the PIN so they can log in. Walk-in close % only pays out once a job is marked both Arrived AND Paid." }),
    el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, [nameInput, pinInput, rateInput, walkInRateInput,
      el("button", { class: "primary", onclick: async () => {
        try {
          await api("/api/employees", { method: "POST", body: JSON.stringify({ name: nameInput.value, pin: pinInput.value, commissionRate: rateInput.value, walkInCommissionRate: walkInRateInput.value }) });
          nameInput.value = ""; pinInput.value = ""; rateInput.value = ""; walkInRateInput.value = "";
          notice.className = "notice ok"; notice.textContent = "Added.";
          loadList();
        } catch (e) { notice.className = "notice err"; notice.textContent = e.message; }
      }, text: "Add" }),
    ]),
    notice,
  ]));
  content.appendChild(list);
  await loadList();
}

// ---------------- Sales rep: read-only bookings, no way to touch status ----------------
async function renderSalesSchedule(content) {
  const body = el("div");
  const { cols, wrap, clearAll } = makeServiceColumns();
  const nav = renderDayNav((params) => load(params));
  const searchInput = el("input", { placeholder: "Search by car or customer name...", style: "max-width:320px" });
  let searchMode = false;

  function renderJobCard(job) {
    const statusLabel = job.status === "arrived" ? "Showed" : job.status === "no_show" ? "No-show" : job.status === "cancelled" ? "Cancelled" : job.status === "unconfirmed" ? "Unconfirmed" : "Upcoming";
    const { cardStyle, badge } = cancelledTreatment(job.status);
    const notesSection = renderNotesSection(job, () => searchMode ? runSearch() : load());
    const upsellList = el("div", { style: "margin-bottom:6px" }, (job.upsells || []).map((u) =>
      el("span", { class: "pill", text: `${u.name} — ${money(u.price)} (${u.attributedToName})` })
    ));
    const upsellForm = renderUpsellForm(job.id, () => searchMode ? runSearch() : load());
    return el("div", { class: "card", style: cardStyle }, [
      el("div", { class: "row", style: "margin-bottom:8px" }, [
        el("div", {}, [
          el("div", { style: "font-weight:500" }, [el("span", { text: job.car }), badge]),
          el("div", { class: "muted", text: `${formatDateTime(job.date)} · ${job.customerName || ""} · ${job.baseService || ""}` }),
        ]),
        el("div", { style: "text-align:right" }, [
          el("div", { class: "mono", style: "color:var(--amber)", text: money(job.basePrice) }),
          el("div", { style: `color:${job.status === "arrived" ? "var(--green)" : job.status === "no_show" || job.status === "cancelled" ? "var(--red)" : job.status === "unconfirmed" ? "var(--amber)" : "var(--sub)"};font-size:12px;font-weight:600`, text: statusLabel }),
        ]),
      ]),
      el("div", { style: "border-top:0.5px solid var(--border);padding-top:8px;margin-top:4px" }, [upsellList, upsellForm]),
      notesSection,
    ]);
  }

  async function runSearch() {
    const q = searchInput.value.trim().toLowerCase();
    wrap.style.display = "none";
    body.style.display = "";
    clearHeightLocked(body);
    if (!q) { searchMode = false; nav.el.style.display = ""; return load(); }
    searchMode = true;
    nav.el.style.display = "none";
    // Searches the rep's whole history, not just one day - pulls a wide year-by-year net.
    const thisYear = new Date().getFullYear();
    const allJobs = [];
    for (const y of [thisYear - 1, thisYear, thisYear + 1]) {
      const jobs = await api(`/api/my/sales-schedule?period=year&date=${y}-01-01`);
      allJobs.push(...jobs);
    }
    const matches = allJobs.filter((j) => (j.car || "").toLowerCase().includes(q) || (j.customerName || "").toLowerCase().includes(q));
    if (matches.length === 0) { body.appendChild(el("div", { class: "muted", text: "No matching bookings found." })); return; }
    matches.sort((a, b) => (a.date < b.date ? 1 : -1)).forEach((job) => body.appendChild(renderJobCard(job)));
  }
  searchInput.addEventListener("input", () => { clearTimeout(searchInput._t); searchInput._t = setTimeout(runSearch, 300); });

  async function load(params) {
    if (searchMode) return; // search results already rendered - don't overwrite with the day view
    const p = params || nav.getParams();
    const qs = new URLSearchParams(p).toString();
    const jobs = await api(`/api/my/sales-schedule?${qs}`);
    clearHeightLocked(body);
    clearAll();
    if (jobs.length === 0) { wrap.style.display = "none"; body.style.display = ""; body.appendChild(el("div", { class: "muted", text: "No bookings on this day." })); return; }
    body.style.display = "none";
    wrap.style.display = "";
    jobs.sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((job) => cols[serviceColumnFor(job.baseService)].appendChild(renderJobCard(job)));
  }
  content.appendChild(el("div", { class: "muted", style: "margin-bottom:10px", text: "Status here is set by your manager — this is a read-only view of what you booked and whether it showed." }));
  content.appendChild(el("div", { class: "field", style: "margin-bottom:10px" }, [el("label", { text: "Search all your bookings" }), searchInput]));
  content.appendChild(nav.el);
  content.appendChild(wrap);
  content.appendChild(body);
  await load();
}

// Full shop schedule for sales reps — every job, not just their own bookings. No price
// shown (same privacy rule as employees), but arrival/completion status is visible.
async function renderSalesFullSchedule(content) {
  const { cols, wrap, clearAll } = makeServiceColumns();
  const emptyMsg = el("div", { class: "muted", style: "display:none", text: "Nothing booked on this day." });
  const nav = renderDayNav((params) => load(params));
  async function load(params) {
    const p = params || nav.getParams();
    const qs = new URLSearchParams(p).toString();
    const jobs = await api(`/api/sales/full-schedule?${qs}`);
    clearAll();
    emptyMsg.style.display = jobs.length === 0 ? "" : "none";
    if (jobs.length === 0) return;
    jobs.sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((job) => {
      const statusLabel = job.status === "arrived" ? "Arrived" : job.status === "no_show" ? "No-show" : job.status === "cancelled" ? "Cancelled" : job.status === "unconfirmed" ? "Unconfirmed" : "Upcoming";
      const statusColor = job.status === "arrived" ? "var(--green)" : job.status === "no_show" ? "var(--red)" : job.status === "cancelled" ? "var(--red)" : job.status === "unconfirmed" ? "var(--amber)" : "var(--sub)";
      const { cardStyle, badge } = cancelledTreatment(job.status);
      const upsellList = el("div", { style: "margin-bottom:6px" }, (job.upsells || []).map((u) =>
        el("span", { class: "pill", text: `${u.name} — ${money(u.price)} (${u.attributedToName})` })
      ));
      const upsellForm = renderUpsellForm(job.id, () => load());
      cols[serviceColumnFor(job.baseService)].appendChild(el("div", { class: "card", style: cardStyle }, [
        el("div", { class: "row", style: "margin-bottom:8px" }, [
          el("div", {}, [
            el("div", { style: "font-weight:500" }, [el("span", { text: job.car }), badge]),
            el("div", { class: "muted", text: `${formatDateTime(job.date)} · ${job.baseService || ""} · ${job.employeeNames}` }),
          ]),
          el("div", { style: "text-align:right" }, [
            el("div", { style: `color:${statusColor};font-size:12px;font-weight:600`, text: statusLabel }),
            job.completed ? el("div", { class: "muted", style: "font-size:11px", text: "Service complete" }) : null,
          ]),
        ]),
        el("div", { style: "border-top:0.5px solid var(--border);padding-top:8px;margin-top:4px" }, [upsellList, upsellForm]),
        renderNotesSection(job, () => load()),
      ]));
    });
  }
  content.appendChild(el("div", { class: "muted", style: "margin-bottom:10px", text: "Every car on the schedule, not just yours. Status is set by your manager." }));
  content.appendChild(nav.el);
  content.appendChild(wrap);
  content.appendChild(emptyMsg);
  await load();
}

async function renderSalesPerformance(content) {
  const body = el("div");
  const picker = renderPeriodPicker((params) => load(params), "payperiod", SALES_PAY_PERIOD_ANCHOR);
  async function load(params) {
    const p = params || picker.getParams();
    const qs = new URLSearchParams(p).toString();
    const stats = await api(`/api/my/sales-performance?${qs}`);
    clearHeightLocked(body);
    body.appendChild(el("div", { class: "metric-grid" }, [
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Total booked" }), el("div", { class: "metric-value mono", text: stats.totalBooked })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Booked value" }), el("div", { class: "metric-value mono", style: "color:var(--amber)", text: money(stats.totalBookedValue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Showed" }), el("div", { class: "metric-value mono", style: "color:var(--green)", text: stats.showedCount })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "No-shows" }), el("div", { class: "metric-value mono", style: "color:var(--red)", text: stats.noShowCount })]),
    ]));
    body.appendChild(el("div", { class: "card" }, [
      el("div", { class: "muted", style: "margin-bottom:10px", text: "PIPELINE — WHAT'S COMING VS. WHAT'S ALREADY HAPPENED" }),
      el("div", { class: "row", style: "margin-bottom:6px" }, [
        el("span", { class: "muted", text: `Booked, not shown yet (${stats.pendingCount})` }),
        el("span", { class: "mono", style: "color:var(--sub)", text: money(stats.pendingValue) }),
      ]),
      el("div", { class: "row" }, [
        el("span", { class: "muted", text: `Shown up (${stats.showedCount})` }),
        el("span", { class: "mono", style: "color:var(--green)", text: money(stats.showedValue) }),
      ]),
    ]));
    body.appendChild(el("div", { class: "card" }, [
      el("div", { class: "row", style: "margin-bottom:4px" }, [
        el("span", { class: "muted", text: "Value that showed (this is what your commission is based on)" }),
        el("span", { class: "mono", style: "color:var(--cyan)", text: money(stats.showedValue) }),
      ]),
      el("div", { class: "row", style: "margin-top:6px;font-size:12.5px" }, [
        el("span", { class: "muted", text: `During hours (${stats.commissionRate}%): ${stats.duringHoursCount} sale${stats.duringHoursCount !== 1 ? "s" : ""}` }),
        el("span", { class: "mono muted", text: money(stats.duringHoursValue) }),
      ]),
      el("div", { class: "row", style: "font-size:12.5px" }, [
        el("span", { class: "muted", text: `After hours (${stats.afterHoursCommissionRate}%): ${stats.afterHoursCount} sale${stats.afterHoursCount !== 1 ? "s" : ""}` }),
        el("span", { class: "mono muted", text: money(stats.afterHoursValue) }),
      ]),
      (stats.commissionRate > 0 || stats.afterHoursCommissionRate > 0)
        ? el("div", { class: "row", style: "border-top:0.5px solid var(--border);padding-top:8px;margin-top:8px" }, [
            el("span", { class: "muted", text: "Your total commission" }),
            el("span", { class: "mono", style: "color:var(--green);font-weight:600;font-size:18px", text: money(stats.commission) }),
          ])
        : el("div", { class: "muted", style: "font-size:11.5px;border-top:0.5px solid var(--border);padding-top:8px;margin-top:8px", text: "No commission rate set for you yet — ask the owner." }),
    ]));
    if ((stats.commissionAudit || []).length > 0) {
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "margin-bottom:8px", text: "COMMISSION AUDIT — exactly when each deal closed and why it got the rate it did" }),
        ...stats.commissionAudit.map((a) => el("div", { class: "row", style: "margin-bottom:6px;font-size:12.5px" }, [
          el("span", {}, [
            el("div", { text: a.car }),
            el("div", { class: "muted", style: "font-size:11px", text: `${a.closedAtEastern} — ${a.duringHours ? "in-hours" : "after-hours"} (${a.rateApplied}%)` }),
          ]),
          el("span", { class: "mono", style: `color:${a.duringHours ? "var(--cyan)" : "var(--amber)"}`, text: money(a.commissionAmount) }),
        ])),
      ]));
    }
    if (stats.upsellsClosedCount > 0) {
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "margin-bottom:8px", text: "UPSELLS YOU CLOSED (tracked separately from your base-sale commission above)" }),
        ...stats.upsellsClosed.map((u) => el("div", { class: "row", style: "margin-bottom:4px;font-size:13px" }, [
          el("span", {}, [
            el("div", { text: u.name }),
            el("div", { class: "muted", style: "font-size:11px", text: `${u.car} · ${formatDateTime(u.date)}` }),
          ]),
          el("span", { class: "mono", style: "color:var(--cyan)", text: money(u.price) }),
        ])),
        el("div", { class: "row", style: "border-top:0.5px solid var(--border);padding-top:8px;margin-top:6px" }, [
          el("span", { class: "muted", text: "Total" }),
          el("span", { class: "mono", style: "font-weight:600", text: money(stats.upsellsClosedValue) }),
        ]),
      ]));
    }
  }
  content.appendChild(picker.el);
  content.appendChild(body);
  await load();
}

// ---------------- Owner: manage sales reps ----------------
async function renderOwnerSalesReps(content) {
  const nameInput = el("input", { placeholder: "Name" });
  const initialsInput = el("input", { placeholder: "Initials (e.g. DG)", style: "max-width:130px" });
  const pinInput = el("input", { type: "text", placeholder: "PIN (4+ digits)", style: "max-width:140px" });
  const rateInput = el("input", { type: "number", placeholder: "Commission % (9am-6pm ET, Mon-Sat)", style: "max-width:220px" });
  const afterRateInput = el("input", { type: "number", placeholder: "After-hours %", style: "max-width:130px" });
  const notice = el("div", { class: "notice" });
  const list = el("div");

  async function loadList() {
    const reps = await api("/api/salesreps");
    clearHeightLocked(list);
    if (reps.length === 0) list.appendChild(el("div", { class: "muted", text: "No sales reps added yet." }));
    reps.forEach((r) => {
      const initials = el("input", { value: r.initials || "", placeholder: "Initials", style: "max-width:70px" });
      initials.addEventListener("change", () => api(`/api/salesreps/${r.id}`, { method: "PATCH", body: JSON.stringify({ initials: initials.value }) }));
      const rate = el("input", { type: "number", value: r.commissionRate || 0, style: "max-width:70px" });
      const afterRate = el("input", { type: "number", value: r.afterHoursCommissionRate || 0, style: "max-width:70px" });
      rate.addEventListener("change", () => api(`/api/salesreps/${r.id}`, { method: "PATCH", body: JSON.stringify({ commissionRate: rate.value }) }));
      afterRate.addEventListener("change", () => api(`/api/salesreps/${r.id}`, { method: "PATCH", body: JSON.stringify({ afterHoursCommissionRate: afterRate.value }) }));
      const newPinInput = el("input", { type: "text", placeholder: "New PIN", style: "max-width:90px" });
      const resetNotice = el("span", { class: "muted", style: "font-size:11px" });
      list.appendChild(el("div", { class: "card row" }, [
        el("div", { style: "flex:1;font-weight:500", text: r.name }),
        el("span", { class: "muted", style: "font-size:11.5px", text: "Initials:" }), initials,
        el("span", { class: "muted", style: "font-size:11.5px", text: "In hours:" }), rate, el("span", { class: "muted", style: "font-size:11.5px", text: "%" }),
        el("span", { class: "muted", style: "font-size:11.5px;margin-left:8px", text: "After hours:" }), afterRate, el("span", { class: "muted", style: "font-size:11.5px", text: "%" }),
        newPinInput,
        el("button", { class: "ghost", onclick: async () => {
          if (!newPinInput.value.trim()) return;
          await api(`/api/salesreps/${r.id}`, { method: "PATCH", body: JSON.stringify({ pin: newPinInput.value.trim() }) });
          newPinInput.value = ""; resetNotice.textContent = "PIN reset ✓"; resetNotice.style.color = "var(--green)";
          setTimeout(() => { resetNotice.textContent = ""; }, 2500);
        }, text: "Reset PIN" }),
        resetNotice,
        el("button", { class: "icon-danger", onclick: async () => { await api(`/api/salesreps/${r.id}`, { method: "DELETE" }); loadList(); }, text: "Remove" }),
      ]));
    });
  }

  content.appendChild(el("div", { class: "card" }, [
    el("div", { class: "muted", style: "margin-bottom:10px", text: "ADD SALES REP — this is the person who closed the deal, not the tech who worked it. Initials should match exactly what they type at the start of the appointment title (e.g. \"DG\" for Dmitriy Gumenyuk) — that's what the tracker uses to identify who booked a job. Their commission is on the base sale, only counted once a manager marks the appointment as arrived. The rate that applies depends on when the deal actually closed — during business hours (Mon–Sat, 9am–6pm Eastern) or after." }),
    el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, [nameInput, initialsInput, pinInput, rateInput, afterRateInput,
      el("button", { class: "primary", onclick: async () => {
        try {
          await api("/api/salesreps", { method: "POST", body: JSON.stringify({ name: nameInput.value, initials: initialsInput.value, pin: pinInput.value, commissionRate: rateInput.value, afterHoursCommissionRate: afterRateInput.value }) });
          nameInput.value = ""; initialsInput.value = ""; pinInput.value = ""; rateInput.value = ""; afterRateInput.value = "";
          notice.className = "notice ok"; notice.textContent = "Added.";
          loadList();
        } catch (e) { notice.className = "notice err"; notice.textContent = e.message; }
      }, text: "Add" }),
    ]),
    notice,
  ]));
  content.appendChild(list);
  await loadList();
}

// ---------------- Attendance — who showed up, who didn't, who worked a half day ----------------
async function renderAttendance(content) {
  const dayBody = el("div");
  const nav = renderDayNav((params) => loadDay(params));
  async function loadDay(params) {
    const date = (params || nav.getParams()).date;
    const people = await api(`/api/manager/attendance?date=${date}`);
    clearHeightLocked(dayBody);
    if (people.length === 0) { dayBody.appendChild(el("div", { class: "muted", text: "No employees or managers added yet." })); return; }
    people.forEach((p) => {
      const statusBtn = (value, label, color) => {
        const active = p.status === value;
        return el("button", {
          class: "tab-btn" + (active ? " active" : ""),
          style: "border-color:" + (active ? color : "var(--border)") + ";color:" + (active ? color : "var(--sub)"),
          onclick: async () => {
            await api("/api/manager/attendance", { method: "POST", body: JSON.stringify({ personType: p.type, personId: p.id, date, status: active ? null : value }) });
            loadDay();
          },
          text: (active ? "✓ " : "") + label,
        });
      };
      const startInput = el("input", { type: "time", value: p.startTime || "", style: "max-width:110px" });
      const endInput = el("input", { type: "time", value: p.endTime || "", style: "max-width:110px" });
      const saveTimes = async () => {
        await api("/api/manager/attendance", { method: "POST", body: JSON.stringify({ personType: p.type, personId: p.id, date, startTime: startInput.value, endTime: endInput.value }) });
      };
      startInput.addEventListener("change", saveTimes);
      endInput.addEventListener("change", saveTimes);

      dayBody.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row", style: "margin-bottom:8px" }, [
          el("div", {}, [
            el("div", { style: "font-weight:500", text: p.name }),
            el("div", { class: "muted", style: "font-size:11.5px", text: p.type === "manager" ? "Manager" : "Employee" }),
          ]),
          el("div", { style: "display:flex;gap:8px" }, [
            statusBtn("present", "Present", "var(--green)"),
            statusBtn("half_day", "Half day", "var(--amber)"),
            statusBtn("absent", "Absent", "var(--red)"),
          ]),
        ]),
        el("div", { style: "display:flex;gap:8px;align-items:center" }, [
          el("span", { class: "muted", style: "font-size:11.5px", text: "In:" }), startInput,
          el("span", { class: "muted", style: "font-size:11.5px", text: "Out:" }), endInput,
          el("span", { class: "muted", style: "font-size:10.5px", text: "usually 9–5 or 9–6, only fill in if it was different" }),
        ]),
      ]));
    });
  }

  const summaryBody = el("div");
  const summaryPicker = renderPeriodPicker((params) => loadSummary(params), "payperiod");
  async function loadSummary(params) {
    const p = params || summaryPicker.getParams();
    const qs = new URLSearchParams(p).toString();
    const rows = await api(`/api/owner/attendance-summary?${qs}`);
    clearHeightLocked(summaryBody);
    if (rows.length === 0) { summaryBody.appendChild(el("div", { class: "muted", text: "No one added yet." })); return; }
    const table = el("table", {}, [
      el("tr", {}, [el("th", { text: "Name" }), el("th", { text: "Present" }), el("th", { text: "Half day" }), el("th", { text: "Absent" })]),
      ...rows.map((r) => el("tr", {}, [
        el("td", { text: r.name }),
        el("td", { class: "mono", style: "color:var(--green)", text: r.present }),
        el("td", { class: "mono", style: "color:var(--amber)", text: r.halfDay }),
        el("td", { class: "mono", style: "color:var(--red)", text: r.absent }),
      ])),
    ]);
    summaryBody.appendChild(table);
  }

  content.appendChild(el("div", { class: "muted", style: "margin-bottom:8px;font-size:11.5px;letter-spacing:0.04em", text: "ATTENDANCE SUMMARY — DAYS PRESENT, HALF-DAY, AND MISSED" }));
  content.appendChild(summaryPicker.el);
  content.appendChild(summaryBody);
  content.appendChild(el("div", { class: "muted", style: "margin:20px 0 8px;font-size:11.5px;letter-spacing:0.04em", text: "MARK TODAY (OR ANY DAY)" }));
  content.appendChild(nav.el);
  content.appendChild(dayBody);
  await loadDay();
  await loadSummary();
}

// ---------------- Cleanup — find and fix every job missing a price or a sales rep ----------------
async function renderCleanup(content) {
  const body = el("div");
  const salesReps = await api("/api/manager/salesreps-list");
  const employees = await api("/api/manager/employees");
  const managersList = await api("/api/manager/managers-list");

  const autoFixResult = el("div", { style: "margin-top:10px" });
  const autoFixBtn = el("button", { class: "primary", style: "background:var(--green)", onclick: async () => {
    const r = await api("/api/manager/cleanup-auto-fix", { method: "POST", body: JSON.stringify({ dryRun: true }) });
    autoFixResult.innerHTML = "";
    if (r.fixedService + r.fixedRep === 0) {
      autoFixResult.appendChild(el("div", { class: "muted", text: "Nothing found that can be auto-fixed from the car/title text — the rest genuinely need a human look." }));
      return;
    }
    autoFixResult.appendChild(el("div", { class: "card" }, [
      el("div", { style: "font-size:12.5px;margin-bottom:6px", text: `Would auto-fix ${r.fixedService} service(s) and ${r.fixedRep} sales rep(s) from the car/title text. ${r.stillNeedsPrice} job(s) still need a price entered by hand — that can never be guessed.` }),
      el("button", { class: "primary", style: "background:var(--red)", onclick: async () => {
        if (!confirm(`Apply these ${r.fixedService + r.fixedRep} fixes now?`)) return;
        await api("/api/manager/cleanup-auto-fix", { method: "POST", body: JSON.stringify({ dryRun: false }) });
        autoFixResult.innerHTML = "";
        load();
      }, text: `Apply ${r.fixedService + r.fixedRep} fixes now` }),
    ]));
    r.preview.forEach((p) => {
      autoFixResult.appendChild(el("div", { class: "card", style: "font-size:11.5px" }, [
        el("div", { text: p.car }),
        el("div", { class: "muted" }, [
          p.serviceFix ? el("span", { text: `Service → ${p.serviceFix}  ` }) : null,
          p.repFix ? el("span", { text: `Rep → ${p.repFix}` }) : null,
        ]),
      ]));
    });
  }, text: "Auto-fix what we can from car/title text" });
  content.appendChild(el("div", { class: "card" }, [
    el("div", { class: "muted", style: "margin-bottom:8px", text: "Detects service and sales rep the same way the live GHL flow already does — from the car/title text (e.g. \"DG 2024 Toyota Venza Ceramic Coating\"). Only fixes what it can clearly detect; price always needs a human. Preview first, nothing changes until you confirm." }),
    autoFixBtn, autoFixResult,
  ]));

  const calMapResult = el("div", { style: "margin-top:10px" });
  content.appendChild(el("div", { class: "card" }, [
    el("div", { class: "muted", style: "margin-bottom:8px", text: "CALENDAR → SERVICE MAPPING — for jobs whose title has nothing to guess from (a genuine online booking's title is often just the customer's name). Which calendar it came through is unambiguous, so tell it once here and it'll auto-fill going forward." }),
    el("button", { class: "primary", onclick: async () => {
      const d = await api("/api/manager/calendar-service-map");
      calMapResult.innerHTML = "";
      if (d.seenCalendars.length === 0) { calMapResult.appendChild(el("div", { class: "muted", text: "No calendar IDs seen in your data yet." })); return; }
      d.seenCalendars.forEach((c) => {
        const select = el("select", { style: "max-width:180px" }, [
          el("option", { value: "", text: "Not mapped yet..." }),
          el("option", { value: "Window Tint", text: "Window Tint", ...(d.map[c.calendarId] === "Window Tint" ? { selected: "true" } : {}) }),
          el("option", { value: "Ceramic Coating", text: "Ceramic Coating", ...(d.map[c.calendarId] === "Ceramic Coating" ? { selected: "true" } : {}) }),
          el("option", { value: "PPF", text: "PPF", ...(d.map[c.calendarId] === "PPF" ? { selected: "true" } : {}) }),
        ]);
        calMapResult.appendChild(el("div", { class: "card row" }, [
          el("div", { style: "font-size:12px" }, [
            el("div", { class: "mono", style: "font-size:11px", text: c.calendarId }),
            el("div", { class: "muted", style: "font-size:11px", text: `e.g. "${c.exampleCar}"` }),
          ]),
          el("div", { style: "display:flex;gap:8px;align-items:center" }, [
            select,
            el("button", { class: "ghost", onclick: async () => {
              if (!select.value) return;
              await api("/api/manager/calendar-service-map", { method: "POST", body: JSON.stringify({ calendarId: c.calendarId, service: select.value }) });
              const r = await api("/api/manager/cleanup-fix-by-calendar", { method: "POST", body: JSON.stringify({ dryRun: false }) });
              alert(`Saved. Fixed ${r.fixed} existing job(s) using this mapping.`);
              load();
            }, text: "Save" }),
          ]),
        ]));
      });
    }, text: "Show calendars seen so far" }),
    calMapResult,
  ]));

  const selectedForOnline = new Set();
  const bulkOnlineBar = el("div", { style: "display:none;margin-bottom:12px" });
  function updateBulkBar() {
    if (selectedForOnline.size === 0) { bulkOnlineBar.style.display = "none"; return; }
    bulkOnlineBar.style.display = "block";
    bulkOnlineBar.innerHTML = "";
    bulkOnlineBar.appendChild(el("div", { class: "card", style: "border-color:var(--amber)" }, [
      el("div", { style: "font-size:12.5px;margin-bottom:8px", text: `${selectedForOnline.size} job(s) selected — for genuine website self-bookings where nobody actually closed the deal.` }),
      el("button", { class: "primary", style: "background:var(--amber)", onclick: async () => {
        if (!confirm(`Mark ${selectedForOnline.size} job(s) as Online Booking? This clears any missing-rep flag on them.`)) return;
        await api("/api/manager/cleanup-mark-online", { method: "POST", body: JSON.stringify({ ids: Array.from(selectedForOnline) }) });
        selectedForOnline.clear();
        load();
      }, text: `Mark ${selectedForOnline.size} as Online Booking` }),
    ]));
  }

  async function load() {
    const jobs = await api("/api/manager/needs-cleanup");
    clearHeightLocked(body);
    selectedForOnline.clear();
    updateBulkBar();
    if (jobs.length === 0) { body.appendChild(el("div", { class: "muted", text: "Nothing to clean up — every job has a price and a sales rep or walk-in assignment." })); return; }
    jobs.forEach((job) => {
      const priceInput = el("input", { type: "number", value: job.basePrice || "", placeholder: "Base price", style: "max-width:100px" });
      const serviceSelect = el("select", { style: "max-width:170px" }, [
        el("option", { value: "", text: "Set service..." }),
        el("option", { value: "Window Tint", text: "Window Tint", ...(job.baseService === "Window Tint" ? { selected: "true" } : {}) }),
        el("option", { value: "Ceramic Coating", text: "Ceramic Coating", ...(job.baseService === "Ceramic Coating" ? { selected: "true" } : {}) }),
        el("option", { value: "PPF", text: "PPF", ...(job.baseService === "PPF" ? { selected: "true" } : {}) }),
      ]);
      const repSelect = el("select", { style: "max-width:200px" }, [
        el("option", { value: "", text: "Assign a sales rep..." }),
        ...salesReps.map((r) => el("option", { value: r.id, text: r.name, ...(job.salesRepId === r.id ? { selected: "true" } : {}) })),
      ]);
      const closerSelect = el("select", { style: "max-width:200px" }, [
        el("option", { value: "", text: "...or a walk-in closer" }),
        ...employees.map((e) => el("option", { value: `employee::${e.id}`, text: `${e.name} (tech)`, ...(job.walkInClosedById === e.id ? { selected: "true" } : {}) })),
        ...managersList.map((m) => el("option", { value: `manager::${m.id}`, text: `${m.name} (manager)`, ...(job.walkInClosedById === m.id ? { selected: "true" } : {}) })),
      ]);
      const saveNotice = el("span", { class: "muted", style: "font-size:11px" });
      const onlineCheckbox = job.missingRep ? el("input", { type: "checkbox", onchange: (e) => {
        if (e.target.checked) selectedForOnline.add(job.id); else selectedForOnline.delete(job.id);
        updateBulkBar();
      } }) : null;

      body.appendChild(el("div", { class: "card" }, [
        el("div", { style: "display:flex;gap:8px;align-items:flex-start" }, [
          onlineCheckbox ? el("div", { style: "padding-top:2px" }, [onlineCheckbox]) : null,
          el("div", { style: "flex:1" }, [
            el("div", { style: "font-weight:500", text: job.car }),
            el("div", { class: "muted", style: "font-size:12.5px;margin-bottom:8px", text: `${formatDateTime(job.date)}${job.customerName ? " · " + job.customerName : ""} · ${job.baseService || "no service set"}` }),
            el("div", { style: "display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap" }, [
              job.missingPrice ? el("span", { class: "pill", style: "background:var(--amberDim);color:var(--amber)", text: "Missing price" }) : null,
              job.missingRep ? el("span", { class: "pill", style: "background:var(--amberDim);color:var(--amber)", text: "Missing sales rep — check the box above to bulk-mark as Online Booking" }) : null,
              job.missingService ? el("span", { class: "pill", style: "background:var(--amberDim);color:var(--amber)", text: "Missing service" }) : null,
            ]),
            el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center" }, [
              priceInput, serviceSelect, repSelect, closerSelect,
              el("button", { class: "primary", onclick: async () => {
                const patch = {};
                if (priceInput.value) patch.basePrice = priceInput.value;
                if (serviceSelect.value) patch.baseService = serviceSelect.value;
                if (repSelect.value) patch.salesRepId = repSelect.value;
                if (closerSelect.value) {
                  const [type, id] = closerSelect.value.split("::");
                  patch.isWalkIn = true; patch.walkInClosedByType = type; patch.walkInClosedById = id;
                }
                await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify(patch) });
                saveNotice.textContent = "Saved ✓"; saveNotice.style.color = "var(--green)";
                setTimeout(load, 600);
              }, text: "Save" }),
              saveNotice,
            ]),
          ]),
        ]),
      ]));
    });
  }
  content.appendChild(el("div", { class: "muted", style: "margin-bottom:14px", text: "Every job missing a base price or a sales rep, regardless of date. Fix what you can here — the rest can just stay as-is going forward." }));
  content.appendChild(bulkOnlineBar);
  content.appendChild(body);
  await load();
}

function clear(node) { node.innerHTML = ""; return node; }

// ---------------- Search — find a job by customer name, phone, email, or car ----------------
async function renderSearch(content) {
  const input = el("input", { placeholder: "Search by name, phone, email, or car...", style: "max-width:400px" });
  const results = el("div", { style: "margin-top:14px" });
  let timer;
  async function runSearch() {
    const q = input.value.trim();
    if (!q) { results.innerHTML = ""; return; }
    const rows = await api(`/api/manager/search?q=${encodeURIComponent(q)}`);
    clearHeightLocked(results);
    if (rows.length === 0) { results.appendChild(el("div", { class: "muted", text: "No matches." })); return; }
    rows.forEach((s) => {
      const upsellPills = (s.upsells || []).length
        ? el("div", { style: "margin-top:6px" }, s.upsells.map((u) => el("span", { class: "pill", text: `${u.name} — ${money(u.price)} (${u.attributedToName})` })))
        : null;

      const detailWrap = el("div", { style: "display:none;margin-top:10px;border-top:0.5px solid var(--border);padding-top:10px" });
      function buildDetail() {
        detailWrap.innerHTML = "";
        const closerLabel = s.salesRepName ? `Sales rep: ${s.salesRepName}` : s.isWalkIn ? "Walk-in (no rep)" : s.isOnlineBooking ? "Online booking" : "Unassigned";
        detailWrap.appendChild(el("div", { class: "muted", style: "font-size:12.5px;margin-bottom:8px" }, [
          el("div", { text: `Base price: ${money(s.basePrice)}` }),
          el("div", { text: closerLabel }),
          s.managerHelperNames ? el("div", { text: `Manager help: ${s.managerHelperNames}` }) : null,
        ]));
        detailWrap.appendChild(renderPhotoGrid(s, runSearch));
        detailWrap.appendChild(renderNotesSection(s, runSearch));
      }
      buildDetail();

      const card = el("div", {
        class: "card", style: "cursor:pointer",
        onclick: (e) => {
          if (e.target.closest("button, input, select, textarea, a")) return; // don't toggle when interacting with something inside
          const showing = detailWrap.style.display !== "none";
          detailWrap.style.display = showing ? "none" : "block";
        },
      }, [
        el("div", { class: "row" }, [
          el("div", {}, [
            el("div", { style: "font-weight:500", text: s.car }),
            el("div", { class: "muted", text: `${s.customerName || ""}${s.customerPhone ? " · " + s.customerPhone : ""}${s.customerEmail ? " · " + s.customerEmail : ""}` }),
            el("div", { class: "muted", text: `${formatDateTime(s.date)} · ${s.employeeNames} · ${s.baseService || ""}` }),
          ]),
          el("div", { style: "text-align:right" }, [
            el("div", { class: "mono", style: "color:var(--amber)", text: money(s.total) }),
            el("div", { class: "muted", style: "font-size:11.5px", text: `${s.status || "pending"}${s.completed ? " · complete" : ""}${s.paid ? " · paid (" + (s.paymentMethod === "cash" ? "cash" : "card") + ")" : " · unpaid"}` }),
          ]),
        ]),
        upsellPills,
        el("div", { class: "muted", style: "font-size:10.5px;margin-top:6px", text: "Tap for full details, photos, and notes" }),
        detailWrap,
      ]);
      results.appendChild(card);
    });
  }
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(runSearch, 300); });
  content.appendChild(el("div", { class: "field" }, [el("label", { text: "Look up a customer, vehicle, or job" }), input]));
  content.appendChild(results);
}

// ---------------- Manager's own performance — managers upsell too ----------------
async function renderManagerPerformance(content) {
  const body = el("div");
  const picker = renderPeriodPicker((params) => load(params), "month");
  async function load(params) {
    const p = params || picker.getParams();
    const qs = new URLSearchParams(p).toString();
    const stats = await api(`/api/manager/performance?${qs}`);
    clearHeightLocked(body);
    body.appendChild(el("div", { class: "metric-grid" }, [
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Your upsell revenue" }), el("div", { class: "metric-value mono", style: "color:var(--cyan)", text: money(stats.upsellRevenue) })]),
      el("div", { class: "metric" }, [el("div", { class: "metric-label", text: "Cars you upsold" }), el("div", { class: "metric-value mono", text: stats.cars })]),
      stats.commissionRate > 0 ? el("div", { class: "metric" }, [el("div", { class: "metric-label", text: `Est. commission (${stats.commissionRate}%)` }), el("div", { class: "metric-value mono", style: "color:var(--green)", text: money(stats.commission) })]) : null,
    ]));
    if (stats.top && stats.top.length) {
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "margin-bottom:8px", text: "STRONG SUIT" }),
        ...stats.top.map((t) => el("div", { class: "row", style: "margin-bottom:4px" }, [el("span", { text: t.name }), el("span", { class: "mono muted", text: `${t.count}x · ${money(t.revenue)}` })])),
      ]));
    }
    if (stats.growthArea) {
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "margin-bottom:8px", text: "GROWTH AREA" }),
        el("div", { class: "row" }, [el("span", { text: stats.growthArea.name }), el("span", { class: "mono muted", text: `${stats.growthArea.count}x · ${money(stats.growthArea.revenue)}` })]),
      ]));
    }
    if (stats.walkInCommissionRate > 0 || stats.walkInClosedCount > 0) {
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "margin-bottom:8px", text: "WALK-INS YOU CLOSED" }),
        el("div", { class: "row", style: "margin-bottom:4px" }, [el("span", { class: "muted", text: "Closed this period" }), el("span", { class: "mono", text: stats.walkInClosedCount })]),
        el("div", { class: "row", style: "margin-bottom:4px" }, [el("span", { class: "muted", text: "Arrived and paid" }), el("span", { class: "mono", style: "color:var(--green)", text: stats.walkInArrivedPaidCount })]),
        stats.walkInCommissionRate > 0
          ? el("div", { class: "row", style: "border-top:0.5px solid var(--border);padding-top:8px;margin-top:4px" }, [
              el("span", { class: "muted", text: `Commission (${stats.walkInCommissionRate}%, only on arrived + paid)` }),
              el("span", { class: "mono", style: "color:var(--green);font-weight:600", text: money(stats.walkInCommission) }),
            ])
          : el("div", { class: "muted", style: "font-size:11px;border-top:0.5px solid var(--border);padding-top:8px;margin-top:4px", text: "No walk-in commission rate set for you yet." }),
      ]));
    }
    if (stats.tipDetails !== undefined && stats.tipDetails.length > 0) {
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row" }, [
          el("span", { class: "muted", style: "margin-bottom:8px", text: `TIPS (${stats.tipDetails.length} CAR${stats.tipDetails.length !== 1 ? "S" : ""})` }),
          el("span", { class: "mono", style: "color:var(--green);font-weight:600", text: money(stats.tipsTotal) }),
        ]),
        el("div", { style: "margin-top:4px" }, stats.tipDetails.map((t) => el("div", { class: "row", style: "font-size:11px;margin-bottom:3px" }, [
          el("span", { class: "muted", text: `${t.car} — ${money(t.totalAmount)} (split ${t.splitCount} way${t.splitCount !== 1 ? "s" : ""})` }),
          el("span", { class: "mono", text: money(t.yourShare) }),
        ]))),
      ]));
    }
    if (stats.payType) {
      body.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "margin-bottom:8px", text: stats.payType === "salary" ? `BASE PAY — SALARY ($${stats.salaryPerPeriod}/period)` : stats.payType === "hourly" ? `BASE PAY — HOURLY ($${stats.hourlyRate}/hr)` : `CAR COMMISSION (${stats.carCommissionRate}% PER CAR)` }),
        el("div", { class: "row" }, [
          el("span", { class: "muted", text: stats.payType === "salary" ? `${stats.basePay.daysPresent} full day(s), ${stats.basePay.daysHalf} half day(s), ${stats.basePay.daysAbsent} absent` : stats.payType === "hourly" ? `${stats.basePay.hoursCounted.toFixed(1)} hours worked` : `${(stats.basePay.carDetails || []).length} car(s) arrived + paid` }),
          el("span", { class: "mono", style: "color:var(--green);font-weight:600", text: money(stats.basePay.amount) }),
        ]),
        stats.payType === "commission" && (stats.basePay.carDetails || []).length > 0
          ? el("div", { style: "margin-top:6px" }, stats.basePay.carDetails.map((c) => el("div", { class: "row", style: "font-size:11px;margin-bottom:3px" }, [
              el("span", { class: "muted", text: `${c.car} — ${money(c.basePrice)} (split ${c.splitCount} way${c.splitCount !== 1 ? "s" : ""})` }),
              el("span", { class: "mono", text: money(c.yourShare) }),
            ])))
          : null,
      ]));
    }
    body.appendChild(el("div", { class: "card" }, [
      el("div", { class: "row" }, [
        el("span", { style: "font-weight:600;font-size:14px", text: "Total owed to you" }),
        el("span", { class: "mono", style: "color:var(--amber);font-weight:700;font-size:18px", text: money(stats.totalPay) }),
      ]),
    ]));
    body.appendChild(el("div", { class: "muted", style: "margin:16px 0 8px;font-size:11.5px;letter-spacing:0.04em", text: "CARS YOU UPSOLD THIS PERIOD" }));
    if (!stats.jobs || stats.jobs.length === 0) {
      body.appendChild(el("div", { class: "muted", text: "No upsells logged by you in this period." }));
    } else {
      stats.jobs.forEach((j) => {
        body.appendChild(el("div", { class: "card" }, [
          el("div", { class: "row" }, [
            el("div", {}, [
              el("div", { style: "font-weight:500", text: j.car }),
              el("div", { class: "muted", text: `${formatDateTime(j.date)}${j.customerName ? " · " + j.customerName : ""}` }),
            ]),
            el("div", { class: "mono", style: "color:var(--cyan)", text: money(j.upsells.reduce((a, u) => a + (parseFloat(u.price) || 0), 0)) }),
          ]),
          el("div", { style: "margin-top:6px" }, j.upsells.map((u) => el("span", { class: "pill", text: `${u.name} — ${money(u.price)}` }))),
        ]));
      });
    }
  }
  content.appendChild(picker.el);
  content.appendChild(body);
  await load();
}

// ---------------- Manager job-status board (used by both manager and owner) ----------------
function renderDayNav(onChange) {
  const dateInput = el("input", { type: "date", value: new Date().toISOString().slice(0, 10) });
  function fire() { onChange({ period: "day", date: dateInput.value }); }
  function shift(delta) {
    const d = new Date(dateInput.value + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + delta);
    dateInput.value = d.toISOString().slice(0, 10);
    fire();
  }
  const prev = el("button", { class: "ghost", text: "< Prev day" });
  prev.addEventListener("click", () => shift(-1));
  const next = el("button", { class: "ghost", text: "Next day >" });
  next.addEventListener("click", () => shift(1));
  const todayBtn = el("button", { class: "ghost", text: "Today" });
  todayBtn.addEventListener("click", () => { dateInput.value = new Date().toISOString().slice(0, 10); fire(); });
  dateInput.addEventListener("change", fire);
  const wrap = el("div", { style: "display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap" }, [prev, dateInput, next, todayBtn]);
  return { el: wrap, getParams: () => ({ period: "day", date: dateInput.value }) };
}

// Groups a job into a display column by service - reused by both Job Status and All Jobs.
function serviceColumnFor(baseService) {
  const s = (baseService || "").toLowerCase();
  if (s.includes("tint")) return "Window Tint";
  if (s.includes("ceramic")) return "Ceramic Coating";
  return "PPF";
}
// A cancelled job should be unmistakable at a glance, everywhere it shows up — not just
// slightly dimmer than an active one. Unconfirmed is a real, different status though —
// the customer hasn't confirmed they're still coming, not that they've definitely
// cancelled — so it gets its own distinct amber flag instead of the same red strikethrough.
function cancelledTreatment(status) {
  const isCancelled = status === "cancelled";
  const isUnconfirmed = status === "unconfirmed";
  return {
    cardStyle: isCancelled ? "opacity:0.6;text-decoration:line-through" : isUnconfirmed ? "border-left:3px solid var(--amber)" : "",
    badge: isCancelled
      ? el("span", { style: "text-decoration:none;color:var(--red);font-size:10px;font-weight:700;margin-left:6px;letter-spacing:0.04em", text: "CANCELLED" })
      : isUnconfirmed
      ? el("span", { style: "text-decoration:none;color:var(--amber);font-size:10px;font-weight:700;margin-left:6px;letter-spacing:0.04em", text: "UNCONFIRMED" })
      : null,
  };
}

function makeServiceColumns() {
  const cardLists = {}; // returned to callers - append job cards here; safe to clear without losing the header
  const outerBoxes = {}; // the full column including its header - used only for show/hide filtering
  [["Window Tint", "WINDOW TINT"], ["Ceramic Coating", "CERAMIC COATING"], ["PPF", "PPF / NEEDS SERVICE SET"]].forEach(([key, label]) => {
    const cardList = el("div", {});
    outerBoxes[key] = el("div", { style: "flex:1;min-width:280px" }, [
      el("div", { class: "muted", style: "margin-bottom:8px;font-weight:600;text-align:center;letter-spacing:0.04em", text: label }),
      cardList,
    ]);
    cardLists[key] = cardList;
  });
  const colsWrap = el("div", { style: "display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start" }, Object.values(outerBoxes));

  // On a phone, three columns stacked full-width one after another is still effectively
  // one long scroll — this lets you filter down to just one service at a time instead.
  const tabs = ["All", "Window Tint", "Ceramic Coating", "PPF"];
  const tabBar = el("div", { style: "display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap" });
  function applyFilter(active) {
    Object.entries(outerBoxes).forEach(([name, boxEl]) => {
      const show = active === "All" || active === name;
      boxEl.style.display = show ? "" : "none";
      boxEl.style.minWidth = active === "All" ? "280px" : "0";
    });
  }
  tabs.forEach((t) => {
    const btn = el("button", { class: "tab-btn" + (t === "All" ? " active" : ""), text: t, onclick: () => {
      Array.from(tabBar.children).forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      applyFilter(t);
    } });
    tabBar.appendChild(btn);
  });

  const wrap = el("div", {}, [tabBar, colsWrap]);
  // Clears just the cards for a reload, keeping the tab bar and whichever filter was
  // selected completely untouched. Also holds the container's height steady across the
  // clear-and-refill — without this, the page briefly collapses to near-zero height the
  // instant it's cleared, and the browser's native scroll behavior snaps back to the top
  // during that gap, before the new cards even render.
  const clearAll = () => {
    const currentHeight = colsWrap.offsetHeight;
    if (currentHeight > 0) colsWrap.style.minHeight = currentHeight + "px";
    Object.values(cardLists).forEach((c) => { c.innerHTML = ""; });
    requestAnimationFrame(() => requestAnimationFrame(() => { colsWrap.style.minHeight = ""; }));
  };
  return { cols: cardLists, wrap, clearAll };
}

async function renderManagerJobs(content) {
  const { cols, wrap, clearAll } = makeServiceColumns();
  const emptyMsg = el("div", { class: "muted", style: "display:none", text: "No jobs on this day." });
  const employees = await api("/api/manager/employees");
  const managersList = await api("/api/manager/managers-list");
  const salesRepsList = await api("/api/manager/salesreps-list");
  const nav = renderDayNav((params) => load(params));

  // Manual add - for a real job that's in GHL/the schedule but never synced to the
  // tracker for some reason. Not meant to replace the live sync, just a fallback so a
  // missing job doesn't have to sit invisible until the underlying sync issue is found.
  const addFormWrap = el("div", { style: "display:none" });
  const addCustomerName = el("input", { placeholder: "Customer name" });
  const addCar = el("input", { placeholder: "Car / title" });
  const addDate = el("input", { type: "datetime-local" });
  const addService = el("select", {}, [
    el("option", { value: "", text: "Service..." }),
    el("option", { value: "Window Tint", text: "Window Tint" }),
    el("option", { value: "Ceramic Coating", text: "Ceramic Coating" }),
    el("option", { value: "PPF", text: "PPF" }),
  ]);
  const addPrice = el("input", { type: "number", placeholder: "Base price" });
  const addEmployeeChecks = employees.map((e) => {
    const cb = el("input", { type: "checkbox", value: e.id });
    return { id: e.id, name: e.name, cb, row: el("label", { style: "display:flex;align-items:center;gap:6px;font-size:12.5px;margin-bottom:4px" }, [cb, el("span", { text: e.name })]) };
  });
  const addNotice = el("div", { class: "muted", style: "font-size:11.5px;margin-top:6px" });
  const addToggleBtn = el("button", { class: "ghost", style: "margin-bottom:10px", onclick: () => {
    const showing = addFormWrap.style.display !== "none";
    addFormWrap.style.display = showing ? "none" : "block";
    addToggleBtn.textContent = showing ? "+ Add a missing job" : "− Hide add-job form";
  }, text: "+ Add a missing job" });
  addFormWrap.appendChild(el("div", { class: "card" }, [
    el("div", { class: "muted", style: "margin-bottom:8px", text: "For a real job that's booked in GHL but never made it into the tracker — not a replacement for fixing the actual sync." }),
    el("div", { class: "field" }, [el("label", { text: "Customer name" }), addCustomerName]),
    el("div", { class: "field" }, [el("label", { text: "Car / title" }), addCar]),
    el("div", { class: "field" }, [el("label", { text: "Date & time" }), addDate]),
    el("div", { class: "field" }, [el("label", { text: "Service" }), addService]),
    el("div", { class: "field" }, [el("label", { text: "Base price" }), addPrice]),
    el("div", { style: "margin:8px 0" }, [el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:4px", text: "Worked by" }), ...addEmployeeChecks.map((c) => c.row)]),
    el("button", { class: "primary", onclick: async () => {
      const employeeIds = addEmployeeChecks.filter((c) => c.cb.checked).map((c) => c.id);
      if (!addCar.value.trim() || employeeIds.length === 0) { addNotice.textContent = "Car and at least one tech are required."; addNotice.style.color = "var(--red)"; return; }
      await api("/api/sales", { method: "POST", body: JSON.stringify({
        customerName: addCustomerName.value, car: addCar.value, date: addDate.value || undefined,
        baseService: addService.value, basePrice: addPrice.value, employeeIds,
      }) });
      addCustomerName.value = ""; addCar.value = ""; addDate.value = ""; addService.value = ""; addPrice.value = "";
      addEmployeeChecks.forEach((c) => { c.cb.checked = false; });
      addNotice.textContent = "Added ✓"; addNotice.style.color = "var(--green)";
      addFormWrap.style.display = "none";
      addToggleBtn.textContent = "+ Add a missing job";
      load();
    }, text: "Add job" }),
    addNotice,
  ]));

  const tipWidgetWrap = el("div", { style: "margin-bottom:14px" });
  async function load(params) {
    const p = params || nav.getParams();
    const qs = new URLSearchParams(p).toString();
    const jobs = await api(`/api/manager/jobs?${qs}`);
    tipWidgetWrap.innerHTML = "";
    tipWidgetWrap.appendChild(renderTipWidget(jobs, () => load()));
    clearAll();
    emptyMsg.style.display = jobs.length === 0 ? "" : "none";
    if (jobs.length === 0) return;
    jobs.sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((job) => {
      const statusBtn = (value, label) => {
        const active = job.status === value;
        return el("button", {
          class: "tab-btn" + (active ? " active" : ""),
          style: "border-color:" + (active ? "var(--green)" : "var(--border)") + ";color:" + (active ? "var(--green)" : "var(--sub)"),
          onclick: async () => { await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ status: active ? "pending" : value }) }); load(); },
          text: (active ? "✓ " : "") + label,
        });
      };
      const boolBtn = (field, label) => {
        const active = job[field];
        return el("button", {
          class: "tab-btn" + (active ? " active" : ""),
          style: "border-color:" + (active ? "var(--green)" : "var(--border)") + ";color:" + (active ? "var(--green)" : "var(--sub)"),
          onclick: async () => { await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ [field]: !active }) }); load(); },
          text: (active ? "✓ " : "") + label,
        });
      };
      // Cash asks "how much?" before marking anything, because the amount is what gets
      // logged to Cash & Expenses. Full amount for the common case, or a custom amount when
      // a customer split the payment (some cash, rest on card, or just paid part so far).
      const cashNotice = el("div", { class: "muted", style: "font-size:11.5px;margin-top:6px" });
      const cashPanel = el("div", { style: "display:none;margin-bottom:10px;padding:10px 12px;background:var(--panel);border:0.5px solid var(--border);border-radius:8px" });
      const customCashInput = el("input", { type: "number", step: "0.01", min: "0", placeholder: "Custom amount", style: "max-width:130px" });
      const saveCash = async (amount) => {
        if (!(amount > 0)) { cashNotice.textContent = "Enter a real amount."; cashNotice.style.color = "var(--red)"; return; }
        // A typo like 5000 instead of 500 would silently overstate cash on hand, so an
        // amount above the job's total gets one confirmation (a bigger amount can be real).
        if ((job.total || 0) > 0 && amount > job.total + 0.005 && !confirm(`That's more than this job's total (${money(job.total || 0)}). Log ${money(amount)} in cash anyway?`)) return;
        try {
          await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ paidCash: true, cashPaidAmount: amount }) });
          load();
        } catch (err) { cashNotice.textContent = err.message || "Something went wrong."; cashNotice.style.color = "var(--red)"; }
      };
      const fullCashBtn = el("button", { class: "primary", onclick: () => saveCash(job.total), text: job.total > 0 ? `Full amount — ${money(job.total)}` : "Full amount — no price set" });
      if (!(job.total > 0)) fullCashBtn.disabled = true;
      customCashInput.addEventListener("keydown", (ev) => { if (ev.key === "Enter") saveCash(parseFloat(customCashInput.value)); });
      cashPanel.appendChild(el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:8px", text: "How much was paid in cash? This goes straight into Cash & Expenses." }));
      cashPanel.appendChild(el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center" }, [
        fullCashBtn,
        customCashInput,
        el("button", { class: "ghost", onclick: () => saveCash(parseFloat(customCashInput.value)), text: "Log custom" }),
        el("button", { class: "ghost", onclick: () => { cashPanel.style.display = "none"; }, text: "Cancel" }),
      ]));
      cashPanel.appendChild(cashNotice);
      const openCashPanel = () => {
        customCashInput.value = job.cashPaidAmount > 0 ? job.cashPaidAmount : "";
        cashNotice.textContent = "";
        cashPanel.style.display = "block";
      };
      const paymentBtn = (field, label) => {
        const active = field === "paidCash" ? !!job.paidCash : !!job.paidCard;
        return el("button", {
          class: "tab-btn" + (active ? " active" : ""),
          style: "border-color:" + (active ? "var(--green)" : "var(--border)") + ";color:" + (active ? "var(--green)" : "var(--sub)"),
          onclick: async () => {
            if (field === "paidCash") {
              if (!active) { if (cashPanel.style.display === "none") openCashPanel(); else cashPanel.style.display = "none"; return; }
              // Turning cash OFF also removes the logged cash entry, so say so first.
              if (job.cashPaidAmount > 0 && !confirm(`Remove the ${money(job.cashPaidAmount)} cash payment from this job and from Cash & Expenses?`)) return;
            }
            await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ [field]: !active }) });
            load();
          },
          text: (active ? "✓ " : "") + label,
        });
      };

      const assignWrap = el("div", { style: "display:flex;gap:6px;flex-wrap:wrap" });
      let selected = new Set(job.employeeIds || []);
      employees.forEach((emp) => {
        const chip = el("button", {
          class: "tab-btn" + (selected.has(emp.id) ? " active" : ""),
          onclick: async () => {
            if (selected.has(emp.id)) selected.delete(emp.id); else selected.add(emp.id);
            await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ employeeIds: Array.from(selected) }) });
            load();
          },
          text: emp.name,
        });
        assignWrap.appendChild(chip);
      });

      const managerAssignWrap = el("div", { style: "display:flex;gap:6px;flex-wrap:wrap" });
      let selectedMgrs = new Set(job.managerHelperIds || []);
      managersList.forEach((mgr) => {
        const chip = el("button", {
          class: "tab-btn" + (selectedMgrs.has(mgr.id) ? " active" : ""),
          onclick: async () => {
            if (selectedMgrs.has(mgr.id)) selectedMgrs.delete(mgr.id); else selectedMgrs.add(mgr.id);
            await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ managerHelperIds: Array.from(selectedMgrs) }) });
            load();
          },
          text: mgr.name,
        });
        managerAssignWrap.appendChild(chip);
      });

      const upsellList = el("div", { style: "margin-bottom:6px" }, (job.upsells || []).map((u) => {
        const nameInput = el("input", { value: u.name, style: "max-width:120px;font-size:12px" });
        const priceInput = el("input", { type: "number", value: u.price, style: "max-width:65px;font-size:12px" });
        const creditSelect = el("select", {
          style: "max-width:170px;font-size:11px;margin-left:6px;background:var(--panel);border:0.5px solid var(--border);border-radius:6px;color:var(--sub);padding:2px 4px",
          onchange: async (e) => {
            const [creditType, creditId] = e.target.value ? e.target.value.split("::") : ["none", ""];
            await api(`/api/sales/${job.id}/upsells/${u.id}`, { method: "PATCH", body: JSON.stringify({ creditType, creditId }) });
            load();
          },
        }, [
          el("option", { value: "", text: "Unassigned" }),
          ...employees.map((e) => el("option", { value: `employee::${e.id}`, text: `Tech: ${e.name}`, ...(u.employeeId === e.id ? { selected: "true" } : {}) })),
          ...managersList.map((m) => el("option", { value: `manager::${m.id}`, text: `Manager: ${m.name}`, ...(u.managerId === m.id ? { selected: "true" } : {}) })),
          ...salesRepsList.map((r) => el("option", { value: `salesrep::${r.id}`, text: `Rep: ${r.name}`, ...(u.salesRepId === r.id ? { selected: "true" } : {}) })),
        ]);
        return el("div", { style: "display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-bottom:6px;background:var(--panel);border-radius:7px;padding:4px 6px" }, [
          nameInput, priceInput, creditSelect,
          el("button", { class: "ghost", style: "font-size:10px;padding:3px 7px", onclick: async () => {
            await api(`/api/sales/${job.id}/upsells/${u.id}`, { method: "PATCH", body: JSON.stringify({ name: nameInput.value, price: priceInput.value }) });
            load();
          }, text: "Save" }),
          el("button", { class: "icon-danger", style: "font-size:10px;padding:3px 7px", onclick: async () => {
            if (!confirm("Delete this upsell?")) return;
            await api(`/api/sales/${job.id}/upsells/${u.id}`, { method: "DELETE" });
            load();
          }, text: "✕" }),
        ]);
      }));
      const upsellForm = renderUpsellForm(job.id, () => load());

      const priceInput = el("input", { type: "number", value: job.basePrice, style: "max-width:90px;text-align:right;font-family:monospace" });
      const priceNotice = el("span", { class: "muted", style: "font-size:10px" });
      const priceEditor = el("div", { style: "display:flex;align-items:center;gap:6px;justify-content:flex-end" }, [
        el("span", { class: "muted", style: "font-size:11px", text: "Base price:" }),
        priceInput,
        el("button", { class: "ghost", style: "font-size:11px;padding:3px 8px", onclick: async () => {
          await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ basePrice: priceInput.value }) });
          priceNotice.textContent = "Saved ✓"; priceNotice.style.color = "var(--green)";
          load();
        }, text: "Save" }),
      ]);

      const { cardStyle, badge } = cancelledTreatment(job.status);
      cols[serviceColumnFor(job.baseService)].appendChild(el("div", { class: "card", style: cardStyle }, [
        el("div", { class: "row", style: "margin-bottom:10px" }, [
          el("div", {}, [
            el("div", { style: "font-weight:500" }, [el("span", { text: job.car }), badge]),
            el("div", { class: "muted", text: `${formatDateTime(job.date)}${job.customerName ? " · " + job.customerName : ""}${job.customerPhone ? " · " + job.customerPhone : ""}` }),
            el("div", { class: "muted", text: job.baseService || "no service set" }),
          ]),
          el("div", { style: "text-align:right" }, [
            el("div", { class: "muted", style: "font-size:11px", text: `Base: ${money(job.basePrice)}` }),
            job.upsellTotal > 0 ? el("div", { class: "muted", style: "font-size:11px", text: `Upsells: ${money(job.upsellTotal)}` }) : null,
            el("div", { class: "mono", style: "color:var(--amber);font-size:17px;font-weight:600;margin-top:2px", text: `Total: ${money(job.total)}` }),
          ]),
        ]),
        el("div", { style: "margin-bottom:10px" }, [
          el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:4px", text: "CAR / TITLE — GHL doesn't tell us if this gets edited after booking, fix it here if it changes" }),
          (() => {
            const carInput = el("input", { value: job.car || "", style: "max-width:280px" });
            const saveBtn = el("button", { class: "ghost", style: "margin-left:6px", onclick: async () => {
              if (!carInput.value.trim()) return;
              await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ car: carInput.value }) });
              load();
            }, text: "Save" });
            return el("div", { style: "display:flex;align-items:center" }, [carInput, saveBtn]);
          })(),
        ]),
        el("div", { style: "margin-bottom:10px" }, [
          el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:4px", text: `SERVICE (currently: ${job.baseService || "not set"})` }),
          el("select", {
            style: "max-width:200px;background:var(--panel);border:0.5px solid var(--border);border-radius:7px;color:var(--text);padding:6px 8px;font-size:13px",
            onchange: async (e) => {
              if (!e.target.value) return;
              await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ baseService: e.target.value }) });
              load();
            },
          }, [
            el("option", { value: "", text: "Set service..." }),
            el("option", { value: "Window Tint", text: "Window Tint", ...(job.baseService === "Window Tint" ? { selected: "true" } : {}) }),
            el("option", { value: "Ceramic Coating", text: "Ceramic Coating", ...(job.baseService === "Ceramic Coating" ? { selected: "true" } : {}) }),
            el("option", { value: "PPF", text: "PPF", ...(job.baseService === "PPF" ? { selected: "true" } : {}) }),
          ]),
        ]),
        el("div", { style: "margin-bottom:10px;display:flex;gap:8px;flex-wrap:wrap" }, [
          job.status !== "cancelled"
            ? el("button", { class: "icon-danger", style: "font-size:11px;padding:4px 10px", onclick: async () => {
                if (!confirm(`Cancel this appointment for ${job.car}? This can't be easily undone from here.`)) return;
                await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) });
                load();
              }, text: "✕ Cancel appointment" })
            : el("button", { class: "ghost", style: "font-size:11px;padding:4px 10px", onclick: async () => {
                await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ status: "pending" }) });
                load();
              }, text: "↺ Uncancel" }),
          el("button", { class: "icon-danger", style: "font-size:11px;padding:4px 10px", onclick: async () => {
            if (!confirm(`Permanently DELETE this job (${job.car})? Only do this if it's genuinely not a real appointment - not in the CRM at all, a test entry, etc. This can't be undone.`)) return;
            await api(`/api/sales/${job.id}`, { method: "DELETE" });
            load();
          }, text: "🗑 Delete job" }),
        ]),
        el("div", { style: "margin-bottom:10px" }, [priceEditor, priceNotice]),
        el("div", { style: "margin-bottom:10px" }, [
          el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:4px", text: "DATE / TIME — for the rare case it needs a manual fix" }),
          (() => {
            const dt = new Date(job.date);
            const pad = (n) => String(n).padStart(2, "0");
            const localValue = isNaN(dt.getTime()) ? "" : `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
            const dtInput = el("input", { type: "datetime-local", value: localValue, style: "max-width:220px" });
            return el("div", { style: "display:flex;align-items:center;gap:6px" }, [
              dtInput,
              el("button", { class: "ghost", onclick: async () => {
                if (!dtInput.value) return;
                await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ date: dtInput.value }) });
                load();
              }, text: "Save" }),
            ]);
          })(),
        ]),
        el("div", { style: "margin-bottom:10px" }, [
          el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:4px", text: `SALES REP (currently: ${job.salesRepName})` }),
          el("select", {
            style: "max-width:220px;background:var(--panel);border:0.5px solid var(--border);border-radius:7px;color:var(--text);padding:6px 8px;font-size:13px",
            onchange: async (e) => {
              if (!e.target.value) return;
              if (e.target.value === "__online__") { await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ isOnlineBooking: true }) }); load(); return; }
              await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ salesRepId: e.target.value }) });
              load();
            },
          }, [
            el("option", { value: "", text: "Assign a sales rep..." }),
            ...salesRepsList.map((r) => el("option", { value: r.id, text: r.name, ...(job.salesRepId === r.id ? { selected: "true" } : {}) })),
            el("option", { value: "__online__", text: "Online Booking (website, no rep)", ...(job.isOnlineBooking ? { selected: "true" } : {}) }),
          ]),
        ]),
        el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px" }, [
          statusBtn("arrived", "Arrived"),
          statusBtn("no_show", "No-show"),
          boolBtn("completed", "Service complete"),
          paymentBtn("paidCash", "Paid — Cash"),
          paymentBtn("paidCard", "Paid — Card"),
          el("button", {
            class: "tab-btn" + (job.isWalkIn ? " active" : ""),
            style: "border-color:" + (job.isWalkIn ? "var(--amber)" : "var(--border)") + ";color:" + (job.isWalkIn ? "var(--amber)" : "var(--sub)"),
            onclick: async () => { await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ isWalkIn: !job.isWalkIn }) }); load(); },
            text: (job.isWalkIn ? "✓ " : "") + "Walk-in (no rep commission)",
          }),
        ]),
        job.paidCash ? el("div", { class: "row", style: "margin-bottom:10px;font-size:12px" }, [
          el("span", { style: job.cashPaidAmount > 0 ? "color:var(--green)" : "color:var(--sub)", text: job.cashPaidAmount > 0 ? `Cash received: ${money(job.cashPaidAmount)}` : "Cash amount not logged" }),
          el("button", { class: "ghost", style: "font-size:10.5px;padding:3px 8px", onclick: openCashPanel, text: job.cashPaidAmount > 0 ? "Edit" : "Log amount" }),
        ]) : null,
        cashPanel,
        job.isWalkIn ? el("div", { style: "margin-bottom:10px" }, [
          el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:4px", text: `WHO ACTUALLY CLOSED THIS WALK-IN? (currently: ${job.walkInClosedByName || "not set"})` }),
          el("select", {
            style: "max-width:220px;background:var(--panel);border:0.5px solid var(--border);border-radius:7px;color:var(--text);padding:6px 8px;font-size:13px",
            onchange: async (e) => {
              const [type, id] = e.target.value.split("::");
              if (!type || !id) return;
              await api(`/api/manager/jobs/${job.id}`, { method: "PATCH", body: JSON.stringify({ walkInClosedByType: type, walkInClosedById: id }) });
              load();
            },
          }, [
            el("option", { value: "", text: "Select who closed it..." }),
            ...employees.map((e) => el("option", { value: `employee::${e.id}`, text: `${e.name} (tech)`, ...(job.walkInClosedById === e.id ? { selected: "true" } : {}) })),
            ...managersList.map((m) => el("option", { value: `manager::${m.id}`, text: `${m.name} (manager)`, ...(job.walkInClosedById === m.id ? { selected: "true" } : {}) })),
          ]),
        ]) : null,
        el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:2px", text: `TECHS WHO WORKED THIS CAR (currently: ${job.employeeNames})` }),
        assignWrap,
        el("div", { class: "muted", style: "font-size:11.5px;margin:8px 0 2px", text: `MANAGERS WHO ALSO HELPED (currently: ${job.managerHelperNames || "none"})` }),
        managerAssignWrap,
        el("div", { style: "margin-top:10px;border-top:0.5px solid var(--border);padding-top:10px" }, [
          upsellList,
          upsellForm,
        ]),
        renderPhotoGrid(job, () => load()),
        renderNotesSection(job, () => load()),
      ]));
    });
  }
  content.appendChild(tipWidgetWrap);
  content.appendChild(addToggleBtn);
  content.appendChild(addFormWrap);
  content.appendChild(nav.el);
  content.appendChild(wrap);
  content.appendChild(emptyMsg);
  await load();
}

// ---------------- Owner: manage managers ----------------
async function renderOwnerManagers(content) {
  const nameInput = el("input", { placeholder: "Name" });
  const pinInput = el("input", { type: "text", placeholder: "PIN (4+ digits)", style: "max-width:140px" });
  const rateInput = el("input", { type: "number", placeholder: "Upsell commission %", style: "max-width:150px" });
  const walkInRateInput = el("input", { type: "number", placeholder: "Walk-in close %", style: "max-width:140px" });
  const notice = el("div", { class: "notice" });
  const list = el("div");

  async function loadList() {
    const managers = await api("/api/managers");
    clearHeightLocked(list);
    if (managers.length === 0) list.appendChild(el("div", { class: "muted", text: "No managers added yet." }));
    managers.forEach((m) => {
      const rate = el("input", { type: "number", value: m.commissionRate || 0, style: "max-width:70px" });
      rate.addEventListener("change", () => api(`/api/managers/${m.id}`, { method: "PATCH", body: JSON.stringify({ commissionRate: rate.value }) }));
      const walkInRate = el("input", { type: "number", value: m.walkInCommissionRate || 0, style: "max-width:70px" });
      walkInRate.addEventListener("change", () => api(`/api/managers/${m.id}`, { method: "PATCH", body: JSON.stringify({ walkInCommissionRate: walkInRate.value }) }));
      const newPinInput = el("input", { type: "text", placeholder: "New PIN", style: "max-width:100px" });
      const resetNotice = el("span", { class: "muted", style: "font-size:11px" });

      const payTypeSelect = el("select", { style: "max-width:110px" }, [
        el("option", { value: "", text: "Not set", ...(!m.payType ? { selected: "true" } : {}) }),
        el("option", { value: "salary", text: "Salary", ...(m.payType === "salary" ? { selected: "true" } : {}) }),
        el("option", { value: "hourly", text: "Hourly", ...(m.payType === "hourly" ? { selected: "true" } : {}) }),
        el("option", { value: "commission", text: "Commission", ...(m.payType === "commission" ? { selected: "true" } : {}) }),
      ]);
      const salaryInput = el("input", { type: "number", placeholder: "$ per period", value: m.salaryPerPeriod || "", style: `max-width:110px;${m.payType === "salary" ? "" : "display:none"}` });
      const hourlyInput = el("input", { type: "number", placeholder: "$ per hour", value: m.hourlyRate || "", style: `max-width:90px;${m.payType === "hourly" ? "" : "display:none"}` });
      const carCommissionInput = el("input", { type: "number", placeholder: "% per car", value: m.carCommissionRate || "", style: `max-width:90px;${m.payType === "commission" ? "" : "display:none"}` });
      payTypeSelect.addEventListener("change", async () => {
        salaryInput.style.display = payTypeSelect.value === "salary" ? "" : "none";
        hourlyInput.style.display = payTypeSelect.value === "hourly" ? "" : "none";
        carCommissionInput.style.display = payTypeSelect.value === "commission" ? "" : "none";
        await api(`/api/managers/${m.id}`, { method: "PATCH", body: JSON.stringify({ payType: payTypeSelect.value || null }) });
      });
      salaryInput.addEventListener("change", () => api(`/api/managers/${m.id}`, { method: "PATCH", body: JSON.stringify({ salaryPerPeriod: salaryInput.value }) }));
      hourlyInput.addEventListener("change", () => api(`/api/managers/${m.id}`, { method: "PATCH", body: JSON.stringify({ hourlyRate: hourlyInput.value }) }));
      carCommissionInput.addEventListener("change", () => api(`/api/managers/${m.id}`, { method: "PATCH", body: JSON.stringify({ carCommissionRate: carCommissionInput.value }) }));

      list.appendChild(el("div", { class: "card" }, [
        el("div", { class: "row", style: "margin-bottom:8px" }, [
          el("div", { style: "flex:1;font-weight:500", text: m.name }),
          el("button", { class: "icon-danger", onclick: async () => { await api(`/api/managers/${m.id}`, { method: "DELETE" }); loadList(); }, text: "Remove" }),
        ]),
        el("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px" }, [
          el("span", { class: "muted", style: "font-size:11.5px", text: "Upsell:" }), rate, el("span", { class: "muted", style: "font-size:11.5px", text: "%" }),
          el("span", { class: "muted", style: "font-size:11.5px;margin-left:6px", text: "Walk-in close:" }), walkInRate, el("span", { class: "muted", style: "font-size:11.5px", text: "%" }),
        ]),
        el("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px" }, [
          el("span", { class: "muted", style: "font-size:11.5px", text: "Base pay:" }), payTypeSelect, salaryInput, hourlyInput, carCommissionInput,
        ]),
        el("div", { style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" }, [
          newPinInput,
          el("button", { class: "ghost", onclick: async () => {
            if (!newPinInput.value.trim()) return;
            await api(`/api/managers/${m.id}`, { method: "PATCH", body: JSON.stringify({ pin: newPinInput.value.trim() }) });
            newPinInput.value = ""; resetNotice.textContent = "PIN reset ✓"; resetNotice.style.color = "var(--green)";
            setTimeout(() => { resetNotice.textContent = ""; }, 2500);
          }, text: "Reset PIN" }),
          resetNotice,
        ]),
      ]));
    });
  }

  content.appendChild(el("div", { class: "card" }, [
    el("div", { class: "muted", style: "margin-bottom:10px", text: "ADD MANAGER — they get their own PIN, a Job Status dashboard, search, and their own upsell performance (no shop-wide revenue or other people's commissions). Walk-in close % only pays out once a job is marked both Arrived AND Paid." }),
    el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, [nameInput, pinInput, rateInput, walkInRateInput,
      el("button", { class: "primary", onclick: async () => {
        try {
          await api("/api/managers", { method: "POST", body: JSON.stringify({ name: nameInput.value, pin: pinInput.value, commissionRate: rateInput.value, walkInCommissionRate: walkInRateInput.value }) });
          nameInput.value = ""; pinInput.value = ""; rateInput.value = ""; walkInRateInput.value = "";
          notice.className = "notice ok"; notice.textContent = "Added.";
          loadList();
        } catch (e) { notice.className = "notice err"; notice.textContent = e.message; }
      }, text: "Add" }),
    ]),
    notice,
  ]));
  content.appendChild(list);
  await loadList();
}

// ---------------- Owner: built-in webhook test tool ----------------
async function renderTestTool(content) {
  const car = el("input", { placeholder: "Car (e.g. 2023 BMW M3)", value: "2023 BMW M3" });
  const customer = el("input", { placeholder: "Customer name", value: "Test Customer" });
  const phone = el("input", { placeholder: "Customer phone", value: "555-123-4567" });
  const email = el("input", { placeholder: "Customer email", value: "test@example.com" });
  const employeeName = el("input", { placeholder: "Employee name(s) — separate multiple with a comma", value: "" });
  const salesRepName = el("input", { placeholder: "Sales rep name (who closed it)", value: "" });
  const baseService = el("select", {}, [
    el("option", { value: "Window Tint", text: "Window Tint" }),
    el("option", { value: "PPF", text: "PPF" }),
    el("option", { value: "Ceramic Coating", text: "Ceramic Coating" }),
  ]);
  const basePrice = el("input", { type: "number", placeholder: "Base price", value: "899" });
  const notice = el("div", { class: "notice" });

  content.appendChild(el("div", { class: "card", style: "max-width:480px" }, [
    el("div", { class: "muted", style: "margin-bottom:10px", text: "SIMULATE A JOB COMING IN FROM GOHIGHLEVEL — use this to test the whole flow before wiring up the real GHL webhook" }),
    el("div", { class: "field" }, [el("label", { text: "Car" }), car]),
    el("div", { class: "field" }, [el("label", { text: "Customer" }), customer]),
    el("div", { class: "field" }, [el("label", { text: "Phone" }), phone]),
    el("div", { class: "field" }, [el("label", { text: "Email" }), email]),
    el("div", { class: "field" }, [el("label", { text: "Employee name(s)" }), employeeName]),
    el("div", { class: "field" }, [el("label", { text: "Sales rep name" }), salesRepName]),
    el("div", { class: "field" }, [el("label", { text: "Base service" }), baseService]),
    el("div", { class: "field" }, [el("label", { text: "Base price" }), basePrice]),
    el("button", { class: "primary", onclick: async () => {
      try {
        await api("/api/owner/simulate-webhook", { method: "POST", body: JSON.stringify({
          date: new Date().toISOString(), customerName: customer.value, customerPhone: phone.value, customerEmail: email.value, car: car.value,
          employeeName: employeeName.value, salesRepName: salesRepName.value, baseService: baseService.value, basePrice: basePrice.value,
        }) });
        notice.className = "notice ok";
        notice.textContent = "Test job created — check \"All jobs\", \"Job status\", or \"Search\" to see it.";
      } catch (e) { notice.className = "notice err"; notice.textContent = e.message; }
    }, text: "Create test job" }),
    notice,
  ]));

  const cancelJobId = el("input", { placeholder: "Job ID to cancel (copy from All jobs)" });
  const cancelNotice = el("div", { class: "notice" });
  content.appendChild(el("div", { class: "card", style: "max-width:480px" }, [
    el("div", { class: "muted", style: "margin-bottom:10px", text: "SIMULATE A CANCELLATION — test what happens when GHL tells the tracker an appointment got cancelled. This removes the job from all revenue/commission totals but keeps it visible (marked Cancelled) in All Jobs and Search." }),
    el("div", { class: "field" }, [el("label", { text: "Job ID" }), cancelJobId]),
    el("button", { class: "primary", onclick: async () => {
      try {
        await api("/api/owner/simulate-cancel", { method: "POST", body: JSON.stringify({ saleId: cancelJobId.value.trim() }) });
        cancelNotice.className = "notice ok";
        cancelNotice.textContent = "Marked cancelled — check \"All jobs\" to see it, and \"Dashboard\" to confirm the revenue dropped.";
      } catch (e) { cancelNotice.className = "notice err"; cancelNotice.textContent = e.message; }
    }, text: "Cancel this job" }),
    cancelNotice,
  ]));

  const deleteJobId = el("input", { placeholder: "Job ID to delete (copy from All jobs)" });
  const deleteNotice = el("div", { class: "notice" });
  content.appendChild(el("div", { class: "card", style: "max-width:480px" }, [
    el("div", { class: "muted", style: "margin-bottom:10px", text: "SIMULATE A DELETION — test what happens when an appointment gets deleted in GHL, not just marked cancelled. This actually removes the job from the tracker entirely, rather than leaving it visible as Cancelled." }),
    el("div", { class: "field" }, [el("label", { text: "Job ID" }), deleteJobId]),
    el("button", { class: "primary", style: "background:var(--red);color:#fff", onclick: async () => {
      try {
        await api("/api/owner/simulate-delete", { method: "POST", body: JSON.stringify({ saleId: deleteJobId.value.trim() }) });
        deleteNotice.className = "notice ok";
        deleteNotice.textContent = "Deleted — check \"All jobs\": it should be completely gone, not showing as Cancelled.";
      } catch (e) { deleteNotice.className = "notice err"; deleteNotice.textContent = e.message; }
    }, text: "Delete this job" }),
    deleteNotice,
  ]));

  const debugBody = el("div");
  async function loadDebugLog() {
    const log = await api("/api/owner/debug-log");
    debugBody.innerHTML = "";
    if (log.length === 0) { debugBody.appendChild(el("div", { class: "muted", text: "Nothing logged yet." })); return; }
    log.forEach((entry) => {
      const isFailure = !!entry.failedReason;
      const isWarning = !!entry.salesRepMatchFailed;
      const isSuccess = !!entry.matchedSaleId && !isWarning;
      const summary = [];
      if (entry.endpoint) summary.push(`Endpoint: ${entry.endpoint}`);
      if (isSuccess) summary.push(`✓ Matched and updated job ${entry.matchedSaleId}`);
      if (entry.before) summary.push(`Before: ${JSON.stringify(entry.before)}`);
      if (entry.after) summary.push(`After: ${JSON.stringify(entry.after)}`);
      if (isFailure) summary.push(`✗ FAILED: ${entry.failedReason}`);
      if (entry.knownContactIds) summary.push(`Contact IDs currently on file: ${JSON.stringify(entry.knownContactIds)}`);
      if (entry.salesRepMatchFailed) {
        summary.push(`⚠ Sales rep "${entry.salesRepNameReceived}" didn't match anyone registered`);
        summary.push(`Registered sales rep names: ${JSON.stringify(entry.knownSalesRepNames)}`);
      }
      if (entry.contentType) summary.push(`Content-Type: ${entry.contentType}`);
      if (entry.requestUrl) summary.push(`Called: ${entry.requestUrl}`);
      if (entry.responseStatus !== undefined) summary.push(`Response status: ${entry.responseStatus}`);
      if (entry.error) summary.push(`✗ ERROR: ${entry.error}`);
      const rawContent = entry.responseBody !== undefined ? entry.responseBody : entry.body;
      debugBody.appendChild(el("div", { class: "card" }, [
        el("div", { class: "muted", style: "font-size:11px;margin-bottom:6px", text: entry.receivedAt }),
        summary.length ? el("div", { style: `font-size:12px;margin-bottom:8px;font-weight:500;color:${isFailure || entry.error ? "var(--red)" : isWarning ? "var(--amber)" : isSuccess ? "var(--green)" : "var(--sub)"}` },
          summary.map((line) => el("div", { text: line }))) : null,
        el("div", { class: "muted", style: "font-size:10.5px;margin-bottom:4px", text: "Raw content received:" }),
        el("pre", { style: "font-family:monospace;font-size:11.5px;white-space:pre-wrap;word-break:break-all;color:var(--text);margin:0", text: JSON.stringify(rawContent, null, 2) }),
      ]));
    });
  }
  content.appendChild(el("div", { class: "card", style: "max-width:600px" }, [
    el("div", { class: "muted", style: "margin-bottom:10px", text: "GHL API IMPORT — PHASE 1: TEST ONLY. This does not import anything yet. It makes one real call to GHL's API and shows the raw response below, so we can see exactly what your account returns before building the real bulk import. Requires GHL_API_TOKEN and GHL_LOCATION_ID set as environment variables in Railway first." }),
    el("button", { class: "primary", style: "margin-bottom:10px", onclick: async () => {
      try {
        await api("/api/owner/ghl-import-test", { method: "POST" });
        await loadDebugLog();
      } catch (e) { alert(e.message); }
    }, text: "Test 1: Sample opportunities" }),
    el("div", { style: "margin-bottom:10px" }, [
      el("button", { class: "primary", onclick: async () => {
        try { await api("/api/owner/ghl-test-pipelines", { method: "POST" }); await loadDebugLog(); } catch (e) { alert(e.message); }
      }, text: "Test 2: Pipeline stage names" }),
    ]),
    el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:4px", text: "Paste the 'Booked W Deposit' stage ID from Test 2's results:" }),
    (() => {
      const stageIdInput = el("input", { placeholder: "Stage ID", style: "max-width:280px;margin-bottom:10px" });
      return el("div", {}, [
        stageIdInput,
        el("button", { class: "primary", onclick: async () => {
          try { await api("/api/owner/ghl-test-booked-stage", { method: "POST", body: JSON.stringify({ stageId: stageIdInput.value.trim() }) }); await loadDebugLog(); } catch (e) { alert(e.message); }
        }, text: "Test 2b: Real booked jobs only" }),
      ]);
    })(),
    el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:4px;margin-top:10px", text: "Paste a real contact ID from Test 1's results to run these two:" }),
    (() => {
      const contactIdInput = el("input", { placeholder: "Contact ID", style: "max-width:220px;margin-bottom:8px" });
      return el("div", {}, [
        contactIdInput,
        el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, [
          el("button", { class: "primary", onclick: async () => {
            try { await api("/api/owner/ghl-test-contact", { method: "POST", body: JSON.stringify({ contactId: contactIdInput.value.trim() }) }); await loadDebugLog(); } catch (e) { alert(e.message); }
          }, text: "Test 3: Contact details (find sales rep)" }),
          el("button", { class: "primary", onclick: async () => {
            try { await api("/api/owner/ghl-test-appointments", { method: "POST", body: JSON.stringify({ contactId: contactIdInput.value.trim() }) }); await loadDebugLog(); } catch (e) { alert(e.message); }
          }, text: "Test 4: Their appointments (find car/date)" }),
        ]),
      ]);
    })(),
    el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:4px;margin-top:10px", text: "Paste that user ID (from assignedUserId) to resolve it to a real name:" }),
    (() => {
      const userIdInput = el("input", { placeholder: "User ID", style: "max-width:220px;margin-bottom:8px" });
      return el("div", {}, [
        userIdInput,
        el("button", { class: "primary", onclick: async () => {
          try { await api("/api/owner/ghl-test-user", { method: "POST", body: JSON.stringify({ userId: userIdInput.value.trim() }) }); await loadDebugLog(); } catch (e) { alert(e.message); }
        }, text: "Test 5: Resolve user ID to name" }),
      ]);
    })(),
  ]));

  const titleSyncResult = el("div", { style: "margin-top:10px" });
  content.appendChild(el("div", { class: "card" }, [
    el("div", { class: "muted", style: "margin-bottom:8px", text: "AUTO TITLE SYNC — runs automatically every 30 minutes on its own, checking every upcoming job (next 3 weeks) directly against GHL and auto-correcting the title if it's changed. Run it manually here to test or check right now." }),
    el("button", { class: "primary", onclick: async () => {
      titleSyncResult.innerHTML = "";
      titleSyncResult.appendChild(el("div", { class: "muted", text: "Running..." }));
      const r = await api("/api/owner/title-sync-now", { method: "POST" });
      titleSyncResult.innerHTML = "";
      if (r.skipped) { titleSyncResult.appendChild(el("div", { class: "muted", text: r.reason })); return; }
      titleSyncResult.appendChild(el("div", { class: "card" }, [
        el("div", { style: "font-size:12.5px", text: `Checked ${r.checked} of ${r.candidateCount} upcoming job(s), corrected ${r.updated} title(s).` }),
      ]));
    }, text: "Run title sync now" }),
    titleSyncResult,
  ]));

  const importStageId = el("input", { placeholder: "Booked stage ID (from Test 2)", style: "max-width:280px" });
  const importCutoff = el("input", { type: "date" });
  const importResults = el("div", { style: "margin-top:10px" });
  const importStatus = el("div", { class: "muted", style: "font-size:11.5px;margin-top:8px" });

  async function loadImportStatus() {
    const s = await api("/api/owner/ghl-bulk-import-status");
    importStatus.textContent = s.cursorSet
      ? `In progress — ${s.totalImportedSoFar} imported so far. Click "Import this batch" to continue.`
      : s.totalImportedSoFar > 0
        ? `Done — ${s.totalImportedSoFar} total imported. Nothing left to import.`
        : "Not started yet.";
  }

  function renderImportResult(r) {
    importResults.innerHTML = "";
    const lines = [
      `Processed: ${r.processed}`,
      `${r.dryRun ? "Would import" : "Imported"}: ${r.dryRun ? r.preview.length : r.imported}`,
      `Skipped (before cutoff date): ${r.skippedOld}`,
      `Skipped (no appointment found): ${r.skippedNoAppointment}`,
      r.errors.length ? `Errors: ${r.errors.length}` : null,
      r.totalAvailable !== null ? `Total in this stage: ${r.totalAvailable}` : null,
      r.hasMore ? "More batches remain — click again to continue." : "This was the last batch.",
    ].filter(Boolean);
    importResults.appendChild(el("div", { class: "card" }, lines.map((l) => el("div", { style: "font-size:12.5px", text: l }))));
    if (r.dryRun && r.preview.length) {
      r.preview.forEach((p) => {
        importResults.appendChild(el("div", { class: "card", style: "font-size:11.5px" }, [
          el("div", { style: "font-weight:500", text: p.car || "(no title)" }),
          el("div", { class: "muted", text: `${p.customerName} · ${p.date} · $${p.basePrice} · ${p.baseService || "service unknown"}` }),
        ]));
      });
    }
  }

  let autoImportRunning = false;
  const autoImportLog = el("div", { style: "margin-top:10px;max-height:240px;overflow-y:auto" });

  async function runAutoImport(stopBtn, startBtn) {
    autoImportRunning = true;
    stopBtn.style.display = "inline-block";
    startBtn.disabled = true;
    while (autoImportRunning) {
      let r;
      try {
        r = await api("/api/owner/ghl-bulk-import", { method: "POST", body: JSON.stringify({ stageId: importStageId.value.trim(), cutoffDate: importCutoff.value, dryRun: false, batchSize: 15 }) });
      } catch (e) {
        autoImportLog.appendChild(el("div", { style: "color:var(--red);font-size:12px", text: `Error: ${e.message} — stopped.` }));
        break;
      }
      autoImportLog.appendChild(el("div", { style: "font-size:12px", text: `Batch done — imported ${r.imported}, skipped ${r.skippedOld + r.skippedNoAppointment}, total so far: ${r.totalImportedSoFar}${r.totalAvailable ? ` of ~${r.totalAvailable}` : ""}` }));
      autoImportLog.scrollTop = autoImportLog.scrollHeight;
      await loadImportStatus();
      if (!r.hasMore) {
        autoImportLog.appendChild(el("div", { style: "color:var(--green);font-size:12px;font-weight:600", text: "✓ All done — nothing left to import." }));
        break;
      }
      await new Promise((res) => setTimeout(res, 500)); // brief pause between batches, easy on GHL's rate limits
    }
    autoImportRunning = false;
    stopBtn.style.display = "none";
    startBtn.disabled = false;
  }

  content.appendChild(el("div", { class: "card", style: "max-width:600px" }, [
    el("div", { class: "muted", style: "margin-bottom:10px", text: "PHASE 2: REAL IMPORT — imports real jobs from GHL's Booked stage using everything confirmed above. Preview first (nothing saved), then import in small batches. Safe to re-run — matches by opportunity ID, never creates duplicates." }),
    el("div", { class: "field" }, [el("label", { text: "Booked w/ Deposit stage ID" }), importStageId]),
    el("div", { class: "field" }, [el("label", { text: "Only import appointments on/after this date" }), importCutoff]),
    el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;margin-top:8px" }, [
      el("button", { class: "ghost", onclick: async () => {
        try {
          const r = await api("/api/owner/ghl-bulk-import", { method: "POST", body: JSON.stringify({ stageId: importStageId.value.trim(), cutoffDate: importCutoff.value, dryRun: true, batchSize: 15 }) });
          renderImportResult(r);
        } catch (e) { alert(e.message); }
      }, text: "Preview this batch (no changes saved)" }),
      el("button", { class: "primary", onclick: async () => {
        try {
          const r = await api("/api/owner/ghl-bulk-import", { method: "POST", body: JSON.stringify({ stageId: importStageId.value.trim(), cutoffDate: importCutoff.value, dryRun: false, batchSize: 15 }) });
          renderImportResult(r);
          await loadImportStatus();
        } catch (e) { alert(e.message); }
      }, text: "Import this batch for real" }),
      el("button", { class: "icon-danger", onclick: async () => {
        if (!confirm("Reset the import progress cursor? You'll start over from the beginning of the Booked stage next time.")) return;
        await api("/api/owner/ghl-bulk-import-reset", { method: "POST" });
        await loadImportStatus();
      }, text: "Reset progress" }),
    ]),
    (() => {
      const startBtn = el("button", { class: "primary", style: "margin-top:8px;background:var(--green)" });
      const stopBtn = el("button", { class: "icon-danger", style: "margin-top:8px;margin-left:8px;display:none" });
      startBtn.textContent = "Auto-import everything remaining (keep this tab open)";
      startBtn.onclick = () => runAutoImport(stopBtn, startBtn);
      stopBtn.textContent = "Stop";
      stopBtn.onclick = () => { autoImportRunning = false; };
      return el("div", {}, [startBtn, stopBtn]);
    })(),
    importStatus,
    autoImportLog,
    importResults,
    (() => {
      const dedupeResult = el("div", { style: "margin-top:10px" });
      const dedupeBtn = el("button", { class: "ghost", text: "Preview one-click cleanup", onclick: async () => {
        const r = await api("/api/owner/dedupe-contacts", { method: "POST", body: JSON.stringify({ dryRun: true }) });
        dedupeResult.innerHTML = "";
        if (r.groupsAffected === 0) { dedupeResult.appendChild(el("div", { class: "muted", text: "Nothing to clean up." })); return; }
        dedupeResult.appendChild(el("div", { class: "card" }, [
          el("div", { style: "font-size:12.5px;margin-bottom:6px", text: `Would keep ${r.groupsAffected} job(s) (the most recent per customer) and delete ${r.totalRemoved} older duplicate(s). Check the times below before confirming.` }),
          el("button", { class: "primary", style: "background:var(--red)", onclick: async () => {
            if (!confirm(`This deletes ${r.totalRemoved} job(s) permanently, keeping only the most recent per customer. Continue?`)) return;
            const real = await api("/api/owner/dedupe-contacts", { method: "POST", body: JSON.stringify({ dryRun: false }) });
            dedupeResult.innerHTML = "";
            dedupeResult.appendChild(el("div", { class: "card", style: "color:var(--green)", text: `Done — removed ${real.totalRemoved} duplicate(s).` }));
          }, text: `Confirm — delete ${r.totalRemoved} older duplicates now` }),
        ]));
        r.plan.forEach((p) => {
          dedupeResult.appendChild(el("div", { class: "card", style: "font-size:11.5px" }, [
            el("div", { style: "color:var(--green);margin-bottom:3px", text: `✓ Keeping: ${p.keep.car || "(no car)"} — ${p.keep.customerName} — ${formatDateTime(p.keep.date)}` }),
            ...p.remove.map((rm) => el("div", { class: "muted", style: "margin-left:12px", text: `✕ Deleting: ${rm.car || "(no car)"} — ${formatDateTime(rm.date)}` })),
          ]));
        });
      } });
      return el("div", { style: "margin-bottom:10px" }, [
        el("div", { class: "muted", style: "font-size:11.5px;margin-bottom:6px", text: "ONE-CLICK CLEANUP — keeps whichever job has the most recent date per customer, deletes the rest. Preview first, no per-group review needed." }),
        dedupeBtn, dedupeResult,
      ]);
    })(),
    (() => {
      const diagResult = el("div", { style: "margin-top:10px" });
      async function runDiag() {
        const d = await api("/api/owner/import-diagnostic");
        diagResult.innerHTML = "";
        diagResult.appendChild(el("div", { class: "card" }, [
          el("div", { style: "font-size:12.5px", text: `Total jobs in database: ${d.totalSalesInDatabase}` }),
          el("div", { style: "font-size:12.5px", text: `Unique GHL opportunity IDs: ${d.uniqueOpportunityIds}` }),
          el("div", { style: `font-size:12.5px;font-weight:600;color:${d.duplicateOpportunityIds > 0 ? "var(--red)" : "var(--green)"}`, text: d.duplicateOpportunityIds > 0 ? `⚠ ${d.duplicateOpportunityIds} exact duplicate(s) found` : "✓ No exact duplicates (same opportunity ID)" }),
          el("div", { style: `font-size:12.5px;font-weight:600;color:${d.contactsWithMultipleJobs > 0 ? "var(--amber)" : "var(--green)"}`, text: d.contactsWithMultipleJobs > 0 ? `⚠ ${d.contactsWithMultipleJobs} customer(s) with multiple separate jobs — review below, or use one-click cleanup above` : "✓ No customers with multiple jobs" }),
          el("div", { style: `font-size:12.5px;font-weight:600;color:${d.nameOnlyDuplicateGroups > 0 ? "var(--amber)" : "var(--green)"}`, text: d.nameOnlyDuplicateGroups > 0 ? `⚠ ${d.nameOnlyDuplicateGroups} customer(s) with the same name on multiple jobs, any date — could be a reschedule that moved days, could be a genuine repeat customer, check below` : "✓ No same-name jobs on different dates" }),
        ]));
        (d.contactDuplicates || []).forEach((group) => {
          diagResult.appendChild(el("div", { class: "card" }, [
            el("div", { class: "muted", style: "font-size:11px;margin-bottom:6px", text: `Same customer, ${group.count} separate jobs — keep the real one, delete the rest:` }),
            ...group.jobs.map((j) => el("div", { class: "row", style: "margin-bottom:4px" }, [
              el("div", { style: "font-size:12px" }, [
                el("div", { text: j.car || "(no car)" }),
                el("div", { class: "muted", style: "font-size:10.5px", text: `${j.customerName} · ${formatDateTime(j.date)} · $${j.basePrice} · opp: ${j.ghlOpportunityId}` }),
              ]),
              el("button", { class: "icon-danger", onclick: async () => { await api(`/api/sales/${j.id}`, { method: "DELETE" }); runDiag(); }, text: "Delete this one" }),
            ])),
          ]));
        });
        (d.nameOnlyDuplicates || []).forEach((group) => {
          diagResult.appendChild(el("div", { class: "card", style: "border-color:var(--amber)" }, [
            el("div", { class: "muted", style: "font-size:11px;margin-bottom:6px", text: `"${group.customerName}" appears ${group.count} times — could be a reschedule moved to a different day, or a genuine repeat visit. Check the dates before deleting:` }),
            ...group.jobs.map((j) => el("div", { class: "row", style: "margin-bottom:4px" }, [
              el("div", { style: "font-size:12px" }, [
                el("div", { text: j.car || "(no car)" }),
                el("div", { class: "muted", style: "font-size:10.5px", text: `${formatDateTime(j.date)} · $${j.basePrice} · opp: ${j.ghlOpportunityId || "none"}` }),
              ]),
              el("button", { class: "icon-danger", onclick: async () => { await api(`/api/sales/${j.id}`, { method: "DELETE" }); runDiag(); }, text: "Delete this one" }),
            ])),
          ]));
        });
      }
      const diagBtn = el("button", { class: "ghost", text: "Check for duplicate jobs (manual review)", onclick: runDiag });
      return el("div", {}, [diagBtn, diagResult]);
    })(),
  ]));
  await loadImportStatus();
  content.appendChild(el("div", { class: "card", style: "max-width:600px" }, [
    el("div", { class: "muted", style: "margin-bottom:10px", text: "WEBHOOK DEBUG LOG — point any GHL webhook action at the URL below to see exactly what GHL actually sends, raw. Useful for checking whether an event (like a deleted appointment) secretly fires something we haven't mapped yet." }),
    el("div", { class: "mono", style: "font-size:11.5px;color:var(--cyan);margin-bottom:12px;word-break:break-all", text: `${window.location.origin}/api/webhook/ghl/debug?secret=YOUR_WEBHOOK_SECRET` }),
    el("div", { style: "display:flex;gap:8px;margin-bottom:12px" }, [
      el("button", { class: "ghost", onclick: loadDebugLog, text: "Refresh log" }),
      el("button", { class: "ghost", onclick: async () => { await api("/api/owner/debug-log/clear", { method: "POST" }); loadDebugLog(); }, text: "Clear log" }),
    ]),
  ]));
  content.appendChild(debugBody);
  await loadDebugLog();
}

boot();
