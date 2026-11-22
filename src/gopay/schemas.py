"""Les schémas Pydantic : ce que l'API accepte en entrée et renvoie en sortie."""

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, computed_field, field_validator

# Types réutilisables
Telephone = Annotated[str, Field(pattern=r"^\+2217[05678]\d{7}$", examples=["+221770000000"])]
Montant = Annotated[Decimal, Field(gt=0, max_digits=12, decimal_places=0)]
MontantTransfert = Annotated[Decimal, Field(ge=100, max_digits=12, decimal_places=0)]  # R1


def nettoyer_telephone(valeur: object) -> object:
    """Accepte « +221 77 000 00 00 » en retirant les espaces."""
    if isinstance(valeur, str):
        return valeur.replace(" ", "")
    return valeur


# ---------- Wallets ----------
class WalletIn(BaseModel):
    """Les données pour ouvrir un wallet."""

    nom: str = Field(min_length=2, max_length=100)
    telephone: Telephone
    type: Literal["client", "marchand"] = "client"
    region: str = Field(default="Dakar", min_length=2, max_length=50)

    @field_validator("telephone", mode="before")
    @classmethod
    def sans_espaces(cls, valeur: object) -> object:
        return nettoyer_telephone(valeur)


class WalletOut(BaseModel):
    """Un wallet renvoyé par l'API."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    nom: str
    telephone: str
    type: str
    region: str
    solde: Decimal
    cree_le: datetime


class DepotIn(BaseModel):
    """Un dépôt sur un wallet."""

    montant: Montant


# ---------- Transferts ----------
class TransfertIn(BaseModel):
    """Un transfert local, d'au moins 100 FCFA (R1)."""

    beneficiaire_tel: Telephone
    montant: MontantTransfert

    @field_validator("beneficiaire_tel", mode="before")
    @classmethod
    def sans_espaces(cls, valeur: object) -> object:
        return nettoyer_telephone(valeur)


class TransfertOut(BaseModel):
    """Un transfert renvoyé par l'API, avec le total débité."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    expediteur_id: int
    beneficiaire_tel: str
    montant: Decimal
    frais: Decimal
    code_retrait: str
    statut: Literal["en_attente", "retire"]
    cree_le: datetime

    @computed_field  # type: ignore[prop-decorator]
    @property
    def total_debite(self) -> Decimal:
        """Montant + frais : ce qui sort réellement du wallet."""
        return self.montant + self.frais


# ---------- Transferts de la diaspora ----------
class TransfertDiasporaIn(BaseModel):
    """Un transfert payé en devise par la diaspora."""

    beneficiaire_tel: Telephone
    devise: Literal["EUR", "USD"]
    montant_devise: Annotated[Decimal, Field(gt=0, max_digits=12, decimal_places=2)]

    @field_validator("beneficiaire_tel", mode="before")
    @classmethod
    def sans_espaces(cls, valeur: object) -> object:
        return nettoyer_telephone(valeur)


class TransfertDiasporaOut(BaseModel):
    """Le transfert créé, avec le taux de change utilisé."""

    devise: str
    montant_devise: Decimal
    taux: Decimal
    transfert: TransfertOut


# ---------- Retraits ----------
class RetraitIn(BaseModel):
    """Un retrait : le code et le numéro du bénéficiaire."""

    code_retrait: str = Field(pattern=r"^\d{6}$")
    beneficiaire_tel: Telephone

    @field_validator("beneficiaire_tel", mode="before")
    @classmethod
    def sans_espaces(cls, valeur: object) -> object:
        return nettoyer_telephone(valeur)


class RetraitOut(BaseModel):
    """La confirmation d'un retrait."""

    transfert_id: int
    montant: Decimal
    statut: Literal["retire"]


# ---------- Paiements et historique ----------
class PaiementIn(BaseModel):
    """Un paiement chez un marchand."""

    marchand_id: int
    montant: Montant


class TransactionOut(BaseModel):
    """Une ligne d'historique renvoyée par l'API."""

    model_config = ConfigDict(from_attributes=True)

    id: int
    wallet_id: int
    type: str
    montant: Decimal
    frais: Decimal
    solde_apres: Decimal
    reference: str | None
    cree_le: datetime


class PageTransactions(BaseModel):
    """Une page d'historique et le curseur de la page suivante."""

    items: list[TransactionOut]
    next_cursor: int | None


# ---------- Webhooks des marchands ----------
class WebhookIn(BaseModel):
    """L'adresse où le marchand veut recevoir ses webhooks."""

    url: HttpUrl


class WebhookOut(BaseModel):
    """La configuration enregistrée, avec le secret de signature."""

    marchand_id: int
    url: str
    secret: str
