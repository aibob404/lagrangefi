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
