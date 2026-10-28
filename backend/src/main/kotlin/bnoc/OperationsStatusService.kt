package bnoc

import jakarta.annotation.PostConstruct
import org.springframework.beans.factory.annotation.Value
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.net.URI
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.time.Instant

@Service
class OperationsStatusService(
    private val db: Database,
    private val auth: AuthService,
    private val transaction: TransactionTemplate,
    @param:Value("\${bnoc.operations.valid-seconds:120}") private val validSeconds: Long,
    @param:Value("\${bnoc.operations.poll-ms:30000}") private val pollMs: Long,
    @param:Value("\${bnoc.operations.timeout-ms:5000}") private val timeoutMs: Long
) {
    private data class Definition(val id: String, val kind: String, val group: String?, val name: String)
    private val definitions = listOf(
        Definition("posture-transmission", "posture", null, "전송망 운용태세"),
        Definition("posture-computing", "posture", null, "전산체계 운용태세"),
        Definition("alarm-facility", "alarm", null, "통신시설 장애경보"),
        Definition("alarm-network", "alarm", null, "통신망 이상경보"),
        Definition("asset-facility-main", "asset", "통신시설", "주 통신실"),
        Definition("asset-facility-reserve", "asset", "통신시설", "예비 통신실"),
        Definition("asset-equipment-optical", "asset", "전송장비", "광전송 장비"),
        Definition("asset-equipment-wireless", "asset", "전송장비", "무선중계 장비"),
        Definition("asset-system-support", "asset", "업무체계", "업무지원 체계"),
        Definition("asset-system-situation", "asset", "업무체계", "상황공유 체계"),
        Definition("asset-network-internal", "asset", "통신망", "내부 업무망"),
        Definition("asset-network-facility", "asset", "통신망", "시설 관리망"),
        Definition("asset-computer-server", "asset", "전산장비", "업무 서버"),
        Definition("asset-computer-storage", "asset", "전산장비", "자료 보관 서버")
    )
    private val groups = listOf("통신시설", "전송장비", "업무체계", "통신망", "전산장비")

    @PostConstruct fun validateConfiguration() {
        check(validSeconds > 0 && pollMs > 0 && timeoutMs > 0) { "운영현황 수집 주기·시간 초과·유효시간은 양수여야 합니다." }
    }

    @Scheduled(fixedDelayString = "\${bnoc.operations.poll-ms:30000}", initialDelayString = "\${bnoc.operations.poll-ms:30000}")
    fun collectOnSchedule() { collect() }

    fun collect() {
        val attemptedAt = Instant.now()
        val result = runCatching {
            val response = auth.client.send(
                HttpRequest.newBuilder(URI("${auth.providerUrl}/feeds/operations"))
                    .header("X-Mock-Key", auth.secret).timeout(Duration.ofMillis(timeoutMs)).GET().build(),
                HttpResponse.BodyHandlers.ofString()
            )
            if (response.statusCode() != 200) throw FeedFailure("SOURCE_UNAVAILABLE")
            validateFeed(db.json.readValue(response.body(), Map::class.java))
        }
        val feed = result.getOrNull()
        val failure = when (val error = result.exceptionOrNull()) {
            null -> null
            is FeedFailure -> error.code
            is java.net.http.HttpTimeoutException -> "TIMEOUT"
            else -> "SOURCE_UNAVAILABLE"
        }
        transaction.execute {
            db.lockResource("operations-status")
            if (feed != null) {
                val succeededAt = Instant.now().toString()
                feed.forEach { item ->
                    db.jdbc.update(
                        "INSERT INTO bnoc_operations_status_items(item_id,kind,group_id,display_name,stage_code,health,observed_at,last_success) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE kind=VALUES(kind),group_id=VALUES(group_id),display_name=VALUES(display_name),stage_code=VALUES(stage_code),health=VALUES(health),observed_at=VALUES(observed_at),last_success=VALUES(last_success)",
                        item["itemId"], item["kind"], item["groupId"], item["displayName"], item["stageCode"], item["health"], item["observedAt"], succeededAt
                    )
                }
                val observed = feed.minOf { Instant.parse(it["observedAt"] as String) }.toString()
                db.jdbc.update("INSERT INTO bnoc_operations_status_state(state_id,last_attempt,last_success,observed_at,collection_state,failure_code) VALUES (1,?,?,?,'ok',NULL) ON DUPLICATE KEY UPDATE last_attempt=VALUES(last_attempt),last_success=VALUES(last_success),observed_at=VALUES(observed_at),collection_state='ok',failure_code=NULL", attemptedAt.toString(), succeededAt, observed)
            } else {
                db.jdbc.update("INSERT INTO bnoc_operations_status_state(state_id,last_attempt,collection_state,failure_code) VALUES (1,?,'failed',?) ON DUPLICATE KEY UPDATE last_attempt=VALUES(last_attempt),collection_state='failed',failure_code=VALUES(failure_code)", attemptedAt.toString(), failure ?: "SOURCE_UNAVAILABLE")
            }
        }
    }

    fun snapshot(): Map<String, Any?> {
        if (db.rows("SELECT state_id FROM bnoc_operations_status_state WHERE state_id=1").isEmpty()) collect()
        val rows = db.rows("SELECT * FROM bnoc_operations_status_items ORDER BY item_id")
        val state = db.rows("SELECT * FROM bnoc_operations_status_state WHERE state_id=1").firstOrNull()
        val observedAt = state?.get("observed_at") as? String
        val stale = observedAt?.let { !Instant.now().isBefore(Instant.parse(it).plusSeconds(validSeconds)) } ?: false
        val collectionState = when {
            state == null -> "not_collected"
            state["collection_state"] == "failed" -> "failed"
            stale -> "stale"
            else -> "ok"
        }
        val items = rows.map { row ->
            mapOf("itemId" to row["item_id"], "kind" to row["kind"], "groupId" to row["group_id"], "displayName" to row["display_name"], "stageCode" to row["stage_code"], "health" to row["health"], "observedAt" to row["observed_at"])
        }
        return mapOf(
            "collectionState" to collectionState, "failureCode" to state?.get("failure_code"), "lastAttempt" to state?.get("last_attempt"),
            "lastSuccess" to state?.get("last_success"), "observedAt" to observedAt, "stale" to stale,
            "postures" to items.filter { it["kind"] == "posture" }, "alarms" to items.filter { it["kind"] == "alarm" },
            "groups" to groups.map { group -> mapOf("groupId" to group, "items" to items.filter { it["kind"] == "asset" && it["groupId"] == group }) }, "items" to items
        )
    }

    private fun validateFeed(feed: Map<*, *>): List<Map<String, Any?>> {
        if (feed["kind"] != "operations" || feed["sourceMode"] != "simulation") throw FeedFailure("SOURCE_MISMATCH")
        val topObserved = (feed["observedAt"] as? String)?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: throw FeedFailure("INVALID_OBSERVED_AT")
        if (topObserved.isAfter(Instant.now().plusSeconds(60))) throw FeedFailure("FUTURE_OBSERVED_AT")
        val input = feed["items"] as? List<*> ?: throw FeedFailure("INVALID_FEED")
        if (input.size != definitions.size) throw FeedFailure("INVALID_FEED")
        val byId = definitions.associateBy { it.id }
        val seen = mutableSetOf<String>()
        return input.map { value ->
            val item = value as? Map<*, *> ?: throw FeedFailure("INVALID_FEED")
            val id = item["itemId"] as? String ?: throw FeedFailure("INVALID_FEED")
            val definition = byId[id] ?: throw FeedFailure("INVALID_FEED")
            if (!seen.add(id) || item["kind"] != definition.kind || item["displayName"] != definition.name || item["groupId"] != definition.group) throw FeedFailure("INVALID_FEED")
            val observed = (item["observedAt"] as? String)?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: throw FeedFailure("INVALID_OBSERVED_AT")
            if (observed.isAfter(Instant.now().plusSeconds(60))) throw FeedFailure("FUTURE_OBSERVED_AT")
            val stage = if (definition.kind == "posture") item["stageCode"] as? String else null
            val health = if (definition.kind != "posture") item["health"] as? String else null
            if (definition.kind == "posture" && stage !in listOf("1", "2", "3", "4", "5")) throw FeedFailure("INVALID_STAGE")
            if (definition.kind != "posture" && health !in listOf("normal", "abnormal")) throw FeedFailure("INVALID_HEALTH")
            mapOf("itemId" to id, "kind" to definition.kind, "groupId" to definition.group, "displayName" to definition.name, "stageCode" to stage, "health" to health, "observedAt" to observed.toString())
        }.also { if (seen.size != definitions.size) throw FeedFailure("INVALID_FEED") }
    }

    private class FeedFailure(val code: String) : RuntimeException(code)
}
