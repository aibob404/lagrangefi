package fi.lagrange.trader.signal

import fi.lagrange.trader.data.model.DailyBar
import fi.lagrange.trader.data.model.MacroSnapshot
import kotlinx.datetime.LocalDate
import kotlin.math.pow
import kotlin.math.sqrt

enum class MacroRegime { STRONG_BULL, BULL, NEUTRAL, BEAR }
enum class TrendState { STRONG, MODERATE, WEAK }

data class MacroRegimeResult(
    val date: LocalDate,
    val mBase: Int,                  // [-5, +5]
    val regime: MacroRegime,
    val trendState: TrendState,
    val spread2y10y: Double,
    val creditZScore: Double,
    val ffrLevel: Double,
    val adx: Double,
    val details: Map<String, Int>    // per-component breakdown
)

class MacroRegimeEngine {

    fun compute(
        spyBars: List<DailyBar>,
        macroHistory: List<MacroSnapshot>
    ): MacroRegimeResult? {
        if (spyBars.size < 200 || macroHistory.isEmpty()) return null

        val latest = macroHistory.last()
        val closes  = spyBars.map { it.close }.toDoubleArray()
        val highs   = spyBars.map { it.high }.toDoubleArray()
        val lows    = spyBars.map { it.low }.toDoubleArray()

        // --- Component 1: SMA 50/200 crossover ---
        val sma50Arr  = Indicators.sma(closes, 50)
        val sma200Arr = Indicators.sma(closes, 200)
        val sma50  = sma50Arr.last()
        val sma200 = sma200Arr.last()
        val price  = closes.last()
        val smaScore = when {
            price > sma200 && sma50 > sma200 ->  2   // golden-cross state
            price < sma200 && sma50 < sma200 -> -2   // death-cross state
            else -> 0
        }

        // --- Component 2: ADX + annualised slope of 50-SMA ---
        val adxResult = Indicators.adx(highs, lows, closes, 14)
        val adx = adxResult.adx.lastOrNull { !it.isNaN() } ?: 0.0
        val sma50Recent = sma50Arr.takeLast(20).filter { !it.isNaN() }.toDoubleArray()
        val slopePct = if (sma50Recent.size >= 10)
            Indicators.linearRegressionSlope(sma50Recent) / price * 252 * 100 else 0.0
        val adxScore = when {
            adx >= 25 && slopePct >  5.0 ->  1
            adx <  20 || slopePct < -5.0 -> -1
            else -> 0
        }

        // --- Component 3: Fed Funds Rate level ---
        val ffr = latest.fedFundsRate
        val ffrScore = when {
            ffr <  2.0 ->  2
            ffr <= 4.0 ->  0
            ffr <= 5.5 -> -1
            else       -> -2
        }

        // --- Component 4: Yield curve (10Y - 3M) ---
        val spread2y10y = latest.yield10y - latest.yield3m  // 3M T-bill as short rate
        val yieldScore = when {
            spread2y10y >  1.0 ->  1   // healthy steepening
            spread2y10y >= 0.0 ->  0   // flat
            spread2y10y >= -0.5 -> -1  // shallow inversion
            else               -> -2   // deep inversion
        }

        // --- Component 5: Credit spreads — HYG/LQD z-score ---
        var creditZScore = 0.0
        val creditScore: Int
        if (macroHistory.size >= 20) {
            val ratios = macroHistory.map { snap ->
                if (snap.lqdClose > 0) snap.hygClose / snap.lqdClose else 1.0
            }
            val window = minOf(ratios.size, 20)
            val slice  = ratios.takeLast(window)
            val mean   = slice.average()
            val std    = sqrt(slice.map { (it - mean).pow(2) }.average())
            creditZScore = if (std > 0) (ratios.last() - mean) / std else 0.0
            creditScore = when {
                creditZScore >  1.0 ->  1
                creditZScore < -2.0 -> -2
                creditZScore < -1.0 -> -1
                else                ->  0
            }
        } else {
            creditScore = 0
        }

        val mBase = (smaScore + adxScore + ffrScore + yieldScore + creditScore).coerceIn(-5, 5)

        val trendState = when {
            adx >= 25 -> TrendState.STRONG
            adx >= 20 -> TrendState.MODERATE
            else      -> TrendState.WEAK
        }
        val regime = when {
            mBase >=  4 -> MacroRegime.STRONG_BULL
            mBase >=  1 -> MacroRegime.BULL
            mBase >= -1 -> MacroRegime.NEUTRAL
            else        -> MacroRegime.BEAR
        }

        return MacroRegimeResult(
            date         = latest.date,
            mBase        = mBase,
            regime       = regime,
            trendState   = trendState,
            spread2y10y  = spread2y10y,
            creditZScore = creditZScore,
            ffrLevel     = ffr,
            adx          = adx,
            details      = mapOf(
                "smaScore"    to smaScore,
                "adxScore"    to adxScore,
                "ffrScore"    to ffrScore,
                "yieldScore"  to yieldScore,
                "creditScore" to creditScore
            )
        )
    }
}
