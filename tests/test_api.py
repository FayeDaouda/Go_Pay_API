"""Les tests de Go Pay (TD3).

Les tests du TD2 viendront s'ajouter ici. FraudCheck et l'envoi des webhooks sont remplacés
par des faux grâce à l'injection de dépendances : aucun serveur externe n'est nécessaire,
sauf pour test_vrai_serveur_grpc, qui démarre lui-même son serveur gRPC.
"""

import asyncio
import json
import time
from collections.abc import Iterator
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

import marchand_demo
from gopay.dependencies import get_antifraude, get_envoyeur, get_repository
from gopay.errors import ServiceIndisponible
from gopay.fraude.client import ClientFraude, Verdict
from gopay.fraude.serveur import demarrer
from gopay.graphql_api import Contexte, schema
from gopay.main import app
from gopay.repository import MemoireRepository
from gopay.services import GoPayService
from gopay.webhooks import signer, verifier

TEL_AWA = "+221770000001"
TEL_MODOU = "+221780000002"
TEL_BOUTIQUE = "+221760000003"


# ---------- Les faux, à la place des services externes ----------
class FauxAntiFraude:
    """Bloque à partir de 1 000 000 FCFA ; peut simuler une panne."""

    def __init__(self, en_panne: bool = False) -> None:
        self.en_panne = en_panne

    def evaluer(self, wallet_id: int, montant: int, beneficiaire_tel: str, region: str) -> Verdict:
        if self.en_panne:
            raise ServiceIndisponible("FraudCheck injoignable (test).")
        return Verdict(score=0.9 if montant >= 1_000_000 else 0.1, bloquer=montant >= 1_000_000, raison="test")


class FauxEnvoyeur:
    """Enregistre les webhooks au lieu de les envoyer."""

    def __init__(self) -> None:
        self.envois: list[tuple[str, str, dict[str, object]]] = []

    def envoyer(self, url: str, secret: str, evenement: dict[str, object]) -> bool:
        self.envois.append((url, secret, evenement))
        return True


# ---------- La fixture et les fonctions d'aide ----------
@pytest.fixture
def client() -> Iterator[TestClient]:
    """Un client de test avec une base vide et un faux FraudCheck, pour chaque test."""
    repo = MemoireRepository()
    app.dependency_overrides[get_repository] = lambda: repo
    app.dependency_overrides[get_antifraude] = lambda: FauxAntiFraude()
    with TestClient(app) as c:  # le « with » partage une seule boucle entre HTTP et WebSocket
        yield c
    app.dependency_overrides.clear()


def ouvrir(client: TestClient, nom: str, telephone: str, depot: int = 0, type_: str = "client") -> int:
    """Ouvre un wallet, fait un dépôt si demandé, et renvoie son identifiant."""
    r = client.post("/v1/wallets", json={"nom": nom, "telephone": telephone, "type": type_})
    assert r.status_code == 201, r.text
    wallet_id: int = r.json()["id"]
    if depot:
        assert client.post(f"/v1/wallets/{wallet_id}/depots", json={"montant": depot}).status_code == 201
    return wallet_id


def entetes(wallet_id: int) -> dict[str, str]:
    return {"X-Wallet-Id": str(wallet_id)}


def solde(client: TestClient, wallet_id: int) -> str:
    valeur: str = client.get(f"/v1/wallets/{wallet_id}").json()["solde"]
    return valeur


# ---------- TD3 partie A : GraphQL ----------
def test_graphql_dataloader_une_seule_lecture() -> None:
    repo = MemoireRepository()
    service = GoPayService(repo)
    for i in range(5):
        wallet = service.ouvrir_wallet(f"Client {i}", f"+22177000000{i}", "client")
        for _ in range(20):
            service.deposer(wallet.id, Decimal("1000"))
    contexte = Contexte(repo)
    resultat = asyncio.run(
        schema.execute("{ transactions(limite: 100) { montant wallet { nom } } }", context_value=contexte)
    )
    assert resultat.errors is None
    assert resultat.data is not None and len(resultat.data["transactions"]) == 100
    assert contexte.lectures_wallets == 1  # 100 transactions, 5 wallets, UNE seule lecture groupée


def test_graphql_par_http(client: TestClient) -> None:
    ouvrir(client, "Awa", TEL_AWA, depot=20000)
    r = client.post("/graphql", json={"query": "{ wallets { nom solde region } }"})
    assert r.json()["data"]["wallets"] == [{"nom": "Awa", "solde": "20000", "region": "Dakar"}]


# ---------- TD3 partie B : gRPC (R12, R13) ----------
def test_transfert_bloque_par_antifraude(client: TestClient) -> None:
    awa = ouvrir(client, "Awa", TEL_AWA, depot=3_000_000)
    r = client.post("/v1/transferts", json={"beneficiaire_tel": TEL_MODOU, "montant": 1_900_000}, headers=entetes(awa))
    assert r.status_code == 422
    assert solde(client, awa) == "3000000"


def test_antifraude_injoignable(client: TestClient) -> None:
    app.dependency_overrides[get_antifraude] = lambda: FauxAntiFraude(en_panne=True)
    awa = ouvrir(client, "Awa", TEL_AWA, depot=200_000)
    petit = client.post("/v1/transferts", json={"beneficiaire_tel": TEL_MODOU, "montant": 10_000}, headers=entetes(awa))
    gros = client.post("/v1/transferts", json={"beneficiaire_tel": TEL_MODOU, "montant": 60_000}, headers=entetes(awa))
    assert petit.status_code == 201  # sous 50 000 FCFA : on laisse passer
    assert gros.status_code == 503  # au-dessus : on refuse


def test_vrai_serveur_grpc() -> None:
    serveur = demarrer(port=50071)
    try:
        client_fraude = ClientFraude("localhost:50071")
        assert client_fraude.evaluer(1, 15_000, TEL_MODOU, "Dakar").bloquer is False
        assert client_fraude.evaluer(1, 1_900_000, TEL_MODOU, "Dakar").bloquer is True
    finally:
        serveur.stop(0)
    with pytest.raises(ServiceIndisponible):
        ClientFraude("localhost:50071").evaluer(1, 15_000, TEL_MODOU, "Dakar")


# ---------- TD3 partie C : temps réel et webhooks (R14, R15) ----------
def test_agent_prevenu_sans_code_de_retrait(client: TestClient) -> None:
    awa = ouvrir(client, "Awa", TEL_AWA, depot=20000)
    with client.websocket_connect("/ws/agents/7") as ws:
        client.post("/v1/transferts", json={"beneficiaire_tel": TEL_MODOU, "montant": 5000}, headers=entetes(awa))
        message = ws.receive_json()
    assert message["type"] == "transfert"
    assert message["montant"] == "5000"
    assert "code_retrait" not in message


def test_suivi_sse(client: TestClient) -> None:
    awa = ouvrir(client, "Awa", TEL_AWA, depot=20000)
    corps = {"beneficiaire_tel": TEL_MODOU, "montant": 5000}
    transfert = client.post("/v1/transferts", json=corps, headers=entetes(awa)).json()
    client.post("/v1/retraits", json={"code_retrait": transfert["code_retrait"], "beneficiaire_tel": TEL_MODOU})
    with client.stream("GET", f"/v1/transferts/{transfert['id']}/suivi") as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        lignes = [ligne for ligne in r.iter_lines() if ligne.startswith("data:")]
    assert json.loads(lignes[-1].removeprefix("data: "))["statut"] == "retire"


def test_signature_webhook() -> None:
    corps = b'{"event_id": "evt_1", "montant": "45000"}'
    t = int(time.time())
    entete = f"t={t},v1={signer('secret', corps, t)}"
    assert verifier("secret", corps, entete)
    assert not verifier("secret", corps.replace(b"45000", b"95000"), entete)  # corps modifié
    assert not verifier("autre-secret", corps, entete)  # mauvais secret
    vieux = t - 600
    assert not verifier("secret", corps, f"t={vieux},v1={signer('secret', corps, vieux)}")  # trop ancien


def test_paiement_declenche_un_webhook(client: TestClient) -> None:
    envoyeur = FauxEnvoyeur()
    app.dependency_overrides[get_envoyeur] = lambda: envoyeur
    awa = ouvrir(client, "Awa", TEL_AWA, depot=50000)
    boutique = ouvrir(client, "Boutique Ndiaye", TEL_BOUTIQUE, type_="marchand")
    config = client.put(f"/v1/marchands/{boutique}/webhook", json={"url": "http://127.0.0.1:8002/hooks/gopay"}).json()
    client.post("/v1/paiements", json={"marchand_id": boutique, "montant": 45000}, headers=entetes(awa))
    assert len(envoyeur.envois) == 1
    url, secret, evenement = envoyeur.envois[0]
    assert url == "http://127.0.0.1:8002/hooks/gopay"
    assert secret == config["secret"]
    assert evenement["type"] == "paiement.recu" and evenement["montant"] == "45000"


def test_marchand_demo_verifie_et_dedoublonne(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(marchand_demo, "SECRET", "secret-test")
    marchand = TestClient(marchand_demo.app)
    corps = json.dumps({"event_id": "evt_test_1", "montant": "45000", "client_id": 1}).encode()
    t = int(time.time())
    entetes_ok = {"GoPay-Signature": f"t={t},v1={signer('secret-test', corps, t)}"}
    assert marchand.post("/hooks/gopay", content=corps, headers=entetes_ok).json() == {"statut": "recu"}
    assert marchand.post("/hooks/gopay", content=corps, headers=entetes_ok).json() == {"statut": "deja_traite"}
    faux = {"GoPay-Signature": f"t={t},v1=0000"}
    assert marchand.post("/hooks/gopay", content=corps, headers=faux).status_code == 401
