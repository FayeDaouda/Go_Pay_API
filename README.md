# Go Pay API

API de transfert d'argent du wallet vers le cash, réalisée pendant les TD1, TD2 et TD3 du module
« Développement moderne avec Python (API) », Master 2 DATA-IA, ISM Dakar.

| Tag   | Contenu |
|-------|---------|
| `td1` | API REST : wallets, dépôts, transferts avec code de retrait, retraits, paiements marchands, historique paginé, erreurs au format Problem Details |
| `td2` | Idempotence, verrou par wallet, client de change résilient (délais, nouvelles tentatives, Retry-After), transferts de la diaspora, filtres de l'historique |
| `td3` | GraphQL avec DataLoader, service anti-fraude FraudCheck en gRPC, alertes WebSocket, suivi SSE, webhooks signés vers les marchands |

## Installation

```bash
uv sync
```

## Lancer les services

Chaque service tourne dans son propre terminal, depuis ce dossier.

| Service | Commande | Adresse |
|---------|----------|---------|
| API Go Pay | `uv run fastapi dev src/gopay/main.py` | http://127.0.0.1:8000/docs |
| Service de change simulé | `uv run fastapi dev mock_change.py --port 8001` | http://127.0.0.1:8001/taux?de=EUR |
| FraudCheck (gRPC) | `uv run python -m gopay.fraude.serveur` | localhost:50051 |
| Marchand de démonstration | `MARCHAND_SECRET=<secret> uv run fastapi dev marchand_demo.py --port 8002` | http://127.0.0.1:8002/recus |

## Interface web

Une fois l'API lancée, l'interface s'ouvre sur http://127.0.0.1:8000 (redirection vers `/app/`).
Elle est faite en HTML, CSS et JavaScript sans dépendance, dans `src/gopay/static/`, et servie par FastAPI.

- **Espace client** : ouvrir un wallet, déposer, envoyer de l'argent, payer un marchand, envoyer depuis
  l'étranger (EUR ou USD) et consulter l'historique filtré. Après un envoi, le code de retrait s'affiche
  sur un ticket qui se met à jour en direct (SSE) au moment du retrait.
- **Espace agent** : recevoir en direct (WebSocket) les transferts à préparer, puis valider un retrait avec
  le code et le numéro du bénéficiaire.

Pour voir le temps réel, ouvrez deux onglets : l'espace agent dans l'un (bouton « Recevoir les alertes »),
l'espace client dans l'autre. La diaspora a besoin du service de change (port 8001), et le contrôle
anti-fraude de FraudCheck (port 50051).

Autres points d'accès de l'API : GraphiQL sur http://127.0.0.1:8000/graphql, WebSocket des agents sur
`ws://127.0.0.1:8000/ws/agents/{agent_id}`, suivi SSE sur `/v1/transferts/{id}/suivi`.

Les transferts et les paiements exigent les en-têtes `X-Wallet-Id` et `Idempotency-Key`.

## Vérifier

```bash
uv run ruff format .
uv run ruff check .
uv run mypy src
uv run pytest          # 33 tests
```

Scripts de démonstration (l'API et, selon le cas, les autres services doivent tourner) :

| Script | Ce qu'il montre |
|--------|-----------------|
| `essai_concurrence.py` | 20 transferts simultanés sur 10 000 FCFA : 9 réussis, solde 550 FCFA (R10) |
| `charge.py` | double envoi, transferts simultanés et diaspora contre l'API réelle |
| `essai_graphql.py` | 100 transactions de 5 wallets : une seule lecture de wallets (DataLoader) |
| `essai_flux.py` | 100 transferts évalués par FraudCheck sur un flux gRPC bidirectionnel |
| `agent_demo.py` | un agent connecté en WebSocket qui affiche les alertes de transfert |

## Organisation du code

```
src/gopay/
  main.py           crée l'application et branche les routes
  models.py         les objets métier stockés (Wallet, Transfert, Transaction)
  schemas.py        ce que l'API accepte et renvoie (Pydantic)
  repository.py     le stockage en mémoire, la latence simulée et les verrous
  services.py       les règles métier R1 à R15, sans code HTTP
  dependencies.py   les dépendances injectées avec Depends
  errors.py         les erreurs métier et leur format Problem Details
  idempotence.py    le stock des Idempotency-Key (R9)
  change.py         le client du service de change
  graphql_api.py    l'API GraphQL en lecture seule
  static/           l'interface web (HTML, CSS, JavaScript)
  temps_reel.py     WebSocket des agents et suivi SSE
  webhooks.py       signature HMAC et envoi des webhooks
  fraude/           client et serveur FraudCheck (gRPC) ; fraud_pb2* est généré
  routers/          les routes REST
protos/gopay/fraude/fraud.proto   le contrat gRPC
tests/test_api.py                 les tests des trois TD
```

Pour régénérer le code gRPC après une modification du contrat :

```bash
uv run python -m grpc_tools.protoc -I protos --python_out=src --pyi_out=src --grpc_python_out=src protos/gopay/fraude/fraud.proto
```

## Règles métier

| Règle | Description |
|-------|-------------|
| R1 | Un transfert fait au moins 100 FCFA |
| R2 | Frais de 1 %, avec un minimum de 50 FCFA |
| R3 | Le wallet est débité du montant et des frais |
| R4 | Le solde doit couvrir le montant et les frais |
| R5 | Chaque transfert reçoit un code de retrait unique à 6 chiffres |
| R6 | Un code de retrait ne sert qu'une fois |
| R7 | Un paiement va d'un client vers un marchand, jamais vers soi-même |
| R8 | Arrondi au franc le plus proche, une moitié vers le haut |
| R9 | La même Idempotency-Key ne traite une requête qu'une seule fois |
| R10 | Un verrou par wallet : jamais de solde négatif, même en parallèle |
| R11 | Les transferts de la diaspora sont convertis en FCFA avant les frais |
| R12 | FraudCheck bloque un transfert à partir d'un score de 0,8 |
| R13 | FraudCheck injoignable : on accepte sous 50 000 FCFA, on refuse au-delà (503) |
| R14 | Les agents sont prévenus de chaque transfert, sans le code de retrait |
| R15 | Les marchands reçoivent un webhook signé (HMAC-SHA256) à chaque paiement |

## Note sur l'historique git

Le TD3 a été réalisé avant le TD2. Le code du TD2 a ensuite été intégré au code existant sans retirer
ce que le TD3 avait ajouté. Les tags `td2` et `td3` pointent donc tous les deux sur la version qui
contient les trois TD et passe 32 tests. L'interface web a été ajoutée ensuite, sur la branche `main`
(33 tests avec celui de l'interface).
