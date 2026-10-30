package bnoc

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.transaction.support.TransactionTemplate
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID

class SharedOverviewFeedbackContractTest {
    private lateinit var db:Database
    private lateinit var workflow:WorkflowService
    private lateinit var query:QueryService
    private lateinit var planned:PlannedWorkService
    private lateinit var requester:Actor
    private lateinit var bnoc:Actor
    @BeforeEach fun setup() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE","sa","")
        db=Database(JdbcTemplate(source));db.initialize()
        val transaction=TransactionTemplate(DataSourceTransactionManager(source))
        workflow=WorkflowService(db,transaction);query=QueryService(db,workflow);planned=PlannedWorkService(db,transaction)
        requester=db.actor("requester")!!;bnoc=db.actor("bnoc")!!
    }
    private fun command(actor:Actor,type:String,number:String?=null,work:WorkRecord?=null,payload:Map<String,Any?> = emptyMap()) = workflow.execute(actor,Command(type,UUID.randomUUID().toString(),number,work?.number,work?.revision?:number?.let { db.request(it)!!.revision },payload))
    private fun create(detail:String="컴퓨터 고장 1대 / 행정실 / 증상을 잘 모르겠어요\n전화기 고장 1대 / 회의실 / 통화가 안 돼요"):String = command(requester,"createRequest",payload=mapOf("category" to "장비/체계","subcategories" to mapOf("systemType" to "인터넷","resourceType" to "PC","workType" to "고장"),"detail" to detail,"location" to "행정실","contact" to "1234")).requestNumber!!
    private fun assign(number:String,teams:List<String>) { command(bnoc,"assignTeams",number,payload=mapOf("teamIds" to teams,"priority" to "general")) }
    private fun seed() {
        val shared=create();assign(shared,listOf("무선반","유선반"))
        val excluded=create();assign(excluded,listOf("정체반"))
        val work=db.works(shared).first { it.teamId=="무선반" }
        command(db.actor("team-wireless")!!,"updateWork",shared,work,mapOf("nextStatus" to "완료"))
        val today=LocalDate.now(ZoneId.of("Asia/Seoul")).toString()
        planned.create(db.actor("team-wireless")!!,"계획 점검",today,UUID.randomUUID().toString())
        planned.create(db.actor("team-info")!!,"다른 부서 점검",today,UUID.randomUUID().toString())
    }
    @Test fun `multiple departments filter assigned planned counts and detail with one union`() {
        seed();val selected=setOf("무선반","유선반")
        for(actor in listOf(bnoc,requester,db.actor("team-wireless")!!,db.actor("access-admin")!!)) {
            val result=query.shared(actor,mapOf("teamIds" to selected.joinToString(","),"bucket" to "all"))
            val counts=result["counts"] as Map<*,*>;val items=result["items"] as List<*>;val departments=result["byDepartment"] as List<*>
            assertEquals(3,counts["all"],"MULTI_DEPARTMENT_TOTAL_MUST_INCLUDE_ONLY_SELECTED_UNION")
            assertEquals(2,counts["assigned"]);assertEquals(1,counts["planned"]);assertEquals(1,counts["allCompleted"]);assertEquals(2,counts["allRemaining"])
            assertEquals(3,items.size);assertTrue(items.all { (it as Map<*,*>)["teamId"] in selected })
            assertEquals(selected,departments.map { (it as Map<*,*>)["department"] }.toSet())
        }
    }
    @Test fun `multiple department conditions intersect status and keep single department compatibility`() {
        seed()
        val filtered=query.shared(bnoc,mapOf("teamIds" to "무선반,유선반","status" to "완료","bucket" to "all"))
        assertEquals(1,filtered["total"]);assertEquals(0,(filtered["counts"] as Map<*,*>)["planned"])
        assertEquals("무선반",((filtered["items"] as List<*>).single() as Map<*,*>)["teamId"])
        assertEquals(query.shared(bnoc,mapOf("teamId" to "무선반")),query.shared(bnoc,mapOf("teamIds" to "무선반")))
        assertEquals(5,(query.shared(bnoc,emptyMap())["counts"] as Map<*,*>)["all"])
        for(invalid in listOf("무선반,없는반","무선반,")) assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { query.shared(bnoc,mapOf("teamIds" to invalid)) }.code)
    }
    @Test fun `unassigned requests are outside every selected department`() {
        create()
        assertEquals(1,query.shared(bnoc,mapOf("bucket" to "unassigned"))["total"])
        val selected=query.shared(bnoc,mapOf("teamIds" to "무선반,유선반","bucket" to "unassigned"))
        assertEquals(0,selected["total"]);assertEquals(0,selected["unassignedRequests"])
    }
    @Test fun `notification summaries retain request context without exposing internal return notes`() {
        val number=create();assign(number,listOf("무선반"));val work=db.works(number).single()
        command(db.actor("team-wireless")!!,"updateWork",number,work,mapOf("nextStatus" to "반환","returnReason" to "내부 반환 사유"))
        val returned=query.notifications(bnoc).first { it["event"]=="작업 반환" }
        val summary=returned["summary"] as String
        assertTrue(summary.contains("컴퓨터 고장 1대"));assertTrue(summary.contains("행정실"));assertFalse(summary.contains('\n'));assertFalse(summary.contains("내부 반환 사유"))
        val other=db.actor("requester-2") ?: requester.copy(id="unrelated",role="requester")
        db.jdbc.update("INSERT INTO bnoc_notifications(notification_id,recipient_subject,event_name,request_number,work_number,recorded_at,is_read) VALUES (?,?,?,?,?,?,?)",UUID.randomUUID().toString(),other.id,"요청 등록",number,null,java.time.Instant.now().toString(),false)
        assertTrue(query.notifications(other).isEmpty(),"SUMMARY_MUST_RECHECK_REQUEST_VISIBILITY")
    }
    @Test fun `visible request summaries include content independently of reuse eligibility`() {
        val number=create();assign(number,listOf("무선반"))
        for(actor in listOf(bnoc,requester,db.actor("team-wireless")!!)) {
            val row=query.list(actor,emptyMap()).single { it["requestNumber"]==number }
            assertTrue((row["detailPreview"] as? String).orEmpty().contains("컴퓨터 고장"),"VISIBLE_LIST_MUST_SHOW_REQUEST_CONTENT")
            assertEquals("행정실",row["location"])
        }
        assertTrue(query.list(db.actor("team-wired")!!,emptyMap()).isEmpty())
        assertTrue(query.list(requester.copy(id="unrelated"),emptyMap()).isEmpty())
        assertTrue(query.list(db.actor("access-admin")!!,emptyMap()).isEmpty())
        val request=db.request(number)!!
        for(actor in listOf(null,requester.copy(id="unrelated"),db.actor("team-wired")!!,db.actor("access-admin")!!)) {
            val hidden=query.summary(request,actor)
            assertFalse(hidden.containsKey("detailPreview"),"SUMMARY_MUST_NOT_BYPASS_DETAIL_VISIBILITY")
            assertFalse(hidden.containsKey("location"))
        }
        val longNumber=create("컴퓨터 고장 "+"자세한 증상 ".repeat(30))
        assertEquals(120,(query.summary(db.request(longNumber)!!,bnoc)["detailPreview"] as String).length)
    }
    @Test fun `work notifications identify original department after reassignment without changing events`() {
        val number=create();assign(number,listOf("무선반","유선반"))
        val wireless=db.actor("team-wireless")!!;var work=db.works(number).first { it.teamId=="무선반" }
        command(wireless,"updateWork",number,work,mapOf("nextStatus" to "작업 중"))
        val alert=query.notifications(requester).first { it["event"]=="작업 중" }
        assertEquals("무선반",alert["relatedDepartment"],"WORK_NOTIFICATION_MUST_IDENTIFY_DEPARTMENT")
        assertEquals(work.number,alert["relatedWorkItemId"])
        work=db.work(work.number)!!;command(wireless,"updateWork",number,work,mapOf("nextStatus" to "반환","returnReason" to "업무 범위 확인"))
        work=db.work(work.number)!!;command(bnoc,"reassignReturnedWork",number,work,mapOf("teamIds" to listOf("정체반")))
        val retained=query.notifications(requester).first { it["notificationId"]==alert["notificationId"] }
        assertEquals("무선반",retained["relatedDepartment"],"HISTORICAL_NOTIFICATION_MUST_KEEP_ORIGINAL_DEPARTMENT")
        assertEquals("작업 중",retained["event"])
        val past=query.list(wireless,emptyMap()).single { it["requestNumber"]==number }
        assertEquals("past",past["participation"])
        assertTrue((past["detailPreview"] as String).contains("컴퓨터 고장"))
        assertNull(query.notifications(bnoc).first { it["event"]=="요청 등록" }["relatedDepartment"])
    }
    @Test fun `returned and resolved returned history both permit direct rejection projection`() {
        val number=create();assign(number,listOf("무선반"));var work=db.works(number).single()
        command(db.actor("team-wireless")!!,"updateWork",number,work,mapOf("nextStatus" to "반환","returnReason" to "담당 업무 아님"));work=db.work(work.number)!!
        assertEquals(true,query.detail(bnoc,number)["canReject"],"ALL_RETURNED_MUST_EXPOSE_DIRECT_REJECTION")
        command(bnoc,"withdrawReturnedWork",number,work)
        assertEquals(true,query.detail(bnoc,number)["canReject"],"WITHDRAWN_HISTORY_MUST_NOT_HIDE_REJECTION")
        assertEquals(false,query.detail(requester,number)["canReject"]);assertEquals(1,db.works(number).size)
    }
}
