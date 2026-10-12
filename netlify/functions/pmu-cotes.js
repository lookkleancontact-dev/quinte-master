// ============================================================================
// PMU COTES — récupération et normalisation
// ============================================================================
// ⚠️ IMPORTANT : l'API PMU utilisée ici (offline.turfinfo.api.pmu.fr) est
// NON-OFFICIELLE et NON-DOCUMENTÉE. Elle est utilisée depuis des années par
// la communauté (forums Excel/VBA, projets GitHub), mais :
//   - elle peut changer de structure sans préavis
//   - elle peut devenir indisponible sans préavis
//   - les noms de champs ci-dessous sont basés sur des usages documentés
//     publiquement, pas sur une spec officielle garantie
//
// Cette fonction est volontairement défensive (recherche souple des champs)
// pour limiter la casse si la structure bouge légèrement. Si elle échoue,
// elle renvoie le JSON brut reçu pour pouvoir diagnostiquer facilement.
// ============================================================================

function formatDateApi(d) {
  // Convertit une Date JS en format JJMMAAAA attendu par l'API PMU
  var dd = String(d.getDate()).padStart(2, "0");
  var mm = String(d.getMonth() + 1).padStart(2, "0");
  var yyyy = d.getFullYear();
  return dd + mm + yyyy;
}

// Cherche récursivement, dans l'objet programme, la réunion/course qui
// propose le pari QUINTE_PLUS — sans dépendre d'un chemin de champ figé.
function trouverCourseQuinte(programme) {
  var reunions = (programme && programme.programme && programme.programme.reunions) || [];
  for (var i = 0; i < reunions.length; i++) {
    var r = reunions[i];
    var courses = r.courses || [];
    for (var j = 0; j < courses.length; j++) {
      var c = courses[j];
      var blob = JSON.stringify(c);
      if (blob.indexOf("QUINTE_PLUS") !== -1) {
        return {
          numReunion: r.numOfficiel || r.numExterne || r.numReunion || (i + 1),
          numCourse: c.numOrdre || c.numExterne || c.numCourse || (j + 1),
          hippodrome: (r.hippodrome && r.hippodrome.libelleCourt) || (r.hippodrome && r.hippodrome.libelle) || "",
          discipline: c.discipline || c.specialite || ""
        };
      }
    }
  }
  return null;
}

// Extrait la cote actuelle d'un participant, quel que soit le nom exact
// du champ utilisé par l'API à ce moment-là.
function extraireCote(participant) {
  var candidats = [
    participant.dernierRapportDirect && participant.dernierRapportDirect.rapport,
    participant.dernierRapportReference && participant.dernierRapportReference.rapport,
    participant.rapportDirect,
    participant.cote
  ];
  for (var i = 0; i < candidats.length; i++) {
    if (typeof candidats[i] === "number" && candidats[i] > 0) return candidats[i];
  }
  return null;
}

exports.handler = async function (event) {
  try {
    var params = event.queryStringParameters || {};
    var dateObj = params.date ? new Date(params.date) : new Date();
    var dateApi = formatDateApi(dateObj);

    var numReunion = params.reunion;
    var numCourse = params.course;

    // Étape 1 : si on n'a pas reunion/course en paramètre, on les trouve
    // automatiquement en repérant la course Quinté+ du jour.
    var hippodrome = "", discipline = "";
    if (!numReunion || !numCourse) {
      var progRes = await fetch("https://offline.turfinfo.api.pmu.fr/rest/client/61/programme/" + dateApi);
      if (!progRes.ok) {
        return { statusCode: 502, body: JSON.stringify({ error: "Programme PMU inaccessible (" + progRes.status + ")" }) };
      }
      var programme = await progRes.json();
      var trouve = trouverCourseQuinte(programme);
      if (!trouve) {
        return { statusCode: 404, body: JSON.stringify({ error: "Aucune course QUINTE_PLUS trouvée pour cette date. L'API a peut-être changé de structure — vérifier manuellement le JSON du programme.", date: dateApi }) };
      }
      numReunion = trouve.numReunion;
      numCourse = trouve.numCourse;
      hippodrome = trouve.hippodrome;
      discipline = trouve.discipline;
    }

    // Étape 2 : récupération des participants + cotes
    var url = "https://offline.turfinfo.api.pmu.fr/rest/client/61/programme/" + dateApi +
      "/R" + numReunion + "/C" + numCourse + "/participants";
    var partRes = await fetch(url);
    if (!partRes.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: "Participants PMU inaccessibles (" + partRes.status + ")", url: url }) };
    }
    var dataPart = await partRes.json();
    var participants = dataPart.participants || [];

    if (!participants.length) {
      return { statusCode: 404, body: JSON.stringify({ error: "Aucun participant trouvé.", url: url, brut: dataPart }) };
    }

    // Étape 3 : extraction des cotes + normalisation en score 0-100
    var chevaux = participants.map(function (p) {
      return {
        numPmu: p.numPmu,
        nom: p.nom,
        statut: p.statut || "PARTANT",
        cote: extraireCote(p)
      };
    }).filter(function (c) { return c.statut !== "NON_PARTANT"; });

    var cotesValides = chevaux.filter(function (c) { return c.cote; }).map(function (c) { return 1 / c.cote; });
    var maxInverse = cotesValides.length ? Math.max.apply(null, cotesValides) : 0;

    chevaux.forEach(function (c) {
      if (c.cote && maxInverse > 0) {
        c.score_cotes = Math.round(100 * (1 / c.cote) / maxInverse);
      } else {
        c.score_cotes = null; // cote indisponible — à exclure ou traiter à part dans le consensus
      }
    });

    chevaux.sort(function (a, b) { return (b.score_cotes || 0) - (a.score_cotes || 0); });

    return {
      statusCode: 200,
      body: JSON.stringify({
        date: dateApi,
        numReunion: numReunion,
        numCourse: numCourse,
        hippodrome: hippodrome,
        discipline: discipline,
        chevaux: chevaux
      })
    };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
