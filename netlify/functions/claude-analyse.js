// Même principe que claude-search.js : la clé API reste côté serveur.

function getAnalysePrompt(hist) {
  return "Tu es QUINTÉ MASTER, pronostiqueur hippique d'élite, 25 ans d'expérience.\n" +
    (hist ? "MÉMOIRE DE TES PRONOSTICS PASSÉS :\n" + hist + "\nUtilise ces données pour t'améliorer.\n" : "") +
    "\nRÈGLES : Cherche les OUTSIDERS, écarte les favoris évidents. Objectif : GROSSE CAGNOTTE.\n\nFORMAT CONDENSÉ OBLIGATOIRE :\n\n⚠️ PIÈGES À ÉVITER\n• [Favori surfait] : [raison courte]\n\n🎯 PRONOSTIC FINAL\nBase : N°X [Nom], N°X [Nom], N°X [Nom]\nOutsiders : N°X [Nom], N°X [Nom]\nJoker cagnotte : N°X [Nom]\n\n📋 JEU : [ORDRE ou DÉSORDRE] — [raison courte]\n\n🧠 POURQUOI CES CHEVAUX\n• [Cheval] : [justification 1 ligne]\n• [Outsider] : [pourquoi il peut surprendre]\n\n⚡ INTUITION : [1 phrase directe]\n\nHIPPODROME : [nom exact]\nDISCIPLINE : [type exact]";
}

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Méthode non autorisée" }) };
  }

  try {
    const { today, donnees, historique } = JSON.parse(event.body || "{}");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system: getAnalysePrompt(historique || ""),
        messages: [{
          role: "user",
          content: "Données du Quinté+ du " + today + " :\n\n" + donnees + "\n\nDonne ton pronostic complet avec numéros ET noms."
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
