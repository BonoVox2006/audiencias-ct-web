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

  const id = (event.queryStringParameters || {}).id;
  if (!id) {
    return response(400, { error: "Parâmetro id é obrigatório" });
  }

  try {
    const base = `https://dadosabertos.camara.leg.br/api/v2/eventos/${encodeURIComponent(id)}`;
    const headers = { Accept: "application/json" };

    const [evRes, pautaRes] = await Promise.all([
      fetch(base, { headers }),
      fetch(`${base}/pauta?itens=50`, { headers })
    ]);

    if (!evRes.ok) {
      return response(evRes.status === 404 ? 404 : 500, {
        error: "Evento não encontrado",
        detail: await evRes.text()
      });
    }

    const evento = await evRes.json();
    const pautaJson = pautaRes.ok ? await pautaRes.json() : { dados: [] };

    let membros = [];
    const orgaoId =
      Array.isArray(evento?.orgaos) && evento.orgaos[0]?.id ? String(evento.orgaos[0].id) : null;

    if (orgaoId) {
      const mRes = await fetch(
        `https://dadosabertos.camara.leg.br/api/v2/orgaos/${encodeURIComponent(orgaoId)}/membros?itens=100`,
        { headers }
      );
      if (mRes.ok) {
        const mJson = await mRes.json();
        membros = Array.isArray(mJson?.dados) ? mJson.dados : [];
      }
    }

    return response(200, {
      evento: evento.dados || evento,
      pauta: Array.isArray(pautaJson?.dados) ? pautaJson.dados : [],
      membros,
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    return response(500, { error: "Falha ao carregar evento", detail: String(err?.message || err) });
  }
};
