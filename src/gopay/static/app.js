// Go Pay : l'interface web. Elle parle à l'API servie par le même serveur (même origine, pas de CORS).

const $ = (selecteur, racine = document) => racine.querySelector(selecteur);
const $$ = (selecteur, racine = document) => [...racine.querySelectorAll(selecteur)];

const REGIONS = [
  "Dakar", "Thiès", "Diourbel", "Saint-Louis", "Louga", "Kaolack", "Fatick",
  "Kaffrine", "Ziguinchor", "Kolda", "Sédhiou", "Tambacounda", "Kédougou", "Matam",
];

// Pour chaque type d'opération : son libellé, son icône et son sens (entrée ou sortie d'argent)
const OPERATIONS = {
  depot: { libelle: "Dépôt", court: "Dépôt", icone: "i-deposer", sens: "entree" },
  transfert: { libelle: "Transfert envoyé", court: "Transfert", icone: "i-envoyer", sens: "sortie" },
  transfert_diaspora: { libelle: "Envoi depuis l'étranger", court: "De l'étranger", icone: "i-monde", sens: "neutre" },
  paiement_envoye: { libelle: "Paiement", court: "Paiement", icone: "i-payer", sens: "sortie" },
  paiement_recu: { libelle: "Paiement reçu", court: "Paiement reçu", icone: "i-payer", sens: "entree" },
};

// ---------- Petites aides ----------
const francs = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const decimales = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 3 });
const fcfa = (valeur) => `${francs.format(Number(valeur))} FCFA`;
const sansEspaces = (texte) => texte.replace(/\s+/g, "");
// +221770000001 devient +221 77 000 00 01, plus facile à lire et à dicter.
const telephone = (t) => t.replace(/^\+221(\d{2})(\d{3})(\d{2})(\d{2})$/, "+221 $1 $2 $3 $4");
const initiales = (nom) => nom.split(/\s+/).filter(Boolean).slice(0, 2).map((m) => m[0].toUpperCase()).join("");

// R2 : 1 % arrondi au franc (une moitié vers le haut), 50 FCFA au minimum. Calcul en entiers.
const fraisDe = (montant) => Math.max(Math.floor((montant + 50) / 100), 50);

function icone(id) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icone");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}

function element(balise, classe, texte) {
  const el = document.createElement(balise);
  if (classe) el.className = classe;
  if (texte !== undefined) el.textContent = texte;
  return el;
}

// Le stockage du navigateur peut être indisponible (navigation privée) : on ne bloque jamais dessus.
const memoire = {
  lire(cle) { try { return localStorage.getItem(cle); } catch { return null; } },
  ecrire(cle, valeur) { try { localStorage.setItem(cle, valeur); } catch { /* sans importance */ } },
};

const etat = {
  wallets: [],
  walletId: Number(memoire.lire("gopay.wallet")) || null,
  soldeMasque: memoire.lire("gopay.masque") === "1",
  curseur: null,
  suivi: null, // l'EventSource du ticket affiché
  agent: null, // la WebSocket de l'agent
  guichet: { recus: 0, payes: 0, aPreparer: new Map() }, // transfert_id -> montant
};

// ---------- Appels à l'API ----------
class ErreurApi extends Error {
  constructor(message, { statut = 0, reseau = false, titre = "" } = {}) {
    super(message);
    this.statut = statut;
    this.reseau = reseau;
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
  if (Array.isArray(corps?.errors) && corps.errors.length) {
    const messages = corps.errors.map((e) => {
      const champ = e.loc?.[e.loc.length - 1];
      if (champ === "montant" && e.type === "greater_than_equal") return "Un transfert fait au moins 100 FCFA.";
      return CHAMPS[champ] ?? `${champ} : ${e.msg}`;
    });
    return new ErreurApi([...new Set(messages)].join(" "), { statut, titre: "Vérifiez le formulaire" });
  }
  let message = corps?.detail ?? `L'API a répondu ${statut}.`;
  if (statut === 503) message += " Réessayez dans un instant.";
  return new ErreurApi(message, { statut, titre: corps?.title ?? "" });
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
    throw new ErreurApi("Vérifiez qu'elle tourne, puis renvoyez : la même opération ne sera pas comptée deux fois.", { reseau: true, titre: "L'API ne répond pas" });
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

// ---------- Messages et notifications ----------
function afficher(zone, type, titre, texte = "") {
  const message = element("div", `message message-${type}`);
  message.append(element("strong", "", titre));
  if (texte) message.append(document.createTextNode(texte));
  zone.replaceChildren(message);
}

function notifier(texte) {
  const zone = $("#notifications");
  const note = element("div", "notification", texte);
  zone.append(note);
  setTimeout(() => note.remove(), 3800);
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

const walletCourant = () => etat.wallets.find((w) => w.id === etat.walletId) ?? null;

function afficherWallets() {
  const wallet = walletCourant();
  const aucun = !wallet;
  $("#bienvenue").hidden = !aucun;
  $("#tableau").hidden = aucun;
  // Le formulaire d'ouverture va là où on en a besoin : la bienvenue, ou la colonne de côté
  (aucun ? $("#place-bienvenue") : $("#place-cote")).append($("#form-wallet"));
  if (aucun) return;

  const heure = new Date().getHours();
  const prenom = wallet.type === "marchand" ? wallet.nom : wallet.nom.split(/\s+/)[0];
  $("#salutation").textContent = `${heure >= 18 || heure < 5 ? "Bonsoir" : "Bonjour"}, ${prenom}`;
  $("#salutation-suite").textContent = wallet.type === "marchand"
    ? "Suivez les paiements de vos clients."
    : "Que voulez-vous faire aujourd'hui ?";
  afficherSolde();
  $("#solde-infos").textContent = `${wallet.type === "marchand" ? "Marchand" : "Client"} à ${wallet.region}`;
  memoire.ecrire("gopay.wallet", String(wallet.id));
  completerTelephone(wallet.id);
  afficherListeWallets();
  afficherMarchands();
  chargerActivite();
}

function afficherSolde() {
  const wallet = walletCourant();
  if (!wallet) return;
  const bouton = $("#masquer-solde");
  $("#solde-montant").textContent = etat.soldeMasque ? "••• •••" : francs.format(Number(wallet.solde));
  bouton.setAttribute("aria-pressed", String(etat.soldeMasque));
  $("use", bouton).setAttribute("href", etat.soldeMasque ? "#i-oeil-barre" : "#i-oeil");
  $("span", bouton).textContent = etat.soldeMasque ? "Afficher" : "Masquer";
}

$("#masquer-solde").addEventListener("click", () => {
  etat.soldeMasque = !etat.soldeMasque;
  memoire.ecrire("gopay.masque", etat.soldeMasque ? "1" : "0");
  afficherSolde();
  afficherListeWallets();
});

// Le téléphone n'est pas dans GraphQL (donnée privée) : on le lit avec la route REST du wallet.
async function completerTelephone(walletId) {
  try {
    const w = await api(`/v1/wallets/${walletId}`);
    if (w.id === etat.walletId) {
      $("#solde-infos").textContent = `${telephone(w.telephone)}, ${w.type === "marchand" ? "marchand" : "client"} à ${w.region}`;
    }
  } catch { /* l'affichage simple suffit */ }
}

function avatar(wallet) {
  const a = element("span", `avatar${wallet.type === "marchand" ? " avatar-marchand" : ""}`, initiales(wallet.nom));
  a.dataset.teinte = String(wallet.id % 4);
  a.setAttribute("aria-hidden", "true");
  return a;
}

function afficherListeWallets() {
  const liste = $("#liste-wallets");
  liste.replaceChildren(...etat.wallets.map((w) => {
    const li = document.createElement("li");
    const bouton = element("button", "wallet");
    bouton.type = "button";
    if (w.id === etat.walletId) bouton.setAttribute("aria-current", "true");
    const texte = element("span");
    texte.append(
      element("span", "wallet-nom", w.nom),
      element("span", "wallet-type", `${w.type === "marchand" ? "Marchand" : "Client"}, ${w.region}`),
    );
    bouton.append(avatar(w), texte, element("span", "wallet-solde", etat.soldeMasque ? "•••" : fcfa(w.solde)));
    bouton.addEventListener("click", () => choisirWallet(w.id));
    li.append(bouton);
    return li;
  }));
}

function choisirWallet(id) {
  etat.walletId = id;
  afficherWallets();
  $$(".panneau .retour").forEach((z) => z.replaceChildren());
  if (!$("#panneau-historique").hidden) chargerHistorique();
}

function afficherMarchands() {
  const choix = $("#paiement-marchand");
  const marchands = etat.wallets.filter((w) => w.type === "marchand" && w.id !== etat.walletId);
  choix.replaceChildren(...marchands.map((m) => new Option(`${m.nom} (n°${m.id})`, m.id)));
  if (!marchands.length) choix.append(new Option("Aucun marchand : ouvrez un wallet marchand", "", true, true));
  choix.disabled = !marchands.length;
}

brancher($("#form-wallet"), async (donnees) => {
  const wallet = await api("/v1/wallets", {
    methode: "POST",
    corps: {
      nom: donnees.get("nom").trim(),
      telephone: sansEspaces(donnees.get("telephone")),
      type: donnees.get("type"),
      region: donnees.get("region"),
    },
  });
  $("#form-wallet").reset();
  $(".retour", $("#form-wallet")).replaceChildren();
  $("#nouveau-wallet").open = false;
  etat.walletId = wallet.id;
  await chargerWallets();
  ouvrirAction($("#onglet-deposer")); // un wallet neuf est vide : la première étape est le dépôt
  notifier(`Wallet de ${wallet.nom} ouvert.`);
});

// ---------- Les numéros récents, proposés en un clic ----------
function lireRecents() {
  try { return JSON.parse(memoire.lire("gopay.recents") ?? "[]"); } catch { return []; }
}

function retenirNumero(numero) {
  const recents = [numero, ...lireRecents().filter((n) => n !== numero)].slice(0, 4);
  memoire.ecrire("gopay.recents", JSON.stringify(recents));
  afficherRecents();
}

function afficherRecents() {
  const recents = lireRecents();
  for (const zone of $$(".recents")) {
    zone.hidden = !recents.length;
    zone.replaceChildren(element("span", "recents-libelle", "Récents :"), ...recents.map((n) => {
      const b = element("button", "", telephone(n));
      b.type = "button";
      b.addEventListener("click", () => {
        const champ = $(`#${zone.dataset.pour}`);
        champ.value = telephone(n);
        champ.dispatchEvent(new Event("input", { bubbles: true }));
      });
      return b;
    }));
  }
}

// ---------- Tuiles d'action (onglets) ----------
const actions = $$(".action");
function ouvrirAction(action) {
  for (const a of actions) {
    const active = a === action;
    a.setAttribute("aria-selected", String(active));
    a.tabIndex = active ? 0 : -1;
    $(`#${a.getAttribute("aria-controls")}`).hidden = !active;
  }
  if (action.id === "onglet-historique") chargerHistorique();
}
actions.forEach((a, i) => {
  a.addEventListener("click", () => ouvrirAction(a));
  a.addEventListener("keydown", (e) => {
    const pas = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!pas) return;
    const suivante = actions[(i + pas + actions.length) % actions.length];
    suivante.focus();
    ouvrirAction(suivante);
  });
});

$("#voir-historique").addEventListener("click", () => {
  ouvrirAction($("#onglet-historique"));
  const doux = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  $(".panneaux").scrollIntoView({ behavior: doux ? "smooth" : "auto", block: "start" });
});

// ---------- Le ticket de retrait et son suivi en direct (SSE) ----------
function ticket(transfert, lignes) {
  const t = $("#modele-ticket").content.firstElementChild.cloneNode(true);
  const code = $(".ticket-code", t);
  code.setAttribute("aria-label", `Code ${transfert.code_retrait.split("").join(" ")}`);
  [...transfert.code_retrait].forEach((c, i) => {
    const chiffre = element("span", "chiffre", c);
    chiffre.style.animationDelay = `${i * 70}ms`;
    chiffre.setAttribute("aria-hidden", "true");
    code.append(chiffre);
  });
  const details = $(".ticket-details", t);
  for (const [terme, valeur] of lignes) details.append(element("dt", "", terme), element("dd", "", valeur));
  suivre(transfert.id, t);
  chargerQr(transfert, t);
  return t;
}

// ---------- Le QR code de retrait ----------
// La route est réservée à l'expéditeur : on envoie son X-Wallet-Id, donc pas de simple <img src>.
async function chargerQr(transfert, t) {
  const boite = $(".ticket-qr", t);
  try {
    const reponse = await fetch(`/v1/transferts/${transfert.id}/qrcode`, {
      headers: { "X-Wallet-Id": String(transfert.expediteur_id) },
    });
    if (!reponse.ok) throw new Error();
    const svg = await reponse.text();
    boite.innerHTML = svg; // SVG produit par notre propre API
    boite.setAttribute("role", "img");
    boite.setAttribute("aria-label", `QR code du retrait, code ${transfert.code_retrait.split("").join(" ")}`);
    preparerPartage(transfert, svg, t);
  } catch {
    boite.replaceChildren(element("span", "ticket-qr-attente", "QR code indisponible : utilisez le code à 6 chiffres."));
  }
}

// Transforme le SVG en image PNG (fond blanc, marge), le format que les messageries acceptent.
async function qrEnPng(svg, taille = 720) {
  const source = svg.replace("<svg ", `<svg width="${taille}" height="${taille}" `);
  const url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const toile = document.createElement("canvas");
    toile.width = toile.height = taille;
    const ctx = toile.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, taille, taille);
    const marge = Math.round(taille * 0.08);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, marge, marge, taille - 2 * marge, taille - 2 * marge);
    return await new Promise((ok) => toile.toBlob(ok, "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// « Partager » sur téléphone (WhatsApp, SMS…), « Enregistrer » sur ordinateur.
function preparerPartage(transfert, svg, t) {
  const bouton = $('[data-role="partager"]', t);
  const nom = `go-pay-retrait-${transfert.id}.png`;
  const peutPartager = Boolean(navigator.canShare?.({ files: [new File([""], nom, { type: "image/png" })] }));
  $("span", bouton).textContent = peutPartager ? "Partager le QR code" : "Enregistrer le QR code";
  bouton.hidden = false;
  bouton.addEventListener("click", async () => {
    const fichier = new File([await qrEnPng(svg)], nom, { type: "image/png" });
    const texte = `Go Pay : ${fcfa(transfert.montant)} à retirer chez un agent. Code de retrait : ${transfert.code_retrait}.`;
    if (peutPartager) {
      try { await navigator.share({ files: [fichier], title: "Retrait Go Pay", text: texte }); } catch { /* partage annulé */ }
      return;
    }
    const lien = element("a");
    lien.href = URL.createObjectURL(fichier);
    lien.download = nom;
    lien.click();
    setTimeout(() => URL.revokeObjectURL(lien.href), 1000);
    notifier("QR code enregistré dans vos téléchargements.");
  });
}

function marquerSuivi(t, statut) {
  const attente = $('[data-etape="en_attente"]', t);
  const retire = $('[data-etape="retire"]', t);
  if (statut === "retire") {
    attente.dataset.etat = "fait";
    retire.dataset.etat = "fait";
    const heure = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    $(".suivi-texte", retire).textContent = `Retiré en espèces à ${heure}`;
    notifier("Le bénéficiaire a retiré l'argent.");
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
  const numero = sansEspaces(donnees.get("beneficiaire_tel"));
  const transfert = await api("/v1/transferts", {
    methode: "POST",
    entetes: entetesOperation(formulaire),
    corps: { beneficiaire_tel: numero, montant: donnees.get("montant") },
  });
  zone.replaceChildren(ticket(transfert, [
    ["Bénéficiaire", telephone(transfert.beneficiaire_tel)],
    ["Montant", fcfa(transfert.montant)],
    ["Frais", fcfa(transfert.frais)],
    ["Total débité", fcfa(transfert.total_debite)],
  ]));
  retenirNumero(numero);
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
  notifier("Paiement effectué.");
});

// ---------- Déposer ----------
$$(".pastilles-montant button").forEach((b) => b.addEventListener("click", () => {
  $("#depot-montant").value = b.dataset.montant;
  $("#depot-montant").focus();
}));

brancher($("#form-deposer"), async (donnees, zone) => {
  const transaction = await api(`/v1/wallets/${etat.walletId}/depots`, {
    methode: "POST",
    corps: { montant: donnees.get("montant") },
  });
  await chargerWallets();
  $("#form-deposer").reset();
  afficher(zone, "ok", `${fcfa(transaction.montant)} déposés.`, ` Nouveau solde : ${fcfa(transaction.solde_apres)}.`);
  notifier("Dépôt effectué.");
});

// ---------- Depuis l'étranger ----------
const formDiaspora = $("#form-diaspora");
formDiaspora.addEventListener("input", () => {
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
});

brancher(formDiaspora, async (donnees, zone) => {
  const numero = sansEspaces(donnees.get("beneficiaire_tel"));
  const resultat = await api("/v1/transferts-diaspora", {
    methode: "POST",
    entetes: entetesOperation(formDiaspora),
    corps: { beneficiaire_tel: numero, devise: donnees.get("devise"), montant_devise: donnees.get("montant_devise") },
  });
  const t = resultat.transfert;
  const conversion = element("p", "conversion",
    `${decimales.format(Number(resultat.montant_devise))} ${resultat.devise} au taux de ${decimales.format(Number(resultat.taux))} donnent ${fcfa(t.montant)}.`);
  zone.replaceChildren(ticket(t, [
    ["Bénéficiaire", telephone(t.beneficiaire_tel)],
    ["Reçu en espèces", fcfa(t.montant)],
    ["Frais", fcfa(t.frais)],
  ]), conversion);
  retenirNumero(numero);
  await chargerWallets();
});

// ---------- Activité récente et historique ----------
// Date courte pour l'activité récente : l'heure si c'est aujourd'hui, sinon le jour.
function dateCourte(iso) {
  const d = new Date(iso);
  if (d.toDateString() === new Date().toDateString()) {
    return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

function ligneOperation(t, compacte = false) {
  const info = OPERATIONS[t.type] ?? { libelle: t.type, court: t.type, icone: "i-historique", sens: "sortie" };
  const li = document.createElement("li");
  const pastille = element("span", "operation-pastille");
  pastille.dataset.sens = info.sens;
  pastille.append(icone(info.icone));
  const signe = { entree: "+", sortie: "−", neutre: "" }[info.sens];
  const quand = compacte
    ? dateCourte(t.cree_le)
    : new Date(t.cree_le).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
  const details = [
    Number(t.frais) > 0 ? `frais ${fcfa(t.frais)}` : "",
    info.sens === "neutre" ? "payé en devise" : `solde ${fcfa(t.solde_apres)}`,
  ].filter(Boolean).join(", ");
  const montant = element("span", "operation-montant", `${signe}${fcfa(t.montant)}`);
  montant.dataset.sens = info.sens;
  li.append(pastille, element("span", "operation-libelle", compacte ? info.court ?? info.libelle : info.libelle), montant,
    element("span", "operation-date", quand), element("span", "operation-detail", details));
  return li;
}

const listeVide = (texte) => element("li", "liste-vide", texte);

async function chargerActivite() {
  const liste = $("#activite");
  try {
    const page = await api(`/v1/wallets/${etat.walletId}/transactions?limit=4`);
    liste.replaceChildren(...(page.items.length
      ? page.items.map((t) => ligneOperation(t, true))
      : [listeVide("Aucune opération pour l'instant. Commencez par un dépôt.")]));
    $("#voir-historique").hidden = !page.items.length;
  } catch {
    liste.replaceChildren(listeVide("L'activité n'a pas pu être chargée."));
  }
}

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
    liste.append(...page.items.map((t) => ligneOperation(t)));
    if (!liste.children.length) {
      const filtre = filtres.get("type") || filtres.get("du") || filtres.get("au");
      liste.append(listeVide(filtre ? "Aucune opération ne correspond à ces filtres." : "Aucune opération pour l'instant. Commencez par un dépôt."));
    }
    etat.curseur = page.next_cursor;
    plus.hidden = !page.next_cursor;
  } catch (erreur) {
    afficher(zone, "erreur", erreur.titre || erreur.message, erreur.titre ? ` ${erreur.message}` : "");
  }
}

$("#form-historique").addEventListener("submit", (e) => { e.preventDefault(); chargerHistorique(); });
$("#historique-plus").addEventListener("click", () => chargerHistorique(true));

// ---------- Espace agent : alertes en WebSocket et retraits ----------
function afficherGuichet() {
  const g = etat.guichet;
  $("#stat-recus").textContent = francs.format(g.recus);
  $("#stat-payes").textContent = francs.format(g.payes);
  $("#stat-especes").textContent = fcfa([...g.aPreparer.values()].reduce((a, b) => a + b, 0));
}

function connecterAgent(agentId) {
  const etatFlux = $("#flux-etat");
  const libelle = $("#agent-bouton span");
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/agents/${agentId}`);
  etat.agent = ws;
  etatFlux.textContent = "Connexion en cours.";
  ws.addEventListener("open", () => {
    etatFlux.dataset.etat = "ok";
    etatFlux.textContent = `Alertes activées pour l'agent n°${agentId}. Les nouveaux transferts arrivent ici en direct.`;
    libelle.textContent = "Arrêter les alertes";
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
    libelle.textContent = "Recevoir les alertes";
  });
}

function ajouterAlerte({ transfert_id: id, montant }) {
  $("#vide-alertes").hidden = true;
  const li = element("li", "alerte alerte-nouvelle");
  li.dataset.transfert = id;
  const heure = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  li.append(
    element("span", "alerte-montant", fcfa(montant)),
    element("span", "alerte-infos", `Transfert n°${id}, reçu à ${heure}`),
    element("span", "alerte-statut", "À préparer"),
  );
  $("#alertes").prepend(li);
  etat.guichet.recus += 1;
  etat.guichet.aPreparer.set(String(id), Number(montant));
  afficherGuichet();
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
  etat.guichet.payes += 1;
  etat.guichet.aPreparer.delete(String(retrait.transfert_id));
  afficherGuichet();
  $("#form-retrait").reset();
  $("#lecture-retour").replaceChildren();
  afficher(zone, "ok", `Retrait validé : remettez ${fcfa(retrait.montant)} en espèces.`, ` Transfert n°${retrait.transfert_id}.`);
  notifier("Retrait validé.");
});

$("#retrait-code").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); });

// ---------- Lecture du QR code par l'agent ----------
// Le navigateur sait parfois lire les QR codes lui-même (BarcodeDetector) ; sinon on charge jsQR.
let detecteur = null;
async function detecteurNatif() {
  if (detecteur !== null) return detecteur;
  detecteur = false;
  if ("BarcodeDetector" in window) {
    try {
      if ((await BarcodeDetector.getSupportedFormats()).includes("qr_code")) {
        detecteur = new BarcodeDetector({ formats: ["qr_code"] });
      }
    } catch { /* pas de détecteur natif */ }
  }
  return detecteur;
}

let promesseJsQR = null;
function chargerJsQR() {
  promesseJsQR ??= new Promise((ok, echec) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";
    script.onload = () => ok(window.jsQR);
    script.onerror = () => { promesseJsQR = null; echec(new Error("jsQR")); };
    document.head.append(script);
  });
  return promesseJsQR;
}

const toileLecture = document.createElement("canvas");
// Lit un QR code dans une image ou une vidéo ; renvoie le texte, ou null si rien n'est trouvé.
async function decoderQr(source, largeur, hauteur) {
  const natif = await detecteurNatif();
  if (natif) {
    const trouves = await natif.detect(source);
    return trouves[0]?.rawValue ?? null;
  }
  const jsQR = await chargerJsQR();
  toileLecture.width = largeur;
  toileLecture.height = hauteur;
  const ctx = toileLecture.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, largeur, hauteur);
  return jsQR(ctx.getImageData(0, 0, largeur, hauteur).data, largeur, hauteur)?.data ?? null;
}

// Le QR code contient gopay://retrait?code=123456&tel=... ; un simple code à 6 chiffres est accepté aussi.
function lireContenuRetrait(texte) {
  try {
    const adresse = new URL(texte);
    const code = adresse.searchParams.get("code") ?? "";
    if (adresse.protocol === "gopay:" && /^\d{6}$/.test(code)) return { code, tel: adresse.searchParams.get("tel") };
  } catch { /* ce n'est pas une adresse */ }
  const brut = texte.trim();
  return /^\d{6}$/.test(brut) ? { code: brut, tel: null } : null;
}

function remplirRetrait(texte) {
  const zone = $("#lecture-retour");
  const retrait = lireContenuRetrait(texte);
  if (!retrait) {
    afficher(zone, "erreur", "Ce QR code n'est pas un retrait Go Pay.", " Demandez au bénéficiaire son code à 6 chiffres.");
    return;
  }
  $("#retrait-code").value = retrait.code;
  if (retrait.tel) $("#retrait-tel").value = telephone(retrait.tel);
  afficher(zone, "ok", "QR code lu.", " Vérifiez le numéro avec le bénéficiaire, puis validez le retrait.");
  $("#form-retrait button[type=submit]").focus();
}

// La caméra : on cherche un QR code quatre fois par seconde jusqu'à en trouver un.
const scanner = $("#scanner");
let flux = null;
async function ouvrirScanner() {
  const video = $("#scanner-video");
  const etatScanner = $("#scanner-etat");
  etatScanner.textContent = "Ouverture de la caméra.";
  scanner.showModal();
  try {
    const camera = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    if (!scanner.open) { // la fenêtre a été fermée pendant la demande d'autorisation : on éteint la caméra
      camera.getTracks().forEach((piste) => piste.stop());
      return;
    }
    flux = camera;
    video.srcObject = flux;
    await video.play();
    etatScanner.textContent = "Recherche d'un QR code.";
    while (scanner.open && flux) {
      if (video.readyState >= 2) {
        const texte = await decoderQr(video, video.videoWidth, video.videoHeight).catch(() => null);
        if (texte) {
          fermerScanner();
          remplirRetrait(texte);
          return;
        }
      }
      await new Promise((ok) => setTimeout(ok, 250));
    }
  } catch {
    etatScanner.textContent = "Caméra indisponible. Importez une photo du QR code ou saisissez le code.";
  }
}

function fermerScanner() {
  flux?.getTracks().forEach((piste) => piste.stop());
  flux = null;
  if (scanner.open) scanner.close();
}

$("#scanner-ouvrir").addEventListener("click", ouvrirScanner);
$("#scanner-fermer").addEventListener("click", fermerScanner);
scanner.addEventListener("close", fermerScanner);

$("#qr-photo").addEventListener("change", async (e) => {
  const fichier = e.target.files?.[0];
  e.target.value = "";
  if (!fichier) return;
  const zone = $("#lecture-retour");
  try {
    const image = await createImageBitmap(fichier);
    const texte = await decoderQr(image, image.width, image.height);
    if (texte) remplirRetrait(texte);
    else afficher(zone, "erreur", "Aucun QR code trouvé sur cette photo.", " Essayez une photo plus nette, ou saisissez le code.");
  } catch {
    afficher(zone, "erreur", "Cette photo n'a pas pu être lue.", " Saisissez le code à 6 chiffres.");
  }
});

// ---------- Espaces client / agent ----------
function ouvrirEspace(nom) {
  $$(".espace").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.espace === nom)));
  $("#espace-client").hidden = nom !== "client";
  $("#espace-agent").hidden = nom !== "agent";
  memoire.ecrire("gopay.espace", nom);
  if (nom === "client") chargerWallets().catch(() => afficherWallets()); // API injoignable : on montre la bienvenue
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
afficherRecents();
afficherGuichet();
verifierApi();
setInterval(verifierApi, 10000);
ouvrirEspace(memoire.lire("gopay.espace") === "agent" ? "agent" : "client");
