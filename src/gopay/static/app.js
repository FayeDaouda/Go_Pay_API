// Go Pay : l'interface web. Elle parle à l'API servie par le même serveur (même origine, pas de CORS).

const $ = (selecteur, racine = document) => racine.querySelector(selecteur);
const $$ = (selecteur, racine = document) => [...racine.querySelectorAll(selecteur)];

const REGIONS = [
  "Dakar", "Thiès", "Diourbel", "Saint-Louis", "Louga", "Kaolack", "Fatick",
  "Kaffrine", "Ziguinchor", "Kolda", "Sédhiou", "Tambacounda", "Kédougou", "Matam",
];

const LIBELLES = {
  depot: "Dépôt",
  transfert: "Transfert envoyé",
  transfert_diaspora: "Reçu de l'étranger pour un bénéficiaire",
  paiement_envoye: "Paiement",
  paiement_recu: "Paiement reçu",
};
const ENTREES = new Set(["depot", "paiement_recu"]); // ce qui augmente le solde

// ---------- Petites aides ----------
const francs = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const decimales = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 3 });
const fcfa = (valeur) => `${francs.format(Number(valeur))} FCFA`;
const sansEspaces = (texte) => texte.replace(/\s+/g, "");
// +221770000001 devient +221 77 000 00 01, plus facile à lire et à dicter.
const telephone = (t) => t.replace(/^\+221(\d{2})(\d{3})(\d{2})(\d{2})$/, "+221 $1 $2 $3 $4");

// R2 : 1 % arrondi au franc (une moitié vers le haut), 50 FCFA au minimum. Calcul en entiers.
const fraisDe = (montant) => Math.max(Math.floor((montant + 50) / 100), 50);

// Le stockage du navigateur peut être indisponible (navigation privée) : on ne bloque jamais dessus.
const memoire = {
  lire(cle) { try { return localStorage.getItem(cle); } catch { return null; } },
  ecrire(cle, valeur) { try { localStorage.setItem(cle, valeur); } catch { /* sans importance */ } },
};

const etat = {
  wallets: [],
  walletId: Number(memoire.lire("gopay.wallet")) || null,
  curseur: null,
  suivi: null, // l'EventSource du ticket affiché
  agent: null, // la WebSocket de l'agent
};

// ---------- Appels à l'API ----------
class ErreurApi extends Error {
  constructor(message, { statut = 0, reseau = false, type = "", titre = "" } = {}) {
    super(message);
    this.statut = statut;
    this.reseau = reseau;
    this.type = type;
    this.titre = titre; // le titre de l'erreur (Problem Details), par exemple « Solde insuffisant »
  }
}

const CHAMPS = {
  telephone: "Numéro invalide : écrivez-le au format +221 77 000 00 00.",
  beneficiaire_tel: "Numéro du bénéficiaire invalide : écrivez-le au format +221 77 000 00 00.",
  montant: "Montant invalide.",
  montant_devise: "Montant en devise invalide : deux décimales au plus.",
  nom: "Le nom doit faire au moins 2 caractères.",
  code_retrait: "Le code de retrait fait 6 chiffres.",
};

// Transforme une réponse d'erreur (format Problem Details) en message lisible.
function lireErreur(statut, corps) {
  const type = (corps?.type ?? "").split("/").pop();
  if (Array.isArray(corps?.errors) && corps.errors.length) {
    const messages = corps.errors.map((e) => {
      const champ = e.loc?.[e.loc.length - 1];
      if (champ === "montant" && e.type === "greater_than_equal") return "Un transfert fait au moins 100 FCFA.";
      return CHAMPS[champ] ?? `${champ} : ${e.msg}`;
    });
    return new ErreurApi([...new Set(messages)].join(" "), { statut, type, titre: "Vérifiez le formulaire" });
  }
  let message = corps?.detail ?? `L'API a répondu ${statut}.`;
  if (statut === 503) message += " Réessayez dans un instant.";
  return new ErreurApi(message, { statut, type, titre: corps?.title ?? "" });
}

async function api(chemin, { methode = "GET", corps, entetes = {} } = {}) {
  let reponse;
  try {
    reponse = await fetch(chemin, {
      method: methode,
      headers: { ...(corps ? { "Content-Type": "application/json" } : {}), ...entetes },
      body: corps ? JSON.stringify(corps) : undefined,
    });
  } catch {
    throw new ErreurApi("L'API ne répond pas. Vérifiez qu'elle tourne, puis renvoyez : la même opération ne sera pas comptée deux fois.", { reseau: true });
  }
  const donnees = await reponse.json().catch(() => null);
  if (!reponse.ok) throw lireErreur(reponse.status, donnees);
  return donnees;
}

// R9 : une Idempotency-Key par opération. On la garde si le réseau coupe, pour que le renvoi ne débite pas deux fois.
function cleDe(formulaire) {
  if (!formulaire.dataset.cle) formulaire.dataset.cle = crypto.randomUUID();
  return formulaire.dataset.cle;
}

function entetesOperation(formulaire) {
  return { "X-Wallet-Id": String(etat.walletId), "Idempotency-Key": cleDe(formulaire) };
}

// ---------- Messages ----------
function afficher(zone, type, titre, texte = "") {
  zone.replaceChildren();
  const message = document.createElement("div");
  message.className = `message message-${type}`;
  const fort = document.createElement("strong");
  fort.textContent = titre;
  message.append(fort);
  if (texte) message.append(document.createTextNode(texte));
  zone.append(message);
}

// Soumission commune : bouton désactivé pendant l'appel, erreurs affichées dans la zone du formulaire.
function brancher(formulaire, action) {
  const zone = $(".retour", formulaire);
  formulaire.addEventListener("input", () => { delete formulaire.dataset.cle; }); // nouvelle saisie : nouvelle clé
  formulaire.addEventListener("submit", async (evenement) => {
    evenement.preventDefault();
    const bouton = $("button[type=submit]", formulaire);
    bouton.disabled = true;
    try {
      await action(new FormData(formulaire), zone);
      delete formulaire.dataset.cle;
    } catch (erreur) {
      if (!(erreur instanceof ErreurApi)) console.error(erreur);
      if (erreur instanceof ErreurApi && !erreur.reseau) delete formulaire.dataset.cle;
      if (erreur.titre) afficher(zone, "erreur", erreur.titre, ` ${erreur.message}`);
      else afficher(zone, "erreur", erreur.message);
    } finally {
      bouton.disabled = false;
    }
  });
}

// ---------- Wallets ----------
async function chargerWallets() {
  const reponse = await api("/graphql", {
    methode: "POST",
    corps: { query: "{ wallets(limite: 100) { id nom type region solde } }" },
  });
  etat.wallets = reponse.data?.wallets ?? [];
  if (!etat.wallets.some((w) => w.id === etat.walletId)) etat.walletId = etat.wallets[0]?.id ?? null;
  afficherWallets();
}

function walletCourant() {
  return etat.wallets.find((w) => w.id === etat.walletId) ?? null;
}

function afficherWallets() {
  const choix = $("#choix-wallet");
  choix.replaceChildren();
  for (const [type, titre] of [["client", "Clients"], ["marchand", "Marchands"]]) {
    const liste = etat.wallets.filter((w) => w.type === type);
    if (!liste.length) continue;
    const groupe = document.createElement("optgroup");
    groupe.label = titre;
    for (const w of liste) groupe.append(new Option(`${w.nom} (n°${w.id})`, w.id, false, w.id === etat.walletId));
    choix.append(groupe);
  }
  const wallet = walletCourant();
  const aucun = !wallet;
  choix.disabled = aucun;
  $("#bloc-solde").hidden = aucun;
  $("#vide-wallet").hidden = !aucun;
  if (aucun) $("#nouveau-wallet").open = true;
  $$(".operations button[type=submit]").forEach((b) => { b.disabled = aucun; });
  if (wallet) {
    $("#solde-montant").textContent = francs.format(Number(wallet.solde));
    $("#solde-infos").textContent = `${wallet.type === "marchand" ? "Marchand" : "Client"} à ${wallet.region}`;
    memoire.ecrire("gopay.wallet", String(wallet.id));
    completerTelephone(wallet.id);
  }
  afficherMarchands();
}

// Le téléphone n'est pas dans GraphQL (donnée privée) : on le lit avec la route REST du wallet.
async function completerTelephone(walletId) {
  try {
    const w = await api(`/v1/wallets/${walletId}`);
    if (w.id === etat.walletId) $("#solde-infos").textContent = `${telephone(w.telephone)}, ${w.type === "marchand" ? "marchand" : "client"} à ${w.region}`;
  } catch { /* l'affichage simple suffit */ }
}

function afficherMarchands() {
  const choix = $("#paiement-marchand");
  const marchands = etat.wallets.filter((w) => w.type === "marchand" && w.id !== etat.walletId);
  choix.replaceChildren(...marchands.map((m) => new Option(`${m.nom} (n°${m.id})`, m.id)));
  if (!marchands.length) choix.append(new Option("Aucun marchand : ouvrez un wallet marchand", "", true, true));
  choix.disabled = !marchands.length;
}

$("#choix-wallet").addEventListener("change", (e) => {
  etat.walletId = Number(e.target.value);
  afficherWallets();
  if (!$("#panneau-historique").hidden) chargerHistorique();
});

brancher($("#form-wallet"), async (donnees, zone) => {
  const wallet = await api("/v1/wallets", {
    methode: "POST",
    corps: {
      nom: donnees.get("nom").trim(),
      telephone: sansEspaces(donnees.get("telephone")),
      type: donnees.get("type"),
      region: donnees.get("region"),
    },
  });
  etat.walletId = wallet.id;
  await chargerWallets();
  $("#form-wallet").reset();
  afficher(zone, "ok", `Wallet de ${wallet.nom} ouvert.`, ` Numéro de wallet : ${wallet.id}.`);
});

// ---------- Onglets ----------
const onglets = $$(".onglet");
function ouvrirOnglet(onglet) {
  for (const o of onglets) {
    const actif = o === onglet;
    o.setAttribute("aria-selected", String(actif));
    o.tabIndex = actif ? 0 : -1;
    $(`#${o.getAttribute("aria-controls")}`).hidden = !actif;
  }
  if (onglet.id === "onglet-historique") chargerHistorique();
}
onglets.forEach((o, i) => {
  o.addEventListener("click", () => ouvrirOnglet(o));
  o.addEventListener("keydown", (e) => {
    const pas = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!pas) return;
    const suivant = onglets[(i + pas + onglets.length) % onglets.length];
    suivant.focus();
    ouvrirOnglet(suivant);
  });
});

// ---------- Le ticket de retrait et son suivi en direct (SSE) ----------
function ticket(transfert, lignes) {
  const t = $("#modele-ticket").content.firstElementChild.cloneNode(true);
  const code = $(".ticket-code", t);
  code.setAttribute("aria-label", `Code ${transfert.code_retrait.split("").join(" ")}`);
  [...transfert.code_retrait].forEach((c, i) => {
    const chiffre = document.createElement("span");
    chiffre.className = "chiffre";
    chiffre.textContent = c;
    chiffre.style.animationDelay = `${i * 70}ms`;
    chiffre.setAttribute("aria-hidden", "true");
    code.append(chiffre);
  });
  const details = $(".ticket-details", t);
  for (const [terme, valeur] of lignes) {
    const dt = document.createElement("dt");
    dt.textContent = terme;
    const dd = document.createElement("dd");
    dd.textContent = valeur;
    details.append(dt, dd);
  }
  suivre(transfert.id, t);
  return t;
}

function marquerSuivi(t, statut) {
  const attente = $('[data-etape="en_attente"]', t);
  const retire = $('[data-etape="retire"]', t);
  if (statut === "retire") {
    attente.dataset.etat = "fait";
    retire.dataset.etat = "fait";
    $(".suivi-texte", retire).textContent = `Retiré en espèces à ${new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  } else {
    attente.dataset.etat = "actif";
  }
}

function suivre(transfertId, t) {
  etat.suivi?.close();
  const source = new EventSource(`/v1/transferts/${transfertId}/suivi`);
  source.addEventListener("statut", (e) => {
    const { statut } = JSON.parse(e.data);
    marquerSuivi(t, statut);
    if (statut === "retire") source.close(); // sinon le navigateur se reconnecte
  });
  etat.suivi = source;
}

// ---------- Envoyer ----------
const montantEnvoi = $("#envoi-montant");
montantEnvoi.addEventListener("input", () => {
  const montant = Math.floor(Number(montantEnvoi.value));
  const apercu = $("#envoi-apercu");
  const bouton = $("#envoi-bouton");
  if (montant >= 100) {
    const frais = fraisDe(montant);
    apercu.innerHTML = `Frais : <strong>${fcfa(frais)}</strong>. Total débité : <strong>${fcfa(montant + frais)}</strong>.`;
    bouton.textContent = `Envoyer ${fcfa(montant)}`;
  } else {
    apercu.textContent = "100 FCFA minimum. Frais de 1 %, 50 FCFA au moins.";
    bouton.textContent = "Envoyer";
  }
});

brancher($("#form-envoyer"), async (donnees, zone) => {
  const formulaire = $("#form-envoyer");
  const transfert = await api("/v1/transferts", {
    methode: "POST",
    entetes: entetesOperation(formulaire),
    corps: { beneficiaire_tel: sansEspaces(donnees.get("beneficiaire_tel")), montant: donnees.get("montant") },
  });
  zone.replaceChildren(ticket(transfert, [
    ["Bénéficiaire", telephone(transfert.beneficiaire_tel)],
    ["Montant", fcfa(transfert.montant)],
    ["Frais", fcfa(transfert.frais)],
    ["Total débité", fcfa(transfert.total_debite)],
  ]));
  await chargerWallets();
});

// ---------- Payer ----------
brancher($("#form-payer"), async (donnees, zone) => {
  const formulaire = $("#form-payer");
  const marchand = etat.wallets.find((w) => w.id === Number(donnees.get("marchand_id")));
  const transaction = await api("/v1/paiements", {
    methode: "POST",
    entetes: entetesOperation(formulaire),
    corps: { marchand_id: Number(donnees.get("marchand_id")), montant: donnees.get("montant") },
  });
  await chargerWallets();
  afficher(zone, "ok", `${fcfa(transaction.montant)} payés à ${marchand?.nom ?? "ce marchand"}.`, ` Nouveau solde : ${fcfa(transaction.solde_apres)}.`);
});

// ---------- Déposer ----------
$$(".montants-rapides button").forEach((b) => b.addEventListener("click", () => {
  $("#depot-montant").value = b.dataset.montant;
  $("#depot-montant").focus();
}));

brancher($("#form-deposer"), async (donnees, zone) => {
  const transaction = await api(`/v1/wallets/${etat.walletId}/depots`, {
    methode: "POST",
    corps: { montant: donnees.get("montant") },
  });
  await chargerWallets();
  afficher(zone, "ok", `${fcfa(transaction.montant)} déposés.`, ` Nouveau solde : ${fcfa(transaction.solde_apres)}.`);
});

// ---------- Depuis l'étranger ----------
const formDiaspora = $("#form-diaspora");
function apercuDiaspora() {
  const devise = new FormData(formDiaspora).get("devise");
  const montant = Number($("#diaspora-montant").value);
  const apercu = $("#diaspora-apercu");
  if (devise === "EUR" && montant > 0) {
    apercu.innerHTML = `Environ <strong>${fcfa(Math.round(montant * 655.957))}</strong> pour le bénéficiaire (1 euro = 655,957 FCFA).`;
  } else if (devise === "EUR") {
    apercu.textContent = "1 euro vaut 655,957 FCFA (parité fixe).";
  } else {
    apercu.textContent = "Le taux du dollar varie : il est fixé au moment de l'envoi.";
  }
}
formDiaspora.addEventListener("input", apercuDiaspora);

brancher(formDiaspora, async (donnees, zone) => {
  const resultat = await api("/v1/transferts-diaspora", {
    methode: "POST",
    entetes: entetesOperation(formDiaspora),
    corps: {
      beneficiaire_tel: sansEspaces(donnees.get("beneficiaire_tel")),
      devise: donnees.get("devise"),
      montant_devise: donnees.get("montant_devise"),
    },
  });
  const t = resultat.transfert;
  const conversion = document.createElement("p");
  conversion.className = "conversion";
  conversion.textContent = `${decimales.format(Number(resultat.montant_devise))} ${resultat.devise} au taux de ${decimales.format(Number(resultat.taux))} donnent ${fcfa(t.montant)}.`;
  zone.replaceChildren(ticket(t, [
    ["Bénéficiaire", telephone(t.beneficiaire_tel)],
    ["Reçu en espèces", fcfa(t.montant)],
    ["Frais", fcfa(t.frais)],
  ]), conversion);
  await chargerWallets();
});

// ---------- Historique ----------
async function chargerHistorique(suite = false) {
  const liste = $("#historique");
  const zone = $("#historique-retour");
  const plus = $("#historique-plus");
  if (!etat.walletId) { liste.replaceChildren(); return; }
  if (!suite) etat.curseur = null;
  const filtres = new FormData($("#form-historique"));
  const parametres = new URLSearchParams({ limit: "10" });
  for (const nom of ["type", "du", "au"]) if (filtres.get(nom)) parametres.set(nom, filtres.get(nom));
  if (etat.curseur) parametres.set("cursor", etat.curseur);
  try {
    const page = await api(`/v1/wallets/${etat.walletId}/transactions?${parametres}`);
    zone.replaceChildren();
    if (!suite) liste.replaceChildren();
    for (const t of page.items) liste.append(ligneHistorique(t));
    if (!liste.children.length) {
      const vide = document.createElement("li");
      vide.className = "historique-vide";
      vide.textContent = filtres.get("type") || filtres.get("du") || filtres.get("au")
        ? "Aucune opération ne correspond à ces filtres."
        : "Aucune opération pour l'instant. Commencez par un dépôt.";
      liste.append(vide);
    }
    etat.curseur = page.next_cursor;
    plus.hidden = !page.next_cursor;
  } catch (erreur) {
    afficher(zone, "erreur", erreur.message);
  }
}

function ligneHistorique(t) {
  const li = document.createElement("li");
  const entree = ENTREES.has(t.type);
  const neutre = t.type === "transfert_diaspora"; // aucun wallet débité
  const signe = neutre ? "" : entree ? "+" : "−";
  const quand = new Date(t.cree_le).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
  const details = [Number(t.frais) > 0 ? `frais ${fcfa(t.frais)}` : "", neutre ? "payé en devise" : `solde ${fcfa(t.solde_apres)}`].filter(Boolean).join(", ");
  li.innerHTML = `
    <span class="operation-libelle"></span>
    <span class="operation-montant" data-sens="${entree ? "entree" : "sortie"}"></span>
    <span class="operation-date"></span>
    <span class="operation-detail"></span>`;
  $(".operation-libelle", li).textContent = LIBELLES[t.type] ?? t.type;
  $(".operation-montant", li).textContent = `${signe}${fcfa(t.montant)}`;
  $(".operation-date", li).textContent = quand;
  $(".operation-detail", li).textContent = details;
  return li;
}

$("#form-historique").addEventListener("submit", (e) => { e.preventDefault(); chargerHistorique(); });
$("#historique-plus").addEventListener("click", () => chargerHistorique(true));

// ---------- Espace agent : alertes en WebSocket et retraits ----------
function connecterAgent(agentId) {
  const etatFlux = $("#flux-etat");
  const bouton = $("#agent-bouton");
  const protocole = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${protocole}://${location.host}/ws/agents/${agentId}`);
  etat.agent = ws;
  etatFlux.textContent = "Connexion en cours.";
  ws.addEventListener("open", () => {
    etatFlux.dataset.etat = "ok";
    etatFlux.textContent = `Alertes activées pour l'agent n°${agentId}.`;
    bouton.textContent = "Arrêter les alertes";
  });
  ws.addEventListener("message", (e) => {
    const message = JSON.parse(e.data);
    if (message.type === "transfert") ajouterAlerte(message);
  });
  ws.addEventListener("close", () => {
    if (etat.agent !== ws) return;
    etat.agent = null;
    delete etatFlux.dataset.etat;
    etatFlux.textContent = "Alertes arrêtées.";
    bouton.textContent = "Recevoir les alertes";
  });
}

function ajouterAlerte({ transfert_id: id, montant }) {
  $("#vide-alertes").hidden = true;
  const li = document.createElement("li");
  li.className = "alerte alerte-nouvelle";
  li.dataset.transfert = id;
  li.innerHTML = `<span class="alerte-montant"></span><span class="alerte-infos"></span><span class="alerte-statut">À préparer</span>`;
  $(".alerte-montant", li).textContent = fcfa(montant);
  $(".alerte-infos", li).textContent = `Transfert n°${id}, reçu à ${new Date().toLocaleTimeString("fr-FR")}`;
  $("#alertes").prepend(li);
}

$("#form-agent").addEventListener("submit", (e) => {
  e.preventDefault();
  if (etat.agent) { etat.agent.close(); return; }
  connecterAgent(Number($("#agent-id").value) || 1);
});

brancher($("#form-retrait"), async (donnees, zone) => {
  const retrait = await api("/v1/retraits", {
    methode: "POST",
    corps: { code_retrait: donnees.get("code_retrait").trim(), beneficiaire_tel: sansEspaces(donnees.get("beneficiaire_tel")) },
  });
  const alerte = $(`.alerte[data-transfert="${retrait.transfert_id}"]`);
  if (alerte) {
    alerte.dataset.etat = "paye";
    $(".alerte-statut", alerte).textContent = "Payé";
  }
  $("#form-retrait").reset();
  afficher(zone, "ok", `Retrait validé : remettez ${fcfa(retrait.montant)} en espèces.`, ` Transfert n°${retrait.transfert_id}.`);
});

$("#retrait-code").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); });

// ---------- Espaces client / agent ----------
function ouvrirEspace(nom) {
  $$(".espace").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.espace === nom)));
  $("#espace-client").hidden = nom !== "client";
  $("#espace-agent").hidden = nom !== "agent";
  memoire.ecrire("gopay.espace", nom);
  if (nom === "client") chargerWallets().catch(() => {});
}
$$(".espace").forEach((b) => b.addEventListener("click", () => ouvrirEspace(b.dataset.espace)));

// ---------- État de l'API ----------
async function verifierApi() {
  const zone = $("#etat-api");
  try {
    const reponse = await fetch("/health");
    if (!reponse.ok) throw new Error();
    zone.dataset.etat = "ok";
    $(".etat-texte", zone).textContent = "API connectée";
  } catch {
    zone.dataset.etat = "ko";
    $(".etat-texte", zone).textContent = "API injoignable";
  }
}

// ---------- Démarrage ----------
$("#wallet-region").replaceChildren(...REGIONS.map((r) => new Option(r, r)));
verifierApi();
setInterval(verifierApi, 10000);
ouvrirEspace(memoire.lire("gopay.espace") === "agent" ? "agent" : "client");
