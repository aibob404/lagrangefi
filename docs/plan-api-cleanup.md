# Plan: Clean API Module (lagrangefi)

## Context

The `apps/api/` Kotlin + Ktor module has accumulated technical debt documented in `docs/BEST_PRACTICES.md` as explicit TODO items. The main problems are:
- Business logic (DB transactions, financial calculations, tick math) living directly in the routing layer
- Correctness bugs that can waste gas or leave funds at risk
- Minor security/robustness issues

This plan addresses all documented TODOs in priority order: money-at-risk bugs first, then correctness, then refactoring.

---

## Phase 1 — Critical Correctness Bugs (surgical, isolated fixes)

### Step 1.1 — Unify tick range calculation

**Problem:** Two different implementations produce different tick ranges:
- `Routing.kt:63-71` `calcTicks()` — uses `floorDiv + 1` for tickUpper (correct)
- `UniswapStrategy.kt:262-270` `calculateNewRange()` — uses plain truncation (produces too-narrow range)

This causes a newly-minted position to appear out-of-range on the first scheduler tick → unnecessary rebalance.

**Fix:** Create `StrategyMath.kt` with the canonical implementation; update both callers.

**New file:** `apps/api/src/main/kotlin/fi/lagrange/strategy/StrategyMath.kt`
```kotlin
package fi.lagrange.strategy

fun calcTickRange(currentTick: Int, fee: Int, rangePercent: Double): Pair<Int, Int> {
    val spacing = feeToTickSpacing(fee)
    val log1_0001 = Math.log(1.0001)
    val rawLower = currentTick + (Math.log(1.0 - rangePercent) / log1_0001).toInt()
    val rawUpper = currentTick + Math.ceil(Math.log(1.0 + rangePercent) / log1_0001).toInt()
    val tickLower = Math.floorDiv(rawLower, spacing) * spacing
    val tickUpper = (Math.floorDiv(rawUpper, spacing) + 1) * spacing
    return Pair(tickLower, tickUpper)
}

fun feeToTickSpacing(fee: Int): Int = when (fee) {
    100 -> 1; 500 -> 10; 3000 -> 60; 10000 -> 200; else -> 60
}
```

**Files changed:**
- Create `StrategyMath.kt`
- `Routing.kt`: delete private `calcTicks()` (lines 63-71); replace call on line 141 with `calcTickRange(...)` + add import
- `UniswapStrategy.kt`: delete private `calculateNewRange()` and `feeToTickSpacing()` (lines 262-278); replace call on line 96 with `calcTickRange(...)` + add import

**Note:** `Routing.kt`'s `calcTicks()` uses `else -> 200` for unknown fee tiers; `StrategyMath.calcTickRange()` inherits `else -> 60` from `UniswapStrategy.kt`. This is a silent behavior change for unknown fee tiers. For v1 (only 500/3000 in use) it is harmless, but is intentional and documented here.

---

### Step 1.2 — Fix non-idempotent close (money at risk)

**Problem:** `Routing.kt` uses timestamp-based strings as idempotency keys. Two rapid DELETE calls each get unique keys → position closed twice on-chain:
- Line 336: `val idempotencyKey = "close-$strategyId-${System.currentTimeMillis()}"` (passed to `chainClient.close()`)
- Line 370: `val closeIdempotencyKey = "close-event-$strategyId-${System.currentTimeMillis()}"` (used for the DB event)

**Fix:** Generate a single UUID v4; insert `StrategyEvents` row with `status = "pending"` **before** chain call, using that UUID as the key for both.

**Files changed:** `Routing.kt` only (close handler, lines 332-344)

**Prerequisite — verify no existing duplicate keys before deploying:**
```sql
SELECT idempotency_key, COUNT(*) FROM strategy_events GROUP BY 1 HAVING COUNT(*) > 1;
```
`StrategyEvents.idempotencyKey` already has `uniqueIndex()` (`Tables.kt:89`) — no schema change needed.

New flow:
1. `val closeIdempotencyKey = java.util.UUID.randomUUID().toString()`
2. Insert `StrategyEvents` with `action="CLOSE_STRATEGY"`, `status="pending"`, `idempotencyKey=closeIdempotencyKey` inside `transaction { }` — **before** `chainClient.close()`
3. Call `chainClient.close(idempotencyKey = closeIdempotencyKey, ...)`

The existing `transaction { }` at line 371 (which updates the event) is updated in-place using this same `closeIdempotencyKey`.

**⚠ Steps 1.2 and 1.3 must be applied together** — Step 1.3's catch block references `closeIdempotencyKey` which only exists after this step.

---

### Step 1.3 — Fix silent error swallowing in close

**Problem:** `Routing.kt:345` — `catch (_: Exception) { /* non-fatal */ }` silently swallows `chainClient.close()` failures. LP stays open on-chain with no monitoring; user is unaware.

**Fix:** Replace silent catch with DB update + Telegram alert.

**Files changed:** `Routing.kt` only (line 345)

```kotlin
} catch (e: Exception) {
    transaction {
        StrategyEvents.update({ StrategyEvents.idempotencyKey eq closeIdempotencyKey }) {
            it[status] = "failed"
            it[errorMessage] = e.message
            it[completedAt] = Clock.System.now()
        }
    }
    telegram.sendAlert("Strategy <b>${strategy.name}</b> close FAILED: ${e.message}. Position may still be open on-chain.")
}
```

The post-close stats enrichment (pool price fetch, `recordClose()`) remains in a separate non-fatal catch.

**Note on chain-side idempotency:** This fix closes the DB-side double-record. Chain-side idempotency (`chain/`'s `processedKeys` set) is in-memory and lost on pod restart — that exposure remains until the post-MVP DB-backed idempotency store is built (see CLAUDE.md "Known risks"). Do not treat this step as a complete solution.

---

### Step 1.4 — Fix double-query authorization bug

**Problem:** `StrategyService.kt:524-560` (`getStats()`) and `562-639` (`getEventHistory()`) — each checks ownership on lines 525-527 / 563-565, then **re-fetches `Strategies` without `userId` predicate** on the very next line (line 529 / line after auth check). Race condition + unnecessary query.

**Fix:** Reuse the row returned by the combined auth+fetch query; pass it forward. Do not discard the row — `getStats()` needs `strategy[Strategies.createdAt]` to compute `avgRebalanceIntervalHours`.

**Files changed:** `StrategyService.kt` (two methods)

Pattern:
```kotlin
fun getStats(strategyId: Int, userId: Int): StrategyStatsDto? = transaction {
    // Ownership check AND fetch in one query — reuse row below:
    val strategy = Strategies.selectAll()
        .where { (Strategies.id eq strategyId) and (Strategies.userId eq userId) }
        .firstOrNull() ?: return@transaction null
    // use strategy[Strategies.createdAt] for avgRebalanceIntervalHours — no second Strategies query
    val stats = StrategyStats.selectAll()
        .where { StrategyStats.strategyId eq strategyId }
        .firstOrNull() ?: return@transaction null
    // ... map to dto using both strategy and stats rows
}
```

---

## Phase 2 — Service Layer Extraction (Routing.kt cleanup)

Extract all business logic from `Routing.kt` into service methods. Routing handlers must only: extract inputs → call service → return result.

### Step 2.1 — Add `recordStartStrategy()` to `StrategyService`

Absorbs `Routing.kt:225-258` (the `transaction { }` block inside `POST /strategies/start`).

**Signature:**
```kotlin
fun recordStartStrategy(strategyId: Int, mintResult: MintResponse, ethPrice: java.math.BigDecimal)
```

**What it does:** Inserts `StrategyEvents` (START_STRATEGY/success) + `ChainTransactions` per tx + updates `StrategyStats.gasCostWei/Usd`. All in a single `transaction { }`.

Uses `buildTxRecords()` — move to `StrategyMath.kt` (Step 2.3). Add `import fi.lagrange.strategy.buildTxRecords` to `StrategyService.kt`.

**Routing.kt after:** Replace lines 221-258 with one line:
```kotlin
strategyService.recordStartStrategy(strategy.id, mintResult, mintEthPrice)
```

---

### Step 2.2 — Add `insertPendingCloseEvent()` + `finalizeCloseEvent()` to `StrategyService`

Absorbs the close handler's two **separate** `try/catch` blocks in `Routing.kt`:
- Block 1 (lines 333–345): chain call + silent catch — covered by Step 1.2/1.3
- Block 2 (lines 347–~446): stats snapshot + event recording + fee accumulation

Note the ordering: `recordClose()` is called at **line 360**, before the event `transaction {}` at line 371. `finalizeCloseEvent` must preserve this: call `recordClose()` first, then write the event + chain txs + fee accumulation in one transaction.

Two methods because routing needs the eventId between them (for the chain call in between).

**Signatures:**
```kotlin
fun insertPendingCloseEvent(strategyId: Int, idempotencyKey: String): Int  // returns eventId

fun finalizeCloseEvent(
    strategyId: Int,
    eventId: Int,
    strategy: StrategyRecord,
    closeResult: CloseResponse?,
    closeEthPriceBD: java.math.BigDecimal,   // caller fetches pool price
    closeFailed: Boolean,
    closeError: String?,
)
```

`finalizeCloseEvent` collapses the two `transaction { }` blocks (lines 371–413 and 415–446) into one (gas update + fee accumulation). This fixes a data-consistency gap where a crash between the two transactions leaves gas recorded but fees not. It also calls `recordClose()` first (preserving the current ordering).

**Routing.kt after (close handler):** ~25 lines instead of ~130. Routing fetches pool price (needs WETH/USDC constants) and passes `closeEthPriceBD` to the service.

---

### Step 2.3 — Move `buildTxRecords` + `stepToAction` to `StrategyMath.kt`

`buildTxRecords` is `internal fun` in `UniswapStrategy.kt`; `stepToAction` is `private fun`. After Phase 2, both are needed by `UniswapStrategy`, `StrategyService`, and `Routing.kt`.

**Files changed:**
- Move both functions from `UniswapStrategy.kt` to `StrategyMath.kt` as `public` (change `internal`/`private` → `public`)
- Add `import fi.lagrange.strategy.buildTxRecords` / `stepToAction` in `UniswapStrategy.kt`

---

### Step 2.4 — Remove dead imports from `Routing.kt`; update imports in other files

After Steps 2.1-2.3:

**`Routing.kt` — remove:**
- `fi.lagrange.model.{ChainTransactions, StrategyEvents, StrategyStats, Strategies}`
- `org.jetbrains.exposed.sql.{insert, selectAll, update, transactions.transaction}`
- `fi.lagrange.strategy.buildTxRecords`
- `kotlinx.datetime.Clock`

**`UniswapStrategy.kt` — add:**
- `import fi.lagrange.strategy.buildTxRecords`
- `import fi.lagrange.strategy.stepToAction`

**`StrategyService.kt` — add (from Step 2.1):**
- `import fi.lagrange.strategy.buildTxRecords`

---

## Phase 3 — SHOULD Fixes

### Step 3.1 — NPE in JWT extraction → proper 401

**File:** `auth/JwtConfig.kt` (line ~55), `plugins/StatusPages.kt`

Add `class UnauthorizedException(message: String) : Exception(message)`.

Replace:
```kotlin
principal<JWTPrincipal>()!!.payload.getClaim("userId").asInt()
```
With:
```kotlin
principal<JWTPrincipal>()
    ?.payload?.getClaim("userId")?.asInt()
    ?: throw UnauthorizedException("Missing or invalid token")
```

Add handler in `StatusPages.kt`:
```kotlin
exception<UnauthorizedException> { call, cause ->
    call.respond(HttpStatusCode.Unauthorized, mapOf("error" to cause.message))
}
```

---

### Step 3.2 — `StatusPages` — add `IllegalArgumentException` → 400 handler

**File:** `plugins/StatusPages.kt`

Add handler for `IllegalArgumentException` → 400 before the `Throwable` catch-all. (`IllegalArgumentException` is thrown by `strategyService.create()` for duplicate active strategies.) The `UnauthorizedException` → 401 handler is already covered by Step 3.1.

---

### Step 3.3 — Missing DB index on `Strategies.userId`

**File:** `model/Tables.kt` (line 26)

Change:
```kotlin
val userId = integer("user_id").references(Users.id)
```
To:
```kotlin
val userId = integer("user_id").references(Users.id).index()
```

**Important:** `SchemaUtils.createMissingTablesAndColumns()` does not add indexes to existing tables. A manual migration is required:
```sql
CREATE INDEX IF NOT EXISTS strategies_user_id ON strategies(user_id);
```
Apply to both `prod` and `test` namespaces via `kubectl exec` on the postgres pod.

---

### Step 3.4 — JSON injection in `TelegramNotifier`

**File:** `services/TelegramNotifier.kt`

Add `@Serializable` data class for the Telegram API payload; use `Json.encodeToString()` instead of string interpolation. `kotlinx.serialization` is already on the classpath.

---

### Step 3.5 — Status string constants

**New file:** `model/StatusConstants.kt`

```kotlin
package fi.lagrange.model

object StrategyStatus {
    const val ACTIVE           = "ACTIVE"
    const val INITIATING       = "INITIATING"
    const val STOPPED_MANUALLY = "STOPPED_MANUALLY"
    const val STOPPED_ON_ERROR = "STOPPED_ON_ERROR"
}

object EventStatus {
    const val PENDING     = "pending"
    const val IN_PROGRESS = "in_progress"
    const val SUCCESS     = "success"
    const val FAILED      = "failed"
}
```

Mechanical replacement in: `Routing.kt`, `UniswapStrategy.kt`, `StrategyService.kt`, `Tables.kt` (comment).

---

## Critical Files

| File | Phase |
|------|-------|
| `plugins/Routing.kt` (483 lines) | 1.2, 1.3, 2.1, 2.2, 2.4 |
| `services/StrategyService.kt` (686 lines) | 1.4, 2.1, 2.2 |
| `strategy/UniswapStrategy.kt` (312 lines) | 1.1, 2.3 |
| `strategy/StrategyMath.kt` (new) | 1.1, 2.3 |
| `auth/JwtConfig.kt` (56 lines) | 3.1 |
| `plugins/StatusPages.kt` (21 lines) | 3.1, 3.2 |
| `model/Tables.kt` (152 lines) | 3.3 |
| `services/TelegramNotifier.kt` (34 lines) | 3.4 |
| `model/StatusConstants.kt` (new) | 3.5 |

---

## Verification

1. **Compile check:** `./gradlew compileKotlin` in `apps/api/` — must pass with zero warnings after each phase
2. **Tick math:** Confirm `calcTickRange(currentTick, 500, 0.05)` produces the same result as the old `Routing.kt:calcTicks()` for several sample tick values
3. **Close idempotency:** Two rapid DELETE requests on the same strategy should result in only one `CLOSE_STRATEGY` event row (second insert hits unique index constraint)
4. **Close failure visibility:** Disconnect chain service, trigger close → Telegram alert must fire; DB event must show `status = "failed"`
5. **DB index:** After applying the manual migration, run `\d strategies` in psql to confirm the index exists
6. **Deploy to test:** Build image via CI `workflow_dispatch`, deploy to test namespace, smoke-test the `/api/v1/strategies` endpoints via the web dashboard
