"""Les dépendances injectées dans les routes avec Depends."""

import os
from typing import Annotated

from fastapi import Depends, Header

from gopay.change import ClientChange
from gopay.fraude.client import ClientFraude
from gopay.idempotence import StockIdempotence
from gopay.models import Wallet
from gopay.repository import MemoireRepository
from gopay.services import AntiFraude, GoPayService
from gopay.webhooks import EnvoyeurWebhooks

_repo = MemoireRepository(latence=0.005)  # 5 ms, comme une vraie base de données
_idempotence = StockIdempotence()
_change = ClientChange(os.environ.get("GOPAY_CHANGE_URL", "http://127.0.0.1:8001"))
_antifraude = ClientFraude(os.environ.get("GOPAY_FRAUDE_ADRESSE", "localhost:50051"))
_envoyeur = EnvoyeurWebhooks()


def get_repository() -> MemoireRepository:
    """Le stockage partagé par toute l'application."""
    return _repo


def get_antifraude() -> AntiFraude:
    """Le client FraudCheck ; remplacé par un faux dans les tests."""
    return _antifraude


def get_service(
    repo: Annotated[MemoireRepository, Depends(get_repository)],
    antifraude: Annotated[AntiFraude, Depends(get_antifraude)],
) -> GoPayService:
    """Le service métier, construit à chaque requête avec ses dépendances."""
    return GoPayService(repo, antifraude)


def get_idempotence() -> StockIdempotence:
    """Le stock des Idempotency-Key déjà traitées."""
    return _idempotence


def get_change() -> ClientChange:
    """Le client du service de change ; remplacé par un faux dans les tests."""
    return _change


Service = Annotated[GoPayService, Depends(get_service)]
Idempotence = Annotated[StockIdempotence, Depends(get_idempotence)]
Change = Annotated[ClientChange, Depends(get_change)]
CleIdempotence = Annotated[str, Header(alias="Idempotency-Key", min_length=8, max_length=100)]


def wallet_courant(service: Service, x_wallet_id: Annotated[int, Header()]) -> Wallet:
    """Le wallet de l'utilisateur, lu dans l'en-tête X-Wallet-Id (remplacé par un jeton JWT plus tard)."""
    return service.lire_wallet(x_wallet_id)


WalletCourant = Annotated[Wallet, Depends(wallet_courant)]


def get_envoyeur() -> EnvoyeurWebhooks:
    """L'envoyeur de webhooks ; remplacé par un faux dans les tests."""
    return _envoyeur


Envoyeur = Annotated[EnvoyeurWebhooks, Depends(get_envoyeur)]
