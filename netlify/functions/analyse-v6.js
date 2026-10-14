// ============================================================================
// QUINTÉ MASTER v6 — moteur de consensus
// ============================================================================
// Trois sources indépendantes notent chaque partant de 0 à 100 :
//   1. MARCHÉ  : la cote PMU (ce que pensent les parieurs)
//   2. FORME   : calculée par le code sur la "musique" officielle
//   3. CLAUDE  : évaluation indépendante (les cotes lui sont CACHÉES, pour
//                que son avis soit réellement indépendant du marché)
// Le score final est une moyenne pondérée, pénalisée pour les chevaux de trot
// qui ont des disqualifications récentes (risque d'allure).
// L'indice de confiance mesure l'accord entre les sources sur le top 5,
// corrigé de l'accord qu'on obtiendrait par pur hasard.
//
// ⚠️ Les poids et les seuils ci-dessous sont des valeurs de DÉPART, non
// validées. Ils devront être recalibrés sur l'historique (backtest).
// ⚠️ L'API PMU est non officielle : la fonction est défensive et signale
// les données manquantes plutôt que de les inventer.
// ============================================================================

const POIDS = { marche: 0.40, claude: 0.30, forme: 0.30 };
const SEUIL_FORT = 55;
const SEUIL_MOYEN = 30;
const API_PMU = "https://offline.turfinfo.api.pmu.fr/rest/client/61/programme/";

function datePariss() {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric"
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return g("day") + g("month") + g("year");
}

function trouverCourseQuinte(programme) {
  const reunions = (programme && programme.programme && programme.programme.reunions) || [];
  for (let i = 0; i < reunions.length; i++) {
    const r = reunions[i];
    const courses = r.courses || [];
    for (let j = 0; j < courses.length; j++) {
      const c = courses[j];
      if (JSON.stringify(c).indexOf("QUINTE_PLUS") !== -1) {
        return {
          numReunion: r.numOfficiel || r.numExterne || r.numReunion || (i + 1),
          numCourse: c.numOrdre || c.numExterne || c.numCourse || (j + 1),
          hippodrome: (r.hippodrome && (r.hippodrome.libelleCourt || r.hippodrome.libelle)) || "",
          discipline: c.discipline || c.specialite || "",
          distance: c.distance || null,
          libelle: c.libelle || c.libelleCourt || ""
        };
      }
    }
  }
  return null;
}

function extraireCote(p) {
  const candidats = [
    p.dernierRapportDirect && p.dernierRapportDirect.rapport,
    p.dernierRapportReference && p.dernierRapportReference.rapport,
    p.rapportDirect,
    p.cote
  ];
  for (let i = 0; i < candidats.length; i++) {
    if (typeof candidats[i] === "number" && candidats[i] > 0) return candidats[i];
  }
  return null;
}

// --- Musique : "1a2a(25)Da4a0a5m" -> [{place:"1",disc:"a"}, ...] (récent d'abord)
function parseMusique(m) {
  if (!m || typeof m !== "string") return [];
  const clean = m.replace(/\(\d+\)/g, "");
  const re = /([0-9]|D|A|T|R)([a-z])/g;
  const out = [];
  let x;
  while ((x = re.exec(clean)) !== null) out.push({ place: x[1], disc: x[2] });
  return out;
}

const PTS = { "1": 100, "2": 85, "3": 72, "4": 60, "5": 50, "6": 40, "7": 32, "8": 25, "9": 20, "0": 10 };

function scoreForme(res) {
  const r = res.slice(0, 5);
  if (r.length < 2) return null; // trop peu de courses : inconnu, pas zéro
  const w = [1, 0.85, 0.7, 0.55, 0.4];
  let num = 0, den = 0;
  r.forEach((x, i) => {
    const pts = PTS[x.place] !== undefined ? PTS[x.place] : 0; // D, A, T, R = 0
    num += pts * w[i];
    den += w[i];
  });
  return Math.round(num / den);
}

function nbDisqualifs(res) {
  return res.slice(0, 5).filter((x) => x.place === "D").length;
}

function scoreMarche(chevaux) {
  const inv = chevaux.filter((c) => c.cote).map((c) => 1 / c.cote);
  const max = inv.length ? Math.max.apply(null, inv) : 0;
  chevaux.forEach((c) => {
    c.score_marche = c.cote && max > 0 ? Math.round(100 * (1 / c.cote) / max) : null;
  });
}

// --- Avis indépendant de Claude (SANS les cotes)
const PROMPT_SYSTEME =
  "Tu es un analyste hippique expert (trot attelé, trot monté, plat, obstacle). " +
  "On te donne les partants d'une course Quinté+ avec leurs données officielles. " +
  "Les cotes te sont volontairement cachées : donne ton évaluation indépendante. " +
  "Pour chaque partant, estime de 0 à 100 sa chance de finir dans les 5 premiers (pas seulement de gagner). " +
  "Règles pour le trot : la régularité d'allure prime sur la vitesse (une disqualification récente dans la musique, notée D, est un vrai risque) ; " +
  "tiens compte de la ferrure, de la corde, du handicap de distance (un cheval qui recule doit rendre de la distance), du couple cheval-driver et de la classe. " +
  "N'invente aucune donnée absente : si une information manque, dis-le et reste prudent (score proche de 40-50). " +
  "Réponds UNIQUEMENT en JSON valide, sans texte autour, au format exact : " +
  '{"scores":[{"n":<numPmu>,"s":<0-100>,"r":"<raison, 12 mots max>"}],"pieges":["<cheval suspect : raison courte>"],"commentaire":"<2 phrases max>"}';

function ligneCheval(c) {
  const v = (x) => (x === null || x === undefined || x === "" ? "?" : x);
  return "N°" + c.numPmu + " " + c.nom +
    " | " + v(c.age) + " ans " + v(c.sexe) +
    " | conducteur: " + v(c.driver) +
    " | entraîneur: " + v(c.entraineur) +
    " | musique: " + v(c.musique) +
    " | courses/victoires/places: " + v(c.nbCourses) + "/" + v(c.victoires) + "/" + v(c.places) +
    " | gains: " + v(c.gains) +
    " | ferrure: " + v(c.ferrure) +
    " | corde: " + v(c.corde) +
    " | handicap distance: " + v(c.handicapDistance);
}

function extraireJson(texte) {
  if (!texte) return null;
  const a = texte.indexOf("{");
  const b = texte.lastIndexOf("}");
  if (a === -1 || b === -1 || b < a) return null;
  try { return JSON.parse(texte.slice(a, b + 1)); } catch (e) { return null; }
}

async function avisClaude(meta, chevaux, infos) {
  const contenu =
    "Course : " + (meta.hippodrome || "?") + " — " + (meta.discipline || "?") +
    (meta.distance ? " — " + meta.distance + " m" : "") +
    " — " + chevaux.length + " partants\n" +
    (infos ? "Informations complémentaires de l'utilisateur : " + infos + "\n" : "") +
    "\nPartants :\n" + chevaux.map(ligneCheval).join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1800,
      system: PROMPT_SYSTEME,
      messages: [{ role: "user", content: contenu }]
    })
  });
  const data = await res.json();
  if (data.error) return { erreur: data.error.message || "erreur Anthropic" };
  const texte = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const json = extraireJson(texte);
  if (!json || !Array.isArray(json.scores)) return { erreur: "réponse de Claude illisible" };
  return { json };
}

// --- Consensus
function rangsPar(chevaux, cle) {
  const liste = chevaux.filter((c) => c[cle] !== null && c[cle] !== undefined)
    .sort((a, b) => b[cle] - a[cle]);
  const rangs = {};
  liste.forEach((c, i) => { rangs[c.numPmu] = i + 1; });
  return { liste, rangs };
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  A.forEach((x) => { if (B.has(x)) inter++; });
  return inter / (A.size + B.size - inter);
}

function indiceConfiance(tops, n, k) {
  if (tops.length < 2 || n <= k) return null;
  let somme = 0, nb = 0;
  for (let i = 0; i < tops.length; i++) {
    for (let j = i + 1; j < tops.length; j++) { somme += jaccard(tops[i], tops[j]); nb++; }
  }
  const J = somme / nb;
  const e = (k * k) / n;               // recouvrement attendu par hasard
  const J0 = e / (2 * k - e);          // accord attendu par hasard
  return Math.max(0, Math.min(100, Math.round(100 * (J - J0) / (1 - J0))));
}

function calculer(meta, chevaux, claudeJson) {
  const trot = /ATTELE|MONTE/i.test(meta.discipline || "");
  const avertissements = [];

  chevaux.forEach((c) => {
    const res = parseMusique(c.musique);
    c.score_forme = scoreForme(res);
    c.nb_disqualifs = nbDisqualifs(res);
    c.penalite_allure = trot ? Math.min(0.30, 0.10 * c.nb_disqualifs) : 0;
    c.score_claude = null;
    c.raison_claude = "";
  });
  scoreMarche(chevaux);

  if (claudeJson) {
    claudeJson.scores.forEach((s) => {
      const c = chevaux.find((x) => String(x.numPmu) === String(s.n));
      if (c && typeof s.s === "number") {
        c.score_claude = Math.max(0, Math.min(100, Math.round(s.s)));
        c.raison_claude = s.r || "";
      }
    });
  }

  const sources = [];
  if (chevaux.some((c) => c.score_marche !== null)) sources.push("marche");
  if (chevaux.some((c) => c.score_forme !== null)) sources.push("forme");
  if (chevaux.some((c) => c.score_claude !== null)) sources.push("claude");

  // Score final : moyenne pondérée sur les sources disponibles pour ce cheval
  chevaux.forEach((c) => {
    let num = 0, den = 0;
    sources.forEach((s) => {
      const val = c["score_" + s];
      if (val !== null && val !== undefined) { num += POIDS[s] * val; den += POIDS[s]; }
    });
    c.score_final = den > 0 ? Math.round((num / den) * (1 - c.penalite_allure)) : null;
  });

  const final = rangsPar(chevaux, "score_final");
  const marche = rangsPar(chevaux, "score_marche");
  const claude = rangsPar(chevaux, "score_claude");
  const forme = rangsPar(chevaux, "score_forme");
  chevaux.forEach((c) => {
    c.rang = final.rangs[c.numPmu] || null;
    c.rang_marche = marche.rangs[c.numPmu] || null;
    c.rang_claude = claude.rangs[c.numPmu] || null;
  });

  // Indice de confiance : accord des sources sur le top 5
  const k = Math.min(5, Math.max(1, chevaux.length - 1));
  const tops = [marche, claude, forme]
    .filter((r) => r.liste.length >= k)
    .map((r) => r.liste.slice(0, k).map((c) => c.numPmu));
  const indice = indiceConfiance(tops, chevaux.length, k);

  let niveau, recommandation;
  if (indice === null) {
    niveau = "indéterminé";
    recommandation = "Moins de deux sources exploitables : impossible de mesurer l'accord. Jouez avec la plus grande prudence.";
  } else if (indice >= SEUIL_FORT) {
    niveau = "consensus fort";
    recommandation = "Les sources s'accordent : course lisible. Un jeu normal est envisageable.";
  } else if (indice >= SEUIL_MOYEN) {
    niveau = "consensus moyen";
    recommandation = "Accord partiel entre les sources : préférez un jeu réduit.";
  } else {
    niveau = "course ouverte";
    recommandation = "Les sources divergent : course très incertaine. Prudence, ou renoncez à jouer cette course.";
  }
  if (tops.length === 2) avertissements.push("Indice établi sur 2 sources seulement : il est moins fiable.");

  // Signaux faibles : Claude bien plus haut que le marché, hors du top 3 final
  const outsiders = chevaux
    .filter((c) => c.rang && c.rang > 3 && c.rang_claude && c.rang_marche &&
      (c.rang_marche - c.rang_claude) >= 4 && c.score_claude >= 55)
    .sort((a, b) => (b.rang_marche - b.rang_claude) - (a.rang_marche - a.rang_claude))
    .slice(0, 2);

  // Favoris à risque
  const pieges = [];
  chevaux.filter((c) => c.rang_marche && c.rang_marche <= 3).forEach((c) => {
    if (c.penalite_allure > 0) {
      pieges.push("N°" + c.numPmu + " " + c.nom + " : " + c.nb_disqualifs + " disqualification(s) récente(s), risque d'allure");
    } else if (c.rang_claude && (c.rang_claude - c.rang_marche) >= 5) {
      pieges.push("N°" + c.numPmu + " " + c.nom + " : favori du marché mais jugé très bas par Claude");
    }
  });

  const manquants = (cle) => chevaux.filter((c) => c[cle] === null || c[cle] === undefined || c[cle] === "").length;
  if (manquants("musique") > chevaux.length / 2) avertissements.push("Musique absente pour la plupart des partants : score de forme peu fiable.");
  if (manquants("cote") > chevaux.length / 2) avertissements.push("Cotes absentes pour la plupart des partants : score de marché peu fiable.");
  if (manquants("ferrure") === chevaux.length && trot) avertissements.push("Ferrure non fournie par l'API : non prise en compte.");

  return { chevaux, final, indice, niveau, recommandation, outsiders, pieges, avertissements, sources, trot };
}

exports.handler = async function (event) {
  try {
    let infos = "";
    try { infos = (JSON.parse(event.body || "{}").infos || "").toString().slice(0, 600); } catch (e) { /* ignore */ }

    const dateApi = datePariss();

    // 1. Course Quinté+ du jour
    const progRes = await fetch(API_PMU + dateApi);
    if (!progRes.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: "Programme PMU inaccessible (" + progRes.status + ")" }) };
    }
    const programme = await progRes.json();
    const meta = trouverCourseQuinte(programme);
    if (!meta) {
      return { statusCode: 404, body: JSON.stringify({ error: "Aucune course Quinté+ trouvée pour le " + dateApi + "." }) };
    }

    // 2. Partants
    const url = API_PMU + dateApi + "/R" + meta.numReunion + "/C" + meta.numCourse + "/participants";
    const partRes = await fetch(url);
    if (!partRes.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: "Partants PMU inaccessibles (" + partRes.status + ")" }) };
    }
    const dataPart = await partRes.json();
    const participants = dataPart.participants || [];
    if (!participants.length) {
      return { statusCode: 404, body: JSON.stringify({ error: "Aucun partant trouvé pour cette course." }) };
    }

    const chevaux = participants
      .filter((p) => (p.statut || "PARTANT") !== "NON_PARTANT")
      .map((p) => ({
        numPmu: p.numPmu,
        nom: p.nom,
        age: p.age || null,
        sexe: p.sexe || null,
        driver: p.driver || p.jockey || null,
        entraineur: p.entraineur || null,
        musique: p.musique || null,
        nbCourses: p.nombreCourses !== undefined ? p.nombreCourses : null,
        victoires: p.nombreVictoires !== undefined ? p.nombreVictoires : null,
        places: p.nombrePlaces !== undefined ? p.nombrePlaces : null,
        gains: p.gainsParticipant && p.gainsParticipant.gainsCarriere !== undefined ? p.gainsParticipant.gainsCarriere : null,
        ferrure: p.deferre || null,
        corde: p.placeCorde !== undefined ? p.placeCorde : null,
        handicapDistance: p.handicapDistance !== undefined ? p.handicapDistance : null,
        cote: extraireCote(p)
      }));

    // 3. Avis de Claude (si indisponible, le moteur continue avec les 2 autres sources)
    const avertissementsAmont = [];
    let claudeJson = null;
    let avis;
    try { avis = await avisClaude(meta, chevaux, infos); } catch (e) { avis = { erreur: e.message }; }
    if (avis.json) claudeJson = avis.json;
    else avertissementsAmont.push("Avis de Claude indisponible (" + avis.erreur + ") : consensus calculé sans lui.");

    const r = calculer(meta, chevaux, claudeJson);
    const top5 = r.final.liste.slice(0, 5);

    const piegesClaude = claudeJson && Array.isArray(claudeJson.pieges) ? claudeJson.pieges.slice(0, 3) : [];

    return {
      statusCode: 200,
      body: JSON.stringify({
        meta: {
          date: dateApi, hippodrome: meta.hippodrome, discipline: meta.discipline,
          distance: meta.distance, reunion: meta.numReunion, course: meta.numCourse,
          nbPartants: chevaux.length
        },
        indice_confiance: r.indice,
        niveau: r.niveau,
        recommandation: r.recommandation,
        base: top5.slice(0, 3).map((c) => c.numPmu),
        selection5: top5.map((c) => c.numPmu),
        complement: r.final.liste.slice(3, 6).map((c) => c.numPmu),
        outsiders: r.outsiders.map((c) => c.numPmu),
        pieges: r.pieges.concat(piegesClaude),
        commentaire: claudeJson && claudeJson.commentaire ? claudeJson.commentaire : "",
        avertissements: avertissementsAmont.concat(r.avertissements),
        sources: r.sources,
        poids: POIDS,
        chevaux: r.chevaux.map((c) => ({
          numPmu: c.numPmu, nom: c.nom, driver: c.driver, musique: c.musique, cote: c.cote,
          score_marche: c.score_marche, score_claude: c.score_claude, score_forme: c.score_forme,
          penalite_allure: c.penalite_allure, score_final: c.score_final, rang: c.rang,
          raison_claude: c.raison_claude
        })).sort((a, b) => (a.rang || 99) - (b.rang || 99))
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

exports._interne = { parseMusique, scoreForme, indiceConfiance, calculer };
