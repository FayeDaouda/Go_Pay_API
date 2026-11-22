"""Les routes des opérations : transferts, retraits, paiements."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, BackgroundTasks

from gopay.dependencies import Envoyeur, Service, WalletCourant
from gopay.schemas import PaiementIn, RetraitIn, RetraitOut, TransactionOut, TransfertIn, TransfertOut
from gopay.temps_reel import agents

router = APIRouter(prefix="/v1", tags=["Opérations"])


@router.post("/transferts", status_code=201)
def creer_transfert(
    data: TransfertIn, wallet: WalletCourant, service: Service, taches: BackgroundTasks
) -> TransfertOut:
    transfert = service.transferer(wallet, data.beneficiaire_tel, data.montant)
    alerte = {"type": "transfert", "transfert_id": transfert.id, "montant": str(transfert.montant)}
    taches.add_task(agents.diffuser, alerte)  # R14 : jamais le code de retrait
    return TransfertOut.model_validate(transfert)


@router.post("/retraits", status_code=201)
def retirer(data: RetraitIn, service: Service) -> RetraitOut:
    transfert = service.retirer(data.code_retrait, data.beneficiaire_tel)
    return RetraitOut(transfert_id=transfert.id, montant=transfert.montant, statut="retire")


@router.post("/paiements", status_code=201)
def payer(
    data: PaiementIn, wallet: WalletCourant, service: Service, taches: BackgroundTasks, envoyeur: Envoyeur
) -> TransactionOut:
    transaction = service.payer(wallet, data.marchand_id, data.montant)
    webhook = service.repo.webhooks.get(data.marchand_id)
    if webhook is not None:  # R15 : prévenir le marchand, après la réponse
        url, secret = webhook
        evenement = {
            "event_id": f"evt_{uuid.uuid4().hex[:12]}",
            "type": "paiement.recu",
            "montant": str(data.montant),
            "marchand_id": data.marchand_id,
            "client_id": wallet.id,
            "cree_le": datetime.now(UTC).isoformat(),
        }
        taches.add_task(envoyeur.envoyer, url, secret, evenement)
    return TransactionOut.model_validate(transaction)
