"""Le QR code de retrait : le bénéficiaire le montre à l'agent au lieu de dicter son code.

Le QR code contient une adresse du type gopay://retrait?code=123456&tel=%2B221780000002.
L'agent la lit avec sa caméra : le code et le numéro se remplissent tout seuls.
Le code à 6 chiffres reste affiché sur le ticket, en secours (SMS, téléphone).
"""

import io
from urllib.parse import urlencode

import segno

from gopay.models import Transfert


def contenu_qr(transfert: Transfert) -> str:
    """Le texte encodé dans le QR code : le code de retrait et le numéro du bénéficiaire."""
    return "gopay://retrait?" + urlencode({"code": transfert.code_retrait, "tel": transfert.beneficiaire_tel})


def qr_svg(transfert: Transfert) -> str:
    """Le QR code en SVG, sans taille fixe : la page le dimensionne comme elle veut."""
    qr = segno.make(contenu_qr(transfert), error="m")  # correction « M » : lisible même un peu abîmé
    tampon = io.BytesIO()
    qr.save(
        tampon,
        kind="svg",
        border=0,
        dark="#171a33",
        light=None,
        omitsize=True,  # un viewBox au lieu d'une largeur en pixels
        xmldecl=False,
        nl=False,
        title="QR code de retrait Go Pay",
    )
    return tampon.getvalue().decode()
