package bnoc

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Timeout
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.transaction.TransactionDefinition
import org.springframework.jdbc.datasource.AbstractDataSource
import org.springframework.mock.web.MockMultipartFile
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.CountDownLatch

class OperationsContractTest {
    lateinit var db:Database
    lateinit var workflow:WorkflowService
    lateinit var queries:QueryService
    lateinit var files:AttachmentService
    lateinit var root:Path
    @BeforeEach fun setup() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "")
        db=Database(JdbcTemplate(source));db.initialize()
        root=Files.createTempDirectory("bnoc-contract-")
        val tx=TransactionTemplate(DataSourceTransactionManager(source))
        workflow=WorkflowService(db,tx,root.toString());queries=QueryService(db,workflow);files=AttachmentService(db,queries,tx,root.toString())
    }
    @AfterEach fun cleanup() { if(::root.isInitialized) Files.walk(root).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) } } }
    fun actor(subject:String)=db.actor(subject)!!
    fun command(type:String,payload:Map<String,Any?> = emptyMap(),revision:Long?=null,number:String?=null,work:String?=null,id:String=UUID.randomUUID().toString())=Command(type,id,number,work,revision,payload)
    private fun scheduleIntervals(start:String)=listOf(mapOf("startsAt" to start,"endsAt" to Instant.parse(start).plusSeconds(3600).toString()))
    fun create():String=workflow.execute(actor("requester"),command("createRequest",mapOf("category" to "장비/체계","subcategories" to mapOf("systemType" to "인터넷","resourceType" to "PC","workType" to "대여"),"detail" to "지원 요청","location" to "신청 위치","contact" to "1234"))).requestNumber!!
    fun assign(number:String,teams:List<String> = listOf("무선반"))=workflow.execute(actor("bnoc"),command("assignTeams",mapOf("teamIds" to teams,"priority" to "urgent"),db.request(number)!!.revision,number))
    fun departmentManager(department:String="무선반"):Actor {
        val target=actor("requester-secondary")
        workflow.execute(actor("access-admin"),command("changeAccess",mapOf("subjectRef" to target.subjectRef,"role" to "requester","department" to department,"teamId" to null,"departmentManager" to true,"active" to true),target.revision))
        return actor("requester-secondary")
    }
    @Test fun `central roster starts empty and legacy daily write commands are disabled`() {
        assertFalse(db.actors().any { it.active && it.role=="bnoc" && it.departmentManager })
        assertFalse(db.actors().any { it.active && it.role=="team" && it.departmentManager })
        assertFalse(db.actors().any { it.active && it.displayName=="부서 담당자" })
        assertTrue(workflow.operations.listCentralRoster(actor("team-wireless"),"무선반")["entries"] is List<*>)
        assertEquals(0,(workflow.operations.listCentralRoster(actor("bnoc"),"BNOC")["entries"] as List<*>).size)
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { workflow.operations.personnel(actor("requester"),"2026-10-01",null) }.code)
        val legacyActor=departmentManager()
        listOf(
            command("savePersonnelRoster",mapOf("department" to "무선반","entries" to emptyList<Any>()),0),
            command("saveDailyPersonnel",mapOf("department" to "무선반","date" to "2026-10-01","entries" to emptyList<Any>()),0),
            command("saveNightDuty",mapOf("department" to "무선반","date" to "2026-10-01","personRefs" to emptyList<String>()),0)
        ).forEach { change -> assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { workflow.execute(legacyActor,change) }.code) }
        assertTrue(db.actors().none { it.displayName.contains("시험 계정") })
    }
    @Test fun `legacy department manager cannot administer the central roster`() {
        val target=actor("requester-secondary")
        workflow.execute(actor("access-admin"),command("changeAccess",mapOf("subjectRef" to target.subjectRef,"role" to "requester","department" to "전장반(전산장비)","teamId" to null,"departmentManager" to true,"active" to true),target.revision))
        val manager=actor("requester-secondary")
        assertEquals("전장반(전산장비)",manager.department)
        assertTrue(manager.departmentManager)
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { workflow.operations.listCentralRoster(manager,null) }.code)
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { workflow.execute(manager,command("savePersonnelRoster",mapOf("department" to "전장반(전산장비)","entries" to emptyList<Any>()),0)) }.code)
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("team-wireless"),command("savePersonnelRoster",mapOf("department" to "무선반","entries" to emptyList<Any>()),0)) }.code)
        val invalidRole=runCatching { workflow.execute(actor("access-admin"),command("changeAccess",mapOf("subjectRef" to manager.subjectRef,"role" to "bnoc","department" to "전장반(전산장비)","teamId" to null,"departmentManager" to true,"active" to true),manager.revision)) }.exceptionOrNull()
        assertTrue(invalidRole is BusinessFailure)
        assertEquals("VALIDATION",(invalidRole as BusinessFailure).code)
    }
    @Test fun `additive migration retains work history and removes legacy generic department manager`() {
        val number=create();assign(number);val work=db.works(number).single();val planned="2026-10-20T01:00:00Z"
        db.jdbc.update("UPDATE bnoc_works SET status='반환',schedule=?,resolved_by=? WHERE work_number=?",planned,"[\"$number-2\"]",work.number)
        val historyCount=db.rows("SELECT * FROM bnoc_history WHERE request_number=?",number).size
        db.jdbc.update("INSERT INTO bnoc_subjects VALUES (?,?,?,?,?,?,?,?,?,?)","department-manager","requester","부서 담당자","BNOC",null,true,UUID.randomUUID().toString(),true,false,1)
        db.jdbc.update("DELETE FROM bnoc_schema_migrations WHERE version=8")
        listOf("resolution_kind","resolution_reason","resolved_at","resolved_by_actor","replacement_work_numbers","previous_schedule").forEach { db.jdbc.execute("ALTER TABLE bnoc_works DROP COLUMN $it") }
        db.jdbc.execute("ALTER TABLE bnoc_notices DROP COLUMN body_document")

        db.initialize()

        val migrated=db.work(work.number)!!
        assertEquals("reassigned",migrated.resolutionKind)
        assertEquals(listOf("$number-2"),migrated.replacementWorkNumbers)
        assertNull(migrated.schedule)
        assertEquals(planned,migrated.previousSchedule)
        assertEquals(historyCount,db.rows("SELECT * FROM bnoc_history WHERE request_number=?",number).size,"MIGRATION_MUST_KEEP_EXISTING_HISTORY")
        val legacy=db.actor("department-manager")!!
        assertFalse(legacy.active)
        assertFalse(legacy.departmentManager)
        assertEquals("요청자",legacy.displayName)
    }
    private fun addMember():String = addCentralPerson("무선반","병","상병","담당 인원","100001")
    @Test fun `active legacy roster member without a profile still counts in daily headcount`() {
        db.jdbc.update("INSERT INTO bnoc_roster(person_ref,department,display_name,active) VALUES (?,?,?,TRUE)","legacy-person-ref","무선반","기존 명부 인원")

        val summary=workflow.operations.personnelSummary(actor("bnoc"),"2026-10-26","무선반")
        val department=(summary["departments"] as List<*>).single() as Map<*,*>

        assertEquals(1,department["total"],"ACTIVE_ROSTER_ROWS_MUST_DEFINE_TOTAL_HEADCOUNT")
        assertEquals(0,department["absent"])
        assertEquals(1,department["current"])
    }
    @Test fun `inactive central personnel cannot be newly selected for monthly duty`() {
        val ref=addMember();val roster=workflow.operations.listCentralRoster(actor("bnoc"),"무선반")
        val profile=(roster["entries"] as List<*>).map { it as Map<*,*> }.single { it["personRef"]==ref }
        workflow.execute(actor("bnoc"),command("saveCentralPerson",mapOf("personRef" to ref,"department" to "무선반","category" to profile["category"],"rank" to profile["rank"],"displayName" to profile["displayName"],"serviceNumber" to profile["serviceNumber"],"internalPhone" to profile["internalPhone"],"active" to false),(roster["revision"] as Number).toLong()))
        val failure=runCatching { workflow.execute(actor("team-wireless"),command("saveDutySchedule",mapOf("month" to "2025-02","date" to "2025-02-01","seat" to "team_night","personRefs" to listOf(ref)),0)) }.exceptionOrNull() as BusinessFailure
        assertEquals("VALIDATION",failure.code)
    }
    @Test fun `unlinked request attachment allows its owner preview and denies other users then linked file downloads`() {
        val bytes="첨부 내용".toByteArray()
        val attachment=files.upload(actor("requester"),"request",MockMultipartFile("file","첨부.txt","text/plain",bytes))
        val ref=attachment["id"] as String
        assertArrayEquals(bytes,files.download(actor("requester"),ref).second,"OWN_TEMP_ATTACHMENT_PREVIEW_REQUIRED")
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) { files.download(actor("requester-secondary"),ref) }.code)
        val number=workflow.execute(actor("requester"),command("createRequest",mapOf("category" to "회의 지원","subcategories" to mapOf("meetingType" to "일반회의"),"detail" to "지원 요청","location" to "신청 위치","contact" to "1234","attachments" to listOf(attachment)))).requestNumber!!
        assertEquals(1,db.attachmentMetadata("request",number).size)
        assertArrayEquals(bytes,files.download(actor("requester"),ref).second)
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) { files.download(actor("requester-secondary"),ref) }.code)
    }
    @Test fun `server department registry extends defaults without duplicating or creating people`() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "")
        val extended=Database(JdbcTemplate(source),additionalDepartments="추가등록허용된부서,BNOC,추가등록허용된부서")
        extended.initialize()
        assertTrue("추가등록허용된부서" in extended.departments,"CONFIGURED_DEPARTMENT_MUST_BE_REGISTERED")
        assertEquals(7,extended.departments.size)
        assertEquals(0,extended.jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_roster",Int::class.java))
        val extendedWorkflow=WorkflowService(extended,TransactionTemplate(DataSourceTransactionManager(source)),root.toString())
        val manager=extended.actor("requester-secondary")!!
        extendedWorkflow.execute(extended.actor("access-admin")!!,command("changeAccess",mapOf("subjectRef" to manager.subjectRef,"role" to "requester","department" to "추가등록허용된부서","teamId" to null,"departmentManager" to true,"active" to true),manager.revision))
        val updated=extended.actor("requester-secondary")!!
        assertEquals("추가등록허용된부서",updated.department)
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { extendedWorkflow.execute(updated,command("savePersonnelRoster",mapOf("department" to "추가등록허용된부서","entries" to emptyList<Any>()),0)) }.code)
    }
    @Test fun `server department registry rejects names exceeding storage limits`() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "")
        assertThrows(IllegalStateException::class.java) { Database(JdbcTemplate(source),additionalDepartments="가".repeat(101)).initialize() }
    }
    @Test fun `absence and monthly schedule history survive central profile inactivity`() {
        val ref=addMember()
        workflow.execute(actor("team-wireless"),command("saveDutySchedule",mapOf("month" to "2025-01","date" to "2025-01-01","seat" to "team_night","personRefs" to listOf(ref)),0))
        absence(ref,"휴가","2025-01-01","2025-01-02")
        val roster=workflow.operations.listCentralRoster(actor("bnoc"),"무선반")
        val profile=(roster["entries"] as List<*>).map { it as Map<*,*> }.single { it["personRef"]==ref }
        workflow.execute(actor("bnoc"),command("saveCentralPerson",mapOf("personRef" to ref,"department" to "무선반","category" to profile["category"],"rank" to profile["rank"],"displayName" to profile["displayName"],"serviceNumber" to profile["serviceNumber"],"internalPhone" to profile["internalPhone"],"active" to false),(roster["revision"] as Number).toLong()))
        val retained=(workflow.operations.listCentralRoster(actor("bnoc"),"무선반")["entries"] as List<*>).map { it as Map<*,*> }.single { it["personRef"]==ref }
        assertEquals(false,retained["active"])
        assertEquals(1,(retained["absences"] as List<*>).size)
        val count=workflow.operations.personnelSummary(actor("bnoc"),"2025-01-01","무선반")["departments"] as List<*>
        assertEquals(0,(count.single() as Map<*,*>)["total"],"inactive person must not remain in current headcount")
        val schedule=workflow.operations.listDutySchedules(actor("team-wireless"),"2025-01")["entries"] as List<*>
        val retainedRef=(((schedule.single() as Map<*,*>)["people"] as List<*>).single() as Map<*,*>)["personRef"]
        assertEquals(ref,retainedRef)
    }
    @Test fun `work personnel from own roster optional and completion actor distinct`() {
        val ref=addCentralPerson("무선반","병","일병","담당 인원","100001");val number=create();assign(number)
        val w=db.works(number).single()
        workflow.execute(actor("team-wireless"),command("updateWork",mapOf("nextStatus" to "완료","assignedPersonRefs" to listOf(ref)),w.revision,number,w.number))
        val view=(queries.detail(actor("team-wireless"),number)["workItems"] as List<*>).single() as Map<*,*>
        assertEquals("무선반",view["completionActor"])
        assertEquals(listOf(ref),view["assignedPersonRefs"])
        assertEquals("담당 인원",((view["assignedPersons"] as List<*>).single() as Map<*,*>)["displayName"])
        assertEquals("INVALID_STATE",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("requester"),command("updateRequest",mapOf("detail" to "다른 요청"),db.request(number)!!.revision,number)) }.code)
    }
    @Test fun `work assignment rejects absences across schedule intervals and requester sees only assigned contact`() {
        val ref=addCentralPerson("무선반","병","상병","담당 병사","100101","4321")
        absence(ref,"휴가","2026-10-21","2026-10-21")
        val number=create();assign(number);val work=db.works(number).single();val team=actor("team-wireless")
        val crossing=listOf(mapOf("startsAt" to "2026-10-20T14:00:00Z","endsAt" to "2026-10-20T16:00:00Z"))
        val failure=runCatching { workflow.execute(team,command("updateWork",mapOf("nextStatus" to "배정","scheduleIntervals" to crossing,"assignedPersonRefs" to listOf(ref)),work.revision,number,work.number)) }.exceptionOrNull() as BusinessFailure
        assertEquals("VALIDATION",failure.code,"END_EXCLUSIVE_SCHEDULE_MUST_CHECK_EVERY_SEOUL_DATE")
        workflow.execute(team,command("updateWork",mapOf("nextStatus" to "배정","scheduleIntervals" to scheduleIntervals("2026-10-20T01:00:00Z"),"assignedPersonRefs" to listOf(ref)),work.revision,number,work.number))
        val requesterDetail=queries.detail(actor("requester"),number)
        val assigned=((requesterDetail["workItems"] as List<*>).single() as Map<*,*>)["assignedPersons"] as List<*>
        val person=assigned.single() as Map<*,*>
        assertEquals(mapOf("displayName" to "담당 병사","rank" to "상병","internalPhone" to "4321"),person)
        val privateDetails=queries.detail(actor("team-wireless"),number)["workItems"] as List<*>
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) { queries.detail(actor("requester-secondary"),number) }.code)
        assertFalse(person.containsKey("serviceNumber"));assertFalse(person.containsKey("personRef"));assertFalse(person.containsKey("department"))
        assertTrue(privateDetails.isNotEmpty())
        absence(ref,"출장","2026-10-20","2026-10-20")
        assertEquals(listOf(ref),db.work(work.number)!!.assignedPersonRefs,"LATER_ABSENCE_ENTRY_MUST_NOT_REWRITE_AN_EXISTING_ASSIGNMENT")
    }
    @Test fun `completed after action starts unclassified cannot be corrected by team`() {
        val preceding=create();assign(preceding)
        val number=workflow.execute(actor("team-wireless"),command("createAfterActionReport",mapOf("category" to "회의 지원","subcategories" to mapOf("meetingType" to "일반회의"),"detail" to "완료 기록","location" to "신청 위치","contact" to "1234","completedConfirmed" to true,"requesterRef" to db.actor("requester")!!.subjectRef,"actualStartedAt" to "2026-01-01T00:00:00Z","actualCompletedAt" to "2026-01-01T01:00:00Z","reason" to "선조치 기록"))).requestNumber!!
        assertNull(db.request(number)!!.priority,"AFTER_ACTION_MUST_START_UNCLASSIFIED")
        val w=db.works(number).single()
        assertEquals("INVALID_STATE",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("team-wireless"),command("updateWork",mapOf("nextStatus" to "배정"),w.revision,number,w.number)) }.code)
        val shared=queries.shared(actor("requester-secondary"),emptyMap())
        val items=shared["items"] as List<Map<*,*>>
        assertEquals("$number-1",items.first()["workNumber"],"RECENT_AFTER_ACTION_MUST_BE_VISIBLE_IN_DEFAULT_ASSIGNED_LIST")
        assertEquals(2,(shared["counts"] as Map<*,*>) ["total"])
        workflow.execute(actor("bnoc"),command("changePriority",mapOf("priority" to "general"),db.request(number)!!.revision,number))
        assertEquals("완료",db.request(number)!!.status)
    }
    @Test fun `BNOC notice shared editing retains other BNOC attachment and removed history file`() {
        val attachment=files.upload(actor("bnoc"),"notice",MockMultipartFile("file","공지.pdf","application/pdf","%PDF-1.4\n%%EOF".toByteArray()))
        val create=command("createDirective",mapOf("title" to "지원 안내","body" to "내용","attachmentRefs" to listOf(attachment["id"])))
        val notice=workflow.execute(actor("bnoc"),create)
        workflow.execute(actor("bnoc-secondary"),command("updateDirective",mapOf("noticeRef" to notice.publicRef,"title" to "지원 안내 수정","body" to "내용","attachmentRefs" to listOf(attachment["id"])),1))
        workflow.execute(actor("bnoc-secondary"),command("updateDirective",mapOf("noticeRef" to notice.publicRef,"title" to "지원 안내 수정","body" to "내용","attachmentRefs" to emptyList<String>()),2))
        assertEquals(0,db.attachmentMetadata("notice",notice.publicRef!!).size)
        assertArrayEquals("%PDF-1.4\n%%EOF".toByteArray(),files.download(actor("requester"),attachment["id"] as String).second)
        files.cleanTemporary()
        assertArrayEquals("%PDF-1.4\n%%EOF".toByteArray(),files.download(actor("requester"),attachment["id"] as String).second)
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("requester"),create.copy(operationId=UUID.randomUUID().toString())) }.code)
    }
    @Test fun `notice editor stores only supported formatting and keeps plain notice text`() {
        val document=mapOf("version" to 1,"blocks" to listOf(
            mapOf("type" to "paragraph","runs" to listOf(mapOf("text" to "업무 안내","bold" to true,"underline" to true,"size" to 20,"color" to "#1d4ed8"))),
            mapOf("type" to "listItem","list" to "bullet","runs" to listOf(mapOf("text" to "확인 사항")))
        ))
        val created=workflow.execute(actor("bnoc"),command("createDirective",mapOf("title" to "서식 안내","body" to "업무 안내\n확인 사항","bodyDocument" to document,"attachmentRefs" to emptyList<String>())))
        val notice=workflow.operations.notice(actor("requester"),created.publicRef!!)
        assertEquals("업무 안내\n확인 사항",notice["body"])
        assertEquals(document,notice["bodyDocument"])
        val invalid=document+mapOf("html" to "<script>alert(1)</script>")
        val rejected=runCatching { workflow.execute(actor("bnoc"),command("updateDirective",mapOf("noticeRef" to created.publicRef,"title" to "서식 안내","body" to "업무 안내\n확인 사항","bodyDocument" to invalid,"attachmentRefs" to emptyList<String>()),1)) }.exceptionOrNull()
        assertTrue(rejected is BusinessFailure,"NOTICE_DOCUMENT_MUST_REJECT_UNSUPPORTED_FIELDS")
        assertEquals("VALIDATION",(rejected as BusinessFailure).code)
        val fractional=mapOf("version" to 1,"blocks" to listOf(mapOf("type" to "paragraph","runs" to listOf(mapOf("text" to "분수 크기","size" to 20.5)))))
        val invalidSize=runCatching { workflow.execute(actor("bnoc"),command("createDirective",mapOf("title" to "잘못된 크기","body" to "분수 크기","bodyDocument" to fractional,"attachmentRefs" to emptyList<String>()))) }.exceptionOrNull()
        assertEquals("VALIDATION",(invalidSize as BusinessFailure).code,"NOTICE_FONT_SIZE_MUST_MATCH_THE_ALLOWLIST_EXACTLY")
        val plain=workflow.execute(actor("bnoc"),command("createDirective",mapOf("title" to "일반 안내","body" to "서식 없는 기존 공지","attachmentRefs" to emptyList<String>())))
        assertNull(workflow.operations.notice(actor("requester"),plain.publicRef!!)["bodyDocument"])
    }
    @Test fun `temporary attachment ownership format and aggregate limits`() {
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { files.upload(actor("bnoc"),"notice",MockMultipartFile("file","bad.pdf","application/pdf","not pdf".toByteArray())) }.code)
        val attachment=files.upload(actor("bnoc"),"notice",MockMultipartFile("file","공지.pdf","application/pdf","%PDF-1.4\n%%EOF".toByteArray()))
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("bnoc-secondary"),command("createDirective",mapOf("title" to "지원 안내","body" to "내용","attachmentRefs" to listOf(attachment["id"])))) }.code)
        assertTrue(workflow.operations.notices(actor("requester")).isEmpty())
    }
    @Test fun `shared overview and schedule ignore legacy work rows without request links`() {
        val number=create();assign(number)
        db.jdbc.execute("SET REFERENTIAL_INTEGRITY FALSE")
        db.jdbc.execute("ALTER TABLE bnoc_works ALTER COLUMN request_number DROP NOT NULL")
        db.jdbc.update("INSERT INTO bnoc_works(work_number,request_number,team_id,status,schedule,resolved_by,origin,revision,assigned_person_refs,assigned_at) VALUES (?,?,?,?,?,?,?,?,?,?)", "legacy-plan-row", null, "무선반", "배정", "2026-10-21T10:00:00Z", "[]", "assigned", 0, "[]", "2026-10-21T09:00:00Z")

        val shared=queries.shared(actor("requester-secondary"),emptyMap())
        assertEquals(1,(shared["counts"] as Map<*,*>)["assigned"])
        assertEquals(listOf("${number}-1"),(shared["items"] as List<Map<*,*>>).map { it["workNumber"] })
        val schedule=queries.schedule(actor("team-wireless"),mapOf("from" to "2026-10-21","to" to "2026-10-22"))
        assertTrue((schedule["entries"] as List<*>).isEmpty())
        assertEquals(1,db.jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_works WHERE request_number IS NULL",Int::class.java))
    }
    @Test fun `effective shared totals exclude replaced cancelled and after action without leaking detail`() {
        val number=create();assign(number)
        val w=db.works(number).single()
        workflow.execute(actor("team-wireless"),command("updateWork",mapOf("nextStatus" to "반환","returnReason" to "담당 범위 확인"),w.revision,number,w.number))
        workflow.execute(actor("bnoc"),command("reassignReturnedWork",mapOf("teamIds" to listOf("유선반")),db.work(w.number)!!.revision,number,w.number))
        val shared=queries.shared(actor("requester-secondary"),mapOf("requestNumber" to number))
        assertEquals(1,(shared["counts"] as Map<*,*>)["assigned"])
        assertEquals(1,(shared["counts"] as Map<*,*>)["remaining"])
        val row=(shared["items"] as List<*>).single() as Map<*,*>
        assertFalse(row.containsKey("detail"),"SHARED_WORK_MUST_NOT_EXPOSE_DETAILS");assertFalse(row.containsKey("location"));assertFalse(row.containsKey("assignedPersonRefs"));assertEquals(false,row["canOpenDetail"])
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) { queries.detail(actor("requester-secondary"),number) }.code)
        assertEquals("urgent",db.request(number)!!.priority)
        assertNotNull(db.works(number).last().assignedAt)
        workflow.execute(actor("requester"),command("cancelRequest",revision=db.request(number)!!.revision,number=number))
        assertEquals(0,(queries.shared(actor("bnoc"),emptyMap())["counts"] as Map<*,*>)["assigned"])
    }
    @Test fun `last returned assignment withdrawal stays pending and remains reachable for adding a department`() {
        val number=create();assign(number)
        val work=db.works(number).single()
        workflow.execute(actor("team-wireless"),command("updateWork",mapOf("nextStatus" to "반환","returnReason" to "담당 범위 확인"),work.revision,number,work.number))
        val returned=db.work(work.number)!!
        workflow.execute(actor("bnoc"),command("withdrawReturnedWork",emptyMap(),returned.revision,number,returned.number))
        val request=db.request(number)!!
        assertEquals("대기",request.status,"NO_CURRENT_WORK_MUST_REMAIN_PENDING")
        assertTrue(workflow.canEdit(actor("requester"),request),"ALL_WITHDRAWN_WORK_MUST_NOT_BLOCK_REQUEST_EDIT")
        val detail=queries.detail(actor("bnoc"),number)
        assertEquals(false,detail["canAssign"],"HISTORICAL_ASSIGNMENT_MUST_USE_ADD_DEPARTMENT_PATH")
        assertEquals(true,detail["canAddTeams"])
        val unassigned=queries.shared(actor("requester-secondary"),mapOf("bucket" to "unassigned"))
        assertTrue((unassigned["items"] as List<Map<*,*>>).any { it["requestNumber"]==number },"WITHDRAWN_REQUEST_MUST_REMAIN_VISIBLE_AS_UNASSIGNED")
        workflow.execute(actor("bnoc"),command("addTeams",mapOf("teamIds" to listOf("유선반")),request.revision,number))
        assertEquals("배정",db.request(number)!!.status)
        assertEquals("유선반",db.works(number).single { it.resolutionKind=="open" }.teamId)
    }
    @Test fun `permission revocation invalidates successful receipt replays`() {
        val number=create();val c=command("assignTeams",mapOf("teamIds" to listOf("무선반"),"priority" to "general"),db.request(number)!!.revision,number)
        val originalActor=actor("bnoc");workflow.execute(originalActor,c)
        val target=actor("bnoc")
        workflow.execute(actor("access-admin"),command("changeAccess",mapOf("subjectRef" to target.subjectRef,"role" to "requester","department" to "BNOC","departmentManager" to false,"active" to true),target.revision))
        assertThrows(BusinessFailure::class.java) { workflow.execute(originalActor,c) }
        assertThrows(BusinessFailure::class.java) { workflow.receipt(originalActor,c.operationId) }
    }
    @Test fun `history projects priority as Korean without changing stored before and after values`() {
        val number=create();assign(number)
        workflow.execute(actor("bnoc"),command("changePriority",mapOf("priority" to "general"),db.request(number)!!.revision,number))
        val before=db.rows("SELECT * FROM bnoc_history WHERE request_number=? ORDER BY history_id",number)
        val history=queries.history(actor("bnoc"),number)
        assertTrue(history.any { it["summary"]=="일반·긴급: 긴급 → 일반" },"HISTORY_PRIORITY_MUST_USE_KOREAN_LABELS")
        assertTrue(queries.history(actor("requester"),number).any { it["summary"]=="일반·긴급: 긴급 → 일반" })
        assertEquals(before,db.rows("SELECT * FROM bnoc_history WHERE request_number=? ORDER BY history_id",number))
        assertEquals("general",db.request(number)!!.priority)
    }
    @Test fun `history projects assignment schedule and completion instants in Seoul without changing fields or privacy`() {
        val number=create();assign(number);val request=db.request(number)!!;val work=db.works(number).single()
        workflow.history(actor("bnoc"),request,work,"배정 시각(접수 시간)",null,"2026-01-01T15:20:00Z")
        workflow.history(actor("bnoc"),request,null,"scheduledAt",null,"2026-01-01T15:00:00Z")
        workflow.history(actor("team-wireless"),request,work,"schedule","2026-01-01T15:00:00Z",null)
        workflow.history(actor("bnoc"),request,null,"schedulePreferences",null,listOf(mapOf("rank" to 1,"date" to "2026-01-02","period" to "AM")))
        workflow.history(actor("team-wireless"),request,work,"scheduleIntervals",null,listOf(mapOf("startsAt" to "2026-01-01T15:00:00Z","endsAt" to "2026-01-01T16:00:00Z")))
        workflow.history(actor("team-wireless"),request,work,"실제 시작 시각",null,"2026-01-01T14:00:00Z")
        workflow.history(actor("team-wireless"),request,work,"완료정보",null,mapOf("completedBy" to "team-wireless","completedAt" to "2026-01-01T15:30:00Z"))
        val before=db.rows("SELECT * FROM bnoc_history WHERE request_number=? ORDER BY history_id",number)
        val history=queries.history(actor("bnoc"),number)
        assertTrue(history.any { it["summary"]=="배정 시각(접수 시간): 2026. 1. 2. 00:20" },"HISTORY_TIME_MUST_USE_SEOUL_DISPLAY")
        assertTrue(history.any { it["field"]=="scheduledAt" && it["summary"]=="희망 일정: 2026. 1. 2. 00:00" })
        assertTrue(history.any { it["field"]=="schedule" && it["summary"]=="작업 일정: 2026. 1. 2. 00:00 → 미정" })
        assertTrue(history.any { it["field"]=="schedulePreferences" && it["summary"]=="희망 일정: 1지망 2026-01-02 오전" })
        assertTrue(history.any { it["field"]=="scheduleIntervals" && it["summary"]=="작업 일정: 2026. 1. 2. 00:00–2026. 1. 2. 01:00" })
        assertTrue(history.any { it["summary"]=="실제 시작 시각: 2026. 1. 1. 23:00" })
        assertTrue(history.any { it["summary"]=="완료정보: 무선반 · 2026. 1. 2. 00:30" })
        assertTrue(history.none { it["summary"].toString().contains("team-wireless") })
        assertTrue(queries.history(actor("requester"),number).none { it["field"]=="완료정보" || it["field"]=="schedule" || it["field"]=="배정 시각(접수 시간)" })
        assertEquals(before,db.rows("SELECT * FROM bnoc_history WHERE request_number=? ORDER BY history_id",number))
    }
    @Test fun `notification persistence failure rolls back all work and receipt`() {
        val number=create()
        db.jdbc.execute("DROP TABLE bnoc_notifications")
        assertThrows(Exception::class.java) { assign(number,listOf("무선반","유선반")) }
        assertTrue(db.works(number).isEmpty());assertNull(db.request(number)!!.priority);assertEquals("대기",db.request(number)!!.status)
        assertEquals(1,db.rows("SELECT * FROM bnoc_history WHERE request_number=?",number).size)
        assertEquals(1,db.rows("SELECT * FROM bnoc_receipts").size)
    }
    @Test fun `business writes use read committed without changing the shared transaction template`() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "")
        val observed=mutableSetOf<Int>()
        fun track(connection:java.sql.Connection):java.sql.Connection=java.lang.reflect.Proxy.newProxyInstance(java.sql.Connection::class.java.classLoader,arrayOf(java.sql.Connection::class.java)) { _,method,args ->
            if(method.name in listOf("prepareStatement","createStatement") && !connection.autoCommit) observed.add(connection.transactionIsolation)
            try { method.invoke(connection,*(args ?: emptyArray())) } catch(error:java.lang.reflect.InvocationTargetException) { throw error.targetException }
        } as java.sql.Connection
        val tracked=object:AbstractDataSource() {
            override fun getConnection()=track(source.connection)
            override fun getConnection(username:String,password:String)=track(source.getConnection(username,password))
        }
        val storage=Database(JdbcTemplate(tracked));storage.initialize()
        val shared=TransactionTemplate(DataSourceTransactionManager(tracked)).also { it.isolationLevel=TransactionDefinition.ISOLATION_REPEATABLE_READ }
        val service=WorkflowService(storage,shared,root.toString())
        val formId=UUID.randomUUID().toString();val formBytes="fixture".toByteArray();val storedName="$formId.bin"
        Files.write(root.resolve(storedName),formBytes)
        storage.jdbc.update("INSERT INTO bnoc_attachments(attachment_ref,owner_subject,resource_kind,resource_ref,file_name,content_type,byte_size,stored_name,uploaded_at,was_linked,current_link) VALUES (?,?,?,?,?,?,?,?,?,?,?)",formId,"requester","request",null,"support-form-fixture.txt","text/plain",formBytes.size,storedName,Instant.now().toString(),false,false)
        val form=mapOf("id" to formId)
        service.execute(storage.actor("requester")!!,command("createRequest",mapOf("category" to "회의 지원","subcategories" to mapOf("meetingType" to "일반회의"),"detail" to "지원 요청","location" to "신청 위치","contact" to "1234","attachments" to listOf(form))))
        assertEquals(setOf(TransactionDefinition.ISOLATION_READ_COMMITTED),observed,"BUSINESS_WRITES_MUST_READ_CURRENT_COMMITTED_ROWS")
        assertEquals(TransactionDefinition.ISOLATION_REPEATABLE_READ,shared.isolationLevel,"SHARED_TRANSACTION_TEMPLATE_MUST_NOT_CHANGE")
    }
    @Test @Timeout(30) fun `independent team simultaneous completion preserves both works and final state`() {
        val number=create();assign(number,listOf("무선반","유선반"));val works=db.works(number)
        val gate=CountDownLatch(1);val pool=Executors.newFixedThreadPool(2)
        try {
            val results=works.mapIndexed { i,w -> pool.submit<CommandResult> { gate.await();workflow.execute(actor(if(i==0) "team-wireless" else "team-wired"),command("updateWork",mapOf("nextStatus" to "완료"),w.revision,number,w.number)) } }
            gate.countDown();results.forEach { assertTrue(it.get().ok) }
        } finally { pool.shutdownNow() }
        assertTrue(db.works(number).all { it.status=="완료" });assertEquals("완료",db.request(number)!!.status)
        val events=db.rows("SELECT work_number FROM bnoc_notifications WHERE request_number=? AND event_name='완료'",number)
        assertEquals(2,events.size)
        assertEquals(works.map { it.number }.toSet(),events.map { it["work_number"] as String }.toSet())
    }
    @Test fun `each work status change alerts requester without alerting schedule-only edits`() {
        val number=create();assign(number,listOf("무선반","유선반"));val works=db.works(number);val requester=actor("requester")
        val wireless=actor("team-wireless")
        workflow.execute(wireless,command("updateWork",mapOf("nextStatus" to "작업 중"),works[0].revision,number,works[0].number))
        var alerts=queries.notifications(requester).filter { it["relatedRequestId"]==number && it["event"]=="작업 중" }
        assertEquals(1,alerts.size)
        assertEquals("작업 중",alerts.single()["event"])
        assertEquals(works[0].number,alerts.single()["relatedWorkItemId"])
        workflow.execute(wireless,command("updateWorkDetails",mapOf("memo" to "메모 수정"),db.work(works[0].number)!!.revision,number,works[0].number))
        assertEquals(1,queries.notifications(requester).count { it["relatedRequestId"]==number && it["event"]=="작업 중" },"SCHEDULE_OR_MEMO_EDIT_MUST_NOT_NOTIFY")
        workflow.execute(actor("team-wired"),command("updateWork",mapOf("nextStatus" to "작업 중"),works[1].revision,number,works[1].number))
        alerts=queries.notifications(requester).filter { it["relatedRequestId"]==number && it["event"]=="작업 중" }
        assertEquals(2,alerts.size,"SECOND_WORK_STATUS_CHANGE_MUST_NOTIFY_WHILE_REQUEST_STATUS_STAYS_IN_PROGRESS")
        assertEquals(setOf(works[0].number,works[1].number),alerts.map { it["relatedWorkItemId"] as String }.toSet())
    }
    @Test fun `requester work status notification failure rolls back work state and receipt`() {
        val number=create();assign(number);val work=db.works(number).single();val beforeHistory=db.rows("SELECT * FROM bnoc_history WHERE request_number=? ORDER BY history_id",number);val beforeReceipts=db.rows("SELECT * FROM bnoc_receipts WHERE request_number=?",number).size
        db.jdbc.execute("DROP TABLE bnoc_notifications")
        assertThrows(Exception::class.java){workflow.execute(actor("team-wireless"),command("updateWork",mapOf("nextStatus" to "작업 중"),work.revision,number,work.number))}
        assertEquals("배정",db.work(work.number)!!.status)
        assertEquals("배정",db.request(number)!!.status)
        assertEquals(beforeHistory,db.rows("SELECT * FROM bnoc_history WHERE request_number=? ORDER BY history_id",number))
        assertEquals(beforeReceipts,db.rows("SELECT * FROM bnoc_receipts WHERE request_number=?",number).size)
    }
    @Test fun `BNOC schedule includes team dates with exclusive end and completed unscheduled excluded`() {
        val number=create();assign(number);val w=db.works(number).single()
        workflow.execute(actor("team-wireless"),command("updateWork",mapOf("nextStatus" to "배정","scheduleIntervals" to scheduleIntervals("2026-10-14T15:00:00Z")),w.revision,number,w.number))
        assertEquals(0,(queries.schedule(actor("bnoc"),mapOf("from" to "2026-10-14","to" to "2026-10-15"))["entries"] as List<*>).size)
        assertEquals(1,(queries.schedule(actor("bnoc"),mapOf("from" to "2026-10-15","to" to "2026-10-16"))["entries"] as List<*>).size)
        workflow.execute(actor("team-wireless"),command("updateWork",mapOf("nextStatus" to "완료","scheduleIntervals" to emptyList<Any>()),db.work(w.number)!!.revision,number,w.number))
        assertEquals(0,(queries.schedule(actor("bnoc"),emptyMap())["unscheduled"] as List<*>).size)
    }
    private fun addCentralPerson(department:String,category:String,rank:String,name:String,serviceNumber:String,phone:String?=null):String {
        val revision=(db.rows("SELECT revision FROM bnoc_personnel_directory_versions WHERE version_key=1").firstOrNull()?.get("revision") as? Number)?.toLong() ?: 0L
        val result=workflow.execute(actor("bnoc"),command("saveCentralPerson",mapOf("department" to department,"category" to category,"rank" to rank,"displayName" to name,"serviceNumber" to serviceNumber,"internalPhone" to phone,"active" to true),revision))
        return result.publicRef!!
    }
    private fun absence(ref:String,type:String,start:String,end:String,revision:Long=0)=workflow.execute(actor("bnoc"),command("saveAbsence",mapOf("personRef" to ref,"absenceType" to type,"startDate" to start,"endDate" to end),revision))

    @Test fun `central personnel calculates inclusive unique absence and preserves department totals`() {
        val onLeave=addCentralPerson("무선반","병","상병","중앙 인원","100001","4321")
        addCentralPerson("무선반","간부","대위","간부 인원","100002")
        absence(onLeave,"휴가","2026-10-20","2026-10-22")
        absence(onLeave,"출장","2026-10-22","2026-10-24")
        val atBoundary=workflow.operations.personnelSummary(actor("bnoc"),"2026-10-22",null)
        val wireless=(atBoundary["departments"] as List<*>).map { it as Map<*,*> }.single { it["department"]=="무선반" }
        assertEquals(2,wireless["total"]);assertEquals(1,wireless["absent"]);assertEquals(1,wireless["current"])
        val nextDay=workflow.operations.personnelSummary(actor("bnoc"),"2026-10-25","무선반")
        val next=(nextDay["departments"] as List<*>).single() as Map<*,*>
        assertEquals(2,next["total"]);assertEquals(0,next["absent"]);assertEquals(2,next["current"])
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { workflow.operations.personnelSummary(actor("requester"),"2026-10-22",null) }.code)
    }

    @Test fun `central roster requires BNOC and rejects duplicate service numbers`() {
        val ref=addCentralPerson("무선반","병","상병","중앙 인원","200001")
        assertTrue((workflow.operations.listCentralRoster(actor("bnoc"),null)["entries"] as List<*>).any { (it as Map<*,*>)["personRef"]==ref })
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("team-wireless"),command("saveCentralPerson",mapOf("department" to "무선반","category" to "병","rank" to "병장","displayName" to "추가 인원","serviceNumber" to "200002","active" to true),1)) }.code)
        val duplicate=runCatching { addCentralPerson("유선반","병","일병","중복 군번","200001") }.exceptionOrNull() as BusinessFailure
        assertEquals("VALIDATION",duplicate.code)
        val requesterView=workflow.operations.listCentralRoster(actor("team-wireless"),"무선반")
        assertTrue((requesterView["entries"] as List<*>).single().let { !(it as Map<*,*>).containsKey("serviceNumber") })
    }

    @Test fun `battalion B duty preserves the legacy A row and both single receipts`() {
        val first=addCentralPerson("무선반","간부","대위","합성 A","BA001")
        val second=addCentralPerson("유선반","간부","소령","합성 B","BB001")
        val legacy=command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-12","seat" to "communications_battalion_day_officer","personRefs" to listOf(first)),0)
        val legacyResult=workflow.execute(actor("bnoc"),legacy)
        val before=db.rows("SELECT * FROM bnoc_duty_schedules WHERE seat=?","communications_battalion_day_officer").single()
        val b=command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-12","seat" to "battalion_b_day_officer","personRefs" to listOf(second)),0)
        val result=workflow.execute(actor("bnoc"),b)
        assertEquals("2026-10|2026-10-12|battalion_b_day_officer|BNOC",result.publicRef)
        assertEquals(before,db.rows("SELECT * FROM bnoc_duty_schedules WHERE seat=?","communications_battalion_day_officer").single())
        assertEquals(legacyResult.copy(replayed=true),workflow.execute(actor("bnoc"),legacy))
        assertEquals(result.copy(replayed=true),workflow.execute(actor("bnoc"),b))
        val view=workflow.operations.listDutySchedules(actor("bnoc"),"2026-10","battalion_b_day_officer")["entries"] as List<Map<String,Any?>>
        assertEquals(second,(view.single()["people"] as List<Map<String,Any?>>).single()["personRef"])
        assertEquals(2,db.rows("SELECT * FROM bnoc_duty_schedules").size)
    }
    @Test fun `battalion B batch text replay and privacy keep officer authority`() {
        val ref=addCentralPerson("무선반","간부","대위","합성 B","BB002")
        val batch=command("saveDutyScheduleBatch",mapOf("month" to "2026-10","seat" to "battalion_b_day_officer","mode" to "replace","entries" to listOf(mapOf("date" to "2026-10-13","personRefs" to listOf(ref),"expectedRevision" to 0))))
        val batchResult=workflow.execute(actor("bnoc"),batch)
        assertEquals(batchResult.copy(replayed=true),workflow.execute(actor("bnoc"),batch))
        val text=command("saveDutyScheduleBatch",mapOf("month" to "2026-10","seat" to "battalion_b_day_officer","text" to "20261014 대위 합성 B"))
        val textResult=workflow.execute(actor("bnoc"),text)
        assertEquals(textResult.copy(replayed=true),workflow.execute(actor("bnoc"),text))
        for(role in listOf("requester","access-admin","team-wireless")) {
            val public=workflow.operations.listDutySchedules(actor(role),"2026-10","battalion_b_day_officer")["entries"] as List<Map<String,Any?>>
            assertEquals(2,public.size)
            assertTrue(public.all { row -> (row["people"] as List<Map<String,Any?>>).all { it.keys==setOf("displayName","rank") } })
            assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { workflow.operations.authorizeReceipt(actor(role),"saveDutyScheduleBatch",batchResult) }.code)
            assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { workflow.execute(actor(role),command("saveDutyScheduleBatch",batch.payload)) }.code)
            assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { workflow.execute(actor(role),command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-15","seat" to "battalion_b_day_officer","personRefs" to listOf(ref)),0)) }.code)
        }
        assertEquals("CONFLICT",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("bnoc"),command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-13","seat" to "battalion_b_day_officer","personRefs" to listOf(ref)),0)) }.code)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("bnoc"),command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-15","seat" to "battalion_b_day_officer","personRefs" to emptyList<String>()),0)) }.code)
    }
    @Test fun `monthly duty seats enforce role rank absence and partial date updates`() {
        val officer=addCentralPerson("무선반","간부","대위","당직 후보","300001")
        val soldier=addCentralPerson("무선반","병","상병","야간 근무 후보","300002")
        val absenceCandidate=addCentralPerson("무선반","병","일병","부재 후보","300003")
        workflow.execute(actor("team-wireless"),command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-14","seat" to "team_night","personRefs" to listOf(soldier)),0))
        absence(absenceCandidate,"휴가","2026-10-14","2026-10-14")
        workflow.execute(actor("bnoc"),command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-12","seat" to "duty_officer","personRefs" to listOf(officer)),0))
        val absentFailure=runCatching { workflow.execute(actor("team-wireless"),command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-14","seat" to "team_night","personRefs" to listOf(soldier,absenceCandidate)),1)) }.exceptionOrNull() as BusinessFailure
        assertEquals("VALIDATION",absentFailure.code)
        absence(soldier,"휴가","2026-10-14","2026-10-14")
        workflow.execute(actor("team-wireless"),command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-15","seat" to "team_night","personRefs" to listOf(soldier)),0))
        val unauthorized=runCatching { workflow.execute(actor("team-wireless"),command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-12","seat" to "duty_officer","personRefs" to listOf(officer)),0)) }.exceptionOrNull() as BusinessFailure
        assertEquals("FORBIDDEN",unauthorized.code)
        val schedules=workflow.operations.listDutySchedules(actor("bnoc"),"2026-10")
        assertEquals(3,(schedules["entries"] as List<*>).size)
        val requesterEntries=workflow.operations.listDutySchedules(actor("requester"),"2026-10")["entries"] as List<Map<String,Any?>>
        assertEquals(3,requesterEntries.size)
        assertTrue(requesterEntries.all { entry ->
            val people=entry["people"] as List<Map<String,Any?>>
            people.all { it.keys==setOf("displayName","rank") }
        })
        val adminEntries=workflow.operations.listDutySchedules(actor("access-admin"),"2026-10")["entries"] as List<Map<String,Any?>>
        assertEquals(3,adminEntries.size)
        assertTrue(adminEntries.all { entry -> (entry["people"] as List<Map<String,Any?>>).all { it.keys==setOf("displayName","rank") } })
        assertEquals("당직 후보",(requesterEntries.first { it["date"]=="2026-10-12" }["people"] as List<Map<String,Any?>>).single()["displayName"])
        val teamEntries=workflow.operations.listDutySchedules(actor("team-wireless"),"2026-10")["entries"] as List<Map<String,Any?>>
        assertTrue(teamEntries.first { it["date"]=="2026-10-12" }["people"].let { (it as List<Map<String,Any?>>).single().keys==setOf("displayName","rank") })
        assertTrue(teamEntries.first { it["date"]=="2026-10-15" }["people"].let { (it as List<Map<String,Any?>>).single().containsKey("personRef") })
        val conflictPerson=(teamEntries.first { it["date"]=="2026-10-14" }["people"] as List<Map<String,Any?>>).single()
        assertEquals(true,conflictPerson["conflict"])
        assertTrue("absenceTypes" !in conflictPerson)
    }
    @Test fun `multiple duty dates add selected members but one date replaces list`() {
        val first=addCentralPerson("무선반","간부","대위","합성 A","700001")
        val second=addCentralPerson("유선반","간부","소령","합성 B","700002")
        val added=addCentralPerson("암호반","간부","중위","합성 C","700003")
        workflow.execute(actor("bnoc"),command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-02","seat" to "duty_officer","personRefs" to listOf(first)),0))
        workflow.execute(actor("bnoc"),command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-03","seat" to "duty_officer","personRefs" to listOf(second)),0))

        workflow.execute(actor("bnoc"),command("saveDutyScheduleBatch",mapOf("month" to "2026-10","seat" to "duty_officer","entries" to listOf(
            mapOf("date" to "2026-10-02","personRefs" to listOf(first,added),"expectedRevision" to 1),
            mapOf("date" to "2026-10-03","personRefs" to listOf(first,added),"expectedRevision" to 1)
        ))))

        var rows=workflow.operations.listDutySchedules(actor("bnoc"),"2026-10","duty_officer")["entries"] as List<*>
        fun refs(date:String)=((rows.single { (it as Map<*,*>) ["date"]==date } as Map<*,*>)["people"] as List<*>).map { (it as Map<*,*>)["personRef"] }
        assertEquals(setOf(first,added),refs("2026-10-02").toSet(),"MULTI_DATE_SAVE_MUST_ADD_SELECTED_MEMBERS")
        assertEquals(2,refs("2026-10-02").size,"MULTI_DATE_SAVE_MUST_NOT_DUPLICATE_EXISTING_MEMBER")
        assertEquals(setOf(second,first,added),refs("2026-10-03").toSet(),"MULTI_DATE_SAVE_MUST_PRESERVE_EACH_DATE_EXISTING_MEMBER")
        assertEquals(3,refs("2026-10-03").size,"MULTI_DATE_SAVE_MUST_NOT_DUPLICATE_EXISTING_MEMBER")

        workflow.execute(actor("bnoc"),command("saveDutyScheduleBatch",mapOf("month" to "2026-10","seat" to "duty_officer","entries" to listOf(
            mapOf("date" to "2026-10-02","personRefs" to listOf(first,added),"expectedRevision" to 2),
            mapOf("date" to "2026-10-03","personRefs" to listOf(first,added),"expectedRevision" to 2)
        ))))
        rows=workflow.operations.listDutySchedules(actor("bnoc"),"2026-10","duty_officer")["entries"] as List<*>
        assertEquals(2L,((rows.single { (it as Map<*,*>) ["date"]=="2026-10-02" } as Map<*,*>) ["revision"] as Number).toLong(),"UNCHANGED_DATE_MUST_NOT_ADVANCE_REVISION")
        assertEquals(2L,((rows.single { (it as Map<*,*>) ["date"]=="2026-10-03" } as Map<*,*>) ["revision"] as Number).toLong(),"UNCHANGED_DATE_MUST_NOT_ADVANCE_REVISION")

        workflow.execute(actor("bnoc"),command("saveDutyScheduleBatch",mapOf("month" to "2026-10","seat" to "duty_officer","entries" to listOf(
            mapOf("date" to "2026-10-02","personRefs" to listOf(added),"expectedRevision" to 2)
        ))))
        rows=workflow.operations.listDutySchedules(actor("bnoc"),"2026-10","duty_officer")["entries"] as List<*>
        assertEquals(listOf(added),refs("2026-10-02"),"SINGLE_DATE_SAVE_MUST_REPLACE_SELECTION")
        assertEquals(setOf(second,first,added),refs("2026-10-03").toSet(),"SINGLE_DATE_SAVE_MUST_NOT_CHANGE_OTHER_DATE")
    }
    @Test fun `explicit append preserves a transferred inactive member even with one date`() {
        val before=addCentralPerson("무선반","병","상병","기존 편성","710001")
        val added=addCentralPerson("무선반","병","병장","추가 편성","710002")
        workflow.execute(actor("team-wireless"),command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-02","seat" to "team_night","personRefs" to listOf(before)),0))
        db.jdbc.update("UPDATE bnoc_roster SET department='유선반',active=FALSE WHERE person_ref=?",before)
        workflow.execute(actor("team-wireless"),command("saveDutyScheduleBatch",mapOf("month" to "2026-10","seat" to "team_night","mode" to "append","entries" to listOf(mapOf("date" to "2026-10-02","personRefs" to listOf(added),"expectedRevision" to 1)))))
        val row=(workflow.operations.listDutySchedules(actor("team-wireless"),"2026-10")["entries"] as List<*>).single() as Map<*,*>
        val people=row["people"] as List<*>
        assertEquals(setOf(before,added),people.map { (it as Map<*,*>)["personRef"] }.toSet(),"APPEND_ONE_DATE_MUST_PRESERVE_EXISTING_PEOPLE")
        assertEquals("기존 편성",(people.first() as Map<*,*>)["displayName"],"TRANSFERRED_DUTY_MEMBER_MUST_REMAIN_VISIBLE")
        workflow.execute(actor("team-wireless"),command("saveDutyScheduleBatch",mapOf("month" to "2026-10","seat" to "team_night","mode" to "replace","entries" to listOf(mapOf("date" to "2026-10-02","personRefs" to listOf(added),"expectedRevision" to 2)))))
        val current=(workflow.operations.listDutySchedules(actor("team-wireless"),"2026-10")["entries"] as List<*>).single() as Map<*,*>
        assertEquals(listOf(added),(current["people"] as List<*>).map { (it as Map<*,*>)["personRef"] },"REPLACE_MUST_ALLOW_REMOVING_TRANSFERRED_MEMBER")
    }
    @Test fun `planned maintenance is visible to other teams without nonplan details`() {
        db.jdbc.update("INSERT INTO bnoc_planned_works(planned_work_id,team_id,title,status,first_work_date,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)","cross-team-plan","유선반","다른 반 계획","in_progress","2026-10-01",1,"2026-10-01T00:00:00Z","2026-10-01T00:00:00Z")
        val schedule=queries.schedule(actor("team-wireless"),mapOf("from" to "2026-10-02","to" to "2026-10-03"))
        assertTrue((schedule["plans"] as List<*>).any { (it as Map<*,*>)["plannedWorkId"]=="cross-team-plan" },"PLANS_MUST_BE_VISIBLE_TO_ALL_LOGGED_IN_ROLES")
        assertTrue((schedule["entries"] as List<*>).isEmpty())
    }
    @Test fun `duty selection waits for personnel commit and rejects its newly committed absence`() {
        val person=addMember()
        val locked=CountDownLatch(1);val release=CountDownLatch(1);val started=CountDownLatch(1)
        val pool=Executors.newFixedThreadPool(2)
        val tx=TransactionTemplate(DataSourceTransactionManager(db.jdbc.dataSource!!))
        val holding=pool.submit { tx.execute {
            db.lockResource("personnel-directory")
            db.jdbc.update("INSERT INTO bnoc_absences(absence_ref,person_ref,absence_type,starts_on,ends_on,revision,recorded_by,recorded_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",UUID.randomUUID().toString(),person,"휴가","2026-10-02","2026-10-02",1,"bnoc","2026-10-01T00:00:00Z","2026-10-01T00:00:00Z")
            locked.countDown();assertTrue(release.await(5,java.util.concurrent.TimeUnit.SECONDS));null
        } }
        try {
            assertTrue(locked.await(5,java.util.concurrent.TimeUnit.SECONDS))
            val saving=pool.submit<Throwable?> {started.countDown();runCatching { workflow.execute(actor("team-wireless"),command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-02","seat" to "team_night","personRefs" to listOf(person)),0)) }.exceptionOrNull()}
            assertTrue(started.await(5,java.util.concurrent.TimeUnit.SECONDS));Thread.sleep(200)
            assertFalse(saving.isDone,"DUTY_MUST_WAIT_FOR_PERSONNEL_COMMIT")
            release.countDown();holding.get(5,java.util.concurrent.TimeUnit.SECONDS)
            assertEquals("VALIDATION",(saving.get(5,java.util.concurrent.TimeUnit.SECONDS) as BusinessFailure).code,"NEW_ABSENCE_MUST_BE_RECHECKED_AFTER_LOCK")
        } finally {release.countDown();pool.shutdownNow()}
    }
    @Test fun `monthly duty text import is atomic additive and leaves unlisted dates unchanged`() {
        val first=addCentralPerson("무선반","간부","대위","당직 후보","400001")
        val second=addCentralPerson("유선반","간부","소령","일직 후보","400002")
        workflow.execute(actor("bnoc"),command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-10","seat" to "duty_officer","personRefs" to listOf(first)),0))
        val invalid=runCatching { workflow.execute(actor("bnoc"),command("saveDutyScheduleBatch",mapOf("month" to "2026-10","seat" to "duty_officer","text" to "20261012 대위 당직 후보\n20261099 소령 일직 후보"))) }.exceptionOrNull() as BusinessFailure
        assertEquals("VALIDATION",invalid.code)
        assertEquals(listOf("2026-10-10"),(workflow.operations.listDutySchedules(actor("bnoc"),"2026-10")["entries"] as List<*>).map { (it as Map<*,*>) ["date"] })
        workflow.execute(actor("bnoc"),command("saveDutyScheduleBatch",mapOf("month" to "2026-10","seat" to "duty_officer","text" to "20261012 대위 당직 후보\n20261014 소령 일직 후보")))
        val rows=workflow.operations.listDutySchedules(actor("bnoc"),"2026-10","duty_officer")["entries"] as List<*>
        assertEquals(setOf("2026-10-10","2026-10-12","2026-10-14"),rows.map { (it as Map<*,*>) ["date"] }.toSet())
        assertEquals(setOf(first),(rows.single { (it as Map<*,*>) ["date"]=="2026-10-10" } as Map<*,*>)["people"].let { (it as List<*>).map { p -> (p as Map<*,*>) ["personRef"] }.toSet() })
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("team-wireless"),command("saveDutyScheduleBatch",mapOf("month" to "2026-10","seat" to "duty_officer","text" to "20261012 대위 당직 후보"))) }.code)
    }
    @Test fun `monthly duty batch rejects stale date revision without partial writes`() {
        val officer=addCentralPerson("무선반","간부","대위","당직 후보","500001")
        workflow.execute(actor("bnoc"),command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-10","seat" to "duty_officer","personRefs" to listOf(officer)),0))
        val stale=runCatching { workflow.execute(actor("bnoc"),command("saveDutyScheduleBatch",mapOf("month" to "2026-10","seat" to "duty_officer","entries" to listOf(
            mapOf("date" to "2026-10-10","personRefs" to listOf(officer),"expectedRevision" to 0),
            mapOf("date" to "2026-10-11","personRefs" to listOf(officer),"expectedRevision" to 0)
        ))))}.exceptionOrNull() as BusinessFailure
        assertEquals("CONFLICT",stale.code)
        val rows=workflow.operations.listDutySchedules(actor("bnoc"),"2026-10","duty_officer")["entries"] as List<*>
        assertEquals(listOf("2026-10-10"),rows.map { (it as Map<*,*>) ["date"] })
    }

    @Test fun `later absence remains visible and existing shift can be corrected without reassignment failure`() {
        val first=addCentralPerson("무선반","병","상병","첫 근무자","600001")
        val second=addCentralPerson("무선반","병","병장","둘째 근무자","600002")
        workflow.execute(actor("team-wireless"),command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-15","seat" to "team_night","personRefs" to listOf(first,second)),0))
        absence(first,"휴가","2026-10-15","2026-10-15")
        val current=workflow.operations.listDutySchedules(actor("team-wireless"),"2026-10","team_night")["entries"] as List<*>
        val members=(current.single() as Map<*,*>)["people"] as List<*>
        assertTrue((members.single { (it as Map<*,*>)["personRef"]==first } as Map<*,*>)["conflict"]==true)
        val replay=workflow.execute(actor("team-wireless"),command("saveDutyScheduleBatch",mapOf("month" to "2026-10","seat" to "team_night","text" to "20261015 상병 첫 근무자")))
        assertEquals("0명 추가 · 1명 기존 편성",replay.state)
        workflow.execute(actor("team-wireless"),command("saveDutySchedule",mapOf("month" to "2026-10","date" to "2026-10-15","seat" to "team_night","personRefs" to listOf(second)),1))
        val corrected=workflow.operations.listDutySchedules(actor("team-wireless"),"2026-10","team_night")["entries"] as List<*>
        assertEquals(listOf(second),(((corrected.single() as Map<*,*>)["people"] as List<*>).map { (it as Map<*,*>)["personRef"] }))
    }
}
