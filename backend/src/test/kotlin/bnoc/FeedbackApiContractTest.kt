package bnoc

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.mock.web.MockHttpSession
import org.springframework.test.web.servlet.MockMvc
import org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*
import org.springframework.test.web.servlet.setup.MockMvcBuilders
import org.springframework.transaction.support.TransactionTemplate
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID

class FeedbackApiContractTest {
    private lateinit var db:Database
    private lateinit var workflow:WorkflowService
    private lateinit var planned:PlannedWorkService
    private lateinit var mvc:MockMvc
    @BeforeEach fun setup() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE","sa","")
        db=Database(JdbcTemplate(source));db.initialize()
        val transaction=TransactionTemplate(DataSourceTransactionManager(source))
        workflow=WorkflowService(db,transaction);planned=PlannedWorkService(db,transaction)
        val auth=AuthService(db,"competition","http://127.0.0.1:1","local-test-key-at-least-24-characters","http://127.0.0.1:1")
        val controller=ApiController(auth,db,workflow,QueryService(db,workflow),mock(AttachmentService::class.java),mock(SituationService::class.java),mock(OperationsStatusService::class.java),planned,mock(DocumentAnalysisService::class.java))
        mvc=MockMvcBuilders.standaloneSetup(controller).setControllerAdvice(ApiErrors()).build()
    }
    private fun session(subject:String)=MockHttpSession().also { it.setAttribute("subject",subject);it.setAttribute("authenticatedAt",Instant.now()) }
    private fun json(value:Any)=db.json.writeValueAsString(value)
    private fun response(body:String):Map<*,*> = db.json.readValue(body,Map::class.java)
    private fun command(type:String,payload:Map<String,Any?>,revision:Long?=null)=mapOf("type" to type,"operationId" to UUID.randomUUID().toString(),"payload" to payload,"expectedRevision" to revision)

    @Test fun `HTTP completed date patch validates persists and rejects foreign actors`() {
        val today=LocalDate.now(ZoneId.of("Asia/Seoul"));val actor=db.actor("team-wireless")!!
        val created=planned.create(actor,"기간 점검",today.minusDays(3).toString(),UUID.randomUUID().toString())
        val id=created["id"] as String
        val completed=planned.complete(actor,id,1,today.toString(),UUID.randomUUID().toString())
        val revision=(completed["revision"] as Number).toLong()
        val input=mapOf("operationId" to UUID.randomUUID().toString(),"revision" to revision,"completedDate" to today.minusDays(1).toString())
        val saved=mvc.perform(patch("/api/planned-works/$id").session(session(actor.id)).contentType("application/json").content(json(input))).andReturn().response
        assertEquals(200,saved.status,"HTTP_PATCH_MUST_ACCEPT_COMPLETED_DATE")
        val data=response(saved.contentAsString)["data"] as Map<*,*>
        val work=data["plannedWork"] as Map<*,*>
        assertEquals(today.minusDays(1).toString(),work["completedDate"]);assertEquals("완료",work["status"])
        val replay=mvc.perform(patch("/api/planned-works/$id").session(session(actor.id)).contentType("application/json").content(json(input))).andReturn().response
        assertEquals(200,replay.status);assertEquals(true,(response(replay.contentAsString)["data"] as Map<*,*>)["replayed"])
        val next=(work["revision"] as Number).toLong()
        for(date in listOf(today.plusDays(1).toString(),today.minusDays(4).toString())) {
            val invalid=input+mapOf("revision" to next,"operationId" to UUID.randomUUID().toString(),"completedDate" to date)
            assertEquals(400,mvc.perform(patch("/api/planned-works/$id").session(session(actor.id)).contentType("application/json").content(json(invalid))).andReturn().response.status)
        }
        val foreign=mvc.perform(patch("/api/planned-works/$id").session(session("team-wired")).contentType("application/json").content(json(input+mapOf("revision" to next,"operationId" to UUID.randomUUID().toString())))).andReturn().response
        assertEquals(404,foreign.status,"FOREIGN_PLANNED_WORK_MUST_NOT_BE_DISCLOSED")
    }

    @Test fun `HTTP batch command keeps validation errors atomic and can be retried without duplicates`() {
        val bnoc=db.actor("bnoc")!!
        workflow.execute(bnoc,Command("saveCentralPerson",UUID.randomUUID().toString(),expectedRevision=0,payload=mapOf("department" to "무선반","category" to "병","rank" to "상병","displayName" to "등록인원","serviceNumber" to "100001","internalPhone" to "1234","active" to true)))
        val invalid=command("saveAbsenceBatch",mapOf("department" to "무선반","text" to "상병 등록인원 휴가 20261001 20261002\n상병 없는인원 교육 20261003 20261004"),1)
        val failure=mvc.perform(post("/api/commands").session(session(bnoc.id)).contentType("application/json").content(json(invalid))).andReturn().response
        assertEquals(400,failure.status);assertTrue((response(failure.contentAsString)["fieldErrors"] as Map<*,*>)["text"].toString().contains("2줄"))
        assertEquals(0,db.rows("SELECT * FROM bnoc_absences").size)
        val valid=command("saveAbsenceBatch",mapOf("department" to "무선반","text" to "상병 등록인원 휴가 20261001 20261002"),1)
        repeat(2) { index ->
            val result=mvc.perform(post("/api/commands").session(session(bnoc.id)).contentType("application/json").content(json(valid))).andReturn().response
            assertEquals(200,result.status);assertEquals(index==1,response(result.contentAsString)["replayed"])
        }
        assertEquals(1,db.rows("SELECT * FROM bnoc_absences").size)
        assertEquals(403,mvc.perform(post("/api/commands").session(session("team-wireless")).contentType("application/json").content(json(valid))).andReturn().response.status)
    }

    @Test fun `HTTP request pagination returns ten ordered rows without missing the last page`() {
        val requester=db.actor("requester")!!
        val created=(1..23).map { workflow.execute(requester,Command("createRequest",UUID.randomUUID().toString(),payload=mapOf("category" to "장비/체계","subcategories" to mapOf("systemType" to "인터넷","resourceType" to "PC","workType" to "고장"),"detail" to "장비 점검 $it","location" to "행정실","contact" to "1234"))).requestNumber!! }.reversed()
        val observed=mutableListOf<String>()
        repeat(3) { page ->
            val result=mvc.perform(get("/api/requests").session(session(requester.id)).param("page",page.toString()).param("size","10")).andReturn().response
            assertEquals(200,result.status)
            val data=response(result.contentAsString)["data"] as Map<*,*>;val items=data["items"] as List<*>
            assertEquals(23,data["total"]);assertEquals(if(page<2)10 else 3,items.size)
            observed+=items.map { (it as Map<*,*>)["requestNumber"] as String }
        }
        assertEquals(created,observed)
    }

    @Test fun `HTTP returned detail exposes rejection and one command closes the request with history intact`() {
        val requester=db.actor("requester")!!;val bnoc=db.actor("bnoc")!!;val team=db.actor("team-wireless")!!
        val number=workflow.execute(requester,Command("createRequest",UUID.randomUUID().toString(),payload=mapOf("category" to "장비/체계","subcategories" to mapOf("systemType" to "인터넷","resourceType" to "PC","workType" to "고장"),"detail" to "담당 범위 확인","location" to "행정실","contact" to "1234"))).requestNumber!!
        workflow.execute(bnoc,Command("assignTeams",UUID.randomUUID().toString(),number,expectedRevision=db.request(number)!!.revision,payload=mapOf("teamIds" to listOf(team.teamId!!),"priority" to "general")))
        val work=db.works(number).single()
        workflow.execute(team,Command("returnWork",UUID.randomUUID().toString(),number,work.number,work.revision,mapOf("returnReason" to "담당 업무 아님")))
        val detail=mvc.perform(get("/api/requests/$number").session(session(bnoc.id))).andReturn().response
        assertEquals(200,detail.status)
        val data=response(detail.contentAsString)["data"] as Map<*,*>
        assertEquals(true,data["canReject"],"HTTP_RETURNED_DETAIL_MUST_EXPOSE_REJECTION")
        val input=command("rejectRequest",mapOf("reason" to "부대 담당 업무가 아닙니다."),(data["revision"] as Number).toLong())+mapOf("requestNumber" to number)
        assertEquals(200,mvc.perform(post("/api/commands").session(session(bnoc.id)).contentType("application/json").content(json(input))).andReturn().response.status)
        assertEquals("기각",db.request(number)!!.status)
        assertEquals("담당 업무 아님",db.work(work.number)!!.returnReason)
        assertEquals("withdrawn",db.work(work.number)!!.resolutionKind)
    }
}
