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

  const sigla = (event.queryStringParameters || {}).sigla;
  if (!sigla) {
    return response(400, { error: "Parâmetro sigla é obrigatório" });
  }

  try {
    const url = `https://dadosabertos.camara.leg.br/api/v2/orgaos?sigla=${encodeURIComponent(sigla)}&itens=5`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      return response(500, { error: "Falha ao buscar órgão", detail: await res.text() });
    }
    const data = await res.json();
    const arr = Array.isArray(data?.dados) ? data.dados : [];
    const o = arr[0];
    if (!o) {
      return response(200, { dados: [] });
    }
    return response(200, {
      dados: [
        {
          id: o.id,
          sigla: o.sigla,
          nome: o.apelido || o.nomeResumido || o.nome || o.sigla,
          tipoOrgao: o.tipoOrgao || "",
          codTipoOrgao: o.codTipoOrgao
        }
      ]
    });
  } catch (err) {
    return response(500, { error: "Falha ao buscar órgão", detail: String(err?.message || err) });
  }
};
