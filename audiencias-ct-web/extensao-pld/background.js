const HOSTS = {
  prod: "https://infoleg-pld.camara.leg.br",
  hom: "https://infoleg-pld-hom.camara.leg.br"
};

function hostDo(ambiente) {
  return HOSTS[ambiente] === HOSTS.hom ? HOSTS.hom : HOSTS.prod;
}

async function abasPld(ambiente) {
  const host = hostDo(ambiente);
  const tabs = await chrome.tabs.query({ url: `${host}/*` });
  return tabs.filter((t) => (t.url || "").includes("/pld-v3/"));
}

async function atualizarPresenca(msg) {
  const ambiente = msg.ambiente === "hom" ? "hom" : "prod";
  const codReuniao = String(msg.codReuniao || "").replace(/\D/g, "");
  const nome = String(msg.nome || "").trim();
  const presenca = Number(msg.presenca);
  if (!codReuniao || !nome || !Number.isFinite(presenca)) {
    return { ok: false, error: "Código da reunião ou nome do convidado ausente." };
  }

  const abas = await abasPld(ambiente);
  if (!abas.length) {
    await chrome.tabs.create({
      url: `${hostDo(ambiente)}/pld-v3/gestao-de-reunioes`,
      active: true
    });
    return {
      ok: false,
      error: "Abri o PLD v3. Entre na sua conta, se pedir, e clique em Chegou de novo."
    };
  }

  let ultimo = "PLD sem sessão. Deixe aberta a aba do PLD v3, já logada, e clique em Chegou de novo.";
  for (const aba of abas) {
    let injected;
    try {
      injected = await chrome.scripting.executeScript({
        target: { tabId: aba.id },
        world: "MAIN",
        func: gravarPresencaNaPagina,
        args: [{ codReuniao, nome, presenca }]
      });
    } catch (err) {
      ultimo = "Não consegui usar a aba do PLD v3. Deixe a Gestão de Reuniões aberta e logada.";
      continue;
    }
    const result = injected && injected[0] ? injected[0].result : null;
    if (result?.ok) return result;
    if (result?.error) ultimo = result.error;
    if (result && !/sem sessão/i.test(result.error || "")) return result;
  }
  return { ok: false, error: ultimo };
}

async function gravarPresencaNaPagina({ codReuniao, nome, presenca }) {
  function norm(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function extrairToken(raw) {
    if (!raw) return null;
    const textos = [raw, raw.replace(/\\"/g, '"')];
    for (const texto of textos) {
      const m =
        texto.match(/"access_token"\s*:\s*"(eyJ[^"]+)"/) ||
        texto.match(/"accessToken"\s*:\s*"(eyJ[^"]+)"/);
      if (m) return m[1];
    }
    return null;
  }

  function tokenDe(store) {
    for (let i = 0; i < store.length; i++) {
      const achado = extrairToken(store.getItem(store.key(i)));
      if (achado) return achado;
    }
    return null;
  }

  async function tokenDaSessao() {
    const ctx = window["__oidc-spa.createOidc.globalContext"];
    const mapa = ctx && ctx.prOidcByConfigId;
    if (mapa && typeof mapa.values === "function") {
      for (const entrada of mapa.values()) {
        try {
          const oidc = await entrada;
          if (!oidc) continue;
          const tokens =
            typeof oidc.getTokens_next === "function"
              ? await oidc.getTokens_next()
              : typeof oidc.getTokens === "function"
                ? oidc.getTokens()
                : null;
          const access = tokens && (tokens.accessToken || tokens.access_token);
          if (typeof access === "string" && access.startsWith("eyJ")) return access;
        } catch {
          /* tenta a próxima instância */
        }
      }
    }
    const app = document.querySelector("#app")?.__vue_app__;
    const pinia = app?.config?.globalProperties?.$pinia;
    const global = pinia?._s?.get?.("global");
    if (typeof global?.token === "string" && global.token.startsWith("eyJ")) return global.token;
    return tokenDe(sessionStorage) || tokenDe(localStorage);
  }

  const token = await tokenDaSessao();
  if (!token) {
    return {
      ok: false,
      error: "A aba do PLD v3 está aberta, mas a sessão não foi lida. Recarregue a Gestão de Reuniões (F5) e clique em Chegou de novo."
    };
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json"
  };

  const listaRes = await fetch(
    `${location.origin}/servico-sileg/item-pauta/reuniao/${encodeURIComponent(codReuniao)}/participantes`,
    { headers }
  );
  if (!listaRes.ok) {
    return { ok: false, error: `O PLD recusou a lista de participantes (${listaRes.status}).` };
  }
  const listaJson = await listaRes.json();
  const lista = Array.isArray(listaJson)
    ? listaJson
    : listaJson?.data || listaJson?.dados || listaJson?.content || [];

  const alvo = norm(nome);
  function nomesDe(p) {
    return [p.nome, p.nomeParticipante, p.nomeDivulgacao].map(norm).filter(Boolean);
  }
  let hits = lista.filter((p) => nomesDe(p).some((n) => n === alvo));
  if (!hits.length) {
    hits = lista.filter((p) =>
      nomesDe(p).some((n) => n.length > 8 && alvo.length > 8 && (n.includes(alvo) || alvo.includes(n)))
    );
  }
  if (hits.length !== 1) {
    return {
      ok: false,
      error:
        hits.length === 0
          ? `Não achei “${nome}” nos participantes da reunião ${codReuniao}. O nome no PLD precisa ser o mesmo.`
          : `Achei ${hits.length} participantes parecidos com “${nome}” na reunião ${codReuniao}.`
    };
  }

  const id = hits[0].id;
  const detRes = await fetch(`${location.origin}/servico-sileg/item-pauta/participante/${id}`, { headers });
  if (!detRes.ok) {
    return { ok: false, error: `O PLD recusou o participante (${detRes.status}).` };
  }
  const det = await detRes.json();
  const put = await fetch(`${location.origin}/servico-sileg/item-pauta/participante/${id}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ ...det, id, presenca })
  });
  if (!put.ok) {
    const texto = await put.text();
    return { ok: false, error: `O PLD não gravou a presença (${put.status}). ${texto.slice(0, 180)}` };
  }
  return { ok: true, nome: det.nome || det.nomeParticipante || nome };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "pld-presenca") return;
  atualizarPresenca(msg).then(sendResponse);
  return true;
});
