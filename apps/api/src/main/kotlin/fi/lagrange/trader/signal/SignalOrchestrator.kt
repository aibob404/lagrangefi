package fi.lagrange.trader.signal

import fi.lagrange.trader.data.model.Bar
import fi.lagrange.trader.data.model.DailyBar
import fi.lagrange.trader.data.model.MacroSnapshot
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalTime

enum class TradeDirection { LONG, SHORT, NONE }

data class TradeSignal(
    val direction: TradeDirection,
    val entryPrice: Double,
    val stopPrice: Double,
    val tp1Price: Double,         // 1R
    val tp2Price: Double,         // 2R
    val shares: Int,
    val qualityScore: Int,        // Q_base [0, 10]
    val macroScore: Int,          // M_base [-5, +5]
    val sizeMultiplier: Double,   // combined vol + event modifier
    val gatesPassed: Map<String, Boolean>,
    val reason: String
)

data class OrchestratorInput(
    val spyDailyBars: List<DailyBar>,
    val spy5minBars: List<Bar>,
    val macroHistory: List<MacroSnapshot>,
    val date: LocalDate,
    val timeEt: LocalTime,
    val accountEquity: Double,
    val riskPct: Double = 0.01,
    val dailyPnl: Double = 0.0,
    val weeklyPnl: Double = 0.0,
    val hasOpenPosition: Boolean = false,
    val priorDayPoc: Double = 0.0,
    val precomputedMacro: MacroRegimeResult? = null
)

class SignalOrchestrator(
    private val macroEngine: MacroRegimeEngine   = MacroRegimeEngine(),
    private val volEngine: VolatilityRegimeEngine = VolatilityRegimeEngine(),
    private val eventFilter: EventFilter          = EventFilter(),
    private val orbSignal: OrbSignal              = OrbSignal()
) {

    fun evaluate(input: OrchestratorInput): TradeSignal {
        // --- Gate 11: no existing position (Phase 1) ---
        if (input.hasOpenPosition)
            return noTrade("Gate 11: existing position open")

        // --- Gate 10: circuit breakers ---
        val equity = input.accountEquity
        if (input.dailyPnl  < -equity * 0.02) return noTrade("Gate 10: daily   loss limit (-2%)")
        if (input.weeklyPnl < -equity * 0.04) return noTrade("Gate 10: weekly  loss limit (-4%)")

        // --- Gate 1: event calendar ---
        val event = eventFilter.check(input.date, input.timeEt)
        if (event.status == EventCalendarStatus.BLOCKED)
            return noTrade("Gate 1: ${event.reason}")

        // --- Gate 2: macro regime (M_base ≥ 1 required) ---
        val macro = input.precomputedMacro
            ?: macroEngine.compute(input.spyDailyBars, input.macroHistory)
            ?: return noTrade("Gate 2: insufficient macro history (need 200+ daily bars)")
        if (macro.mBase < 1)
            return noTrade("Gate 2: macro score ${macro.mBase} < 1 (regime=${macro.regime})")

        // --- Gate 3: volatility regime ---
        val vol = volEngine.compute(input.macroHistory.last())
        if (!vol.allowBreakouts)
            return noTrade("Gate 3: vol regime blocks breakouts (VIX=${vol.vix}, R=${String.format("%.2f", vol.ratio)}, regime=${vol.vixRegime})")
        if (vol.vvixVeto)
            return noTrade("Gate 3: VVIX veto (${vol.vvix} > 130)")

        // --- Gate 4: time-of-day window (09:45–15:30 ET) ---
        val t = input.timeEt
        if (t < LocalTime(9, 45) || t > LocalTime(15, 30))
            return noTrade("Gate 4: outside trading window ($t ET)")

        // --- Daily ATR (used for ORB range check and stop sizing) ---
        if (input.spyDailyBars.size < 15)
            return noTrade("Insufficient daily bars for ATR calculation")
        val dHighs  = input.spyDailyBars.map { it.high }.toDoubleArray()
        val dLows   = input.spyDailyBars.map { it.low }.toDoubleArray()
        val dCloses = input.spyDailyBars.map { it.close }.toDoubleArray()
        val dailyAtr = Indicators.atr(dHighs, dLows, dCloses, 14)
            .lastOrNull { !it.isNaN() } ?: return noTrade("Daily ATR computation failed")

        // --- Gates 5–13: ORB signal (14-item checklist) ---
        val orb = orbSignal.analyze(input.spy5minBars, dailyAtr)
        if (!orb.orbDefined)        return noTrade("Gate 5: ORB not yet defined — ${orb.reason}")
        if (!orb.orRangeValid)      return noTrade("Gate 5: OR range ${String.format("%.2f", orb.openingRange?.range)} invalid vs ATR ${String.format("%.2f", dailyAtr)}")
        if (!orb.breakoutDetected)  return noTrade("Gate 6: no 5-min close above OR_high — ${orb.reason}")

        val bBar = orb.breakoutBar!!

        if (orb.rvol < 1.5)                        return noTrade("Gate 7: RVOL ${String.format("%.2f", orb.rvol)} < 1.5")
        if (!orb.priceAboveVwap)                   return noTrade("Gate 8: price ${bBar.close} below VWAP ${String.format("%.2f", orb.vwap)}")
        if (!orb.notOverextended)                  return noTrade("Gate 9: entry overextended above OR_high")
        if (!orb.emaStackBull)                     return noTrade("Gate 10: EMA stack not bullish (9>21>200)")
        if (orb.rsi14 < 50.0 || orb.rsi14 > 70.0) return noTrade("Gate 11: RSI ${String.format("%.1f", orb.rsi14)} outside [50, 70]")
        if (orb.macdHistogram <= 0.0 || !orb.macdRising)
                                                   return noTrade("Gate 12: MACD histogram not positive/rising")

        // Gate 13: prior-day POC proximity filter
        val poc = input.priorDayPoc
        if (poc > 0 && bBar.close in (poc - 0.25 * dailyAtr)..(poc + 0.25 * dailyAtr))
            return noTrade("Gate 13: entry within 0.25 × ATR of prior-day POC ($poc)")

        // --- All gates passed — size the position ---
        // Stop based on 5-min ATR
        val iHighs  = input.spy5minBars.map { it.high }.toDoubleArray()
        val iLows   = input.spy5minBars.map { it.low }.toDoubleArray()
        val iCloses = input.spy5minBars.map { it.close }.toDoubleArray()
        val atr5    = Indicators.atr(iHighs, iLows, iCloses, 14)
            .lastOrNull { !it.isNaN() } ?: (dailyAtr / 5.0)

        val stopDist   = 0.5 * atr5
        val entryPrice = bBar.close
        val stopPrice  = entryPrice - stopDist
        val tp1Price   = entryPrice + stopDist         // 1R — take 1/3, move stop to BE
        val tp2Price   = entryPrice + 2.0 * stopDist  // 2R — take 1/3, trail remainder
        val riskDollar = equity * input.riskPct
        val rawShares  = if (stopDist > 0) (riskDollar / stopDist).toInt() else 0

        val sizeMult = vol.sizeMultiplier *
            (if (event.status == EventCalendarStatus.CAUTION) 0.75 else 1.0)
        val shares = (rawShares * sizeMult).toInt().coerceAtLeast(1)

        // --- Quality score Q_base ---
        var q = 5  // baseline when all 14 gates pass
        if (orb.rvol >= 2.0) q++
        if (orb.priceAboveVwap && orb.vwapSigmaDistance < 0.5) q++  // near VWAP — better R:R
        if (orb.rsi14 in 55.0..65.0) q++                             // RSI sweet spot
        if (macro.mBase >= 4) q++                                    // strong bull bonus
        q = q.coerceIn(0, 10)

        val gatesPassed = mapOf(
            "event"         to true, "macro"       to true, "volatility" to true,
            "timeOfDay"     to true, "orRange"      to true, "breakout"   to true,
            "rvol"          to true, "aboveVwap"    to true, "notOverext" to true,
            "emaStack"      to true, "rsi"          to true, "macd"       to true,
            "poc"           to true, "circuitBreak" to true
        )

        return TradeSignal(
            direction      = TradeDirection.LONG,
            entryPrice     = entryPrice,
            stopPrice      = stopPrice,
            tp1Price       = tp1Price,
            tp2Price       = tp2Price,
            shares         = shares,
            qualityScore   = q,
            macroScore     = macro.mBase,
            sizeMultiplier = sizeMult,
            gatesPassed    = gatesPassed,
            reason         = "ORB long: Q=$q M=${macro.mBase} " +
                             "RVOL=${String.format("%.1f", orb.rvol)} " +
                             "VIX=${String.format("%.1f", vol.vix)} " +
                             "ratio=${String.format("%.2f", vol.ratio)}"
        )
    }

    private fun noTrade(reason: String) = TradeSignal(
        direction      = TradeDirection.NONE,
        entryPrice     = 0.0, stopPrice = 0.0,
        tp1Price       = 0.0, tp2Price  = 0.0,
        shares         = 0,   qualityScore = 0,
        macroScore     = 0,   sizeMultiplier = 0.0,
        gatesPassed    = emptyMap(),
        reason         = reason
    )
}
