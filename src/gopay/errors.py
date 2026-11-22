"""Les erreurs métier de Go Pay et leur conversion au format Problem Details (RFC 9457)."""

# --- AJOUT étape 7 : imports ---
from decimal import Decimal

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

BASE_TYPE = "https://api.gopay.example/erreurs/"


class GoPayError(Exception):
    """Classe mère de toutes les erreurs métier."""

    status = 400
    code = "erreur"
    titre = "Erreur"

    def __init__(self, detail: str, **extras: object) -> None:
        super().__init__(detail)
        self.detail = detail
        self.extras = extras


class RessourceIntrouvable(GoPayError):
    """404 : le wallet, le marchand ou le code demandé n'existe pas."""

    status, code, titre = 404, "introuvable", "Ressource introuvable"


class TelephoneDejaUtilise(GoPayError):
    """409 : un wallet existe déjà pour ce numéro."""

    status, code, titre = 409, "telephone-deja-utilise", "Téléphone déjà utilisé"


class SoldeInsuffisant(GoPayError):
    """422 : le solde ne couvre pas le montant et les frais (R4)."""

    status, code, titre = 422, "solde-insuffisant", "Solde insuffisant"


class CodeDejaUtilise(GoPayError):
    """409 : ce code de retrait a déjà servi (R6)."""

    status, code, titre = 409, "code-deja-utilise", "Code de retrait déjà utilisé"


class OperationInterdite(GoPayError):
    """422 : opération refusée par une règle métier."""

    status, code, titre = 422, "operation-interdite", "Opération interdite"


class CleDejaUtilisee(GoPayError):
    """422 : la même Idempotency-Key a servi pour une autre requête (R9)."""

    status, code, titre = 422, "idempotency-key-reutilisee", "Idempotency-Key déjà utilisée"


class TraitementEnCours(GoPayError):
    """409 : une requête avec la même Idempotency-Key est encore en cours (R9)."""

    status, code, titre = 409, "traitement-en-cours", "Traitement en cours"


class ServiceIndisponible(GoPayError):
    """503 : un service externe (change, FraudCheck) ne répond pas."""

    status, code, titre = 503, "service-indisponible", "Service indisponible"


# --- AJOUT étape 7 : conversion en réponse HTTP ---
def probleme(request: Request, status: int, code: str, titre: str, detail: str, **extras: object) -> JSONResponse:
    """Construit une réponse d'erreur au format Problem Details (RFC 9457)."""
    corps = {
        "type": BASE_TYPE + code,
        "title": titre,
        "status": status,
        "detail": detail,
        "instance": request.url.path,
        **extras,
    }
    return JSONResponse(
        jsonable_encoder(corps, custom_encoder={Decimal: str}),
        status_code=status,
        media_type="application/problem+json",
    )


def installer_gestionnaires(app: FastAPI) -> None:
    """Branche la conversion des erreurs en réponses HTTP sur l'application."""

    @app.exception_handler(GoPayError)
    async def erreur_metier(request: Request, exc: GoPayError) -> JSONResponse:
        """Une erreur métier devient une réponse avec son propre code HTTP."""
        return probleme(request, exc.status, exc.code, exc.titre, exc.detail, **exc.extras)

    @app.exception_handler(RequestValidationError)
    async def erreur_validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        """Une requête mal formée devient une réponse 422 avec le détail des champs."""
        return probleme(
            request,
            422,
            "validation",
            "Requête invalide",
            "Un ou plusieurs champs sont invalides.",
            errors=exc.errors(),
        )
