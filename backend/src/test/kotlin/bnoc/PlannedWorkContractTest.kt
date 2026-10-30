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

class PlannedWorkContractTest {
    private lateinit var db:Database
    private lateinit var service:PlannedWorkService
    private lateinit var team:Actor
    private lateinit var otherTeam:Actor
    private lateinit var requester:Actor
    private lateinit var queries:QueryService
    @BeforeEach fun setup() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE","sa","")
        db=Database(JdbcTemplate(source));db.initialize()
        val transaction=TransactionTemplate(DataSourceTransactionManager(source))
        service=PlannedWorkService(db,transaction)
        team=db.actor("team-wireless")!!;otherTeam=db.actor("team-wired")!!;requester=db.actor("requester")!!
        queries=QueryService(db,WorkflowService(db,transaction))
    }
    private fun date(offset:Int=0)=LocalDate.now(ZoneId.of("Asia/Seoul")).plusDays(offset.toLong()).toString()
    private fun create(title:String="통신실 점검",firstDate:String=date())=service.create(team,title,firstDate,UUID.randomUUID().toString())

    @Test fun `planned work continues across selected dates and stays outside unplanned tables`() {
        val baseline=queries.shared(team,mapOf("bucket" to "all"))["counts"] as Map<*,*>
        val created=create(firstDate=date(-1))
        assertEquals("진행 중",created["status"])
        assertEquals(1L,created["revision"])
        for(selected in listOf(date(-1),date(),date(1))) {
            val day=service.list(team,selected)
            assertEquals(listOf(created["id"]),((day["inProgress"] as List<*>).map { (it as Map<*,*>)["id"] }))
        }
        assertTrue((service.list(otherTeam,date())["inProgress"] as List<*>).isEmpty())
        assertEquals(0,db.jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_works",Int::class.java))
        val after=queries.shared(team,mapOf("bucket" to "all"))["counts"] as Map<*,*>
        assertEquals((baseline["all"] as Number).toInt()+1,(after["all"] as Number).toInt())
        assertEquals(1,(after["plannedInProgress"] as Number).toInt())
        assertEquals("통신실 점검",(queries.shared(requester,mapOf("bucket" to "planned"))["items"] as List<*>).map { (it as Map<*,*>)["title"] }.single())
    }

    @Test fun `planned work enforces team ownership, date bounds, revision and replay`() {
        val listFailure=runCatching { service.list(requester,date()) }.exceptionOrNull()
        assertTrue(listFailure is BusinessFailure && listFailure.code=="FORBIDDEN","PLANNED_WORK_TEAM_ROLE_REQUIRED")
        val createFailure=runCatching { service.create(requester,"제목",date(),UUID.randomUUID().toString()) }.exceptionOrNull()
        assertTrue(createFailure is BusinessFailure && createFailure.code=="FORBIDDEN","PLANNED_WORK_TEAM_ROLE_REQUIRED")
        val operation=UUID.randomUUID().toString();val created=service.create(team,"장기 점검",date(-2),operation)
        assertTrue(service.create(team,"장기 점검",date(-2),operation)["replayed"] as Boolean)
        assertEquals("DUPLICATE_ACTION",assertThrows(BusinessFailure::class.java) { service.create(team,"다른 내용",date(-2),operation) }.code)
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) { service.update(otherTeam,created["id"] as String,1,"외부 수정",null,UUID.randomUUID().toString()) }.code)
        val updated=service.update(team,created["id"] as String,1,"장기 점검 수정",date(-1),UUID.randomUUID().toString())
        assertEquals(2L,updated["revision"])
        assertEquals("CONFLICT",assertThrows(BusinessFailure::class.java) { service.update(team,created["id"] as String,1,"오래된 수정",null,UUID.randomUUID().toString()) }.code)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { service.complete(team,created["id"] as String,2,date(1),UUID.randomUUID().toString()) }.code)
        val completed=service.complete(team,created["id"] as String,2,date(),UUID.randomUUID().toString())
        assertEquals("완료",completed["status"])
        assertEquals(3L,completed["revision"])
        val counts=queries.shared(team,mapOf("bucket" to "all"))["counts"] as Map<*,*>
        assertEquals(1,(counts["plannedCompleted"] as Number).toInt())
        assertEquals(1,(counts["allCompleted"] as Number).toInt())
    }

    @Test fun `deletion removes the item and replay receipt without creating a deletion history`() {
        val operation=UUID.randomUUID().toString();val created=service.create(team,"삭제 확인",date(),operation)
        val id=created["id"] as String
        val beforeWorks=db.jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_works",Int::class.java)
        assertEquals(true,service.delete(team,id,1)["deleted"])
        assertNull(db.plannedWork(id),"PLANNED_DELETE_MUST_REMOVE_TASK")
        assertEquals(0,db.jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_planned_operation_receipts WHERE planned_work_id=?",Int::class.java,id))
        assertEquals(1,db.jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_planned_operation_uses",Int::class.java))
        assertEquals("DUPLICATE_ACTION",assertThrows(BusinessFailure::class.java) { service.create(team,"삭제 확인",date(),operation) }.code)
        assertEquals(beforeWorks,db.jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_works",Int::class.java))
        assertEquals(0,(queries.shared(team,mapOf("bucket" to "all"))["counts"] as Map<*,*>)["planned"])
    }

    @Test fun `operation ids cannot cross accounts and a team change cannot replay an old result`() {
        val operation=UUID.randomUUID().toString()
        val created=service.create(team,"이전 작업반 제목",date(),operation)
        val crossAccount=runCatching { service.create(otherTeam,"새 작업",date(),operation) }.exceptionOrNull()
        assertTrue(crossAccount is BusinessFailure && crossAccount.code=="OPERATION_NOT_AVAILABLE","PLANNED_OPERATION_ID_MUST_BE_GLOBAL")
        assertTrue(service.create(team,"이전 작업반 제목",date(),operation)["replayed"] as Boolean)
        assertEquals(1,db.jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_planned_works",Int::class.java))

        db.jdbc.update("UPDATE bnoc_subjects SET team_id=? WHERE subject_id=?",otherTeam.teamId,team.id)
        val changedTeam=runCatching { service.create(team,"이전 작업반 제목",date(),operation) }.exceptionOrNull()
        assertTrue(changedTeam is BusinessFailure && changedTeam.code=="OPERATION_NOT_AVAILABLE","PLANNED_REPLAY_MUST_MATCH_CURRENT_TEAM")
        assertEquals(1,db.jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_planned_works WHERE planned_work_id=? AND title=?",Int::class.java,created["id"],"이전 작업반 제목"))
    }

    @Test fun `future work is hidden before its start and appears from its start date`() {
        val futureDate=date(2);val created=create("미래 점검",futureDate);val id=created["id"] as String
        assertTrue((service.list(team,date())["inProgress"] as List<*>).none { (it as Map<*,*>)["id"]==id })
        assertEquals(1,(service.list(team,futureDate)["inProgress"] as List<*>).count { (it as Map<*,*>)["id"]==id })
        val tooEarly=runCatching { service.complete(team,id,1,date(),UUID.randomUUID().toString()) }.exceptionOrNull()
        assertTrue(tooEarly is BusinessFailure && tooEarly.code=="VALIDATION","PLANNED_COMPLETION_NOT_BEFORE_START")
    }

    @Test fun `titles and dates validate while completed work cannot be reopened by editing`() {
        val created=create("마무리 점검",date());val id=created["id"] as String
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { service.update(team,id,1,"  ",null,UUID.randomUUID().toString()) }.code)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { service.update(team,id,1,null,"2026-02-30",UUID.randomUUID().toString()) }.code)
        val completed=service.complete(team,id,1,date(),UUID.randomUUID().toString())
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { service.update(team,id,completed["revision"] as Long,"마무리 점검 수정",date(1),UUID.randomUUID().toString()) }.code)
        assertEquals("completed",db.plannedWork(id)!!.status)
    }

    @Test fun `completed date can be corrected without reopening and remains bounded and replayable`() {
        val created=create("완료일 정정",date(-5));val id=created["id"] as String
        service.complete(team,id,1,date(-1),UUID.randomUUID().toString())
        val operation=UUID.randomUUID().toString()
        val updated=service.update(team,id,2,null,null,operation,date(-2))
        assertEquals("완료",updated["status"],"PLANNED_DATE_CORRECTION_MUST_KEEP_COMPLETED")
        assertEquals(date(-2),updated["completedDate"],"PLANNED_DATE_CORRECTION_MUST_PERSIST")
        assertEquals(3L,updated["revision"])
        assertEquals(true,service.update(team,id,2,null,null,operation,date(-2))["replayed"])
        assertEquals("DUPLICATE_ACTION",assertThrows(BusinessFailure::class.java) { service.update(team,id,2,null,null,operation,date(-3)) }.code)
        for(invalid in listOf(date(-6),date(1),"2026-02-30")) {
            assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { service.update(team,id,3,null,null,UUID.randomUUID().toString(),invalid) }.code)
            assertEquals(date(-2),db.plannedWork(id)!!.completedDate)
        }
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) { service.update(otherTeam,id,3,null,null,UUID.randomUUID().toString(),date()) }.code)
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { service.update(requester,id,3,null,null,UUID.randomUUID().toString(),date()) }.code)
        val moved=service.update(team,id,3,null,date(-1),UUID.randomUUID().toString(),date())
        assertEquals(date(-1),moved["firstWorkDate"])
        assertEquals(date(),moved["completedDate"])
        assertEquals("완료",(service.list(team,date())["completed"] as List<*>).map { it as Map<*,*> }.single()["status"])
    }

    @Test fun `completion date cannot complete an in progress work through update`() {
        val created=create();val id=created["id"] as String
        assertEquals("INVALID_STATE",assertThrows(BusinessFailure::class.java) { service.update(team,id,1,null,null,UUID.randomUUID().toString(),date()) }.code)
        assertEquals("in_progress",db.plannedWork(id)!!.status)
        assertNull(db.plannedWork(id)!!.completedDate)
        assertEquals(1L,db.plannedWork(id)!!.revision)
    }
}
