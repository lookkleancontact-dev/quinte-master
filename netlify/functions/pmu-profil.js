// ============================================================================
// PMU PROFIL — cotes + historique + driver + ferrure + score de surprise
// ============================================================================
// Fichier à placer dans netlify/functions/pmu-profil.js (même dossier que
// pmu-cotes.js, qui reste inchangé).
//
// ⚠️ Même réserve que pmu-cotes.js : l'API PMU utilisée est NON-OFFICIELLE.
// Les noms de champs ci-dessous viennent d'usages communautaires, pas d'une
// spec garantie. La fonction est donc défensive : si un champ manque, elle
// continue avec ce qu'elle a et le signale dans "diagnostic".
//
// Pour vérifier les vrais noms de champs la première fois, ouvrir :
//   /.netlify/functions/pmu-profil?debug=1
// Elle renvoie alors le premier participant tel que reçu, brut.
//
// Les poids du score (forme, classe, bonus de changements) sont des
// HEURISTIQUES non calibrées. Elles servent à classer les outsiders entre eux,
// pas à prouver un avantage. Seuls les tests sur données réelles diront si
// elles valent quelque chose.
// ============================================================================

var BASE = "https://offline.turfinfo.api.pmu.fr/rest/client/61/programme/";

function formatDateApi(d) {
  var dd = String(d.getDate()).padStart(2, "0");
  var mm = String(d.getMonth() + 1).padStart(2, "0");
  return dd + mm + d.getFullYear();
}

async function getJson(url) {
  var ctl = new AbortController();
  var t = setTimeout(function () { ctl.abort(); }, 7000);
  try {
    var r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function norm(s) { return String(s || "").toUpperCase().replace(/[.\s'-]/g, ""); }
function sans(v) { return !v || /^(SANS|AUCUN|AUCUNE|NON|0)/i.test(String(v)); }

// ---- Programme : trouve la course Quinté+ et garde ses infos (distance, terrain…)
function trouverCourseQuinte(programme) {
  var reunions = (programme && programme.programme && programme.programme.reunions) || [];
  for (var i = 0; i < reunions.length; i++) {
    var r = reunions[i];
    var courses = r.courses || [];
    for (var j = 0; j < courses.length; j++) {
      var c = courses[j];
      if (JSON.stringify(c).indexOf("QUINTE_PLUS") !== -1) {
        return {
          numReunion: r.numOfficiel || r.numExterne || r.numReunion || (i + 1),
          numCourse: c.numOrdre || c.numExterne || c.numCourse || (j + 1),
          hippodrome: (r.hippodrome && (r.hippodrome.libelleCourt || r.hippodrome.libelle)) || "",
          course: {
            discipline: c.discipline || c.specialite || "",
            distance: c.distance || null,
            corde: c.corde || "",
            terrain: (c.penetrometre && (c.penetrometre.intitule || c.penetrometre.valeurMesure)) || "",
            conditions: c.conditions || c.conditionsTxt || "",
            partantsDeclares: c.nombreDeclaresPartants || null
          }
        };
      }
    }
  }
  return null;
}

function extraireCote(p) {
  var cands = [
    p.dernierRapportDirect && p.dernierRapportDirect.rapport,
    p.dernierRapportReference && p.dernierRapportReference.rapport,
    p.rapportDirect,
    p.cote
  ];
  for (var i = 0; i < cands.length; i++) {
    if (typeof cands[i] === "number" && cands[i] > 0) return cands[i];
  }
  return null;
}

function nomDriver(p) {
  return p.driver || p.nomJockey || p.jockey || "";
}

// ---- Musique : "1a2aDa" (trot) ou "5p 6p (25) 7p Dp" (galop), du plus récent au plus ancien
function parseMusique(m) {
  var out = [];
  if (!m) return out;
  var re = /\((\d{2})\)|(\d{1,2}|[DATRdatr])([amphscAMPHSC])/g, x;
  while ((x = re.exec(m)) !== null) {
    if (x[1]) continue; // marqueur d'année
    var t = x[2].toUpperCase();
    if (/^\d+$/.test(t)) {
      var n = parseInt(t, 10);
      out.push({ place: n === 0 ? 10 : n, incident: false });
    } else {
      out.push({ place: null, incident: t }); // D, A, T, R
    }
  }
  return out;
}

function scorePlace(place) {
  var tab = [100, 85, 70, 55, 45, 30, 25, 20, 15];
  if (place >= 1 && place <= 9) return tab[place - 1];
  return 8;
}

// ---- Historique détaillé (une seule requête pour toute la course)
function extrairePerfs(perfData, numPmu) {
  var liste = (perfData && (perfData.participants || perfData.performances)) || [];
  var entry = null;
  for (var i = 0; i < liste.length; i++) {
    if (String(liste[i].numPmu) === String(numPmu)) { entry = liste[i]; break; }
  }
  if (!entry) return [];
  var courses = entry.coursesCourues || entry.courses || [];
  var out = [];
  for (var k = 0; k < courses.length && out.length < 6; k++) {
    var c = courses[k];
    var moi = null;
    var parts = c.participants || [];
    for (var q = 0; q < parts.length; q++) { if (parts[q].itsHim) { moi = parts[q]; break; } }
    var place = null;
    if (moi && moi.place) {
      place = typeof moi.place === "object" ? (moi.place.place || moi.place.rangApproximatif || null) : moi.place;
    }
    out.push({
      date: c.date || null,
      hippodrome: c.hippodrome || "",
      distance: c.distance || null,
      nbPartants: c.nbParticipants || parts.length || null,
      place: place,
      driver: moi ? (moi.nomJockey || moi.jockey || moi.driver || "") : "",
      deferre: moi ? (moi.deferre || "") : "",
      oeilleres: moi ? (moi.oeilleres || "") : "",
      reduction: moi ? (moi.reductionKilometrique || null) : null
    });
  }
  return out;
}

// ---- Analyse d'un cheval
function analyser(c, perfs, course) {
  var signaux = [];
  var bonus = 0;

  // Résultats : on préfère l'historique détaillé, sinon la musique
  var res = [];
  if (perfs.length) {
    perfs.forEach(function (f) {
      if (f.place) res.push({ place: f.place, incident: false, nb: f.nbPartants });
      else res.push({ place: null, incident: "?", nb: f.nbPartants });
    });
  } else {
    res = parseMusique(c.musique).slice(0, 6);
  }

  // Forme : moyenne pondérée, les courses récentes comptent plus
  var poids = [1, 0.85, 0.7, 0.55, 0.4, 0.3], sw = 0, ss = 0, top3 = 0, top5 = 0, valides = 0, incidents = 0;
  res.slice(0, 6).forEach(function (r, i) {
    var s = r.place ? scorePlace(r.place) : 0;
    if (r.place) {
      valides++;
      if (r.place <= 3) top3++;
      if (r.place <= 5) top5++;
    } else if (r.incident && r.incident !== "?") {
      incidents++;
    }
    ss += s * poids[i]; sw += poids[i];
  });
  var forme = sw ? ss / sw : 40;
  var regularite = res.length ? Math.round(100 * top5 / Math.min(res.length, 6)) : 40;

  // Ligne trompeuse : incidents (disqualification, arrêt, chute) malgré une bonne forme
  if (incidents >= 1 && top5 >= 2) {
    bonus += 5;
    signaux.push(incidents + " incident(s) récent(s) (disqualification ou arrêt) malgré " + top5 + " place(s) dans les 5 premiers : la musique sous-estime le cheval.");
  }

  // Changements : comparaison avec la course précédente (si historique détaillé)
  var prev = perfs.length ? perfs[0] : null;
  var drv = nomDriver(c);
  if (prev && prev.driver && drv && norm(prev.driver) !== norm(drv)) {
    bonus += 3;
    signaux.push("Change de driver : " + prev.driver + " puis " + drv + " (effet non démontré, à vérifier).");
  } else if (c.driverChange === true) {
    bonus += 3;
    signaux.push("Change de driver, indiqué par le PMU (" + drv + "). Effet non démontré, à vérifier.");
  }
  // Comparaison de ferrure : seulement si l'historique renseigne la ferrure de la course
  // précédente. Dans les données PMU réelles ce champ est vide, le signal est alors désactivé
  // (sinon tous les chevaux apparaîtraient à tort comme "changés").
  var dfNow = c.deferre || "", dfPrev = (prev && prev.deferre) ? prev.deferre : null;
  if (dfPrev !== null && String(dfNow) !== String(dfPrev)) {
    if (!sans(dfNow) && sans(dfPrev)) { bonus += 6; signaux.push("Déferré ce jour (" + dfNow + ") alors qu'il ne l'était pas à la course précédente."); }
    else if (!sans(dfNow) || !sans(dfPrev)) { bonus += 3; signaux.push("Ferrure modifiée : " + (dfPrev || "aucune") + " puis " + (dfNow || "aucune") + "."); }
  }
  var oeNow = c.oeilleres || "", oePrev = (prev && prev.oeilleres) ? prev.oeilleres : null;
  if (oePrev !== null && !sans(oeNow) && sans(oePrev)) {
    bonus += 5; signaux.push("Oeillères ajoutées par rapport à la course précédente.");
  }

  var avis = String(c.avisEntraineur || "").toUpperCase();
  if (/POSITIF/.test(avis)) { bonus += 5; signaux.push("Avis de l'entraîneur : positif."); }

  if (course && course.distance && c.handicapDistance && c.handicapDistance > course.distance) {
    bonus -= 3;
    signaux.push("Recule de " + (c.handicapDistance - course.distance) + " m (handicap de distance).");
  }

  // Distance : a-t-il déjà bien figuré à peu près sur la distance du jour ?
  if (course && course.distance && perfs.length) {
    var proches = perfs.filter(function (f) { return f.distance && Math.abs(f.distance - course.distance) <= 250; });
    var bien = proches.filter(function (f) { return f.place && f.place <= 3; });
    if (bien.length) { bonus += 6; signaux.push("A déjà fini dans les 3 premiers sur une distance proche (" + bien.length + " fois sur ses dernières courses)."); }
    else if (!proches.length) { signaux.push("Aucune de ses dernières courses sur une distance proche de celle du jour."); }
  }

  if (c.indicateurInedit) signaux.push("Inédit : peu ou pas d'historique, score peu fiable.");
  if (!res.length) signaux.push("Aucun historique de résultats disponible : score neutre.");

  return { forme: forme, regularite: regularite, bonus: bonus, signaux: signaux, nbResultats: res.length, top3: top3, top5: top5 };
}

exports.handler = async function (event) {
  try {
    var params = event.queryStringParameters || {};
    var dateApi = formatDateApi(params.date ? new Date(params.date) : new Date());

    var numReunion = params.reunion, numCourse = params.course;
    var hippodrome = "", course = {};

    // Programme : nécessaire pour la course Quinté+ et pour les infos de la course
    try {
      var programme = await getJson(BASE + dateApi);
      if (!numReunion || !numCourse) {
        var t = trouverCourseQuinte(programme);
        if (!t) {
          return { statusCode: 404, body: JSON.stringify({ error: "Aucune course QUINTE_PLUS trouvée pour cette date.", date: dateApi }) };
        }
        numReunion = t.numReunion; numCourse = t.numCourse; hippodrome = t.hippodrome; course = t.course;
      }
    } catch (e) {
      if (!numReunion || !numCourse) {
        return { statusCode: 502, body: JSON.stringify({ error: "Programme PMU inaccessible (" + e.message + ")" }) };
      }
    }

    var url = BASE + dateApi + "/R" + numReunion + "/C" + numCourse;
    var dataPart = await getJson(url + "/participants");
    var participants = dataPart.participants || [];
    if (!participants.length) {
      return { statusCode: 404, body: JSON.stringify({ error: "Aucun participant trouvé.", url: url }) };
    }

    if (params.debug) {
      return { statusCode: 200, body: JSON.stringify({ premier_participant_brut: participants[0], course: course }) };
    }

    // Historique détaillé : facultatif, n'empêche pas la réponse s'il échoue
    var perfData = null, perfsOk = false, perfsErreur = "";
    try {
      perfData = await getJson(url + "/performances-detaillees/pretty");
      perfsOk = true;
    } catch (e) {
      perfsErreur = e.message;
    }

    var chevaux = participants
      .filter(function (p) { return (p.statut || "PARTANT") !== "NON_PARTANT"; })
      .map(function (p) {
        var perfs = perfsOk ? extrairePerfs(perfData, p.numPmu) : [];
        var a = analyser(p, perfs, course);
        var g = p.gainsParticipant || {};
        return {
          numPmu: p.numPmu,
          nom: p.nom,
          statut: p.statut || "PARTANT",
          cote: extraireCote(p),
          age: p.age || null,
          sexe: p.sexe || "",
          race: p.race || "",
          avisEntraineur: p.avisEntraineur || "",
          driver: nomDriver(p),
          entraineur: p.entraineur || "",
          deferre: p.deferre || "",
          oeilleres: p.oeilleres || "",
          musique: p.musique || "",
          nbCourses: p.nombreCourses || 0,
          victoires: p.nombreVictoires || 0,
          places: p.nombrePlaces || 0,
          gainsCarriere: g.gainsCarriere || 0,
          gainsAnnee: g.gainsAnneeEnCours || 0,
          perfs: perfs,
          forme: Math.round(a.forme),
          regularite: a.regularite,
          signaux: a.signaux,
          nbResultats: a.nbResultats,
          _bonus: a.bonus
        };
      });

    // Classe : gains moyens par course, classés dans le lot.
    // Un cheval étranger a des gains de carrière (étranger inclus) mais un nombre de courses
    // françaises partiel : le ratio est faux. On le met à 50 (neutre) et on le signale.
    chevaux.forEach(function (c) {
      var nbMus = parseMusique(c.musique).length;
      c._etranger = /ETRANGER/i.test(c.race) || nbMus > (c.nbCourses || 0);
      c._gpc = c.nbCourses > 0 ? c.gainsCarriere / c.nbCourses : 0;
    });
    var gs = chevaux.filter(function (c) { return !c._etranger; })
      .map(function (c) { return c._gpc; }).sort(function (x, y) { return x - y; });
    chevaux.forEach(function (c) {
      if (c._etranger || gs.length < 2) {
        c.classe = 50;
        if (c._etranger) c.signaux.push("Statistiques françaises partielles (cheval étranger ou historique à l'étranger) : classe non comparable, mise à 50.");
      } else {
        c.classe = Math.round(100 * gs.indexOf(c._gpc) / (gs.length - 1));
      }
      c.profil = Math.round(clamp(0.55 * c.forme + 0.2 * c.classe + 0.15 * c.regularite + c._bonus, 0, 100));
    });

    // Score de cotes (comme pmu-cotes.js)
    var inv = chevaux.filter(function (c) { return c.cote; }).map(function (c) { return 1 / c.cote; });
    var maxInv = inv.length ? Math.max.apply(null, inv) : 0;
    chevaux.forEach(function (c) { c.score_cotes = c.cote && maxInv > 0 ? Math.round(100 * (1 / c.cote) / maxInv) : null; });

    // Surprise = écart entre le rang du profil et le rang du marché (60 %) + niveau du profil (40 %)
    var avecCote = chevaux.filter(function (c) { return c.cote; });
    var parCote = avecCote.slice().sort(function (a, b) { return a.cote - b.cote; });
    var parProfil = avecCote.slice().sort(function (a, b) { return b.profil - a.profil; });
    var n = Math.max(avecCote.length - 1, 1);
    avecCote.forEach(function (c) {
      var pm = parCote.indexOf(c) / n;      // 0 = favori du marché, 1 = dernier
      var pp = parProfil.indexOf(c) / n;    // 0 = meilleur profil, 1 = pire
      var valeur = pm - pp;                 // positif : le profil est meilleur que ne le dit le marché
      c.valeur_vs_marche = Math.round(valeur * 100);
      c.score_surprise = Math.round(clamp(50 + 100 * valeur * 0.6 + (c.profil - 50) * 0.4, 0, 100));
    });
    chevaux.forEach(function (c) { delete c._bonus; delete c._gpc; delete c._etranger; });

    chevaux.sort(function (a, b) { return (b.score_cotes || 0) - (a.score_cotes || 0); });

    return {
      statusCode: 200,
      body: JSON.stringify({
        date: dateApi,
        numReunion: numReunion,
        numCourse: numCourse,
        hippodrome: hippodrome,
        course: course,
        diagnostic: {
          historique_detaille: perfsOk,
          historique_erreur: perfsErreur,
          champs_participant: Object.keys(participants[0] || {}),
          chevaux_avec_historique: chevaux.filter(function (c) { return c.nbResultats > 0; }).length,
          note: "Poids du score = heuristiques non calibrées."
        },
        chevaux: chevaux
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
