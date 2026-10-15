// ============================================================================
// BACKTEST AVEC CLAUDE (un appel Claude par course, payant)
// ============================================================================
// Pour une date passée, la fonction :
//   1. retrouve le Quinté+, ses partants et son arrivée officielle ;
//   2. calcule les scores de marché et de forme (forme écartée si la musique
//      contient déjà le résultat) ;
//   3. demande à Claude un score par partant, SANS lui montrer les cotes,
//      ni l'arrivée, ni la date ;
//   4. renvoie tous les scores bruts : la page recompose elle-même les
//      sélections, ce qui évite de repayer Claude pour tester d'autres poids.
//
// Précaution anti-triche : on n'envoie PAS à Claude les gains, victoires,
// places ni nombre de courses. Pour une course passée, ces totaux peuvent
// inclure le résultat de la course elle-même, et on ne peut pas le vérifier.
// Claude voit donc un peu moins de données ici que dans l'agent en direct.
// ============================================================================

const API_PMU = "https://offline.turfinfo.api.pmu.fr/rest/client/61/programme/";

function versDateApi(s) {
  s = String(s || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return m[3] + m[2] + m[1];
  return /^\d{8}$/.test(s) ? s : null;
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
          course: c,
          numReunion: r.numOfficiel || r.numExterne || r.numReunion || (i + 1),
          numCourse: c.numOrdre || c.numExterne || c.numCourse || (j + 1),
          hippodrome: (r.hippodrome && (r.hippodrome.libelleCourt || r.hippodrome.libelle)) || ""
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
  if (r.length < 2) return null;
  const w = [1, 0.85, 0.7, 0.55, 0.4];
  let num = 0, den = 0;
  r.forEach((x, i) => {
    const pts = PTS[x.place] !== undefined ? PTS[x.place] : 0;
    num += pts * w[i];
    den += w[i];
  });
  return Math.round(num / den);
}

function extraireArrivee(course, participants) {
  const oa = course && course.ordreArrivee;
  if (Array.isArray(oa) && oa.length) {
    const arr = oa.map((x) => (Array.isArray(x) ? x[0] : x)).filter((x) => typeof x === "number");
    if (arr.length) return arr;
  }
  const pos = (participants || [])
    .filter((p) => typeof p.ordreArrivee === "number" && p.ordreArrivee > 0)
    .sort((a, b) => a.ordreArrivee - b.ordreArrivee)
    .map((p) => p.numPmu);
  return pos.length ? pos : null;
}

function verdictMusique(participants, arrivee) {
  const positionDe = {};
  participants.forEach((p) => {
    if (typeof p.ordreArrivee === "number" && p.ordreArrivee > 0) positionDe[p.numPmu] = p.ordreArrivee;
  });
  if (!Object.keys(positionDe).length && arrivee) arrivee.forEach((num, i) => { positionDe[num] = i + 1; });
  let testes = 0, concordances = 0;
  participants.forEach((p) => {
    const pos = positionDe[p.numPmu];
    const res = parseMusique(p.musique);
    if (!pos || pos > 9 || !res.length) return;
    testes++;
    if (res[0].place === String(pos)) concordances++;
  });
  if (testes < 3) return "indeterminé";
  const taux = concordances / testes;
  return taux >= 0.7 ? "contaminée" : taux <= 0.4 ? "propre" : "ambigu";
}

const PROMPT_SYSTEME =
  "Tu es un analyste hippique expert (trot attelé, trot monté, plat, obstacle). " +
  "On te donne les partants d'une course Quinté+ avec leurs données officielles. " +
  "Les cotes te sont volontairement cachées : donne ton évaluation indépendante. " +
  "Pour chaque partant, estime de 0 à 100 sa chance de finir dans les 5 premiers (pas seulement de gagner). " +
  "Règles pour le trot : la régularité d'allure prime sur la vitesse (une disqualification récente dans la musique, notée D, est un vrai risque) ; " +
  "tiens compte de la ferrure, de la corde, du handicap de distance (un cheval qui recule doit rendre de la distance) et du couple cheval-driver. " +
  "N'invente aucune donnée absente : si une information manque, reste prudent (score proche de 40-50). " +
  "Réponds UNIQUEMENT en JSON valide, sans texte autour, au format exact : " +
  '{"scores":[[<numPmu>,<score 0-100>],[<numPmu>,<score 0-100>]]}';

function ligneCheval(p) {
  const v = (x) => (x === null || x === undefined || x === "" ? "?" : x);
  return "N°" + p.numPmu + " " + p.nom +
    " | " + v(p.age) + " ans " + v(p.sexe) +
    " | conducteur: " + v(p.driver || p.jockey) +
    " | entraîneur: " + v(p.entraineur) +
    " | musique: " + v(p.musique) +
    " | ferrure: " + v(p.deferre) +
    " | corde: " + v(p.placeCorde) +
    " | handicap distance: " + v(p.handicapDistance);
}

function extraireJson(texte) {
  if (!texte) return null;
  const a = texte.indexOf("{"), b = texte.lastIndexOf("}");
  if (a === -1 || b === -1 || b < a) return null;
  try { return JSON.parse(texte.slice(a, b + 1)); } catch (e) { return null; }
}

async function scoresClaude(meta, partants) {
  const contenu =
    "Course : " + (meta.hippodrome || "?") + " — " + (meta.discipline || "?") +
    (meta.distance ? " — " + meta.distance + " m" : "") + " — " + partants.length + " partants\n\nPartants :\n" +
    partants.map(ligneCheval).join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      temperature: 0,
      system: PROMPT_SYSTEME,
      messages: [{ role: "user", content: contenu }]
    })
  });
  const data = await res.json();
  if (data.error) return { erreur: data.error.message || "erreur Anthropic" };
  const texte = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const json = extraireJson(texte);
  if (!json || !Array.isArray(json.scores)) return { erreur: "réponse de Claude illisible" };
  const scores = {};
  json.scores.forEach((s) => {
    if (Array.isArray(s) && typeof s[0] === "number" && typeof s[1] === "number") {
      scores[s[0]] = Math.max(0, Math.min(100, Math.round(s[1])));
    }
  });
  return { scores };
}

const sortie = (obj) => ({ statusCode: 200, body: JSON.stringify(obj) });

exports.handler = async function (event) {
  try {
    const dateApi = versDateApi((event.queryStringParameters || {}).date);
    if (!dateApi) return { statusCode: 400, body: JSON.stringify({ error: "Date invalide (format AAAA-MM-JJ)." }) };

    const progRes = await fetch(API_PMU + dateApi);
    if (!progRes.ok) return sortie({ ok: false, date: dateApi, raison: "programme_indisponible" });
    const trouve = trouverCourseQuinte(await progRes.json());
    if (!trouve) return sortie({ ok: false, date: dateApi, raison: "pas_de_quinte" });

    const partRes = await fetch(API_PMU + dateApi + "/R" + trouve.numReunion + "/C" + trouve.numCourse + "/participants");
    if (!partRes.ok) return sortie({ ok: false, date: dateApi, raison: "partants_indisponibles" });
    const participants = (await partRes.json()).participants || [];
    if (!participants.length) return sortie({ ok: false, date: dateApi, raison: "partants_indisponibles" });

    const arrivee = extraireArrivee(trouve.course, participants);
    if (!arrivee || arrivee.length < 5) return sortie({ ok: false, date: dateApi, raison: "arrivee_absente" });

    const discipline = trouve.course.discipline || trouve.course.specialite || "";
    const trot = /ATTELE|MONTE/i.test(discipline);
    const musique = verdictMusique(participants, arrivee);
    const formeValide = musique === "propre";
    const partants = participants.filter((p) => (p.statut || "PARTANT") !== "NON_PARTANT");

    const meta = { hippodrome: trouve.hippodrome, discipline: discipline, distance: trouve.course.distance || null };

    let avis;
    try { avis = await scoresClaude(meta, partants); } catch (e) { avis = { erreur: e.message }; }
    if (avis.erreur) return sortie({ ok: false, date: dateApi, raison: "claude_erreur", message: avis.erreur });

    const inv = partants.map(extraireCote).filter((x) => x).map((x) => 1 / x);
    const maxInv = inv.length ? Math.max.apply(null, inv) : 0;

    const chevaux = partants.map((p) => {
      const res = parseMusique(p.musique);
      const cote = extraireCote(p);
      const nbD = res.slice(0, 5).filter((x) => x.place === "D").length;
      return {
        n: p.numPmu,
        marche: cote && maxInv > 0 ? Math.round(100 * (1 / cote) / maxInv) : null,
        forme: formeValide ? scoreForme(res) : null,
        claude: avis.scores[p.numPmu] !== undefined ? avis.scores[p.numPmu] : null,
        pen: trot && formeValide ? Math.min(0.30, 0.10 * nbD) : 0
      };
    });

    return sortie({
      ok: true,
      date: dateApi,
      hippodrome: trouve.hippodrome,
      discipline: discipline,
      nbPartants: partants.length,
      arrivee: arrivee.slice(0, 5),
      musique: musique,
      forme_valide: formeValide,
      hasard_attendu: Math.round((25 / partants.length) * 100) / 100,
      claude_scores: chevaux.filter((c) => c.claude !== null).length,
      chevaux: chevaux
    });
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
