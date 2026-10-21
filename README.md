# Lakshmi Machine ERP

QR-enabled inventory, stock ledger, sales availability and delivery estimation — built from
[`QR_Inventory_Sales_Accounts_Automation_Master_Prompt.md`](QR_Inventory_Sales_Accounts_Automation_Master_Prompt.md).

| Part | Stack | Folder |
|---|---|---|
| API | FastAPI · SQLAlchemy 2 · Alembic · PostgreSQL (SQLite for local dev) | [`backend/`](backend) |
| Web | Next.js 15 · React 19 · TypeScript · Tailwind CSS 4 · Lucide | [`web/`](web) |
| Android | Expo (React Native) · expo-camera QR scanning · offline queue | [`mobile/`](mobile) |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design decisions and
[docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for exactly what is built, what is not, and what was verified.

## Run locally

```bash
cd backend && python -m pip install -r requirements.txt && cp .env.example .env
```

```bash
cd backend && python -m alembic upgrade head && python -m app.seed --demo
```

```bash
cd backend && python -m uvicorn app.main:app --reload --port 8000
```

```bash
cd web && npm install && cp .env.local.example .env.local && npm run dev
```

Open http://localhost:3000. API docs: http://localhost:8000/docs.

`python -m app.seed --demo` creates an `admin` user plus one demo user per role (`stores`, `stores2`, `sales`,
`purchase`, `qc`, `manager`, `accounts`, `finance`, `auditor`, `planning`, `production`). All share the
password in `SEED_PASSWORD` (see `backend/.env.example`) — change it before any shared deployment. Demo items are posted through the real ledger,
so every dashboard figure is derived from transactions.

### Tests

```bash
cd backend && python -m pytest -q -p no:logging
```

### Android app

```bash
cd mobile && npm install && npx expo start --android
```

The emulator reaches the host API at `http://10.0.2.2:8000` (editable on the login screen). On a physical device use the
host's LAN IP. Build an APK with `npm run build:apk` (requires an Expo/EAS account).

The web app's **Scan & transact** page also works in Android Chrome (camera scanning needs HTTPS or localhost),
and every printed QR encodes `PUBLIC_BASE_URL/q/<token>`, so a phone's camera app opens the item directly.

## Production notes

* Set `APP_ENV=production`, a strong `JWT_SECRET`, `DATABASE_URL=postgresql+psycopg://…`, `CORS_ORIGINS`, `PUBLIC_BASE_URL`.
* Run `alembic upgrade head` on deploy; serve behind HTTPS; `/health` checks DB connectivity.
* Back up PostgreSQL daily (e.g. `pg_dump` + off-site retention) and test restores.
