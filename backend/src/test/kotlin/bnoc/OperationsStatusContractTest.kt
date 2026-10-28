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

    private data class ObservedQuery(val sql:String,val readOnly:Boolean,val isolation:Int)
    private fun strictStorage():Pair<Database,MutableList<ObservedQuery>> {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE","sa","")
        val queries=mutableListOf<ObservedQuery>()
        fun track(connection:java.sql.Connection):java.sql.Connection {
            var readOnly=false
            return java.lang.reflect.Proxy.newProxyInstance(java.sql.Connection::class.java.classLoader,arrayOf(java.sql.Connection::class.java)) { _,method,args ->
                if(method.name=="setReadOnly")readOnly=args!![0] as Boolean
                if(method.name=="isReadOnly")return@newProxyInstance readOnly
                if(method.name=="prepareStatement" && args?.firstOrNull() is String) {
                    val sql=args[0] as String
                    queries.add(ObservedQuery(sql,readOnly,connection.transactionIsolation))
                    if(readOnly && sql.trimStart().substringBefore(' ').uppercase() in setOf("INSERT","UPDATE","DELETE"))
                        throw java.sql.SQLException("Connection is read-only. Queries leading to data modification are not allowed.","S1009")
                }
                try { method.invoke(connection,*(args ?: emptyArray())) } catch(error:java.lang.reflect.InvocationTargetException) { throw error.targetException }
            } as java.sql.Connection
        }
        val tracked=object:org.springframework.jdbc.datasource.AbstractDataSource() {
            override fun getConnection()=track(source.connection)
            override fun getConnection(username:String,password:String)=track(source.getConnection(username,password))
        }
        return Database(JdbcTemplate(tracked)).also { it.initialize() } to queries
    }
    private fun firstControllerSnapshot(storage:Database,queries:MutableList<ObservedQuery>):Map<*,*> {
        val transaction=TransactionTemplate(DataSourceTransactionManager(storage.jdbc.dataSource!!))
        val collector=OperationsStatusService(storage,auth,transaction,120,30000,2000)
        val request=org.springframework.mock.web.MockHttpServletRequest()
        val controllerAuth=org.mockito.Mockito.mock(AuthService::class.java)
        org.mockito.Mockito.`when`(controllerAuth.actor(request)).thenReturn(storage.actor("requester"))
        val controller=ApiController(controllerAuth,storage,org.mockito.Mockito.mock(WorkflowService::class.java),org.mockito.Mockito.mock(QueryService::class.java),org.mockito.Mockito.mock(AttachmentService::class.java),org.mockito.Mockito.mock(SituationService::class.java),collector,org.mockito.Mockito.mock(PlannedWorkService::class.java),org.mockito.Mockito.mock(DocumentAnalysisService::class.java))
        val proxy=org.springframework.aop.framework.ProxyFactory(controller).apply {
            isProxyTargetClass=true
            addAdvice(org.springframework.transaction.interceptor.TransactionInterceptor().apply {
                transactionManager=transaction.transactionManager
                transactionAttributeSource=org.springframework.transaction.annotation.AnnotationTransactionAttributeSource()
            })
        }.proxy as ApiController
        queries.clear()
        val snapshot=proxy.operationsStatus(request)["data"] as Map<*,*>
        val snapshotReads=queries.filter { it.sql.startsWith("SELECT * FROM bnoc_operations_status_") }
        assertEquals(2,snapshotReads.size,"OPERATIONS_ITEMS_AND_STATE_MUST_SHARE_A_READ_SNAPSHOT")
        assertTrue(snapshotReads.all { it.isolation==java.sql.Connection.TRANSACTION_REPEATABLE_READ },"OPERATIONS_SNAPSHOT_MUST_KEEP_REPEATABLE_READ")
        assertTrue(queries.filter { it.sql.startsWith("INSERT") || it.sql.startsWith("UPDATE") }.all { !it.readOnly },"FIRST_COLLECTION_MUST_USE_A_WRITABLE_GET_TRANSACTION")
        assertFalse(transaction.isReadOnly,"SHARED_TRANSACTION_TEMPLATE_MUST_NOT_BE_MUTATED")
        return snapshot
    }
    @Test fun `fresh controller read persists the source in its repeatable read transaction`() {
        val (storage,queries)=strictStorage()
        val snapshot=firstControllerSnapshot(storage,queries)
        assertEquals("ok",snapshot["collectionState"])
        assertEquals(14,(snapshot["items"] as List<*>).size)
        assertEquals(1,storage.rows("SELECT * FROM bnoc_operations_status_state").size)
    }
    @Test fun `fresh controller read persists source failure without a read only write error`() {
        status=503
        val (storage,queries)=strictStorage()
        val snapshot=firstControllerSnapshot(storage,queries)
        assertEquals("failed",snapshot["collectionState"])
        assertEquals("SOURCE_UNAVAILABLE",snapshot["failureCode"])
        assertTrue((snapshot["items"] as List<*>).isEmpty())
        assertNull(snapshot["lastSuccess"])
    }

    @Test fun `old source values are marked stale`() {
        response.set(feed(Instant.now().minusSeconds(300)))
        service.collect()
        assertEquals("stale", service.snapshot()["collectionState"])
        assertEquals(true, service.snapshot()["stale"])
    }
}
