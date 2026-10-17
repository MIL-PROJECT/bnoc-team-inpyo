package bnoc

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.util.UUID

class WorkflowContractTest {
    lateinit var db: Database
    lateinit var service: WorkflowService
    lateinit var requester: Actor
    lateinit var bnoc: Actor
    lateinit var team: Actor
    @BeforeEach fun setup() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "")
        db=Database(JdbcTemplate(source)); db.initialize()
        service=WorkflowService(db, TransactionTemplate(DataSourceTransactionManager(source)))
        requester=db.actor("requester")!!;bnoc=db.actor("bnoc")!!;team=db.actor("team-wireless")!!
    }
    private fun op(type:String,number:String?=null,work:String?=null,revision:Long?=null,payload:Map<String,Any?> = emptyMap())=Command(type,UUID.randomUUID().toString(),number,work,revision,payload)
    private fun create():String = service.execute(requester,op("createRequest",payload=mapOf("category" to "장비/체계","subcategories" to mapOf("systemType" to "인터넷","resourceType" to "PC","workType" to "지원"),"detail" to "지원 요청","location" to "신청 위치","contact" to "1234","scheduledAt" to "2026-10-14T00:00:00Z"))).requestNumber!!
    private fun assign(number:String)=service.execute(bnoc,op("assignTeams",number,revision=db.request(number)!!.revision,payload=mapOf("teamIds" to listOf("무선반"),"priority" to "urgent")))
    @Test fun `BNOC changes an assigned department without return preserving history and optional schedule`() {
        val number=create();assign(number);var old=db.works(number).single()
        val schedule="2026-10-20T01:00:00Z"
        service.execute(team,op("updateWork",number,old.number,old.revision,mapOf("nextStatus" to "배정","schedule" to schedule,"memo" to "기존 계획")))
        old=db.work(old.number)!!;val before=db.request(number)!!
        val command=op("reassignAssignedWork",number,old.number,old.revision,mapOf("teamIds" to listOf("유선반")))
        service.execute(bnoc,command)
        val preserved=db.work(old.number)!!;val next=db.works(number).last()
        assertEquals("배정",preserved.status);assertNull(preserved.returnReason)
        assertEquals(schedule,preserved.schedule);assertEquals(old.memo,preserved.memo)
        assertEquals("reassigned",preserved.resolutionKind);assertEquals(listOf(next.number),preserved.replacementWorkNumbers)
        assertEquals("${number}-2",next.number);assertEquals("유선반",next.teamId);assertEquals(old.number,next.replaces)
        assertEquals("배정",next.status);assertNull(next.schedule,"DIRECT_REASSIGNMENT_MUST_NOT_COPY_SCHEDULE")
        assertTrue(next.assignedPersonRefs.isEmpty());assertNotNull(next.assignedAt)
        assertEquals(before.priority,db.request(number)!!.priority);assertTrue(db.request(number)!!.revision>before.revision)
        assertEquals(listOf("유선반"),RequestStatus.summarize(db.request(number)!!,db.works(number)).departments)
        val notifications=db.rows("SELECT recipient_subject,event_name FROM bnoc_notifications WHERE request_number=?",number)
        assertTrue(notifications.any { it["recipient_subject"]==team.id && it["event_name"]=="배정 변경" },"DIRECT_REASSIGNMENT_MUST_NOTIFY_PREVIOUS_TEAM")
        assertTrue(notifications.any { it["recipient_subject"]=="team-wired" && it["event_name"]=="작업 배정" })
        assertTrue(service.execute(bnoc,command).replayed);assertEquals(2,db.works(number).size)
        assertEquals("INVALID_STATE",assertThrows(BusinessFailure::class.java) { service.execute(team,op("updateWork",number,old.number,preserved.revision,mapOf("nextStatus" to "작업 중"))) }.code)
    }
    @Test fun `direct department change permits assigned state only`() {
        for(status in listOf("작업 중","완료","반환")) {
            val number=create();assign(number);var work=db.works(number).single()
            val payload=if(status=="반환") mapOf("nextStatus" to status,"returnReason" to "담당 확인") else mapOf("nextStatus" to status)
            service.execute(team,op("updateWork",number,work.number,work.revision,payload));work=db.work(work.number)!!
            val failure=runCatching { service.execute(bnoc,op("reassignAssignedWork",number,work.number,work.revision,mapOf("teamIds" to listOf("유선반")))) }.exceptionOrNull()
            assertTrue(failure is BusinessFailure && failure.code=="INVALID_STATE","DIRECT_REASSIGNMENT_ASSIGNED_ONLY: $status")
            assertEquals(1,db.works(number).size);assertEquals("open",db.work(work.number)!!.resolutionKind)
        }
    }
    @Test fun `direct department change rejects foreign roles duplicate departments and stale start version`() {
        val number=create();assign(number);var work=db.works(number).single()
        val payload=mapOf("teamIds" to listOf("유선반"))
        for(actor in listOf(requester,team)) assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { service.execute(actor,op("reassignAssignedWork",number,work.number,work.revision,payload)) }.code)
        for(teams in listOf(emptyList(),listOf("무선반"),listOf("유선반","유선반"))) assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { service.execute(bnoc,op("reassignAssignedWork",number,work.number,work.revision,mapOf("teamIds" to teams))) }.code)
        service.execute(bnoc,op("addTeams",number,revision=db.request(number)!!.revision,payload=payload))
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { service.execute(bnoc,op("reassignAssignedWork",number,work.number,work.revision,payload)) }.code)
        service.execute(team,op("updateWork",number,work.number,work.revision,mapOf("nextStatus" to "작업 중")))
        assertEquals("CONFLICT",assertThrows(BusinessFailure::class.java) { service.execute(bnoc,op("reassignAssignedWork",number,work.number,work.revision,mapOf("teamIds" to listOf("암호반")))) }.code)
        work=db.work(work.number)!!
        assertEquals("INVALID_STATE",assertThrows(BusinessFailure::class.java) { service.execute(bnoc,op("reassignAssignedWork",number,work.number,work.revision,mapOf("teamIds" to listOf("암호반")))) }.code)
        assertEquals(2,db.works(number).size)
    }
    @Test fun `direct department change cannot bypass cancellation or returned command boundary`() {
        val number=create();assign(number);val work=db.works(number).single();val payload=mapOf("teamIds" to listOf("유선반"))
        assertEquals("INVALID_STATE",assertThrows(BusinessFailure::class.java) { service.execute(bnoc,op("reassignReturnedWork",number,work.number,work.revision,payload)) }.code)
        service.execute(requester,op("cancelRequest",number,revision=db.request(number)!!.revision))
        assertEquals("INVALID_STATE",assertThrows(BusinessFailure::class.java) { service.execute(bnoc,op("reassignAssignedWork",number,work.number,work.revision,payload)) }.code)
        assertEquals(1,db.works(number).size)
    }
    @Test fun `BNOC assignment must not set work schedule`() {
        val number=create();assign(number)
        assertNull(db.works(number).single().schedule,"BNOC_ASSIGNMENT_MUST_NOT_SET_SCHEDULE")
    }
    @Test fun `unclassified assignment is rejected before any work is created`() {
        val number=create()
        val failure=runCatching { service.execute(bnoc,op("assignTeams",number,revision=db.request(number)!!.revision,payload=mapOf("teamIds" to listOf("무선반")))) }.exceptionOrNull()
        assertTrue(failure is BusinessFailure,"ASSIGNMENT_CLASSIFICATION_REQUIRED")
        assertEquals("VALIDATION",(failure as BusinessFailure).code)
        assertTrue(db.works(number).isEmpty());assertNull(db.request(number)!!.priority)
    }
    @Test fun `BNOC may correct classification without changing work`() {
        val number=create();assign(number)
        val work=db.works(number).single();val before=work.copy()
        service.execute(bnoc,op("changePriority",number,revision=db.request(number)!!.revision,payload=mapOf("priority" to "general")))
        assertEquals("general",db.request(number)!!.priority)
        assertEquals(before,db.works(number).single())
        assertThrows(BusinessFailure::class.java) { service.execute(team,op("changePriority",number,revision=db.request(number)!!.revision,payload=mapOf("priority" to "urgent"))) }
    }
    @Test fun `unresolved returned work blocks requester edits and all assigned allows again`() {
        val number=create();assign(number);val work=db.works(number).single()
        service.execute(team,op("updateWork",number,work.number,work.revision,mapOf("nextStatus" to "반환","returnReason" to "담당 범위 확인")))
        val failure=assertThrows(BusinessFailure::class.java) { service.execute(requester,op("updateRequest",number,revision=db.request(number)!!.revision,payload=mapOf("detail" to "수정 요청"))) }
        assertEquals("INVALID_STATE",failure.code,"UNRESOLVED_RETURN_MUST_BLOCK_REQUESTER_EDIT")
        service.execute(team,op("updateWork",number,work.number,db.work(work.number)!!.revision,mapOf("nextStatus" to "배정","reusePreviousSchedule" to false,"schedule" to "")))
        service.execute(requester,op("updateRequest",number,revision=db.request(number)!!.revision,payload=mapOf("detail" to "수정 요청")))
        assertEquals("수정 요청",db.request(number)!!.detail)
    }
    @Test fun `return removes current schedule preserves previous schedule and correction requires explicit choice`() {
        val number=create();assign(number);var work=db.works(number).single()
        val planned="2026-10-15T01:00:00Z"
        service.execute(team,op("updateWork",number,work.number,work.revision,mapOf("nextStatus" to "배정","schedule" to planned)))
        work=db.work(work.number)!!
        service.execute(team,op("updateWork",number,work.number,work.revision,mapOf("nextStatus" to "반환","returnReason" to "담당 범위 확인")))
        work=db.work(work.number)!!
        assertNull(work.schedule,"RETURNED_SCHEDULE_MUST_NOT_REMAIN_CURRENT")
        assertEquals(planned,work.previousSchedule,"RETURNED_SCHEDULE_MUST_REMAIN_IN_HISTORY")
        val queries=QueryService(db,service)
        assertTrue((queries.schedule(bnoc,mapOf("from" to "2026-10-15","to" to "2026-10-16"))["entries"] as List<*>).isEmpty())
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { service.execute(team,op("updateWork",number,work.number,work.revision,mapOf("nextStatus" to "배정"))) }.code)
        service.execute(team,op("updateWork",number,work.number,work.revision,mapOf("nextStatus" to "배정","reusePreviousSchedule" to true,"schedule" to "")))
        assertEquals(planned,db.work(work.number)!!.schedule,"EXPLICIT_REUSE_MUST_RESTORE_PREVIOUS_SCHEDULE")
    }
    @Test fun `a later return clears an obsolete previous schedule after the team chose no schedule`() {
        val number=create();assign(number);var work=db.works(number).single()
        service.execute(team,op("updateWork",number,work.number,work.revision,mapOf("nextStatus" to "배정","schedule" to "2026-10-15T01:00:00Z")))
        work=db.work(work.number)!!
        service.execute(team,op("updateWork",number,work.number,work.revision,mapOf("nextStatus" to "반환","returnReason" to "담당 범위 확인")))
        work=db.work(work.number)!!
        service.execute(team,op("updateWork",number,work.number,work.revision,mapOf("nextStatus" to "배정","reusePreviousSchedule" to false,"schedule" to "")))
        work=db.work(work.number)!!
        assertNull(work.schedule)
        service.execute(team,op("updateWork",number,work.number,work.revision,mapOf("nextStatus" to "반환","returnReason" to "다시 확인 필요")))
        assertNull(db.work(work.number)!!.previousSchedule,"A_NEW_RETURN_MUST_NOT_OFFER_AN_OUTDATED_PREVIOUS_SCHEDULE")
    }
    @Test fun `added department keeps classification and progress, completed department can be withdrawn`() {
        val number=create();service.execute(bnoc,op("assignTeams",number,revision=db.request(number)!!.revision,payload=mapOf("teamIds" to listOf("무선반"),"priority" to "general")))
        var request=db.request(number)!!;var wireless=db.works(number).single()
        service.execute(team,op("updateWork",number,wireless.number,wireless.revision,mapOf("nextStatus" to "작업 중")))
        request=db.request(number)!!
        service.execute(bnoc,op("addTeams",number,revision=request.revision,payload=mapOf("teamIds" to listOf("유선반"))))
        request=db.request(number)!!
        assertEquals("general",request.priority,"ADDED_DEPARTMENT_MUST_KEEP_CLASSIFICATION")
        assertEquals("작업 중",request.status,"ADDED_DEPARTMENT_MUST_NOT_LOWER_CURRENT_PROGRESS")
        assertNull(db.works(number).last().schedule,"ADDED_DEPARTMENT_SCHEDULE_MUST_START_UNSET")
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { service.execute(bnoc,op("addTeams",number,revision=request.revision,payload=mapOf("teamIds" to listOf("무선반")))) }.code)

        wireless=db.works(number).first()
        service.execute(team,op("updateWork",number,wireless.number,wireless.revision,mapOf("nextStatus" to "완료")))
        val wired=db.works(number).last()
        val wiredActor=db.actor("team-wired")!!
        service.execute(wiredActor,op("updateWork",number,wired.number,wired.revision,mapOf("nextStatus" to "반환","returnReason" to "담당 범위 확인")))
        val returned=db.work(wired.number)!!
        val beforeRevision=db.request(number)!!.revision
        service.execute(bnoc,op("withdrawReturnedWork",number,returned.number,returned.revision))
        request=db.request(number)!!
        val detail=QueryService(db,service).detail(bnoc,number)
        val progress=detail["progress"] as Map<*,*>
        val resolved=db.work(returned.number)!!
        assertEquals("완료",request.status,"WITHDRAWAL_MUST_KEEP_COMPLETED_REMAINING_WORK")
        assertEquals("withdrawn",resolved.resolutionKind)
        assertNull(resolved.schedule)
        assertEquals("해당 부서 작업 불필요",resolved.resolutionReason)
        assertTrue(request.revision>beforeRevision,"WITHDRAWAL_MUST_ADVANCE_REQUEST_REVISION")
        assertEquals(1,progress["currentDepartments"])
        assertEquals(1,progress["completedDepartments"])
        assertEquals(listOf("무선반"),detail["teamIds"])
        assertEquals(2,(detail["workItems"] as List<*>).size,"HISTORY_MUST_RETAIN_WITHDRAWN_WORK")
        assertEquals("INVALID_STATE",assertThrows(BusinessFailure::class.java) { service.execute(bnoc,op("addTeams",number,revision=request.revision,payload=mapOf("teamIds" to listOf("암호반")))) }.code)
    }
    @Test fun `returned work cannot be reassigned to a department already holding current work`() {
        val number=create();assign(number)
        var request=db.request(number)!!
        service.execute(bnoc,op("addTeams",number,revision=request.revision,payload=mapOf("teamIds" to listOf("유선반"))))
        request=db.request(number)!!
        val wireless=db.works(number).first { it.teamId=="무선반" }
        service.execute(team,op("updateWork",number,wireless.number,wireless.revision,mapOf("nextStatus" to "반환","returnReason" to "담당 범위 확인")))
        val returned=db.work(wireless.number)!!
        val before=db.works(number)
        val failure=runCatching {
            service.execute(bnoc,op("reassignReturnedWork",number,returned.number,returned.revision,mapOf("teamIds" to listOf("유선반"))))
        }.exceptionOrNull()
        assertTrue(failure is BusinessFailure,"REASSIGNMENT_MUST_NOT_DUPLICATE_A_CURRENT_DEPARTMENT")
        assertEquals("VALIDATION",(failure as BusinessFailure).code)
        assertEquals(before,db.works(number))
    }
    @Test fun `notification confirmation marks only the signed-in users selected events`() {
        val number=create();val query=QueryService(db,service)
        val bnocNotification=(query.notifications(bnoc).single()["notificationId"] as String)
        service.execute(bnoc,op("markNotificationsSeen",payload=mapOf("notificationIds" to listOf(bnocNotification))))
        assertEquals(0,query.unseenNotifications(bnoc)["unseen"])
        assign(number)
        val teamActor=db.actor("team-wireless")!!
        val teamNotification=query.notifications(teamActor).single()["notificationId"] as String
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { service.execute(bnoc,op("markNotificationsSeen",payload=mapOf("notificationIds" to listOf(teamNotification)))) }.code)
        assertEquals(false,db.rows("SELECT is_read FROM bnoc_notifications WHERE notification_id=?",teamNotification).single()["is_read"])
    }
    @Test fun `same submission executes once and changed submission is rejected`() {
        val command=op("createRequest",payload=mapOf("category" to "회의 지원","subcategories" to mapOf("meetingType" to "일반회의"),"detail" to "회의 지원","location" to "신청 위치","contact" to "1234"))
        val first=service.execute(requester,command);val second=service.execute(requester,command)
        assertEquals(first.requestNumber,second.requestNumber);assertEquals(true,second.replayed)
        assertEquals(1,db.requests().size)
        assertEquals("DUPLICATE_ACTION",assertThrows(BusinessFailure::class.java) { service.execute(requester,command.copy(payload=command.payload+mapOf("detail" to "다른 요청"))) }.code)
    }
}
