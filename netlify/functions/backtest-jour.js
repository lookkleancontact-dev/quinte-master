// ============================================================================
// BACKTEST D'UN JOUR (gratuit : aucun appel à Claude)
// ============================================================================
// Pour une date passée, la fonction :
//   1. retrouve le Quinté+ et son arrivée officielle ;
//   2. teste si la musique est propre (sinon la forme est ÉCARTÉE, pas devinée) ;
//   3. compose 3 sélections de 5 chevaux, comme le ferait l'agent :
//        - marché        : les 5 plus petites cotes
//        - forme         : les 5 meilleurs scores de forme (si musique propre)
//        - marché+forme  : le moteur v6 sans Claude (si musique propre)
//   4. compte combien de ces 5 chevaux sont dans les 5 premiers de l'arrivée.
// Les poids sont ceux de la v6 : marché 0,40 / forme 0,30 (renormalisés sans Claude).
// ============================================================================

const API_PMU = "https://offline.turfinfo.api.pmu.fr/rest/client/61/programme/";
const POIDS = { marche: 0.40, forme: 0.30 };

function versDateApi(s) {
  s = String(s || "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return m[3] + m[2] + m[1];
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

// La 1re case de la musique égale-t-elle la place obtenue dans CETTE course ?
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
    // On ne teste que les places 1 à 9 : la case "0" de la musique veut dire
    // "non placé" et concorde trop souvent par simple habitude du cheval.
    if (!pos || pos > 9 || !res.length) return;
    testes++;
    if (res[0].place === String(pos)) concordances++;
  });
  if (testes < 3) return { verdict: "indeterminé", taux: null };
  const taux = concordances / testes;
  return { verdict: taux >= 0.7 ? "contaminée" : taux <= 0.4 ? "propre" : "ambigu", taux: Math.round(taux * 100) / 100 };
}

function top5(chevaux, cle) {
  return chevaux
    .filter((c) => c[cle] !== null && c[cle] !== undefined)
    .sort((a, b) => b[cle] - a[cle])
    .slice(0, 5)
    .map((c) => c.num);
}

exports.handler = async function (event) {
  try {
    const dateApi = versDateApi((event.queryStringParameters || {}).date);
    if (!dateApi) return { statusCode: 400, body: JSON.stringify({ error: "Date invalide (format AAAA-MM-JJ)." }) };

    const progRes = await fetch(API_PMU + dateApi);
    if (!progRes.ok) return { statusCode: 200, body: JSON.stringify({ ok: false, date: dateApi, raison: "programme_indisponible" }) };
    const trouve = trouverCourseQuinte(await progRes.json());
    if (!trouve) return { statusCode: 200, body: JSON.stringify({ ok: false, date: dateApi, raison: "pas_de_quinte" }) };

    const partRes = await fetch(API_PMU + dateApi + "/R" + trouve.numReunion + "/C" + trouve.numCourse + "/participants");
    if (!partRes.ok) return { statusCode: 200, body: JSON.stringify({ ok: false, date: dateApi, raison: "partants_indisponibles" }) };
    const participants = (await partRes.json()).participants || [];
    if (!participants.length) return { statusCode: 200, body: JSON.stringify({ ok: false, date: dateApi, raison: "partants_indisponibles" }) };

    const arrivee = extraireArrivee(trouve.course, participants);
    if (!arrivee || arrivee.length < 5) return { statusCode: 200, body: JSON.stringify({ ok: false, date: dateApi, raison: "arrivee_absente" }) };
    const arr5 = arrivee.slice(0, 5);

    const discipline = trouve.course.discipline || trouve.course.specialite || "";
    const trot = /ATTELE|MONTE/i.test(discipline);
    const fuite = verdictMusique(participants, arrivee);
    const formeValide = fuite.verdict === "propre";

    const chevaux = participants
      .filter((p) => (p.statut || "PARTANT") !== "NON_PARTANT")
      .map((p) => {
        const res = parseMusique(p.musique);
        const nbD = res.slice(0, 5).filter((x) => x.place === "D").length;
        return {
          num: p.numPmu,
          cote: extraireCote(p),
          forme: formeValide ? scoreForme(res) : null,
          penalite: trot && formeValide ? Math.min(0.30, 0.10 * nbD) : 0
        };
      });

    // Score de marché : relatif au favori
    const inv = chevaux.filter((c) => c.cote).map((c) => 1 / c.cote);
    const maxInv = inv.length ? Math.max.apply(null, inv) : 0;
    chevaux.forEach((c) => { c.marche = c.cote && maxInv > 0 ? Math.round(100 * (1 / c.cote) / maxInv) : null; });

    // Combinaison marché + forme (poids renormalisés sans Claude)
    chevaux.forEach((c) => {
      let num = 0, den = 0;
      if (c.marche !== null) { num += POIDS.marche * c.marche; den += POIDS.marche; }
      if (c.forme !== null) { num += POIDS.forme * c.forme; den += POIDS.forme; }
      c.combine = den > 0 ? Math.round((num / den) * (1 - c.penalite)) : null;
    });

    const hits = (picks) => picks.filter((n) => arr5.indexOf(n) !== -1).length;
    const strat = (picks) => (picks.length === 5 ? { picks, hits: hits(picks) } : null);

    const sel = {
      marche: strat(top5(chevaux, "marche")),
      forme: formeValide ? strat(top5(chevaux, "forme")) : null,
      combine: formeValide ? strat(top5(chevaux, "combine")) : null
    };

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        date: dateApi,
        hippodrome: trouve.hippodrome,
        discipline: discipline,
        nbPartants: chevaux.length,
        arrivee: arr5,
        musique: fuite.verdict,
        forme_valide: formeValide,
        hasard_attendu: Math.round((25 / chevaux.length) * 100) / 100,
        strategies: sel
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
