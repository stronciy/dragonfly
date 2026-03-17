set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
PASSWORD="Test1234"
COOKIE_JAR="$(mktemp)"
trap 'rm -f "$COOKIE_JAR"' EXIT

rand_email() {
  local ts
  ts="$(date +%s)"
  echo "user_${ts}_$RANDOM@example.com"
}

json_get() {
  node -e 'const obj=JSON.parse(process.argv[1]); const path=process.argv[2].split("."); let cur=obj; for (const p of path) cur=cur?.[p]; console.log(cur ?? "");' "$1" "$2"
}

require_nonempty() {
  if [ -z "$2" ]; then
    echo "ERROR: $1 is empty"
    exit 1
  fi
}

echo "BASE_URL=$BASE_URL"
echo "COOKIE_JAR=$COOKIE_JAR"

###############################################################################
# 0) Catalog (может быть пустым — это ок)
###############################################################################
echo "== Catalog =="
SERVICES_JSON="$(curl -sS "$BASE_URL/api/v1/catalog/services")"
echo "$SERVICES_JSON" | head -c 500; echo
curl -sS "$BASE_URL/api/v1/catalog/crops" | head -c 500; echo

HAS_TYPE=$(node -e 'const j=JSON.parse(process.argv[1]); const cats=j?.data?.categories ?? []; const ok=cats.some(c => (c.subcategories??[]).some(s => (s.types??[]).some(t => t.serviceTypeId==="type-a"))); process.stdout.write(ok?"yes":"no");' "$SERVICES_JSON")
if [ "$HAS_TYPE" != "yes" ]; then
  echo "ERROR: Catalog is empty. Apply migrations to seed test catalog:"
  echo "  cd trae-backend && npx prisma migrate dev"
  exit 1
fi

###############################################################################
# 1) Регистрация customer + login
###############################################################################
echo "== Customer register/login =="
C_EMAIL="$(rand_email)"
C_NAME="Customer Test"
C_REG=$(curl -sS -X POST "$BASE_URL/api/v1/auth/register" \
  -H "content-type: application/json" \
  -d "{\"name\":\"$C_NAME\",\"email\":\"$C_EMAIL\",\"password\":\"$PASSWORD\"}")
echo "$C_REG" | head -c 400; echo

C_LOGIN=$(curl -sS -X POST "$BASE_URL/api/v1/auth/login" \
  -c "$COOKIE_JAR" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$C_EMAIL\",\"password\":\"$PASSWORD\"}")
C_TOKEN="$(json_get "$C_LOGIN" "data.accessToken")"
require_nonempty "C_TOKEN" "$C_TOKEN"
echo "C_TOKEN=${C_TOKEN:0:24}..."

curl -sS "$BASE_URL/api/v1/auth/me" -H "authorization: Bearer $C_TOKEN" | head -c 300; echo
curl -sS "$BASE_URL/api/v1/users/me" -H "authorization: Bearer $C_TOKEN" | head -c 300; echo
curl -sS -X PATCH "$BASE_URL/api/v1/users/me" -H "authorization: Bearer $C_TOKEN" -H "content-type: application/json" \
  -d "{\"phone\":\"+380000000001\"}" | head -c 300; echo

###############################################################################
# 2) Регистрация performer + login + смена роли + настройки (matching)
###############################################################################
echo "== Performer register/login/role/settings =="
P_EMAIL="$(rand_email)"
P_NAME="Performer Test"
P_REG=$(curl -sS -X POST "$BASE_URL/api/v1/auth/register" \
  -H "content-type: application/json" \
  -d "{\"name\":\"$P_NAME\",\"email\":\"$P_EMAIL\",\"password\":\"$PASSWORD\"}")
echo "$P_REG" | head -c 200; echo

P_LOGIN=$(curl -sS -X POST "$BASE_URL/api/v1/auth/login" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$P_EMAIL\",\"password\":\"$PASSWORD\"}")
P_TOKEN="$(json_get "$P_LOGIN" "data.accessToken")"
require_nonempty "P_TOKEN" "$P_TOKEN"
echo "P_TOKEN=${P_TOKEN:0:24}..."

# роль performer
curl -sS -X PATCH "$BASE_URL/api/v1/users/me/role" \
  -H "authorization: Bearer $P_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"role\":\"performer\"}" | head -c 200; echo

# device push token (любой строковый токен, для теста)
curl -sS -X POST "$BASE_URL/api/v1/devices/push-tokens" \
  -H "authorization: Bearer $P_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"expoPushToken\":\"ExponentPushToken[TEST_${RANDOM}]\",\"platform\":\"android\",\"deviceId\":\"dev-${RANDOM}\",\"appVersion\":\"1.0.0\"}" | head -c 250; echo

# настройки performer + services (id строковые, FK нет — важно только совпадение)
SERVICE_CAT="spraying"
SERVICE_SUB="pesticide"
SERVICE_TYPE="type-a"

curl -sS -X PUT "$BASE_URL/api/v1/performer/settings" \
  -H "authorization: Bearer $P_TOKEN" \
  -H "content-type: application/json" \
  -d "{
    \"baseLocationLabel\":\"Test Base\",
    \"baseCoordinate\":{\"lat\":49.8397,\"lng\":24.0297},
    \"coverage\":{\"mode\":\"radius\",\"radiusKm\":50},
    \"services\":[{\"serviceCategoryId\":\"$SERVICE_CAT\",\"serviceSubCategoryId\":\"$SERVICE_SUB\",\"serviceTypeId\":\"$SERVICE_TYPE\"}]
  }" | head -c 250; echo

curl -sS "$BASE_URL/api/v1/performer/settings" -H "authorization: Bearer $P_TOKEN" | head -c 350; echo

###############################################################################
# 3) Customer создаёт Field + Order (published) → worker матчинг
###############################################################################
echo "== Customer fields/orders =="
FIELD_CREATE=$(curl -sS -X POST "$BASE_URL/api/v1/fields" \
  -H "authorization: Bearer $C_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"name\":\"Field #1\",\"areaHa\":120.5,\"regionName\":\"Lviv\",\"centroid\":{\"lat\":49.84,\"lng\":24.03}}")
FIELD_ID="$(json_get "$FIELD_CREATE" "data.field.id")"
require_nonempty "FIELD_ID" "$FIELD_ID"
echo "FIELD_ID=$FIELD_ID"

curl -sS "$BASE_URL/api/v1/fields?limit=10&offset=0" -H "authorization: Bearer $C_TOKEN" | head -c 300; echo
curl -sS "$BASE_URL/api/v1/fields/$FIELD_ID" -H "authorization: Bearer $C_TOKEN" | head -c 300; echo
curl -sS -X PATCH "$BASE_URL/api/v1/fields/$FIELD_ID" -H "authorization: Bearer $C_TOKEN" -H "content-type: application/json" \
  -d "{\"name\":\"Field #1 (updated)\"}" | head -c 250; echo

# (quote) — требует наличие serviceTypeId=type-a (засеивается миграцией seed_catalog)
curl -sS -X POST "$BASE_URL/api/v1/orders/quote" \
  -H "authorization: Bearer $C_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"serviceCategoryId\":\"$SERVICE_CAT\",\"serviceSubCategoryId\":\"$SERVICE_SUB\",\"serviceTypeId\":\"$SERVICE_TYPE\",\"areaHa\":120.5}" | head -c 250; echo

ORDER_CREATE=$(curl -sS -X POST "$BASE_URL/api/v1/orders" \
  -H "authorization: Bearer $C_TOKEN" \
  -H "content-type: application/json" \
  -d "{
    \"serviceCategoryId\":\"$SERVICE_CAT\",
    \"serviceSubCategoryId\":\"$SERVICE_SUB\",
    \"serviceTypeId\":\"$SERVICE_TYPE\",
    \"areaHa\":120.5,
    \"location\":{\"lat\":49.8397,\"lng\":24.0297,\"addressLabel\":\"Test Location\",\"regionName\":\"Lviv\"},
    \"comment\":\"Test order\",
    \"budget\":10000,
    \"status\":\"published\"
  }")
ORDER_ID="$(json_get "$ORDER_CREATE" "data.order.id")"
require_nonempty "ORDER_ID" "$ORDER_ID"
echo "ORDER_ID=$ORDER_ID"

curl -sS "$BASE_URL/api/v1/orders?limit=10&offset=0&group=active" -H "authorization: Bearer $C_TOKEN" | head -c 400; echo
curl -sS "$BASE_URL/api/v1/orders/$ORDER_ID" -H "authorization: Bearer $C_TOKEN" | head -c 500; echo

echo "== Wait for matching worker (5s) =="
sleep 5

###############################################################################
# 4) Performer marketplace: лента + просмотр заказа
###############################################################################
echo "== Marketplace list/get =="
curl -sS "$BASE_URL/api/v1/marketplace/orders?limit=10&offset=0&sort=distance" -H "authorization: Bearer $P_TOKEN" | head -c 500; echo
curl -sS "$BASE_URL/api/v1/marketplace/orders/$ORDER_ID" -H "authorization: Bearer $P_TOKEN" | head -c 500; echo

###############################################################################
# 5) Депозит performer: intent → Stripe confirm → backend confirm → accept
###############################################################################
echo "== Performer deposit + accept =="
: "${STRIPE_SECRET_KEY:?Set STRIPE_SECRET_KEY in your environment (.env for API, and export here for curl to Stripe)}"

PERF_INTENT=$(curl -sS -X POST "$BASE_URL/api/v1/marketplace/orders/$ORDER_ID/deposits/performer-intent" \
  -H "authorization: Bearer $P_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"method\":\"card\"}")
P_PAY_DB_ID="$(json_get "$PERF_INTENT" "data.paymentIntent.id")"
P_CLIENT_SECRET="$(json_get "$PERF_INTENT" "data.paymentIntent.clientSecret")"
require_nonempty "P_PAY_DB_ID" "$P_PAY_DB_ID"
require_nonempty "P_CLIENT_SECRET" "$P_CLIENT_SECRET"
P_PI_ID="${P_CLIENT_SECRET%%_secret_*}"
echo "P_PAY_DB_ID=$P_PAY_DB_ID"
echo "P_PI_ID=$P_PI_ID"

# Stripe: confirm PI (test mode)
curl -sS -u "$STRIPE_SECRET_KEY:" \
  -X POST "https://api.stripe.com/v1/payment_intents/$P_PI_ID/confirm" \
  -d "payment_method=pm_card_visa" >/dev/null
echo "Stripe performer PI confirmed"

# Backend: sync status + создать escrow lock
curl -sS -X POST "$BASE_URL/api/v1/payments/$P_PAY_DB_ID/confirm" \
  -H "authorization: Bearer $P_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"providerPayload\":{}}" | head -c 400; echo

# Accept order (uses db payment id)
curl -sS -X POST "$BASE_URL/api/v1/marketplace/orders/$ORDER_ID/accept" \
  -H "authorization: Bearer $P_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"paymentIntentId\":\"$P_PAY_DB_ID\"}" | head -c 400; echo

###############################################################################
# 6) Депозит customer: intent → Stripe confirm → backend confirm → confirmed
###############################################################################
echo "== Customer deposit => confirmed =="
CUST_INTENT=$(curl -sS -X POST "$BASE_URL/api/v1/orders/$ORDER_ID/deposits/customer-intent" \
  -H "authorization: Bearer $C_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"method\":\"card\"}")
C_PAY_DB_ID="$(json_get "$CUST_INTENT" "data.paymentIntent.id")"
C_CLIENT_SECRET="$(json_get "$CUST_INTENT" "data.paymentIntent.clientSecret")"
require_nonempty "C_PAY_DB_ID" "$C_PAY_DB_ID"
require_nonempty "C_CLIENT_SECRET" "$C_CLIENT_SECRET"
C_PI_ID="${C_CLIENT_SECRET%%_secret_*}"
echo "C_PAY_DB_ID=$C_PAY_DB_ID"
echo "C_PI_ID=$C_PI_ID"

curl -sS -u "$STRIPE_SECRET_KEY:" \
  -X POST "https://api.stripe.com/v1/payment_intents/$C_PI_ID/confirm" \
  -d "payment_method=pm_card_visa" >/dev/null
echo "Stripe customer PI confirmed"

curl -sS -X POST "$BASE_URL/api/v1/payments/$C_PAY_DB_ID/confirm" \
  -H "authorization: Bearer $C_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"providerPayload\":{}}" | head -c 500; echo

curl -sS "$BASE_URL/api/v1/orders/$ORDER_ID" -H "authorization: Bearer $C_TOKEN" | head -c 500; echo

###############################################################################
# 7) started/completed + report media
###############################################################################
echo "== Performer report + status started/completed =="
TMP_FILE="$(mktemp)"
printf "test media %s\n" "$(date -Iseconds)" > "$TMP_FILE"

curl -sS -X POST "$BASE_URL/api/v1/orders/$ORDER_ID/report/media" \
  -H "authorization: Bearer $P_TOKEN" \
  -F "file=@$TMP_FILE;type=text/plain" \
  -F "caption=Before start" | head -c 300; echo

curl -sS -X PATCH "$BASE_URL/api/v1/orders/$ORDER_ID/status" \
  -H "authorization: Bearer $P_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"status\":\"started\"}" | head -c 250; echo

curl -sS "$BASE_URL/api/v1/orders/$ORDER_ID/report" \
  -H "authorization: Bearer $P_TOKEN" | head -c 400; echo

curl -sS -X POST "$BASE_URL/api/v1/orders/$ORDER_ID/report/submit" \
  -H "authorization: Bearer $P_TOKEN" | head -c 250; echo

curl -sS -X PATCH "$BASE_URL/api/v1/orders/$ORDER_ID/status" \
  -H "authorization: Bearer $P_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"status\":\"completed\"}" | head -c 250; echo

###############################################################################
# 8) Agreements + billing + performer wallet/payouts
###############################################################################
echo "== Agreements/billing/wallet/payouts =="
AGREEMENTS=$(curl -sS "$BASE_URL/api/v1/agreements?limit=10&offset=0" -H "authorization: Bearer $C_TOKEN")
echo "$AGREEMENTS" | head -c 400; echo
AGREEMENT_ID="$(json_get "$AGREEMENTS" "data.items.0.id")"
require_nonempty "AGREEMENT_ID" "$AGREEMENT_ID"
curl -sS "$BASE_URL/api/v1/agreements/$AGREEMENT_ID" -H "authorization: Bearer $C_TOKEN" | head -c 500; echo

curl -sS "$BASE_URL/api/v1/billing/summary" -H "authorization: Bearer $C_TOKEN" | head -c 250; echo
curl -sS "$BASE_URL/api/v1/performer/billing/summary" -H "authorization: Bearer $P_TOKEN" | head -c 250; echo
curl -sS "$BASE_URL/api/v1/performer/wallet/reserve-transactions?limit=10&offset=0" -H "authorization: Bearer $P_TOKEN" | head -c 250; echo
curl -sS "$BASE_URL/api/v1/performer/wallet/completed-works?limit=10&offset=0" -H "authorization: Bearer $P_TOKEN" | head -c 350; echo

WITHDRAW=$(curl -sS -X POST "$BASE_URL/api/v1/performer/payouts/withdraw-intent" \
  -H "authorization: Bearer $P_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"amount\":100,\"method\":\"card\",\"destination\":\"test-card\"}")
W_ID="$(json_get "$WITHDRAW" "data.withdrawIntent.id")"
require_nonempty "W_ID" "$W_ID"
curl -sS "$BASE_URL/api/v1/performer/payouts?limit=10&offset=0" -H "authorization: Bearer $P_TOKEN" | head -c 300; echo
curl -sS -X POST "$BASE_URL/api/v1/performer/payouts/$W_ID/confirm" -H "authorization: Bearer $P_TOKEN" | head -c 250; echo

###############################################################################
# 9) Notifications: после матчинга worker писал notifications → отметим read
###############################################################################
echo "== Notifications =="
NOTIFS=$(curl -sS "$BASE_URL/api/v1/notifications?limit=10&offset=0" -H "authorization: Bearer $P_TOKEN")
echo "$NOTIFS" | head -c 400; echo
N_ID="$(json_get "$NOTIFS" "data.items.0.id")"
if [ -n "$N_ID" ]; then
  curl -sS -X PATCH "$BASE_URL/api/v1/notifications/$N_ID/read" -H "authorization: Bearer $P_TOKEN" | head -c 250; echo
fi

###############################################################################
# 10) Arbitration (отдельный мини-сценарий на втором заказе)
###############################################################################
echo "== Arbitration (optional second order) =="
ORDER2=$(curl -sS -X POST "$BASE_URL/api/v1/orders" \
  -H "authorization: Bearer $C_TOKEN" \
  -H "content-type: application/json" \
  -d "{
    \"serviceCategoryId\":\"$SERVICE_CAT\",
    \"serviceSubCategoryId\":\"$SERVICE_SUB\",
    \"serviceTypeId\":\"$SERVICE_TYPE\",
    \"areaHa\":10,
    \"location\":{\"lat\":49.8397,\"lng\":24.0297,\"addressLabel\":\"Test Location 2\",\"regionName\":\"Lviv\"},
    \"comment\":\"Order for arbitration test\",
    \"budget\":1000,
    \"status\":\"published\"
  }")
ORDER2_ID="$(json_get "$ORDER2" "data.order.id")"
sleep 2

curl -sS -X POST "$BASE_URL/api/v1/orders/$ORDER2_ID/arbitration" \
  -H "authorization: Bearer $C_TOKEN" \
  -H "content-type: application/json" \
  -d "{\"reason\":\"Test arbitration\"}" | head -c 350; echo

curl -sS -X POST "$BASE_URL/api/v1/orders/$ORDER2_ID/arbitration/media" \
  -H "authorization: Bearer $C_TOKEN" \
  -F "file=@$TMP_FILE;type=text/plain" | head -c 250; echo

###############################################################################
# 11) Cleanup: delete field (проверка DELETE)
###############################################################################
echo "== Cleanup field delete =="
curl -sS -X DELETE "$BASE_URL/api/v1/fields/$FIELD_ID" -H "authorization: Bearer $C_TOKEN" | head -c 200; echo

echo "DONE"
