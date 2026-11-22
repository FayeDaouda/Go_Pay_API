"""Les objets métier de Go Pay, tels qu'ils sont stockés en interne."""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal


def maintenant() -> datetime:
    """L'heure actuelle en UTC."""
    return datetime.now(UTC)


@dataclass
class Wallet:
    """Un porte-monnaie électronique, client ou marchand."""

    id: int
    nom: str
    telephone: str
    type: str  # "client" ou "marchand"
    region: str = "Dakar"
    solde: Decimal = Decimal("0")
    cree_le: datetime = field(default_factory=maintenant)


@dataclass
class Transfert:
    """Un envoi d'argent, retiré en espèces avec un code à 6 chiffres."""

    id: int
    expediteur_id: int
    beneficiaire_tel: str
    montant: Decimal
    frais: Decimal
    code_retrait: str
    statut: str = "en_attente"  # "en_attente" puis "retire"
    cree_le: datetime = field(default_factory=maintenant)


@dataclass
class Transaction:
    """Une ligne de l'historique d'un wallet."""

    id: int
    wallet_id: int
    type: str  # "depot", "transfert", "paiement_envoye", "paiement_recu"
    montant: Decimal
    frais: Decimal
    solde_apres: Decimal
    reference: str | None = None
    cree_le: datetime = field(default_factory=maintenant)
