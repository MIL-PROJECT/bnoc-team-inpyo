package bnoc

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.transaction.support.TransactionTemplate
import java.time.Instant
import java.util.UUID

class ProxyRequestOwnershipContractTest {
    private lateinit var db:Database
    private lateinit var workflow:WorkflowService
    private lateinit var query:QueryService
    private lateinit var requester:Actor
    private lateinit var otherRequester:Actor
    private lateinit var bnoc:Actor
    private lateinit var team:Actor

    @BeforeEach fun setup() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "")
        db=Database(JdbcTemplate(source));db.initialize()
        workflow=WorkflowService(db,TransactionTemplate(DataSourceTransactionManager(source)))
        query=QueryService(db,workflow)
        requester=db.actor("requester")!!;otherRequester=db.actor("requester-secondary")!!;bnoc=db.actor("bnoc")!!;team=db.actor("team-wireless")!!
    }

    private fun command(actor:Actor,type:String,number:String?=null,revision:Long?=null,payload:Map<String,Any?> = emptyMap()) =
        workflow.execute(actor,Command(type,UUID.randomUUID().toString(),number,expectedRevision=revision,payload=payload))
    private fun requestPayload(ref:String?=requester.subjectRef) = mapOf(
        "category" to "장비/체계","subcategories" to mapOf("systemType" to "인터넷","resourceType" to "PC","workType" to "지원"),
        "detail" to "점검 요청","location" to "사무실","contact" to "1234"
    ) + (ref?.let { mapOf("requesterRef" to it) } ?: emptyMap())

    @Test fun `BNOC requester picker returns only active public requester fields`() {
        db.jdbc.update("UPDATE bnoc_subjects SET active=FALSE WHERE subject_id=?",otherRequester.id)
        val choices=query.requesters(bnoc)
        assertEquals(1,choices.size)
        assertEquals(setOf("requesterRef","displayName","department"),choices.single().keys)
        assertEquals(requester.subjectRef,choices.single()["requesterRef"])
        assertFalse(choices.single().containsValue(requester.id),"SSO_SUBJECT_MUST_NOT_BE_EXPOSED")
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { query.requesters(requester) }.code)
    }

    @Test fun `reuse is available only for own directly registered requests including closed requests`() {
        val direct=command(requester,"createRequest",payload=requestPayload(null)).requestNumber!!
        assertEquals(true,query.detail(requester,direct)["canReuse"],"OWN_DIRECT_REQUEST_CAN_BE_REUSED")
        assertEquals(false,query.detail(bnoc,direct)["canReuse"],"BNOC_MUST_NOT_REUSE_ANOTHER_AUTHORS_REQUEST")
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java){query.detail(otherRequester,direct)}.code)
        command(requester,"cancelRequest",direct,db.request(direct)!!.revision)
        assertEquals(true,query.detail(requester,direct)["canReuse"],"CLOSED_REQUEST_CAN_START_A_NEW_DRAFT")
        val proxy=command(bnoc,"createRequest",payload=requestPayload()).requestNumber!!
        assertEquals(false,query.detail(requester,proxy)["canReuse"],"PROXY_IS_OWNED_BUT_NOT_DIRECTLY_AUTHORED")
        assertEquals(false,query.detail(bnoc,proxy)["canReuse"])
        assertTrue(db.works(direct).isEmpty())
    }

    @Test fun `proxy request binds selected account and actual requester can edit it`() {
        val number=command(bnoc,"createRequest",payload=requestPayload()).requestNumber!!
        val stored=db.request(number)!!
        assertEquals(requester.id,stored.requesterSubject)
        assertEquals(bnoc.id,stored.registeredBy)
        assertEquals(listOf(requester.displayName,requester.department).filter { it.isNotBlank() }.joinToString(" · "),stored.requesterDisplayText)
        val registrationRecipients=db.rows("SELECT recipient_subject FROM bnoc_notifications WHERE request_number=? AND event_name='요청 등록'",number).map { it["recipient_subject"] }
        assertTrue(requester.id in registrationRecipients,"PROXY_REQUESTER_MUST_RECEIVE_REGISTRATION_NOTICE")
        assertTrue(bnoc.id in registrationRecipients,"BNOC_MUST_KEEP_REGISTRATION_NOTICE")
        assertFalse(otherRequester.id in registrationRecipients,"UNRELATED_REQUESTER_MUST_NOT_RECEIVE_REGISTRATION_NOTICE")
        assertTrue(workflow.canEdit(requester,stored))
        assertFalse(workflow.canEdit(otherRequester,stored))
        command(requester,"updateRequest",number,stored.revision,mapOf("detail" to "요청자가 직접 수정"))
        assertEquals("요청자가 직접 수정",db.request(number)!!.detail)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) {
            command(requester,"updateRequest",number,db.request(number)!!.revision,mapOf("requesterRef" to otherRequester.subjectRef))
        }.code)
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) {
            command(otherRequester,"updateRequest",number,db.request(number)!!.revision,mapOf("detail" to "다른 요청자 수정"))
        }.code)
        val choices=query.requesters(team)
        assertTrue(choices.isNotEmpty())
        assertEquals(setOf("requesterRef","displayName","department"),choices.first().keys)
        assertTrue(choices.any { it["requesterRef"]==requester.subjectRef })
    }

    @Test fun `legacy requests without an account owner remain unlinked`() {
        val legacy=RequestRecord("9001",null,"이전 대리 요청",bnoc.id,"장비/체계",mapOf("systemType" to "인터넷","resourceType" to "PC","workType" to "지원"),"기존 내용","기존 위치","1234",registeredAt=Instant.now().toString())
        db.insertRequest(legacy)
        assertFalse(workflow.canEdit(requester,legacy))
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) {
            command(requester,"updateRequest",legacy.number,legacy.revision,mapOf("detail" to "자동 연결 금지"))
        }.code)
        assertNull(db.request(legacy.number)!!.requesterSubject)
    }

    @Test fun `proxy request rejects missing forged inactive or non-requester accounts`() {
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { command(bnoc,"createRequest",payload=requestPayload(null)) }.code)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { command(bnoc,"createRequest",payload=requestPayload()+mapOf("requesterDisplayText" to "임의 이름")) }.code)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { command(bnoc,"createRequest",payload=requestPayload("unknown-ref")) }.code)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { command(bnoc,"createRequest",payload=requestPayload(team.subjectRef)) }.code)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { command(requester,"createRequest",payload=requestPayload(otherRequester.subjectRef)) }.code)
        db.jdbc.update("UPDATE bnoc_subjects SET active=FALSE WHERE subject_id=?",otherRequester.id)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { command(bnoc,"createRequest",payload=requestPayload(otherRequester.subjectRef)) }.code)
        assertEquals(0,db.requests().size)
    }
}
