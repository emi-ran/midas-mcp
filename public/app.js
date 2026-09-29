const $ = (id) => document.getElementById(id);
const numberFormat = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 4 });
const dateFormat = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
const shortDateFormat = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

let csrf = null;
let lastState = null;
let lastHoldingsFetch = 0;
let lastCompletedJob = null;
let loadingState = false;
let loadingHoldings = false;

function money(amount, currency) {
  if (amount === null || !Number.isFinite(Number(amount))) return "—";
  try {
    return new Intl.NumberFormat("tr-TR", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(amount));
  } catch {
    return `${numberFormat.format(Number(amount))} ${currency || ""}`.trim();
  }
}

function date(value) {
  return value ? dateFormat.format(new Date(value)) : "—";
}

function remaining(value) {
  if (!value) return "—";
  const seconds = Math.max(0, Math.floor((value - Date.now()) / 1_000));
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

async function request(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    document.title = "Giriş";
    window.location.replace("/");
    throw new Error("Oturum sona erdi.");
  }
  if (!response.ok) throw new Error(data.error || `İstek başarısız (${response.status})`);
  return data;
}

function startDashboard() {
  $("page-date").textContent = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric" }).format(new Date());
  void loadState();
}

function renderCountdown() {
  const expiry = lastState?.session?.refreshExpiresAt;
  $("countdown").textContent = remaining(expiry);
}

function renderState(data) {
  lastState = data;
  const { session, job } = data;
  const state = job?.state === "running" ? "connecting" : session.state;
  const text = {
    active: ["Oturum aktif", "Midas bağlantın açık. Varlıkların görüntülenebilir."],
    connecting: ["Giriş devam ediyor", "Midas uygulamasına gelen bildirimi telefonundan onayla."],
    expired: ["Oturum süresi doldu", "Yeni bir 24 saatlik dönem için yeniden giriş yapmalısın."],
    unknown: ["Bağlantı bekleniyor", "Midas oturumuna henüz bağlanılamadı."],
  }[state] || ["Durum bilinmiyor", "Oturum bilgileri alınamadı."];

  $("status-pill").dataset.state = state;
  $("status-label").textContent = text[0];
  $("session-heading").textContent = text[0];
  $("session-description").textContent = job?.state === "running"
    ? "Giriş deneniyor. Bildirim henüz gelmediyse iptal edip yeniden deneyebilirsin."
    : text[1];
  $("renew-button").disabled = job?.state === "running";
  $("renew-label").textContent = job?.state === "running" ? "Giriş sürüyor" : "Oturumu Yenile";
  $("cancel-login").hidden = job?.state !== "running";
  $("reload-holdings").disabled = state !== "active";
  $("expiry-caption").textContent = session.refreshExpiresAt ? "İlk girişten başlayan 24 saatlik süre" : "Oturum doğrulandığında görünecek";
  $("last-verified").textContent = date(session.lastVerifiedAt);
  $("expiry-time").textContent = date(session.refreshExpiresAt);
  renderCountdown();

  const notice = $("job-notice");
  notice.classList.toggle("notice-error", job?.state === "failed");
  if (job?.state === "running") {
    notice.hidden = false;
    notice.textContent = "Giriş işlemi sürüyor. Bildirim henüz gelmemiş olabilir; gerekirse girişi iptal edip yeniden dene.";
  } else if (job?.state === "failed") {
    notice.hidden = false;
    notice.textContent = `Giriş tamamlanamadı: ${job.error || "Bilinmeyen hata"}`;
  } else {
    notice.hidden = true;
  }

  if (job?.state === "done" && job.kind === "renew" && lastCompletedJob !== job.startedAt) {
    lastCompletedJob = job.startedAt;
    lastHoldingsFetch = 0;
  }
  if (state === "active" && Date.now() - lastHoldingsFetch >= 60_000) void loadHoldings();
}

async function loadState() {
  if (!csrf || loadingState) return;
  loadingState = true;
  try {
    renderState(await request("/api/dashboard/state"));
  } catch (error) {
    if (csrf) {
      const notice = $("job-notice");
      notice.hidden = false;
      notice.classList.add("notice-error");
      notice.textContent = error.message;
    }
  } finally {
    loadingState = false;
  }
}

function td(text, className = "") {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function renderHoldings(positions, updatedAt) {
  const body = $("holdings-body");
  body.replaceChildren();
  $("position-count").textContent = String(positions.length);
  $("holdings-updated").textContent = `Güncellendi: ${shortDateFormat.format(new Date(updatedAt))}`;

  if (positions.length === 0) {
    const row = document.createElement("tr");
    const cell = td("Açık varlık bulunamadı.", "empty-cell");
    cell.colSpan = 5;
    row.append(cell);
    body.append(row);
  }

  for (const position of positions) {
    const row = document.createElement("tr");
    const asset = document.createElement("td");
    const symbol = document.createElement("span");
    symbol.className = "asset-symbol";
    symbol.textContent = position.symbol;
    const name = document.createElement("span");
    name.className = "asset-name";
    name.textContent = position.name;
    asset.append(symbol, name);
    row.append(
      asset,
      td(position.market === "TR" ? "BIST" : "ABD", "market-tag"),
      td(numberFormat.format(position.quantity), "number-cell"),
      td(money(position.price, position.currency), "number-cell"),
      td(money(position.marketValue, position.currency), "number-cell value-cell"),
    );
    body.append(row);
  }

  const totals = new Map();
  for (const position of positions) {
    if (position.marketValue === null || !Number.isFinite(Number(position.marketValue))) continue;
    totals.set(position.currency, (totals.get(position.currency) || 0) + Number(position.marketValue));
  }
  const grid = $("summary-grid");
  grid.replaceChildren();
  if (totals.size === 0) totals.set("TRY", 0);
  for (const [currency, amount] of totals) {
    const card = document.createElement("div");
    card.className = "summary-card";
    const label = document.createElement("span");
    label.className = "summary-card-label";
    label.textContent = `${currency} VARLIK DEĞERİ`;
    const value = document.createElement("strong");
    value.className = "summary-card-value";
    value.textContent = money(amount, currency);
    card.append(label, value);
    grid.append(card);
  }
}

async function loadHoldings() {
  if (!csrf || loadingHoldings) return;
  loadingHoldings = true;
  $("reload-holdings").disabled = true;
  try {
    const data = await request("/api/dashboard/holdings");
    renderHoldings(data.positions, data.updatedAt);
    lastHoldingsFetch = Date.now();
  } catch (error) {
    if (csrf) {
      const row = document.createElement("tr");
      const cell = td(`Varlıklar alınamadı: ${error.message}`, "empty-cell");
      cell.colSpan = 5;
      row.append(cell);
      $("holdings-body").replaceChildren(row);
    }
  } finally {
    loadingHoldings = false;
    $("reload-holdings").disabled = lastState?.session?.state !== "active";
  }
}

$("renew-button").addEventListener("click", async () => {
  $("renew-button").disabled = true;
  try {
    await request("/api/dashboard/renew", { method: "POST", headers: { "X-CSRF-Token": csrf } });
    await loadState();
  } catch (error) {
    const notice = $("job-notice");
    notice.hidden = false;
    notice.classList.add("notice-error");
    notice.textContent = error.message;
    $("renew-button").disabled = false;
  }
});

$("cancel-login").addEventListener("click", async () => {
  $("cancel-login").disabled = true;
  try {
    await request("/api/dashboard/cancel", { method: "POST", headers: { "X-CSRF-Token": csrf } });
    await loadState();
  } catch (error) {
    const notice = $("job-notice");
    notice.hidden = false;
    notice.classList.add("notice-error");
    notice.textContent = error.message;
  } finally {
    $("cancel-login").disabled = false;
  }
});

$("reload-holdings").addEventListener("click", () => { void loadHoldings(); });

$("logout-button").addEventListener("click", async () => {
  try {
    await request("/api/dashboard/logout", { method: "POST", headers: { "X-CSRF-Token": csrf } });
    document.title = "Giriş";
    window.location.replace("/");
  } catch (error) {
    const notice = $("job-notice");
    notice.hidden = false;
    notice.classList.add("notice-error");
    notice.textContent = error.message;
  }
});

setInterval(renderCountdown, 1_000);
setInterval(() => { void loadState(); }, 3_000);

request("/api/dashboard/me")
  .then((data) => { csrf = data.csrf; startDashboard(); })
  .catch(() => { document.title = "Giriş"; window.location.replace("/"); });
