const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

function response(statusCode, bodyObj) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(bodyObj)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: jsonHeaders, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return response(405, { error: "Método não suportado" });
  }

  try {
    const base = "https://dadosabertos.camara.leg.br/api/v2/deputados";
    const perPage = 100;
    let page = 1;
    const all = [];

    while (page <= 60) {
      const url = `${base}?itens=${perPage}&pagina=${page}&ordem=ASC&ordenarPor=nome`;
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (!res.ok) {
        return response(500, { error: "Falha ao buscar Dados Abertos", detail: await res.text() });
      }
      const data = await res.json();
      const arr = Array.isArray(data?.dados) ? data.dados : [];
      if (!arr.length) break;

      for (const d of arr) {
        all.push({
          id: d.id,
          nome: d.nome,
          siglaPartido: d.siglaPartido,
          siglaUf: d.siglaUf,
          urlFoto: d.urlFoto,
          email: d.email
        });
      }
      if (arr.length < perPage) break;
      page += 1;
    }

    return response(200, {
      dados: all,
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    return response(500, { error: "Falha ao buscar deputados", detail: String(err?.message || err) });
  }
};
