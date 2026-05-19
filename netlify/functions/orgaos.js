const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function response(statusCode, bodyObj) {
  return { statusCode, headers: jsonHeaders, body: JSON.stringify(bodyObj) };
}

/** Comissão Especial, CPI, Externa, Sindicância, GT — Dados Abertos (tiposOrgao). */
const COD_TIPOS_TEMPORARIA = [3, 4, 5, 7, 10];

function normalizeFold(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function classifyCommissionType(orgao) {
  const cod = Number(orgao?.codTipoOrgao);
  if (COD_TIPOS_TEMPORARIA.includes(cod)) return "temporaria";

  const text = normalizeFold(
    `${orgao?.tipoOrgao || ""} ${orgao?.descricaoTipo || ""} ${orgao?.nome || ""} ${orgao?.apelido || ""} ${orgao?.sigla || ""} ${orgao?.nomePublicacao || ""}`
  );
  const sigla = normalizeFold(orgao?.sigla || "");
  if (text.includes("subcomissao") || sigla.startsWith("sub")) return null;
  if (text.includes("comissao mista")) return null;
  if (text.includes("medida provisoria") || sigla.startsWith("mpv") || cod === 9) return null;
  if (text.includes("comissao permanente")) return "permanente";
  if (text.includes("comissao especial")) return "temporaria";
  if (text.includes("comissao externa")) return "temporaria";
  if (text.includes("cpi") || text.includes("comissao parlamentar de inquerito")) return "temporaria";
  if (text.includes("grupo de trabalho") || sigla.startsWith("gt")) return "temporaria";
  if (text.includes("sindicancia")) return "temporaria";
  return null;
}

function isCommissionActive(orgao) {
  const statusText = normalizeFold(
    `${orgao?.situacao || ""} ${orgao?.status || ""} ${orgao?.nome || ""} ${orgao?.apelido || ""}`
  );
  if (
    statusText.includes("arquivad") ||
    statusText.includes("encerrad") ||
    statusText.includes("extinta") ||
    statusText.includes("finalizad")
  ) {
    return false;
  }
  const fim = orgao?.dataFim || orgao?.dataFimRel || null;
  if (!fim) return true;
  const d = new Date(fim);
  if (Number.isNaN(d.getTime())) return true;
  return d >= new Date();
}

function mapOrgao(o) {
  return {
    id: o.id,
    sigla: o.sigla,
    nome: o.apelido || o.nomeResumido || o.nome || o.sigla,
    tipoOrgao: o.tipoOrgao || o.descricaoTipo || "",
    codTipoOrgao: o.codTipoOrgao
  };
}

async function fetchOrgaosPorCodigo(cod) {
  const base = "https://dadosabertos.camara.leg.br/api/v2/orgaos";
  const all = [];
  let page = 1;
  while (page <= 40) {
    const url = `${base}?codTipoOrgao=${cod}&itens=100&pagina=${page}&ordem=ASC&ordenarPor=sigla`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) break;
    const data = await res.json();
    const arr = Array.isArray(data?.dados) ? data.dados : [];
    if (!arr.length) break;
    all.push(...arr);
    if (arr.length < 100) break;
    page += 1;
  }
  return all;
}

async function fetchOrgaoPorSigla(sigla) {
  const url = `https://dadosabertos.camara.leg.br/api/v2/orgaos?sigla=${encodeURIComponent(sigla)}&itens=5`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) return null;
  const data = await res.json();
  const arr = Array.isArray(data?.dados) ? data.dados : [];
  return arr[0] || null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: jsonHeaders, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return response(405, { error: "Método não suportado" });
  }

  try {
    const qs = event.queryStringParameters || {};
    const byId = new Map();

    for (const cod of COD_TIPOS_TEMPORARIA) {
      const rows = await fetchOrgaosPorCodigo(cod);
      for (const o of rows) {
        if (!isCommissionActive(o)) continue;
        if (classifyCommissionType(o) !== "temporaria") continue;
        byId.set(String(o.id), mapOrgao(o));
      }
    }

    for (const siglaFix of ["CEXBRLEG"]) {
      const fixed = await fetchOrgaoPorSigla(siglaFix);
      if (fixed && isCommissionActive(fixed) && classifyCommissionType(fixed) === "temporaria") {
        byId.set(String(fixed.id), mapOrgao(fixed));
      }
    }

    const siglaExtra = (qs.sigla || qs.q || "").trim().toUpperCase();
    if (siglaExtra) {
      const o = await fetchOrgaoPorSigla(siglaExtra);
      if (o && isCommissionActive(o) && classifyCommissionType(o) === "temporaria") {
        byId.set(String(o.id), mapOrgao(o));
      }
    }

    const out = Array.from(byId.values()).sort((a, b) =>
      String(a.sigla).localeCompare(String(b.sigla), "pt-BR")
    );

    return response(200, { dados: out, fetchedAt: new Date().toISOString() });
  } catch (err) {
    return response(500, { error: "Falha ao listar órgãos", detail: String(err?.message || err) });
  }
};
