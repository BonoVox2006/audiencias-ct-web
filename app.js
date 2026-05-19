const $ = (sel) => document.querySelector(sel);

const SHARED_SYNC_ENABLED = location.protocol !== "file:";
const STATUS_KEY = "audiencias_ct_convidado_status_v2";
const ORGAO_PREF_KEY = "audiencias_ct_orgao_v1";
const PHOTO_DB_NAME = "audiencias_ct_fotos_v1";
const PHOTO_STORE = "fotos";
const PHOTO_MAX_PX = 520;
const PHOTO_JPEG_QUALITY = 0.85;

/** @type {Map<string, string>} */
const photoCache = new Map();
let pendingPhotoPersonId = null;
let photoDbPromise = null;

/** Estado compartilhado do evento aberto (todos os usuÃ¡rios). */
let sharedStatuses = {};
let sharedPhotos = {};
let sharedVersion = -1;
let eventSyncTimer = null;

/** @typedef {'pendente'|'chegou'|'nao-vem'} ConvidadoStatus */

/** @type {{id:string,sigla:string,nome:string}[]} */
let orgaos = [];
/** @type {{id:string,nome:string,cargo?:string,meta?:string,confirmado?:boolean}[]} */
let convidados = [];
let currentEventId = null;

const viewHome = $("#viewHome");
const viewEvento = $("#viewEvento");
const statusBar = $("#statusBar");
const orgaoSelect = $("#orgaoSelect");
const orgaoSearch = $("#orgaoSearch");
const eventList = $("#eventList");
const eventHint = $("#eventHint");
const tipoFilter = $("#tipoFilter");
const btnReload = $("#btnReload");

function safeText(s) {
  return (s ?? "").toString();
}

function normalizeFold(s) {
  return safeText(s)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function slugKey(s) {
  return normalizeFold(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function setStatus(msg, kind = "") {
  statusBar.textContent = msg || "";
  statusBar.classList.toggle("is-busy", kind === "busy");
  statusBar.classList.toggle("is-error", kind === "error");
}

async function apiGet(path) {
  const res = await fetch(path, { headers: { Accept: "application/json; charset=utf-8" } });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json?.error || json?.detail || `HTTP ${res.status}`);
  }
  return json;
}

function formatDateTime(iso) {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function eventTipoClass(tipo) {
  const t = normalizeFold(tipo);
  if (t.includes("audiencia")) return "audiencia";
  if (t.includes("reuniao")) return "reuniao";
  if (t.includes("seminario")) return "seminario";
  return "";
}

function matchesTipoFilter(ev, filter) {
  if (!filter) return true;
  const t = normalizeFold(ev?.descricaoTipo || "");
  if (filter === "audiencia") return t.includes("audiencia");
  if (filter === "reuniao") return t.includes("reuniao");
  if (filter === "seminario") return t.includes("seminario");
  return true;
}

function loadStatusesLocal(eventId) {
  try {
    const all = JSON.parse(localStorage.getItem(STATUS_KEY) || "{}");
    const map = all[String(eventId)] || {};
    return typeof map === "object" && map ? map : {};
  } catch {
    return {};
  }
}

function saveStatusesLocal(eventId, map) {
  try {
    const all = JSON.parse(localStorage.getItem(STATUS_KEY) || "{}");
    all[String(eventId)] = map;
    localStorage.setItem(STATUS_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

/** @returns {Record<string, ConvidadoStatus>} */
function loadStatuses(eventId) {
  if (SHARED_SYNC_ENABLED && String(currentEventId) === String(eventId)) {
    return { ...sharedStatuses };
  }
  return loadStatusesLocal(eventId);
}

/** @param {ConvidadoStatus} status */
function saveStatus(eventId, personId, status) {
  if (SHARED_SYNC_ENABLED && String(currentEventId) === String(eventId)) {
    if (status === "pendente") delete sharedStatuses[personId];
    else sharedStatuses[personId] = status;
    void pushSharedEventState(eventId).catch(() => {
      setStatus("Falha ao sincronizar. Tente de novo.", "error");
    });
    return;
  }
  const map = loadStatusesLocal(eventId);
  if (status === "pendente") delete map[personId];
  else map[personId] = status;
  saveStatusesLocal(eventId, map);
}

function photoStorageKey(eventId, personId) {
  return `${String(eventId)}::${String(personId)}`;
}

function applyRemoteEventState(remote, opts = {}) {
  if (!remote) return false;
  const force = Boolean(opts.force);
  const v = Number(remote.version ?? 0);
  if (!force && v <= sharedVersion) return false;

  sharedVersion = v;
  sharedStatuses =
    remote.statuses && typeof remote.statuses === "object" ? { ...remote.statuses } : {};

  const incoming =
    remote.photos && typeof remote.photos === "object" ? remote.photos : {};
  sharedPhotos = {};
  for (const [id, url] of Object.entries(incoming)) {
    if (url) sharedPhotos[id] = url;
  }

  photoCache.clear();
  for (const [id, url] of Object.entries(sharedPhotos)) {
    if (url) photoCache.set(id, url);
  }
  return true;
}

async function syncPhotosToIdb(eventId, photos) {
  if (!eventId || !photos) return;
  const tasks = [];
  for (const [personId, url] of Object.entries(photos)) {
    if (url) tasks.push(savePhotoToIdb(eventId, personId, url));
  }
  await Promise.all(tasks);
}

async function loadPhotosFromIdb(eventId, personIds) {
  if (!eventId) return;
  await Promise.all(
    personIds.map(async (personId) => {
      const url = await getPhotoFromIdb(eventId, personId);
      if (url) {
        sharedPhotos[personId] = url;
        photoCache.set(personId, url);
      }
    })
  );
}

async function fetchSharedEventState(eventId) {
  const res = await fetch(`/api/state?eventId=${encodeURIComponent(eventId)}`, {
    headers: { Accept: "application/json" }
  });
  if (!res.ok) throw new Error("Falha ao ler estado compartilhado.");
  const data = await res.json();
  return data?.dados || null;
}

async function pushSharedEventState(eventId) {
  const res = await fetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      eventId: String(eventId),
      statuses: sharedStatuses,
      photos: sharedPhotos
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = safeText(data?.detail || data?.error);
    throw new Error(detail || "Falha ao gravar estado compartilhado.");
  }
  const out = data?.dados;
  if (out) {
    applyRemoteEventState(out, { force: true });
    await syncPhotosToIdb(eventId, sharedPhotos);
  }
}

async function syncEventFromServer() {
  if (!currentEventId || !SHARED_SYNC_ENABLED) return;
  try {
    const remote = await fetchSharedEventState(currentEventId);
    if (applyRemoteEventState(remote)) {
      await syncPhotosToIdb(currentEventId, sharedPhotos);
      renderConvidados();
    }
  } catch {
    /* servidor indisponÃ­vel */
  }
}

function startEventSync() {
  stopEventSync();
  if (!SHARED_SYNC_ENABLED || !currentEventId) return;
  void syncEventFromServer();
  eventSyncTimer = setInterval(() => void syncEventFromServer(), 3000);
  document.addEventListener("visibilitychange", onVisibilityForSync);
  window.addEventListener("online", onVisibilityForSync);
}

function stopEventSync() {
  if (eventSyncTimer) clearInterval(eventSyncTimer);
  eventSyncTimer = null;
  document.removeEventListener("visibilitychange", onVisibilityForSync);
  window.removeEventListener("online", onVisibilityForSync);
}

function onVisibilityForSync() {
  if (!document.hidden) void syncEventFromServer();
}

function resetSharedEventState() {
  sharedStatuses = {};
  sharedPhotos = {};
  sharedVersion = -1;
  photoCache.clear();
}

function openPhotoDb() {
  if (photoDbPromise) return photoDbPromise;
  photoDbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("Este navegador n\u00e3o suporta salvar fotos."));
      return;
    }
    const req = indexedDB.open(PHOTO_DB_NAME, 1);
    req.onerror = () => reject(req.error || new Error("Erro ao abrir armazenamento de fotos."));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(PHOTO_STORE)) {
        db.createObjectStore(PHOTO_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
  return photoDbPromise;
}

async function getPhotoFromIdb(eventId, personId) {
  try {
    const db = await openPhotoDb();
    const key = photoStorageKey(eventId, personId);
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTO_STORE, "readonly");
      const req = tx.objectStore(PHOTO_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function savePhotoToIdb(eventId, personId, dataUrl) {
  const db = await openPhotoDb();
  const key = photoStorageKey(eventId, personId);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(PHOTO_STORE, "readwrite");
    const req = tx.objectStore(PHOTO_STORE).put(dataUrl, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function deletePhotoFromIdb(eventId, personId) {
  try {
    const db = await openPhotoDb();
    const key = photoStorageKey(eventId, personId);
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTO_STORE, "readwrite");
      const req = tx.objectStore(PHOTO_STORE).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* ignore */
  }
}

async function getPhoto(personId) {
  if (photoCache.has(personId)) return photoCache.get(personId) || null;
  if (sharedPhotos[personId]) return sharedPhotos[personId];
  if (currentEventId) {
    const fromIdb = await getPhotoFromIdb(currentEventId, personId);
    if (fromIdb) {
      photoCache.set(personId, fromIdb);
      sharedPhotos[personId] = fromIdb;
      return fromIdb;
    }
  }
  return null;
}

async function savePhoto(personId, dataUrl) {
  if (!currentEventId) throw new Error("Nenhum evento aberto.");
  const eventId = currentEventId;

  photoCache.set(personId, dataUrl);
  sharedPhotos[personId] = dataUrl;
  await savePhotoToIdb(eventId, personId, dataUrl);

  if (SHARED_SYNC_ENABLED) {
    await pushSharedEventState(eventId);
  }
}

async function removePhoto(personId) {
  if (!currentEventId) throw new Error("Nenhum evento aberto.");
  const eventId = currentEventId;

  delete sharedPhotos[personId];
  photoCache.delete(personId);
  await deletePhotoFromIdb(eventId, personId);

  if (SHARED_SYNC_ENABLED) {
    await pushSharedEventState(eventId);
  }
}

async function preloadPhotos(eventId, personIds) {
  await loadPhotosFromIdb(eventId, personIds);
  for (const id of personIds) {
    const url = sharedPhotos[id];
    if (url) photoCache.set(id, url);
  }
}

function resizeImageFile(file, maxPx = PHOTO_MAX_PX) {
  return new Promise((resolve, reject) => {
    const blobUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(blobUrl);
      let w = img.naturalWidth || img.width;
      let h = img.naturalHeight || img.height;
      if (!w || !h) {
        reject(new Error("Imagem inv\u00e1lida."));
        return;
      }
      const scale = Math.min(1, maxPx / Math.max(w, h));
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("N\u00e3o foi poss\u00edvel processar a imagem."));
        return;
      }
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", PHOTO_JPEG_QUALITY));
    };
    img.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      reject(new Error("N\u00e3o foi poss\u00edvel ler a imagem."));
    };
    img.src = blobUrl;
  });
}

function renderAvatarButton(p) {
  const photoUrl = photoCache.get(p.id);
  const hasPhoto = Boolean(photoUrl);
  const label = hasPhoto
    ? `Alterar foto de ${p.nome}`
    : `Adicionar foto de ${p.nome} (galeria ou arquivo)`;

  if (hasPhoto) {
    return `<div class="convidadoCard__avatarWrap">
      <button type="button" class="convidadoCard__avatar convidadoCard__avatar--photo" data-photo-for="${escapeHtml(p.id)}" aria-label="${escapeHtml(label)}">
        <img src="${photoUrl}" alt="Foto de ${escapeHtml(p.nome)}" loading="lazy" decoding="async" />
      </button>
      <button type="button" class="convidadoCard__photoRemove" data-photo-remove="${escapeHtml(p.id)}" aria-label="Excluir foto de ${escapeHtml(p.nome)}">\u00d7</button>
    </div>`;
  }

  return `<div class="convidadoCard__avatarWrap">
    <button type="button" class="convidadoCard__avatar" data-photo-for="${escapeHtml(p.id)}" aria-label="${escapeHtml(label)}">
      <span class="convidadoCard__initials">${escapeHtml(initials(p.nome))}</span>
      <span class="convidadoCard__avatarHint" aria-hidden="true">+ foto</span>
    </button>
  </div>`;
}

function pickPhotoForPerson(personId) {
  const input = $("#photoFileInput");
  if (!input) return;
  pendingPhotoPersonId = personId;
  input.value = "";
  input.click();
}

async function confirmRemovePhoto(personId) {
  const p = convidados.find((c) => c.id === personId);
  const nome = p?.nome || "este convidado";
  if (!confirm(`Remover a foto de ${nome}?`)) return;
  try {
    setStatus("Removendo foto\u2026", "busy");
    await removePhoto(personId);
    renderConvidados();
    setStatus(SHARED_SYNC_ENABLED ? "Foto removida para todos." : "Foto removida.", "");
  } catch (err) {
    setStatus(err?.message || "Erro ao remover foto.", "error");
  }
}

/** @param {string} descricao */
function parseConvidados(descricao) {
  const text = safeText(descricao);
  const m = text.match(/convidados?\s*:\s*/i);
  if (!m || m.index == null) return [];

  let block = text.split(/\(\s*Requerimento\b/i)[0] || text;
  block = block.slice(m.index + m[0].length);

  const chunks = block
    .replace(/\r\n/g, "\n")
    .split(/\n|;\s*/)
    .map((l) => l.trim())
    .filter((l) => l.length > 4);

  /** @type {typeof convidados} */
  const out = [];
  const seen = new Set();

  for (let chunk of chunks) {
    chunk = chunk.replace(/^e\s+/i, "").trim();
    if (!chunk || /^convidados?$/i.test(chunk)) continue;

    const comma = chunk.indexOf(",");
    if (comma < 3) continue;

    const nome = chunk.slice(0, comma).trim();
    let cargo = chunk.slice(comma + 1).trim();
    const confirmado = /\(confirmad[oa]\)/i.test(cargo);
    cargo = cargo
      .replace(/\(confirmad[oa]\)/gi, "")
      .replace(/;\s*$/g, "")
      .replace(/\s+e\s*$/i, "")
      .trim();

    const key = slugKey(nome);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    out.push({
      id: `conv-${key}`,
      nome,
      cargo,
      confirmado,
      meta: confirmado ? "Confirmado na descri\u00e7\u00e3o" : "Previsto na descri\u00e7\u00e3o"
    });
  }

  out.sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  return out;
}

function buildConvidados(evento) {
  return parseConvidados(evento?.descricao);
}

function initials(name) {
  const parts = safeText(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function statusLabel(s) {
  if (s === "chegou") return "Chegou";
  if (s === "nao-vem") return "N\u00e3o vem";
  return "Pendente";
}

function renderOrgaoOptions() {
  const hint = $("#orgaoHint");
  const rawQ = safeText(orgaoSearch?.value || "").trim();
  const q = normalizeFold(rawQ);
  const filtered = orgaos.filter((o) => {
    if (!q) return true;
    return normalizeFold(o.sigla).includes(q) || normalizeFold(o.nome).includes(q);
  });

  if (!orgaos.length) {
    orgaoSelect.innerHTML = `<option value="">(lista vazia)</option>`;
    if (hint) hint.textContent = "Falha ao carregar. Rode start-server.cmd.";
    return;
  }

  if (filtered.length === 0) {
    orgaoSelect.innerHTML = `<option value="">(nenhuma)</option>`;
    if (hint && rawQ) hint.textContent = `Nada para \u201c${rawQ}\u201d.`;
    return;
  }

  const opts = filtered
    .map(
      (o) =>
        `<option value="${o.id}">${escapeHtml(safeText(o.sigla))} \u2014 ${escapeHtml(safeText(o.nome))}</option>`
    )
    .join("");
  orgaoSelect.innerHTML = `<option value="">\u2014 Selecione \u2014</option>${opts}`;

  if (hint) {
    hint.textContent =
      filtered.length < orgaos.length ? `${filtered.length} de ${orgaos.length}` : `${orgaos.length} comiss\u00f5es`;
  }

  const pref = localStorage.getItem(ORGAO_PREF_KEY);
  if (pref && filtered.some((o) => String(o.id) === pref)) {
    orgaoSelect.value = pref;
  } else if (filtered.length === 1) {
    const onlyId = String(filtered[0].id);
    if (orgaoSelect.value !== onlyId) {
      orgaoSelect.value = onlyId;
      orgaoSelect.dispatchEvent(new Event("change"));
    }
  }
}

async function mergeOrgaoBySigla(sigla) {
  const s = safeText(sigla).trim();
  if (!s) return;
  if (orgaos.some((o) => normalizeFold(o.sigla) === normalizeFold(s))) return;
  try {
    const data = await apiGet(`/api/orgao?sigla=${encodeURIComponent(s)}`);
    for (const o of data?.dados || []) {
      if (!orgaos.some((x) => String(x.id) === String(o.id))) orgaos.push(o);
    }
    orgaos.sort((a, b) => String(a.sigla).localeCompare(String(b.sigla), "pt-BR"));
  } catch {
    /* ignore */
  }
}

async function loadOrgaos() {
  setStatus("Carregando comiss\u00f5es\u2026", "busy");
  const data = await apiGet("/api/orgaos");
  orgaos = Array.isArray(data?.dados) ? data.dados : [];
  await mergeOrgaoBySigla("CEXBRLEG");
  renderOrgaoOptions();
  orgaoSelect.value = "";
  if (eventHint) eventHint.textContent = "Selecione a comiss\u00e3o e depois toque na audi\u00eancia.";
  setStatus(`${orgaos.length} comiss\u00f5es.`, "");
}

function orgaoLabelById(id) {
  const o = orgaos.find((x) => String(x.id) === String(id));
  return o ? o.sigla : `#${id}`;
}

async function loadEventos(orgaoId) {
  if (!orgaoId) {
    eventList.innerHTML = `<p class="muted">Selecione uma comiss\u00e3o.</p>`;
    return;
  }
  setStatus("Buscando audi\u00eancias\u2026", "busy");
  const data = await apiGet(`/api/eventos?idOrgao=${encodeURIComponent(orgaoId)}&itens=100`);
  const filter = tipoFilter?.value || "audiencia";
  const all = data?.dados || [];
  const events = all.filter((ev) => matchesTipoFilter(ev, filter));

  if (!events.length) {
    eventList.innerHTML = `<p class="muted">Nenhuma audi\u00eancia encontrada.</p>`;
    if (eventHint) eventHint.textContent = "Tente \u00abTodos\u00bb no filtro de tipo.";
    setStatus("", "");
    return;
  }

  if (eventHint) eventHint.textContent = `${events.length} evento(s) \u00b7 toque para abrir convidados`;

  eventList.innerHTML = events
    .map((ev) => {
      const tipoCls = eventTipoClass(ev.descricaoTipo);
      const titulo =
        safeText(ev.descricao)
          .split(/\r?\n/)[0]
          .trim() || ev.descricaoTipo || `Evento ${ev.id}`;
      return `
        <article class="eventCard" tabindex="0" data-event-id="${ev.id}" role="button">
          <div class="eventCard__top">
            <span class="pill pill--${tipoCls || "muted"}">${escapeHtml(safeText(ev.descricaoTipo))}</span>
            <span class="pill pill--muted">${escapeHtml(safeText(ev.situacao))}</span>
          </div>
          <h4 class="eventCard__title">${escapeHtml(titulo)}</h4>
          <p class="eventCard__when">${escapeHtml(formatDateTime(ev.dataHoraInicio))}</p>
        </article>`;
    })
    .join("");

  eventList.querySelectorAll(".eventCard").forEach((el) => {
    const open = () => {
      const id = el.getAttribute("data-event-id");
      if (id) location.hash = `#/audiencia/${id}`;
    };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  });

  setStatus("", "");
}

function escapeHtml(s) {
  return safeText(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderStatusSummary(counts) {
  const el = $("#statusSummary");
  if (!el) return;
  el.innerHTML = `
    <span class="chip chip--pendente">${counts.pendente} pendente</span>
    <span class="chip chip--chegou">${counts.chegou} chegou</span>
    <span class="chip chip--nao-vem">${counts.naoVem} n\u00e3o vem</span>`;
}

function renderConvidados() {
  const grid = $("#carometroGrid");
  const q = normalizeFold($("#participanteSearch")?.value || "");
  const statuses = loadStatuses(currentEventId);

  const filtered = convidados.filter((p) => {
    if (!q) return true;
    return normalizeFold(p.nome).includes(q) || normalizeFold(p.cargo).includes(q);
  });

  const counts = { pendente: 0, chegou: 0, naoVem: 0 };
  for (const p of filtered) {
    const s = statuses[p.id] || "pendente";
    if (s === "chegou") counts.chegou += 1;
    else if (s === "nao-vem") counts.naoVem += 1;
    else counts.pendente += 1;
  }
  renderStatusSummary(counts);

  $("#carometroStats").textContent =
    filtered.length === 0
      ? "Nenhum convidado na descri\u00e7\u00e3o do evento."
      : `${filtered.length} convidado(s) na lista`;

  if (!filtered.length) {
    grid.innerHTML = `<p class="muted">Sem bloco \u00abConvidados:\u00bb na descri\u00e7\u00e3o deste evento.</p>`;
    return;
  }

  grid.innerHTML = filtered
    .map((p) => {
      const st = statuses[p.id] || "pendente";
      return `
        <article class="convidadoCard convidadoCard--${st}" data-person-id="${escapeHtml(p.id)}">
          <div class="convidadoCard__head">
            ${renderAvatarButton(p)}
            <div class="convidadoCard__info">
              <div class="convidadoCard__name">${escapeHtml(p.nome)}</div>
              <div class="convidadoCard__cargo">${escapeHtml(p.cargo || "")}</div>
              <span class="convidadoCard__badge">${escapeHtml(statusLabel(st))}</span>
            </div>
          </div>
          <div class="convidadoCard__actions" role="group" aria-label="Situa\u00e7\u00e3o de ${escapeHtml(p.nome)}">
            <button type="button" class="statusBtn ${st === "pendente" ? "is-active" : ""}" data-status="pendente">Pendente</button>
            <button type="button" class="statusBtn statusBtn--chegou ${st === "chegou" ? "is-active" : ""}" data-status="chegou">Chegou</button>
            <button type="button" class="statusBtn statusBtn--nao-vem ${st === "nao-vem" ? "is-active" : ""}" data-status="nao-vem">N\u00e3o vem</button>
          </div>
        </article>`;
    })
    .join("");

  grid.querySelectorAll(".convidadoCard").forEach((card) => {
    const id = card.getAttribute("data-person-id");
    card.querySelectorAll("[data-photo-for]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const pid = btn.getAttribute("data-photo-for");
        if (pid) pickPhotoForPerson(pid);
      });
    });
    card.querySelectorAll("[data-photo-remove]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const pid = btn.getAttribute("data-photo-remove");
        if (pid) void confirmRemovePhoto(pid);
      });
    });
    card.querySelectorAll(".statusBtn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const next = btn.getAttribute("data-status");
        saveStatus(currentEventId, id, next);
        renderConvidados();
      });
    });
  });
}

async function loadEventoPage(eventId) {
  currentEventId = eventId;
  viewHome.hidden = true;
  viewEvento.hidden = false;
  btnReload.hidden = false;

  setStatus("Carregando\u2026", "busy");

  const data = await apiGet(`/api/evento?id=${encodeURIComponent(eventId)}`);
  const ev = data.evento;
  if (!ev) throw new Error("Evento n\u00e3o encontrado");

  const tipoCls = eventTipoClass(ev.descricaoTipo);
  const tipoEl = $("#eventTipo");
  tipoEl.textContent = ev.descricaoTipo || "Evento";
  tipoEl.className = `pill pill--${tipoCls || "muted"}`;

  $("#eventSituacao").textContent = ev.situacao || "\u2014";
  const titulo =
    safeText(ev.descricao)
      .split(/\r?\n/)[0]
      .trim() || `Evento ${eventId}`;
  $("#eventTitulo").textContent = titulo;
  $("#eventQuando").textContent = formatDateTime(ev.dataHoraInicio);
  const local = [ev.localExterno, ev.localCamara?.nome, ev.localCamara?.sala].filter(Boolean).join(" \u00b7 ");
  $("#eventLocal").textContent = local || "Local n\u00e3o informado";
  $("#eventDescricao").textContent = safeText(ev.descricao);

  $("#eventLinkCamara").href = `https://www.camara.leg.br/evento-legislativo/${eventId}`;

  convidados = buildConvidados(ev);
  resetSharedEventState();
  stopEventSync();

  const personIds = convidados.map((c) => c.id);
  try {
    await preloadPhotos(eventId, personIds);
  } catch {
    /* backup local opcional */
  }

  if (SHARED_SYNC_ENABLED) {
    try {
      const remote = await fetchSharedEventState(eventId);
      if (remote) {
        applyRemoteEventState(remote, { force: true });
        await syncPhotosToIdb(eventId, sharedPhotos);
      }
    } catch {
      setStatus("Servidor indispon\u00edvel; fotos deste aparelho mantidas.", "error");
    }
    startEventSync();
  }

  renderConvidados();

  document.title = `${titulo.slice(0, 50)} \u2014 Convidados`;
  const syncHint = SHARED_SYNC_ENABLED ? " \u00b7 colaborativo" : "";
  setStatus(`${convidados.length} convidado(s)${syncHint}.`, "");
}

function showHome() {
  stopEventSync();
  resetSharedEventState();
  currentEventId = null;
  viewHome.hidden = false;
  viewEvento.hidden = true;
  btnReload.hidden = true;
  document.title = "Audi\u00eancias CT \u2014 Convidados";
  setStatus(orgaos.length ? `${orgaos.length} comiss\u00f5es.` : "", "");
}

async function route() {
  const hash = location.hash || "#/";
  const m = hash.match(/^#\/audiencia\/(\d+)/);
  if (m) {
    try {
      await loadEventoPage(m[1]);
    } catch (err) {
      setStatus(`Erro: ${err.message}`, "error");
      showHome();
    }
    return;
  }
  showHome();
  if (orgaoSelect?.value) await loadEventos(orgaoSelect.value);
}

let orgaoSearchTimer = null;
orgaoSearch?.addEventListener("input", () => {
  renderOrgaoOptions();
  const raw = safeText(orgaoSearch?.value || "").trim();
  if (raw.length < 3) return;
  clearTimeout(orgaoSearchTimer);
  orgaoSearchTimer = setTimeout(() => {
    void mergeOrgaoBySigla(raw.toUpperCase()).then(renderOrgaoOptions);
  }, 400);
});

orgaoSelect?.addEventListener("change", async () => {
  const id = orgaoSelect.value;
  if (id) localStorage.setItem(ORGAO_PREF_KEY, id);
  await loadEventos(id);
});

tipoFilter?.addEventListener("change", async () => {
  if (orgaoSelect?.value) await loadEventos(orgaoSelect.value);
});

$("#participanteSearch")?.addEventListener("input", renderConvidados);

$("#photoFileInput")?.addEventListener("change", async () => {
  const input = $("#photoFileInput");
  const file = input?.files?.[0];
  const personId = pendingPhotoPersonId;
  pendingPhotoPersonId = null;
  if (!file || !personId) return;

  if (!file.type.startsWith("image/")) {
    setStatus("Escolha um arquivo de imagem.", "error");
    return;
  }

  try {
    setStatus("Salvando foto\u2026", "busy");
    const dataUrl = await resizeImageFile(file);
    await savePhoto(personId, dataUrl);
    renderConvidados();
    setStatus(
      SHARED_SYNC_ENABLED ? "Foto salva (equipe + este aparelho)." : "Foto salva neste aparelho.",
      ""
    );
  } catch (err) {
    setStatus(err?.message || "Erro ao salvar foto.", "error");
  } finally {
    if (input) input.value = "";
  }
});

btnReload?.addEventListener("click", async () => {
  if (currentEventId) await loadEventoPage(currentEventId);
});

window.addEventListener("hashchange", () => {
  void route();
});

(async function init() {
  try {
    if (location.protocol === "file:") {
      setStatus("Use start-server.cmd no PC.", "error");
    }
    await loadOrgaos();
    await route();
    if (orgaoSelect?.value) await loadEventos(orgaoSelect.value);
  } catch (err) {
    setStatus(`Falha: ${err.message}`, "error");
    orgaoSelect.innerHTML = `<option value="">Erro</option>`;
  }
})();
