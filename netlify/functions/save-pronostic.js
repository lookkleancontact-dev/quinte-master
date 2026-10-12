// Les écritures (POST/PATCH) passent ici, avec la clé service_role
// Supabase gardée côté serveur. Le navigateur ne peut donc jamais écrire
// directement dans la base, seulement lire via la clé anon (lecture seule,
// voir supabase_rls_setup.sql).

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Méthode non autorisée" }) };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const res = await fetch(process.env.SUPABASE_URL + "/rest/v1/pronostics", {
      method: "POST",
      headers: {
        "apikey": process.env.SUPABASE_SERVICE_KEY,
        "Authorization": "Bearer " + process.env.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify(body)
    });

    const text = await res.text();
    if (!res.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: "Supabase : " + text }) };
    }

    return { statusCode: 200, body: text };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
