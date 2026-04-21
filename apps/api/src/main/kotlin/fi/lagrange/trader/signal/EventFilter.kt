package fi.lagrange.trader.signal

import kotlinx.datetime.*

enum class EventCalendarStatus { BLOCKED, CAUTION, CLEAR }

data class EventResult(
    val status: EventCalendarStatus,
    val reason: String = ""
)

/**
 * Layer 3 — Economic calendar filter.
 *
 * Hard blocks: FOMC decision day (from 10:00 ET), CPI/NFP day (before 10:30 ET),
 * monthly OPEX (no entries after 14:30 ET).
 * Caution: quad witching days — caller should apply 0.75× size.
 *
 * FOMC dates are hardcoded through 2026; extend as calendar is published.
 * NFP is auto-detected as the first Friday of each month.
 */
class EventFilter(
    private val fomcDates: Set<LocalDate> = DEFAULT_FOMC_DATES,
    private val cpiDates: Set<LocalDate>  = emptySet()   // inject actual dates for precision
) {

    companion object {
        // FOMC rate-decision days 2024–2026 (release at 14:00 ET)
        val DEFAULT_FOMC_DATES: Set<LocalDate> = setOf(
            // 2024
            LocalDate(2024, 1, 31),  LocalDate(2024, 3, 20),  LocalDate(2024, 5, 1),
            LocalDate(2024, 6, 12),  LocalDate(2024, 7, 31),  LocalDate(2024, 9, 18),
            LocalDate(2024, 11, 7),  LocalDate(2024, 12, 18),
            // 2025
            LocalDate(2025, 1, 29),  LocalDate(2025, 3, 19),  LocalDate(2025, 5, 7),
            LocalDate(2025, 6, 18),  LocalDate(2025, 7, 30),  LocalDate(2025, 9, 17),
            LocalDate(2025, 11, 5),  LocalDate(2025, 12, 17),
            // 2026
            LocalDate(2026, 1, 28),  LocalDate(2026, 3, 18),  LocalDate(2026, 4, 29),
            LocalDate(2026, 6, 17),  LocalDate(2026, 7, 29),  LocalDate(2026, 9, 16),
            LocalDate(2026, 11, 4),  LocalDate(2026, 12, 16)
        )
    }

    fun check(date: LocalDate, timeEt: LocalTime): EventResult {
        // FOMC decision day — blocked from 10:00 ET; market open before 10:00 is caution only
        if (date in fomcDates) {
            return if (timeEt >= LocalTime(10, 0))
                EventResult(EventCalendarStatus.BLOCKED, "FOMC rate decision — no entries from 10:00 ET")
            else
                EventResult(EventCalendarStatus.CAUTION, "FOMC decision day — elevated uncertainty pre-10:00")
        }

        // CPI release day — blocked before 10:30 ET
        if (date in cpiDates && timeEt < LocalTime(10, 30)) {
            return EventResult(EventCalendarStatus.BLOCKED, "CPI release — wait until 10:30 ET")
        }

        // Non-Farm Payrolls — first Friday of month, blocked before 10:30 ET
        if (isNfpDay(date) && timeEt < LocalTime(10, 30)) {
            return EventResult(EventCalendarStatus.BLOCKED, "NFP release — wait until 10:30 ET")
        }

        // Monthly OPEX (3rd Friday) — no new entries after 14:30
        if (isMonthlyOpex(date) && timeEt >= LocalTime(14, 30)) {
            return EventResult(EventCalendarStatus.BLOCKED, "Monthly OPEX — no entries after 14:30 ET")
        }

        // Quad witching (March/June/September/December 3rd Friday) — full-day caution
        if (isQuadWitching(date)) {
            return EventResult(EventCalendarStatus.CAUTION, "Quad witching — reduce size 25%")
        }

        return EventResult(EventCalendarStatus.CLEAR)
    }

    // NFP = first Friday of the month (day-of-month 1–7)
    private fun isNfpDay(date: LocalDate): Boolean =
        date.dayOfWeek == DayOfWeek.FRIDAY && date.dayOfMonth <= 7

    // Monthly OPEX = 3rd Friday (day-of-month 15–21)
    private fun isMonthlyOpex(date: LocalDate): Boolean =
        date.dayOfWeek == DayOfWeek.FRIDAY && date.dayOfMonth in 15..21

    // Quad witching = OPEX in March, June, September, December
    private fun isQuadWitching(date: LocalDate): Boolean =
        isMonthlyOpex(date) && date.month in listOf(Month.MARCH, Month.JUNE, Month.SEPTEMBER, Month.DECEMBER)
}
