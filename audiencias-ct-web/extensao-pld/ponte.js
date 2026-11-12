const PLD_REUNIAO_KEY = "audiencias_ct_pld_reuniao_v1";

function anunciarPonte() {
  window.postMessage(
    { source: "audiencias-ct-ext", type: "audiencias-ct-pld-ponte", pronta: true },
    window.location.origin
  );
}

anunciarPonte();
setInterval(anunciarPonte, 2000);

function eventIdAtual() {
  const m = (location.hash || "").match(/audiencia\/(\d+)/);
  return m ? m[1] : "";
}

function lerConfig() {
  try {
    const all = JSON.parse(localStorage.getItem(PLD_REUNIAO_KEY) || "{}");
    const eventId = eventIdAtual();
    const row = (eventId && all[eventId]) || all.global || {};
    return {
      codReuniao: String(row.codReuniao || "").replace(/\D/g, ""),
      ambiente: row.ambiente === "hom" ? "hom" : "prod"
    };
  } catch {
    return { codReuniao: "", ambiente: "prod" };
  }
}

function gravarConfig(config) {
  const all = JSON.parse(localStorage.getItem(PLD_REUNIAO_KEY) || "{}");
  const row = {
    codReuniao: String(config.codReuniao || "").replace(/\D/g, ""),
    ambiente: config.ambiente === "hom" ? "hom" : "prod"
  };
  const eventId = eventIdAtual();
  if (eventId) all[eventId] = row;
  all.global = row;
  localStorage.setItem(PLD_REUNIAO_KEY, JSON.stringify(all));
}

function configDaTela() {
  const campo = document.querySelector("#pldCodReuniao");
  const ambienteEl = document.querySelector("#pldAmbiente");
  if (!campo) return null;
  return {
    codReuniao: String(campo.value || "").replace(/\D/g, ""),
    ambiente: ambienteEl && ambienteEl.value === "hom" ? "hom" : "prod"
  };
}

function mostrarAviso(texto, erro) {
  let barra = document.getElementById("pld-ponte-aviso");
  if (!barra) {
    barra = document.createElement("div");
    barra.id = "pld-ponte-aviso";
    barra.setAttribute("role", "status");
    barra.style.cssText = [
      "position:fixed",
      "left:12px",
      "right:12px",
      "bottom:12px",
      "z-index:99999",
      "padding:12px 14px",
      "border-radius:10px",
      "font:600 14px/1.35 Segoe UI,sans-serif",
      "box-shadow:0 8px 24px rgba(0,0,0,.35)"
    ].join(";");
    document.documentElement.appendChild(barra);
  }
  barra.style.background = erro ? "#5c1d1d" : "#0f3d32";
  barra.style.color = "#fff";
  barra.textContent = texto;
}

function pedirPresenca(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "pld-presenca", ...payload }, (resp) => {
      const falha = chrome.runtime.lastError;
      if (falha) {
        resolve({ ok: false, error: falha.message });
        return;
      }
      resolve(resp || { ok: false, error: "A extensão não respondeu." });
    });
  });
}

async function aoChegou(nome) {
  const daTela = configDaTela();
  let config = daTela && daTela.codReuniao ? daTela : lerConfig();
  if (!config.codReuniao) {
    const digitado = window.prompt(
      "Código da reunião no PLD de produção (o número longo, ex.: 2100026540):",
      ""
    );
    config = {
      codReuniao: String(digitado || "").replace(/\D/g, ""),
      ambiente: "prod"
    };
    if (!config.codReuniao) {
      mostrarAviso("Presença no PLD não gravada: falta o código da reunião.", true);
      return;
    }
    gravarConfig(config);
  }

  mostrarAviso(`Gravando ${nome} no PLD…`, false);
  const resp = await pedirPresenca({
    codReuniao: config.codReuniao,
    nome,
    ambiente: config.ambiente,
    presenca: 4
  });
  if (resp.ok) {
    mostrarAviso(`PLD: ${resp.nome || nome} marcado como Participou presencialmente.`, false);
    return;
  }
  mostrarAviso(resp.error || "Não foi possível gravar a presença no PLD.", true);
}

document.addEventListener(
  "click",
  (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest(".statusBtn") : null;
    if (!btn || btn.getAttribute("data-status") !== "chegou") return;
    const card = btn.closest(".convidadoCard");
    const nome = card?.querySelector(".convidadoCard__name")?.textContent?.trim() || "";
    if (!nome) {
      mostrarAviso("Não identifiquei o nome do convidado neste cartão.", true);
      return;
    }
    void aoChegou(nome);
  },
  true
);

window.addEventListener("message", (ev) => {
  if (ev.source !== window) return;
  const data = ev.data;
  if (!data || data.source !== "audiencias-ct-page" || data.type !== "audiencias-ct-pld-presenca") return;

  chrome.runtime.sendMessage(
    {
      type: "pld-presenca",
      requestId: data.requestId,
      codReuniao: data.codReuniao,
      nome: data.nome,
      presenca: data.presenca,
      ambiente: data.ambiente
    },
    (resp) => {
      const falha = chrome.runtime.lastError;
      window.postMessage(
        {
          source: "audiencias-ct-ext",
          type: "audiencias-ct-pld-result",
          requestId: data.requestId,
          ok: !falha && !!resp?.ok,
          error: falha ? falha.message : resp?.error || "",
          nome: resp?.nome || data.nome
        },
        window.location.origin
      );
    }
  );
});
