// ============================================================================
// VÉRIFICATION AVANT BACKTEST
// ============================================================================
// Pour une ou plusieurs dates passées, cette fonction répond à 4 questions :
//   1. L'API retrouve-t-elle encore le Quinté+ de cette date ?
//   2. L'arrivée officielle est-elle disponible ?
//   3. La "musique" des partants est-elle PROPRE, ou contient-elle déjà le
//      résultat de cette course ? (si oui, le score de forme "triche")
//   4. Les cotes sont-elles disponibles ?
// Aucune clé API Anthropic n'est utilisée : ce test est gratuit.
// ============================================================================

const API_PMU = "https://offline.turfinfo.api.pmu.fr/rest/client/61/programme/";

function versDateApi(s) {
  s = String(s || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return m[3] + m[2] + m[1];
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return m[1] + m[2] + m[3];
  if (/^\d{8}$/.test(s)) return s;
  return null;
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

// Cherche l'arrivée officielle, sous plusieurs formes possibles
function extraireArrivee(course, participants) {
  const oa = course && course.ordreArrivee;
  if (Array.isArray(oa) && oa.length) {
    const arr = oa.map((x) => (Array.isArray(x) ? x[0] : x)).filter((x) => typeof x === "number");
    if (arr.length) return { arrivee: arr, source: "course.ordreArrivee" };
  }
  const pos = (participants || [])
    .filter((p) => typeof p.ordreArrivee === "number" && p.ordreArrivee > 0)
    .sort((a, b) => a.ordreArrivee - b.ordreArrivee)
    .map((p) => p.numPmu);
  if (pos.length) return { arrivee: pos, source: "participants.ordreArrivee" };
  return { arrivee: null, source: null };
}

// Test de fuite : la 1re case de la musique égale-t-elle la place obtenue
// DANS CETTE course ? Sans fuite, c'est rare (~15-25 %) ; avec fuite, ~100 %.
function testFuite(participants, arrivee) {
  const positionDe = {};
  participants.forEach((p) => {
    if (typeof p.ordreArrivee === "number" && p.ordreArrivee > 0) positionDe[p.numPmu] = p.ordreArrivee;
  });
  if (!Object.keys(positionDe).length && arrivee) {
    arrivee.forEach((num, i) => { positionDe[num] = i + 1; });
  }
  let testes = 0, concordances = 0;
  participants.forEach((p) => {
    const pos = positionDe[p.numPmu];
    const res = parseMusique(p.musique);
    if (!pos || !res.length) return;
    const attendu = pos >= 10 ? "0" : String(pos);
    testes++;
    if (res[0].place === attendu) concordances++;
  });
  if (testes < 3) return { testes, concordances, taux: null, verdict: "indeterminé" };
  const taux = concordances / testes;
  let verdict = "ambigu";
  if (taux >= 0.7) verdict = "contaminée";
  else if (taux <= 0.4) verdict = "propre";
  return { testes, concordances, taux: Math.round(taux * 100) / 100, verdict };
}

async function verifierDate(dateApi) {
  const rapport = { date: dateApi, ok: false };
  let progRes;
  try { progRes = await fetch(API_PMU + dateApi); }
  catch (e) { rapport.erreur = "Appel impossible : " + e.message; return rapport; }
  if (!progRes.ok) { rapport.erreur = "Programme indisponible pour cette date (code " + progRes.status + ")"; return rapport; }

  let programme;
  try { programme = await progRes.json(); }
  catch (e) { rapport.erreur = "Réponse du programme illisible"; return rapport; }

  const trouve = trouverCourseQuinte(programme);
  if (!trouve) { rapport.erreur = "Aucun Quinté+ trouvé pour cette date (pas de Quinté ce jour-là, ou date trop ancienne pour l'API)"; return rapport; }

  const url = API_PMU + dateApi + "/R" + trouve.numReunion + "/C" + trouve.numCourse + "/participants";
  let partRes;
  try { partRes = await fetch(url); }
  catch (e) { rapport.erreur = "Appel des partants impossible : " + e.message; return rapport; }
  if (!partRes.ok) { rapport.erreur = "Partants indisponibles (code " + partRes.status + ")"; return rapport; }
  const dataPart = await partRes.json();
  const participants = dataPart.participants || [];
  if (!participants.length) { rapport.erreur = "Aucun partant renvoyé"; return rapport; }

  const arr = extraireArrivee(trouve.course, participants);
  const nbCotes = participants.filter((p) => extraireCote(p) !== null).length;
  const nbMusiques = participants.filter((p) => parseMusique(p.musique).length > 0).length;
  const exemple = participants[0];

  rapport.ok = true;
  rapport.course = {
    hippodrome: trouve.hippodrome,
    discipline: trouve.course.discipline || trouve.course.specialite || "",
    distance: trouve.course.distance || null,
    reunion: trouve.numReunion, numero: trouve.numCourse,
    statut: trouve.course.statut || trouve.course.categorieStatut || null
  };
  rapport.nbPartants = participants.length;
  rapport.arrivee = { top: arr.arrivee ? arr.arrivee.slice(0, 5) : null, source: arr.source };
  rapport.cotes = { renseignees: nbCotes, total: participants.length };
  rapport.musique = { renseignees: nbMusiques, total: participants.length, fuite: testFuite(participants, arr.arrivee) };
  rapport.diagnostic = {
    cles_course: Object.keys(trouve.course).slice(0, 60),
    cles_participant: Object.keys(exemple).slice(0, 60),
    ordreArrivee_course: trouve.course.ordreArrivee === undefined ? null : trouve.course.ordreArrivee,
    exemple: {
      numPmu: exemple.numPmu, nom: exemple.nom, musique: exemple.musique || null,
      ordreArrivee: exemple.ordreArrivee === undefined ? null : exemple.ordreArrivee,
      cote: extraireCote(exemple)
    }
  };
  return rapport;
}

exports.handler = async function (event) {
  try {
    const params = event.queryStringParameters || {};
    const brut = String(params.dates || "").split(",").map(versDateApi).filter(Boolean).slice(0, 3);
    if (!brut.length) {
      return { statusCode: 400, body: JSON.stringify({ error: "Indiquez 1 à 3 dates (format AAAA-MM-JJ)." }) };
    }
    const rapports = [];
    for (let i = 0; i < brut.length; i++) rapports.push(await verifierDate(brut[i]));
    return { statusCode: 200, body: JSON.stringify({ rapports }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

exports._interne = { testFuite, extraireArrivee, parseMusique };
