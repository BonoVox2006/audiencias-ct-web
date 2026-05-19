const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function response(statusCode, bodyObj) {
  return { statusCode, headers: jsonHeaders, body: JSON.stringify(bodyObj) };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: jsonHeaders, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return response(405, { error: "Método não suportado" });
  }

  const qs = event.queryStringParameters || {};
  const idOrgao = qs.idOrgao || qs.idorgao;
  if (!idOrgao) {
    return response(400, { error: "Parâmetro idOrgao é obrigatório" });
  }

  try {
    const itens = Math.min(Math.max(parseInt(qs.itens || "40", 10) || 40, 1), 100);
    const params = new URLSearchParams({
      idOrgao: String(idOrgao),
      itens: String(itens),
      ordem: "DESC",
      ordenarPor: "dataHoraInicio"
    });
    if (qs.dataInicio) params.set("dataInicio", qs.dataInicio);
    if (qs.dataFim) params.set("dataFim", qs.dataFim);

    const url = `https://dadosabertos.camara.leg.br/api/v2/eventos?${params}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      return response(500, { error: "Falha ao buscar eventos", detail: await res.text() });
    }
    const data = await res.json();
    return response(200, {
      dados: Array.isArray(data?.dados) ? data.dados : [],
      fetchedAt: new Date().toISOString(),
      source: url
    });
  } catch (err) {
    return response(500, { error: "Falha ao listar eventos", detail: String(err?.message || err) });
  }
};
