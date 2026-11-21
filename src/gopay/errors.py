"""Les erreurs métier de Go Pay et leur conversion au format Problem Details (RFC 9457)."""

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
    status, code, titre = 404, "introuvable", "Ressource introuvable"


class TelephoneDejaUtilise(GoPayError):
    status, code, titre = 409, "telephone-deja-utilise", "Téléphone déjà utilisé"


class SoldeInsuffisant(GoPayError):
    status, code, titre = 422, "solde-insuffisant", "Solde insuffisant"


class CodeDejaUtilise(GoPayError):
    status, code, titre = 409, "code-deja-utilise", "Code de retrait déjà utilisé"


class OperationInterdite(GoPayError):
    status, code, titre = 422, "operation-interdite", "Opération interdite"
