const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const PHOTO_MAX_CHARS = 1800000;

function response(statusCode, bodyObj) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(bodyObj)
  };
}

function getEnvOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

async function supabaseRequest(path, options = {}) {
  const supabaseUrl = getEnvOrThrow("SUPABASE_URL").replace(/\/$/, "");
  const serviceRoleKey = getEnvOrThrow("SUPABASE_SERVICE_ROLE_KEY");
  const url = `${supabaseUrl}/rest/v1/${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  return res;
}

function emptyState(eventId, photosOmitted) {
  const dados = {
    eventId,
    statuses: {},
    version: 0,
    updatedAt: null
  };
  if (photosOmitted) dados.photosOmitted = true;
  else dados.photos = {};
  return dados;
}

function readJsonBody(event) {
  if (!event.body) return null;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return JSON.parse(raw);
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function rowToDados(row, eventId, photosOmitted) {
  const dados = {
    eventId: row?.event_id || eventId,
    statuses: row?.statuses || {},
    version: Number(row?.version || 0),
    updatedAt: row?.updated_at || null
  };
  if (photosOmitted) dados.photosOmitted = true;
  else dados.photos = row?.photos || {};
  return dados;
}

async function loadRow(eventId, fields) {
  const query =
    `audiencia_event_state?event_id=eq.${encodeURIComponent(eventId)}` +
    `&select=${fields}&limit=1`;
  const res = await supabaseRequest(query, { method: "GET" });
  if (!res.ok) {
    const detail = await res.text();
    const error = new Error("Falha ao ler estado");
    error.detail = detail;
    error.statusCode = 500;
    throw error;
  }
  const rows = await res.json();
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: jsonHeaders, body: "" };
  }

  try {
    if (event.httpMethod === "GET") {
      const eventId = String(event.queryStringParameters?.eventId || "").trim();
      if (!eventId) return response(400, { error: "eventId obrigatório" });
      const photosOmitted = event.queryStringParameters?.part === "meta";
      const fields = photosOmitted
        ? "event_id,statuses,version,updated_at"
        : "event_id,statuses,photos,version,updated_at";

      const row = await loadRow(eventId, fields);
      if (!row) return response(200, { dados: emptyState(eventId, photosOmitted) });
      return response(200, { dados: rowToDados(row, eventId, photosOmitted) });
    }

    if (event.httpMethod === "POST") {
      const payload = readJsonBody(event);
      if (!payload) return response(400, { error: "Body JSON obrigatório" });

      const eventId = String(payload.eventId || "").trim();
      const statuses = asObject(payload.statuses);
      const keepPhotos = payload.keepPhotos === true;
      const photoPatch = asObject(payload.photoPatch);
      const photosProvided = asObject(payload.photos);
      if (!eventId) return response(400, { error: "eventId obrigatório" });
      if (!statuses) return response(400, { error: "statuses obrigatório" });
      if (!keepPhotos && !photoPatch && !photosProvided) {
        return response(400, { error: "photos obrigatório" });
      }

      if (photoPatch) {
        for (const url of Object.values(photoPatch)) {
          if (typeof url === "string" && url.length > PHOTO_MAX_CHARS) {
            return response(413, { error: "Foto grande demais. Escolha outra imagem." });
          }
        }
      }

      const updatedAt = new Date().toISOString();
      const omitPhotos = keepPhotos || Boolean(photoPatch);

      if (keepPhotos && !photoPatch) {
        const current = await loadRow(eventId, "version");
        const nextVersion = (current ? Number(current.version || 0) : 0) + 1;
        if (current) {
          const patchRes = await supabaseRequest(
            `audiencia_event_state?event_id=eq.${encodeURIComponent(eventId)}`,
            {
              method: "PATCH",
              headers: { Prefer: "return=minimal" },
              body: JSON.stringify({
                statuses,
                version: nextVersion,
                updated_at: updatedAt
              })
            }
          );
          if (!patchRes.ok) {
            const detail = await patchRes.text();
            return response(500, { error: "Falha ao gravar estado", detail });
          }
          return response(200, {
            ok: true,
            dados: {
              eventId,
              statuses,
              photosOmitted: true,
              version: nextVersion,
              updatedAt
            }
          });
        }
      }

      const current = await loadRow(eventId, photoPatch ? "version,photos" : "version");
      const nextVersion = (current ? Number(current.version || 0) : 0) + 1;
      let photos = photosProvided || {};
      if (photoPatch || keepPhotos) {
        photos = asObject(current?.photos) || {};
        if (photoPatch) {
          for (const [personId, url] of Object.entries(photoPatch)) {
            if (typeof url !== "string" || !url) delete photos[personId];
            else photos[personId] = url;
          }
        }
      }

      const upsertRes = await supabaseRequest("audiencia_event_state?on_conflict=event_id", {
        method: "POST",
        headers: {
          Prefer: "resolution=merge-duplicates,return=minimal"
        },
        body: JSON.stringify([
          {
            event_id: eventId,
            statuses,
            photos,
            version: nextVersion,
            updated_at: updatedAt
          }
        ])
      });
      if (!upsertRes.ok) {
        const detail = await upsertRes.text();
        return response(500, { error: "Falha ao gravar estado", detail });
      }

      return response(200, {
        ok: true,
        dados: {
          eventId,
          statuses,
          ...(omitPhotos ? { photosOmitted: true } : { photos }),
          version: nextVersion,
          updatedAt
        }
      });
    }

    return response(405, { error: "Método não suportado" });
  } catch (err) {
    return response(err.statusCode || 500, {
      error: "Falha no estado compartilhado",
      detail: String(err?.detail || err?.message || err)
    });
  }
};
