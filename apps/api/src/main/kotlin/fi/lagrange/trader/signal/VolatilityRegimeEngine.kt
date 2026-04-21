package fi.lagrange.trader.signal

import fi.lagrange.trader.data.model.MacroSnapshot

enum class VixRegime { LOW, NORMAL, ELEVATED, HIGH, EXTREME, CRISIS }
enum class TermStructure { CONTANGO, FLAT, BACKWARDATION }

data class VolatilityRegimeResult(
    val vix: Double,
    val vix3m: Double,
    val vvix: Double,
    val ratio: Double,             // VIX / VIX3M
    val vixRegime: VixRegime,
    val termStructure: TermStructure,
    val allowBreakouts: Boolean,      // long breakouts allowed
    val allowShortBreakouts: Boolean, // bearish breakdowns allowed (backwardation = fear = good for shorts)
    val sizeMultiplier: Double,
    val vvixVeto: Boolean
)

class VolatilityRegimeEngine {

    fun compute(snap: MacroSnapshot): VolatilityRegimeResult {
        val vix  = snap.vixClose
        val vix3m = snap.vix3mClose
        val vvix  = snap.vvixClose
        val ratio = if (vix3m > 0) vix / vix3m else 1.0

        val vixRegime = when {
            vix < 12 -> VixRegime.LOW
            vix < 17 -> VixRegime.NORMAL
            vix < 22 -> VixRegime.ELEVATED
            vix < 30 -> VixRegime.HIGH
            vix < 40 -> VixRegime.EXTREME
            else     -> VixRegime.CRISIS
        }

        // Steep contango < 0.95 → normal; flat 0.95–1.00; backwardation > 1.00
        val termStructure = when {
            ratio < 0.95  -> TermStructure.CONTANGO
            ratio <= 1.00 -> TermStructure.FLAT
            else          -> TermStructure.BACKWARDATION
        }

        // ORB breakout strategies are blocked in backwardation or in EXTREME/CRISIS
        val allowBreakouts = when {
            vixRegime == VixRegime.EXTREME || vixRegime == VixRegime.CRISIS -> false
            vixRegime == VixRegime.HIGH && termStructure == TermStructure.BACKWARDATION -> false
            termStructure == TermStructure.BACKWARDATION -> false
            else -> true
        }

        val sizeMultiplier = when {
            vixRegime == VixRegime.EXTREME || vixRegime == VixRegime.CRISIS -> 0.0
            vixRegime == VixRegime.HIGH -> 0.5
            vixRegime == VixRegime.ELEVATED && termStructure == TermStructure.BACKWARDATION -> 0.5
            vixRegime == VixRegime.ELEVATED -> 0.75
            else -> 1.0
        }

        // Shorts are allowed even in backwardation (fear = good for downside trades)
        // but still blocked during EXTREME/CRISIS (violent reversals) and VVIX veto
        val allowShortBreakouts = vixRegime != VixRegime.EXTREME && vixRegime != VixRegime.CRISIS

        return VolatilityRegimeResult(
            vix                 = vix,
            vix3m               = vix3m,
            vvix                = vvix,
            ratio               = ratio,
            vixRegime           = vixRegime,
            termStructure       = termStructure,
            allowBreakouts      = allowBreakouts,
            allowShortBreakouts = allowShortBreakouts,
            sizeMultiplier      = sizeMultiplier,
            vvixVeto            = vvix > 130.0
        )
    }
}
