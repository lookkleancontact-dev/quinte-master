exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Méthode non autorisée" }) };
  }

  try {
    const { id, resultat_officiel, score, notes } = JSON.parse(event.body || "{}");
    if (!id) {
      return { statusCode: 400, body: JSON.stringify({ error: "id manquant" }) };
    }

    const res = await fetch(process.env.SUPABASE_URL + "/rest/v1/pronostics?id=eq." + id, {
      method: "PATCH",
      headers: {
        "apikey": process.env.SUPABASE_SERVICE_KEY,
        "Authorization": "Bearer " + process.env.SUPABASE_SERVICE_KEY,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify({ resultat_officiel, score, notes })
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
