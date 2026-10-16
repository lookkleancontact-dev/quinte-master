// ============================================================================
// JOURNAL — enregistre le journal des tickets dans Supabase
// ============================================================================
// À placer dans netlify/functions/journal.js
//
// Variables d'environnement Netlify nécessaires :
//   JOURNAL_PASSWORD            mot de passe de votre choix (à créer)
//   SUPABASE_URL                adresse du projet Supabase (déjà présente chez vous)
//   SUPABASE_SERVICE_ROLE_KEY   clé service_role (déjà présente chez vous, nom possible
//                               différent : la fonction cherche aussi SUPABASE_SERVICE_KEY
//                               et toute variable SUPABASE_* contenant SERVICE ou SECRET)
//
// La clé service_role n'est jamais envoyée au navigateur. Sans le mot de passe,
// la fonction refuse toute lecture et toute écriture.
//
// Table Supabase : voir le script SQL fourni avec ce fichier.
// ============================================================================

var crypto = require("crypto");

function trouverEnv(exact, motif) {
  for (var i = 0; i < exact.length; i++) { if (process.env[exact[i]]) return process.env[exact[i]]; }
  var cles = Object.keys(process.env);
  for (var j = 0; j < cles.length; j++) { if (motif.test(cles[j]) && process.env[cles[j]]) return process.env[cles[j]]; }
  return "";
}

function reponse(code, obj) {
  return { statusCode: code, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) };
}

function memeSecret(a, b) {
  var ha = crypto.createHash("sha256").update(String(a)).digest();
  var hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function nombre(v, def) { var n = parseFloat(v); return isFinite(n) && n >= 0 ? n : def; }
function texte(v, max) { return String(v == null ? "" : v).slice(0, max); }

// Ne garde que les champs attendus, avec le bon type
function nettoyer(e) {
  if (!e || typeof e !== "object") return null;
  var id = texte(e.id, 60);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.date || ""))) return null;
  if (e.type !== "Q" && e.type !== "T") return null;
  var ticket = texte(e.ticket, 60);
  if (!ticket) return null;
  var snap = null;
  if (Array.isArray(e.snap)) {
    snap = e.snap.slice(0, 40).map(function (s) {
      return {
        num: nombre(s && s.num, 0),
        cote: nombre(s && s.cote, 0),
        surprise: (s && s.surprise != null) ? nombre(s.surprise, null) : null
      };
    });
  }
  return {
    id: id,
    date: e.date,
    course: texte(e.course, 120),
    type: e.type,
    plage: texte(e.plage, 30) || "autre",
    mise: nombre(e.mise, 0),
    ticket: ticket,
    arrivee: texte(e.arrivee, 60),
    gain: (e.gain === "" || e.gain == null) ? null : nombre(e.gain, 0),
    note: texte(e.note, 300),
    snap: snap,
    updated_at: new Date().toISOString()
  };
}

function versClient(r) {
  var o = {
    id: r.id, date: r.date, course: r.course || "", type: r.type, plage: r.plage || "autre",
    mise: Number(r.mise) || 0, ticket: r.ticket, arrivee: r.arrivee || "",
    gain: (r.gain === null || r.gain === undefined) ? "" : Number(r.gain), note: r.note || ""
  };
  if (r.snap) o.snap = r.snap;
  return o;
}

exports.handler = async function (event) {
  try {
    var mdp = process.env.JOURNAL_PASSWORD;
    if (!mdp) return reponse(500, { error: "Variable JOURNAL_PASSWORD absente dans Netlify." });

    var h = event.headers || {};
    var fourni = h["x-journal-key"] || h["X-Journal-Key"] || "";
    if (!memeSecret(fourni, mdp)) return reponse(401, { error: "Mot de passe incorrect." });

    var base = trouverEnv(["SUPABASE_URL", "SUPABASE_PROJECT_URL"], /^SUPABASE.*URL$/i).replace(/\/+$/, "");
    var cle = trouverEnv(["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY", "SUPABASE_SERVICE_ROLE"], /^SUPABASE.*(SERVICE|SECRET)/i);
    if (!base || !cle) {
      return reponse(500, { error: "Adresse Supabase ou clé service_role introuvable dans les variables Netlify (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)." });
    }
    var entetes = { apikey: cle, Authorization: "Bearer " + cle, "Content-Type": "application/json" };
    var table = base + "/rest/v1/journal_tickets";
    var methode = event.httpMethod;

    if (methode === "GET") {
      var r = await fetch(table + "?select=*&order=date.desc,created_at.desc&limit=2000", { headers: entetes });
      var txt = await r.text();
      if (!r.ok) return reponse(502, { error: "Supabase : " + txt.slice(0, 300) });
      return reponse(200, { entries: JSON.parse(txt).map(versClient) });
    }

    if (methode === "POST") {
      if ((event.body || "").length > 1000000) return reponse(413, { error: "Requête trop volumineuse." });
      var corps = JSON.parse(event.body || "{}");
      var liste = Array.isArray(corps.entries) ? corps.entries.slice(0, 200) : [];
      var propres = liste.map(nettoyer).filter(Boolean);
      if (!propres.length) return reponse(400, { error: "Aucun ticket valide à enregistrer." });
      var r2 = await fetch(table + "?on_conflict=id", {
        method: "POST",
        headers: Object.assign({}, entetes, { Prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify(propres)
      });
      if (!r2.ok) return reponse(502, { error: "Supabase : " + (await r2.text()).slice(0, 300) });
      return reponse(200, { ok: true, enregistres: propres.length });
    }

    if (methode === "DELETE") {
      var id = ((event.queryStringParameters || {}).id) || "";
      if (!/^[A-Za-z0-9_-]{1,60}$/.test(id)) return reponse(400, { error: "Identifiant invalide." });
      var r3 = await fetch(table + "?id=eq." + encodeURIComponent(id), { method: "DELETE", headers: entetes });
      if (!r3.ok) return reponse(502, { error: "Supabase : " + (await r3.text()).slice(0, 300) });
      return reponse(200, { ok: true });
    }

    return reponse(405, { error: "Méthode non autorisée." });
  } catch (err) {
    return reponse(500, { error: err.message });
  }
};
