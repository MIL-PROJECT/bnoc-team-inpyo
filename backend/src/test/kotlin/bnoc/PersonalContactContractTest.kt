package bnoc

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.util.UUID

class PersonalContactContractTest {
    private lateinit var db:Database
    private lateinit var workflow:WorkflowService
    private lateinit var query:QueryService
    private lateinit var requester:Actor
    private lateinit var bnoc:Actor
    private lateinit var wireless:Actor
    private lateinit var wired:Actor

    @BeforeEach fun setup() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "")
        db=Database(JdbcTemplate(source));db.initialize()
        workflow=WorkflowService(db,TransactionTemplate(DataSourceTransactionManager(source)))
        query=QueryService(db,workflow)
        requester=db.actor("requester")!!;bnoc=db.actor("bnoc")!!;wireless=db.actor("team-wireless")!!;wired=db.actor("team-wired")!!
    }

    private fun command(actor:Actor,type:String,number:String?=null,revision:Long?=null,payload:Map<String,Any?> = emptyMap()) =
        workflow.execute(actor,Command(type,UUID.randomUUID().toString(),number,expectedRevision=revision,payload=payload))

    private fun assertNoPersonalContact(value:Any?) {
        when(value) {
            is Map<*,*> -> { assertFalse(value.containsKey("personalContact"),"PRIVATE_CONTACT_KEY_MUST_NOT_LEAVE_DETAIL");value.values.forEach(::assertNoPersonalContact) }
            is Iterable<*> -> value.forEach(::assertNoPersonalContact)
        }
    }

    private fun create():String = command(requester,"createRequest",payload=mapOf(
        "category" to "장비/체계","subcategories" to mapOf("systemType" to "인터넷","resourceType" to "PC","workType" to "고장"),
        "detail" to "화면 오류","location" to "사무실","contact" to "1234","personalContact" to "010-0000-0000"
    )).requestNumber!!

    @Test fun `optional phone accepts omission and enforces the existing text limit`() {
        val payload=mapOf("category" to "장비/체계","subcategories" to mapOf("systemType" to "인터넷","resourceType" to "PC","workType" to "고장"),"detail" to "화면 오류","location" to "사무실","contact" to "1234")
        val number=command(requester,"createRequest",payload=payload).requestNumber!!
        assertNull(db.request(number)!!.personalContact)
        for(value in listOf("문자만 입력","123-abc-4567","123456","+82 10 1234 5678","010(1234)5678")) {
            val invalid=assertThrows(BusinessFailure::class.java) { command(requester,"createRequest",payload=payload+mapOf("personalContact" to value)) }
            assertEquals("VALIDATION",invalid.code)
        }
        assertEquals("821012345678",db.request(command(requester,"createRequest",payload=payload+mapOf("personalContact" to "821012345678")).requestNumber!!)!!.personalContact)
        val invalid=assertThrows(BusinessFailure::class.java) { command(requester,"createRequest",payload=payload+mapOf("personalContact" to "0".repeat(51))) }
        assertEquals("VALIDATION",invalid.code)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { command(wireless,"createAfterActionReport",payload=mapOf("personalContact" to "010-0000-0000")) }.code)
    }

    @Test fun `v10 migration adds nullable phone without dropping existing request rows`() {
        val number=create()
        db.jdbc.execute("ALTER TABLE bnoc_requests DROP COLUMN personal_contact")
        db.jdbc.update("DELETE FROM bnoc_schema_migrations WHERE version=10")
        Database(db.jdbc).initialize()
        assertNotNull(db.jdbc.queryForObject("SELECT request_number FROM bnoc_requests WHERE request_number=?",String::class.java,number))
        assertNull(db.request(number)!!.personalContact)
        assertEquals(1,db.jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_schema_migrations WHERE version=10",Int::class.java))
    }

    @Test fun `completed work remains a current assigned teams contact view`() {
        val number=create()
        command(bnoc,"assignTeams",number,db.request(number)!!.revision,mapOf("teamIds" to listOf("무선반","유선반"),"priority" to "general"))
        val work=db.works(number).first { it.teamId==wireless.teamId }
        workflow.execute(wireless,Command("updateWork",UUID.randomUUID().toString(),number,work.number,work.revision,mapOf("nextStatus" to "완료")))
        assertEquals("010-0000-0000",query.detail(wireless,number)["personalContact"])
        assertEquals("010-0000-0000",query.detail(wired,number)["personalContact"])
    }

    @Test fun `optional personal contact persists and is visible only to owner BNOC and current assigned team`() {
        val number=create()
        assertEquals("010-0000-0000",db.request(number)!!.personalContact)
        assertEquals("010-0000-0000",query.detail(requester,number)["personalContact"])
        assertEquals("010-0000-0000",query.detail(bnoc,number)["personalContact"])
        assertNoPersonalContact(query.list(requester,emptyMap()))

        command(bnoc,"assignTeams",number,db.request(number)!!.revision,mapOf("teamIds" to listOf("무선반"),"priority" to "general"))
        assertEquals("010-0000-0000",query.detail(wireless,number)["personalContact"])
        val alerts=query.notifications(wireless)
        assertTrue(alerts.isNotEmpty(),"ASSIGNED_TEAM_MUST_RECEIVE_THE_TEST_NOTIFICATION")
        assertNoPersonalContact(query.shared(wireless,emptyMap()))
        assertNoPersonalContact(query.schedule(wireless,emptyMap()))
        assertNoPersonalContact(alerts)
        assertNoPersonalContact(query.overview(bnoc,emptyMap()))

        val oldWork=db.works(number).single()
        workflow.execute(bnoc,Command("reassignAssignedWork",UUID.randomUUID().toString(),number,oldWork.number,oldWork.revision,mapOf("teamIds" to listOf("유선반"))))
        assertNull(query.detail(wireless,number)["personalContact"],"PAST_TEAM_MUST_NOT_SEE_PERSONAL_CONTACT")
        assertEquals("010-0000-0000",query.detail(wired,number)["personalContact"])

        command(requester,"updateRequest",number,db.request(number)!!.revision,mapOf("personalContact" to ""))
        assertNull(db.request(number)!!.personalContact,"EMPTY_OPTIONAL_CONTACT_MUST_CLEAR_VALUE")
        val history=db.rows("SELECT before_value,after_value FROM bnoc_history WHERE request_number=?",number)
        assertTrue(history.none { "010-0000-0000" in (it["before_value"]?.toString() ?: "") || "010-0000-0000" in (it["after_value"]?.toString() ?: "") },"PERSONAL_CONTACT_MUST_NOT_BE_COPIED_TO_HISTORY")
    }
}
