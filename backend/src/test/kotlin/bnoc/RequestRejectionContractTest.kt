package bnoc

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.transaction.support.TransactionTemplate
import java.util.UUID

class RequestRejectionContractTest {
    private lateinit var db:Database
    private lateinit var workflow:WorkflowService
    private lateinit var query:QueryService
    private lateinit var requester:Actor
    private lateinit var bnoc:Actor
    private lateinit var team:Actor

    @BeforeEach fun setup() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "")
        db=Database(JdbcTemplate(source));db.initialize()
        workflow=WorkflowService(db,TransactionTemplate(DataSourceTransactionManager(source)))
        query=QueryService(db,workflow)
        requester=db.actor("requester")!!;bnoc=db.actor("bnoc")!!;team=db.actor("team-wireless")!!
    }

    private fun command(actor:Actor,type:String,number:String,revision:Long?=db.request(number)?.revision,payload:Map<String,Any?> = emptyMap()) =
        workflow.execute(actor,Command(type,UUID.randomUUID().toString(),number,expectedRevision=revision,payload=payload))
    private fun create():String = workflow.execute(requester,Command("createRequest",UUID.randomUUID().toString(),payload=mapOf(
        "category" to "장비/체계","subcategories" to mapOf("systemType" to "인터넷","resourceType" to "PC","workType" to "지원"),
        "detail" to "요청 내용","location" to "행정실","contact" to "1234"
    ))).requestNumber!!

    @Test fun `BNOC rejects unassigned request and records reason actor time history and requester notice`() {
        val number=create()
        command(bnoc,"rejectRequest",number,payload=mapOf("reason" to "우리 부대 담당 범위 밖입니다."))

        val stored=db.request(number)!!
        assertEquals("기각",stored.status)
        val metadata=db.rows("SELECT rejection_reason,rejected_by,rejected_at FROM bnoc_requests WHERE request_number=?",number).single()
        assertEquals("우리 부대 담당 범위 밖입니다.",metadata["rejection_reason"])
        assertEquals(bnoc.id,metadata["rejected_by"])
        assertNotNull(metadata["rejected_at"])
        assertNotNull(java.time.Instant.parse(metadata["rejected_at"] as String))
        assertEquals("기각",RequestStatus.derive(stored,db.works(number)))
        assertTrue(query.detail(requester,number)["rejectionReason"]=="우리 부대 담당 범위 밖입니다.")
        assertTrue(query.detail(bnoc,number)["rejectionReason"]=="우리 부대 담당 범위 밖입니다.")
        assertTrue(query.history(requester,number).any { it["field"]=="기각 사유" && it["summary"]=="기각 사유: 우리 부대 담당 범위 밖입니다." })
        assertEquals(1,db.rows("SELECT * FROM bnoc_notifications WHERE recipient_subject=? AND request_number=? AND event_name='기각'",requester.id,number).size)
        assertFalse(query.detail(requester,number)["canAssign"] as Boolean)
        assertFalse(query.detail(requester,number)["canCancel"] as Boolean)
        assertFalse(query.detail(bnoc,number)["canReject"] as Boolean)
        val overview=query.overview(bnoc,emptyMap())
        assertEquals(1,(overview["byStatus"] as Map<*,*>)["기각"])
        val shared=query.shared(requester,emptyMap())
        assertEquals(0,shared["unassignedRequests"])
        assertEquals(0,(shared["counts"] as Map<*,*>)["all"])
    }

    @Test fun `BNOC may reject document waiting but not assigned or completed requests`() {
        val waiting=create()
        command(bnoc,"moveToDocumentWaiting",waiting)
        command(bnoc,"rejectRequest",waiting,payload=mapOf("reason" to "업무 범위가 아닙니다."))
        assertEquals("기각",db.request(waiting)!!.status)

        val assigned=create()
        command(bnoc,"assignTeams",assigned,payload=mapOf("teamIds" to listOf("무선반"),"priority" to "general"))
        assertEquals("INVALID_STATE",assertThrows(BusinessFailure::class.java) {
            command(bnoc,"rejectRequest",assigned,payload=mapOf("reason" to "배정 뒤에는 기각할 수 없습니다."))
        }.code)
        assertEquals("배정",db.request(assigned)!!.status)
        assertEquals(1,db.works(assigned).size)
    }

    @Test fun `BNOC rejects after all returned assignments are withdrawn and keeps their history`() {
        val number=create()
        command(bnoc,"assignTeams",number,payload=mapOf("teamIds" to listOf("무선반"),"priority" to "general"))
        var work=db.works(number).single()
        workflow.execute(team,Command("updateWork",UUID.randomUUID().toString(),number,work.number,work.revision,mapOf("nextStatus" to "반환","returnReason" to "담당 작업이 아닙니다.")))
        work=db.work(work.number)!!
        workflow.execute(bnoc,Command("withdrawReturnedWork",UUID.randomUUID().toString(),number,work.number,work.revision))
        val before=db.work(work.number)!!.copy()
        val historyBefore=db.rows("SELECT * FROM bnoc_history WHERE request_number=?",number).size
        assertTrue(query.detail(bnoc,number)["canReject"] as Boolean,"WITHDRAWN_RETURN_MUST_ALLOW_REJECTION")
        command(bnoc,"rejectRequest",number,payload=mapOf("reason" to "담당 부서가 없는 요청입니다."))
        assertEquals("기각",db.request(number)!!.status)
        assertEquals(before,db.work(work.number),"REJECTION_MUST_PRESERVE_WITHDRAWN_WORK")
        assertTrue(db.rows("SELECT * FROM bnoc_history WHERE request_number=?",number).size>historyBefore)
        assertFalse(query.detail(bnoc,number)["canReject"] as Boolean)
    }

    @Test fun `BNOC directly rejects all returned work atomically without losing return records`() {
        val number=create()
        command(bnoc,"assignTeams",number,payload=mapOf("teamIds" to listOf("무선반","유선반"),"priority" to "general"))
        db.works(number).forEach { work ->
            val actor=db.actor(if(work.teamId=="무선반") "team-wireless" else "team-wired")!!
            workflow.execute(actor,Command("updateWork",UUID.randomUUID().toString(),number,work.number,work.revision,mapOf("nextStatus" to "반환","returnReason" to "담당 작업이 아닙니다.")))
        }
        assertTrue(query.detail(bnoc,number)["canReject"] as Boolean,"ALL_RETURNED_MUST_ALLOW_DIRECT_REJECTION")
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { command(bnoc,"rejectRequest",number,payload=mapOf("reason" to " ")) }.code)
        assertTrue(db.works(number).all { it.resolutionKind=="open" },"INVALID_REJECTION_MUST_NOT_WITHDRAW_RETURNS")
        val command=Command("rejectRequest",UUID.randomUUID().toString(),number,expectedRevision=db.request(number)!!.revision,payload=mapOf("reason" to "부대 담당 업무가 아닙니다."))
        workflow.execute(bnoc,command)
        assertEquals("기각",db.request(number)!!.status)
        assertEquals(2,db.works(number).size)
        assertTrue(db.works(number).all { it.status=="반환" && it.returnReason=="담당 작업이 아닙니다." && it.resolutionKind=="withdrawn" && it.resolvedByActor==bnoc.id })
        assertEquals(2,db.rows("SELECT * FROM bnoc_history WHERE request_number=? AND field_name='반환 배정 해제'",number).size)
        assertTrue(workflow.execute(bnoc,command).replayed)
        assertEquals(1,db.rows("SELECT * FROM bnoc_notifications WHERE request_number=? AND recipient_subject=? AND event_name='기각'",number,requester.id).size)
    }

    @Test fun `one returned department never allows rejection while another department remains responsible`() {
        for(status in listOf("배정","작업 중","완료")) {
            val number=create()
            command(bnoc,"assignTeams",number,payload=mapOf("teamIds" to listOf("무선반","유선반"),"priority" to "general"))
            val wireless=db.works(number).first { it.teamId=="무선반" }
            workflow.execute(team,Command("updateWork",UUID.randomUUID().toString(),number,wireless.number,wireless.revision,mapOf("nextStatus" to "반환","returnReason" to "담당 작업 아님")))
            val wired=db.works(number).first { it.teamId=="유선반" }
            if(status!="배정") workflow.execute(db.actor("team-wired")!!,Command("updateWork",UUID.randomUUID().toString(),number,wired.number,wired.revision,mapOf("nextStatus" to status)))
            assertFalse(query.detail(bnoc,number)["canReject"] as Boolean,"ACTIVE_DEPARTMENT_MUST_BLOCK_REJECTION:$status")
            assertEquals("INVALID_STATE",assertThrows(BusinessFailure::class.java) { command(bnoc,"rejectRequest",number,payload=mapOf("reason" to "기각 금지")) }.code)
            assertTrue(db.works(number).all { it.resolutionKind=="open" })
        }
    }

    @Test fun `failed rejection notification rolls returned resolutions history and request back together`() {
        val number=create()
        command(bnoc,"assignTeams",number,payload=mapOf("teamIds" to listOf("무선반"),"priority" to "general"))
        val assigned=db.works(number).single()
        workflow.execute(team,Command("updateWork",UUID.randomUUID().toString(),number,assigned.number,assigned.revision,mapOf("nextStatus" to "반환","returnReason" to "담당 작업 아님")))
        val before=db.works(number).single().copy();val history=db.rows("SELECT * FROM bnoc_history WHERE request_number=?",number).size
        db.jdbc.execute("DROP TABLE bnoc_notifications")
        assertThrows(Exception::class.java) { command(bnoc,"rejectRequest",number,payload=mapOf("reason" to "기각 저장 실패")) }
        assertEquals(before,db.works(number).single(),"FAILED_REJECTION_MUST_RESTORE_RETURN_RESOLUTION")
        assertEquals("대기",db.request(number)!!.status)
        assertEquals(history,db.rows("SELECT * FROM bnoc_history WHERE request_number=?",number).size)
        assertEquals(0,db.rows("SELECT * FROM bnoc_receipts WHERE command_type='rejectRequest' AND request_number=?",number).size)
    }

    @Test fun `reject requires BNOC a nonblank bounded reason current revision and valid request state`() {
        val number=create()
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) {
            command(team,"rejectRequest",number,payload=mapOf("reason" to "담당 범위 밖"))
        }.code)
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) {
            command(requester,"rejectRequest",number,payload=mapOf("reason" to "담당 범위 밖"))
        }.code)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) {
            command(bnoc,"rejectRequest",number,payload=mapOf("reason" to "   "))
        }.code)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) {
            command(bnoc,"rejectRequest",number,payload=mapOf("reason" to "가".repeat(2001)))
        }.code)
        assertEquals("CONFLICT",assertThrows(BusinessFailure::class.java) {
            command(bnoc,"rejectRequest",number,revision=0L,payload=mapOf("reason" to "담당 범위 밖"))
        }.code)
        assertEquals("대기",db.request(number)!!.status)
        command(bnoc,"rejectRequest",number,payload=mapOf("reason" to "담당 범위 밖"))
        val current=db.request(number)!!.revision
        for((actor,type,payload) in listOf(
            Triple(requester,"updateRequest",mapOf("detail" to "종결 후 수정 금지") as Map<String,Any?>),
            Triple(requester,"cancelRequest",emptyMap()),
            Triple(bnoc,"assignTeams",mapOf("teamIds" to listOf("유선반"),"priority" to "general")),
            Triple(bnoc,"changePriority",mapOf("priority" to "urgent")),
            Triple(bnoc,"moveToDocumentWaiting",emptyMap()),
            Triple(bnoc,"rejectRequest",mapOf("reason" to "다시 기각 금지"))
        )) {
            assertEquals("INVALID_STATE",assertThrows(BusinessFailure::class.java) {
                command(actor,type,number,revision=current,payload=payload)
            }.code,"REJECTED_REQUEST_MUST_REMAIN_TERMINAL: $type")
        }
        assertEquals("기각",db.request(number)!!.status)
        assertTrue(db.works(number).isEmpty())
    }

    @Test fun `v11 migration adds nullable rejection metadata without dropping v10 requests`() {
        val number=create()
        db.jdbc.execute("ALTER TABLE bnoc_requests DROP COLUMN rejection_reason")
        db.jdbc.execute("ALTER TABLE bnoc_requests DROP COLUMN rejected_by")
        db.jdbc.execute("ALTER TABLE bnoc_requests DROP COLUMN rejected_at")
        db.jdbc.update("DELETE FROM bnoc_schema_migrations WHERE version=11")

        Database(db.jdbc).initialize()

        assertEquals(number,db.jdbc.queryForObject("SELECT request_number FROM bnoc_requests WHERE request_number=?",String::class.java,number))
        val metadata=db.rows("SELECT rejection_reason,rejected_by,rejected_at FROM bnoc_requests WHERE request_number=?",number).single()
        assertNull(metadata["rejection_reason"]);assertNull(metadata["rejected_by"]);assertNull(metadata["rejected_at"])
        assertEquals(1,db.jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_schema_migrations WHERE version=11",Int::class.java))
    }

    @Test fun `notification failure rolls request rejection metadata history and receipt back`() {
        val number=create()
        val historyBefore=db.rows("SELECT * FROM bnoc_history WHERE request_number=?",number).size
        db.jdbc.execute("DROP TABLE bnoc_notifications")
        assertThrows(Exception::class.java) {
            command(bnoc,"rejectRequest",number,payload=mapOf("reason" to "담당 범위 밖"))
        }
        val stored=db.request(number)!!
        assertEquals("대기",stored.status)
        val metadata=db.rows("SELECT rejection_reason,rejected_by,rejected_at FROM bnoc_requests WHERE request_number=?",number).single()
        assertNull(metadata["rejection_reason"]);assertNull(metadata["rejected_by"]);assertNull(metadata["rejected_at"])
        assertEquals(historyBefore,db.rows("SELECT * FROM bnoc_history WHERE request_number=?",number).size)
        assertEquals(0,db.rows("SELECT * FROM bnoc_receipts WHERE command_type='rejectRequest' AND request_number=?",number).size)
    }
}
