// Cette fonction tourne côté serveur Netlify : la clé API Anthropic
// n'est JAMAIS envoyée au navigateur, elle reste dans les variables
// d'environnement Netlify (ANTHROPIC_API_KEY).

const SEARCH_PROMPT = "Tu es un collecteur de données hippiques expert. Utilise web_search pour trouver : 1. Hippodrome, discipline, distance, terrain du Quinté+ du jour 2. Liste complète des partants avec numéros, noms, cotes, drivers/jockeys 3. Musique récente de chaque partant 4. Historique récent des arrivées sur cet hippodrome. Résume tout en format structuré et concis. Pas d'analyse, juste les faits.";

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Méthode non autorisée" }) };
  }

  try {
    const { today, infos } = JSON.parse(event.body || "{}");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system: SEARCH_PROMPT,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: "Collecte toutes les données du Quinté+ du jour (" + today + "). " + (infos ? "Info : " + infos : "")
        }]
      })
    });

    const data = await response.json();

    if (data.error) {
      return { statusCode: 502, body: JSON.stringify({ error: "API Anthropic : " + data.error.message }) };
    }

    return { statusCode: 200, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
