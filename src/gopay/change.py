"""Le client du service de change : délais explicites et nouvelles tentatives (version bonus)."""

from decimal import Decimal

import httpx
from tenacity import RetryCallState, retry, retry_if_exception_type, stop_after_attempt, wait_exponential_jitter

from gopay.errors import ServiceIndisponible

# Les erreurs passagères : une nouvelle tentative a des chances de réussir
PASSAGERES = (httpx.ConnectError, httpx.TimeoutException)
attente_par_defaut = wait_exponential_jitter(multiplier=0.2, max=2)


class ReponsePassagere(Exception):
    """Le service répond 429 ou 503 : il demande de revenir plus tard."""

    def __init__(self, statut: int, attente: float) -> None:
        super().__init__(f"HTTP {statut}")
        self.attente = attente


def lire_retry_after(valeur: str | None) -> float:
    """Retry-After vaut un nombre de secondes (on ignore la forme « date HTTP », plus rare)."""
    return float(valeur) if valeur and valeur.isdigit() else 0.0


def attente_conseillee(etat: RetryCallState) -> float:
    """Le délai avant le prochain essai : celui demandé par le serveur, sinon l'attente exponentielle."""
    erreur = etat.outcome.exception() if etat.outcome else None
    if isinstance(erreur, ReponsePassagere) and erreur.attente > 0:
        return min(erreur.attente, 5.0)  # on respecte le serveur, sans attendre plus de 5 s
    return attente_par_defaut(etat)


class ClientChange:
    """Appelle le service de change avec un délai maximal et des nouvelles tentatives."""

    def __init__(self, base_url: str, delai: float = 2.0) -> None:
        self._http = httpx.Client(base_url=base_url, timeout=httpx.Timeout(delai, connect=1.0))

    @retry(
        retry=retry_if_exception_type((*PASSAGERES, ReponsePassagere)),
        stop=stop_after_attempt(4),
        wait=attente_conseillee,
        reraise=True,
    )
    def _demander_taux(self, devise: str) -> Decimal:
        """Un appel HTTP au service de change ; tenacity le relance en cas d'erreur passagère."""
        reponse = self._http.get("/taux", params={"de": devise, "vers": "XOF"})
        if reponse.status_code in (429, 503):
            raise ReponsePassagere(reponse.status_code, lire_retry_after(reponse.headers.get("Retry-After")))
        reponse.raise_for_status()
        return Decimal(reponse.json()["taux"])  # jamais float(...)

    def taux(self, devise: str) -> Decimal:
        """Le taux devise → XOF, ou une erreur 503 si le service reste injoignable."""
        try:
            return self._demander_taux(devise)
        except (httpx.HTTPError, ReponsePassagere) as erreur:
            raise ServiceIndisponible(f"Service de change indisponible ({erreur}).") from erreur

    def fermer(self) -> None:
        """Ferme la connexion HTTP (utile à l'arrêt de l'application)."""
        self._http.close()
