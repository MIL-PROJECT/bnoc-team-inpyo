package bnoc

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

class OperationsStatusContractTest {
    private lateinit var db: Database
    private lateinit var tx: TransactionTemplate
    private lateinit var auth: AuthService
    private lateinit var server: HttpServer
    private lateinit var service: OperationsStatusService
    private val response = AtomicReference<Map<String, Any?>>()
    private var status = 200

    @BeforeEach fun setup() {
        val source = DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "")
        db = Database(JdbcTemplate(source)); db.initialize(); tx = TransactionTemplate(DataSourceTransactionManager(source))
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/feeds/operations") { exchange ->
            val validKey = exchange.requestHeaders.getFirst("X-Mock-Key") == "operations-status-test-secret"
            val bytes = db.json.writeValueAsBytes(if (validKey) response.get() else mapOf("code" to "FORBIDDEN"))
            exchange.sendResponseHeaders(if (validKey) status else 403, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        auth = AuthService(db, "competition", "http://127.0.0.1:${server.address.port}", "operations-status-test-secret", "http://127.0.0.1:8081").also { it.validate() }
        service = OperationsStatusService(db, auth, tx, 120, 30000, 2000)
        response.set(feed())
    }

    @AfterEach fun cleanup() { server.stop(0) }

    private fun feed(observedAt: Instant = Instant.now()): Map<String, Any?> {
        val posture = listOf("posture-transmission" to "전송망 운용태세", "posture-computing" to "전산체계 운용태세").map { (id, name) ->
            mapOf("itemId" to id, "kind" to "posture", "displayName" to name, "stageCode" to "5", "observedAt" to observedAt.toString())
        }
        val alarms = listOf("alarm-facility" to "통신시설 장애경보", "alarm-network" to "통신망 이상경보").map { (id, name) ->
            mapOf("itemId" to id, "kind" to "alarm", "groupId" to null, "displayName" to name, "health" to "normal", "observedAt" to observedAt.toString())
        }
        val names = listOf("통신시설" to listOf("주 통신실" to "asset-facility-main", "예비 통신실" to "asset-facility-reserve"), "전송장비" to listOf("광전송 장비" to "asset-equipment-optical", "무선중계 장비" to "asset-equipment-wireless"), "업무체계" to listOf("업무지원 체계" to "asset-system-support", "상황공유 체계" to "asset-system-situation"), "통신망" to listOf("내부 업무망" to "asset-network-internal", "시설 관리망" to "asset-network-facility"), "전산장비" to listOf("업무 서버" to "asset-computer-server", "자료 보관 서버" to "asset-computer-storage"))
        val assets = names.flatMap { (group, values) -> values.map { (name, id) ->
            mapOf("itemId" to id, "kind" to "asset", "groupId" to group, "displayName" to name, "health" to "normal", "observedAt" to observedAt.toString())
        } }
        return mapOf("kind" to "operations", "sourceMode" to "simulation", "observedAt" to observedAt.toString(), "items" to (posture + alarms + assets))
    }

    @Test fun `valid feed is grouped and last success survives database initialization`() {
        service.collect()
        val snapshot = service.snapshot()
        assertEquals("ok", snapshot["collectionState"])
        assertEquals(2, (snapshot["postures"] as List<*>).size)
        assertEquals(2, (snapshot["alarms"] as List<*>).size)
        assertEquals(5, (snapshot["groups"] as List<*>).size)
        assertEquals(listOf("통신시설", "전송장비", "업무체계", "통신망", "전산장비"), (snapshot["groups"] as List<Map<String, Any?>>).map { it["groupId"] })
        assertTrue((snapshot["groups"] as List<Map<String, Any?>>).all { (it["items"] as List<*>).size == 2 })
        assertEquals(14, (snapshot["items"] as List<*>).size)
        val lastSuccess = snapshot["lastSuccess"]
        db.initialize()
        assertEquals(lastSuccess, service.snapshot()["lastSuccess"])
        assertEquals(14, (service.snapshot()["items"] as List<*>).size)
    }

    @Test fun `failed or malformed feed preserves prior values and never reports current success`() {
        service.collect()
        val lastSuccess = service.snapshot()["lastSuccess"]
        status = 503
        service.collect()
        assertEquals("failed", service.snapshot()["collectionState"])
        assertEquals(lastSuccess, service.snapshot()["lastSuccess"])
        assertEquals(14, (service.snapshot()["items"] as List<*>).size)
        status = 200
        response.set(feed().toMutableMap().also { it["items"] = (feed()["items"] as List<*>).dropLast(1) })
        service.collect()
        assertEquals("INVALID_FEED", service.snapshot()["failureCode"])
        assertEquals(14, (service.snapshot()["items"] as List<*>).size)
        assertEquals(lastSuccess, service.snapshot()["lastSuccess"])
    }

    @Test fun `old source values are marked stale`() {
        response.set(feed(Instant.now().minusSeconds(300)))
        service.collect()
        assertEquals("stale", service.snapshot()["collectionState"])
        assertEquals(true, service.snapshot()["stale"])
    }
}
