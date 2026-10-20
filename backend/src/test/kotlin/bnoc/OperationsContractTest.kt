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
    fun create():String=workflow.execute(actor("requester"),command("createRequest",mapOf("category" to "장비/체계","subcategories" to mapOf("systemType" to "인터넷","resourceType" to "PC","workType" to "대여"),"detail" to "지원 요청","location" to "신청 위치","contact" to "1234"))).requestNumber!!
    fun assign(number:String,teams:List<String> = listOf("무선반"))=workflow.execute(actor("bnoc"),command("assignTeams",mapOf("teamIds" to teams,"priority" to "urgent"),db.request(number)!!.revision,number))
    fun departmentManager(department:String="무선반"):Actor {
        val target=actor("requester-secondary")
        workflow.execute(actor("access-admin"),command("changeAccess",mapOf("subjectRef" to target.subjectRef,"role" to "requester","department" to department,"teamId" to null,"departmentManager" to true,"active" to true),target.revision))
        return actor("requester-secondary")
    }
    @Test fun `rosters start empty and departments mutually read but requester does not`() {
        assertFalse(db.actors().any { it.active && it.role=="bnoc" && it.departmentManager })
        assertFalse(db.actors().any { it.active && it.role=="team" && it.departmentManager })
        assertFalse(db.actors().any { it.active && it.displayName=="부서 담당자" })
        assertTrue(workflow.operations.listRoster(actor("team-wireless"),"BNOC")["entries"] is List<*>)
        assertEquals(0,(workflow.operations.listRoster(actor("bnoc"),"BNOC")["entries"] as List<*>).size)
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { workflow.operations.personnel(actor("requester"),"2026-10-01",null) }.code)
        val crossDepartment=runCatching { workflow.execute(actor("team-wireless"),command("savePersonnelRoster",mapOf("department" to "유선반","entries" to emptyList<Any>()),0)) }.exceptionOrNull()
        assertTrue(crossDepartment is BusinessFailure,"DEPARTMENT_WRITE_MUST_BE_OWN")
        assertEquals("FORBIDDEN",(crossDepartment as BusinessFailure).code)
        assertTrue(db.actors().none { it.displayName.contains("시험 계정") })
    }
    @Test fun `designated department manager is an individual capability scoped to own department`() {
        val target=actor("requester-secondary")
        workflow.execute(actor("access-admin"),command("changeAccess",mapOf("subjectRef" to target.subjectRef,"role" to "requester","department" to "전장반(전산장비)","teamId" to null,"departmentManager" to true,"active" to true),target.revision))
        val manager=actor("requester-secondary")
        assertEquals("전장반(전산장비)",manager.department)
        assertTrue(manager.departmentManager)
        assertTrue(workflow.operations.listRoster(manager,"전장반(전산장비)")["entries"] is List<*>)
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { workflow.execute(manager,command("savePersonnelRoster",mapOf("department" to "유선반","entries" to emptyList<Any>()),0)) }.code)
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
    private fun addMember(manager:Actor=departmentManager()):String {
        workflow.execute(manager,command("savePersonnelRoster",mapOf("department" to "무선반","entries" to listOf(mapOf("displayName" to "담당 인원","active" to true))),0))
        return (workflow.operations.listRoster(actor("team-wireless"),"무선반")["entries"] as List<*>).single().let { (it as Map<*,*>)["personRef"] as String }
    }
    @Test fun `inactive members absent from a past record cannot be newly selected`() {
        val manager=departmentManager();val ref=addMember(manager)
        workflow.execute(manager,command("savePersonnelRoster",mapOf("department" to "무선반","entries" to listOf(mapOf("personRef" to ref,"displayName" to "담당 인원","active" to false))),1))
        val nightFailure=runCatching { workflow.execute(manager,command("saveNightDuty",mapOf("department" to "무선반","date" to "2025-02-01","personRefs" to listOf(ref)),0)) }.exceptionOrNull()
        assertTrue(nightFailure is BusinessFailure,"INACTIVE_NEW_PAST_MEMBER_MUST_BE_REJECTED")
        assertEquals("VALIDATION",(nightFailure as BusinessFailure).code)
        val personnelFailure=runCatching { workflow.execute(manager,command("saveDailyPersonnel",mapOf("department" to "무선반","date" to "2025-02-01","entries" to listOf(mapOf("personRef" to ref,"status" to "available"))),0)) }.exceptionOrNull()
        assertTrue(personnelFailure is BusinessFailure,"INACTIVE_NEW_PAST_MEMBER_MUST_BE_REJECTED")
        assertEquals("VALIDATION",(personnelFailure as BusinessFailure).code)
    }
    @Test fun `unlinked attachment denies owner and other users then linked file downloads`() {
        val bytes="첨부 내용".toByteArray()
        val attachment=files.upload(actor("requester"),"request",MockMultipartFile("file","첨부.txt","text/plain",bytes))
        val ref=attachment["id"] as String
        val ownerFailure=runCatching { files.download(actor("requester"),ref) }.exceptionOrNull()
        assertTrue(ownerFailure is BusinessFailure,"UNLINKED_ATTACHMENT_DOWNLOAD_MUST_BE_DENIED")
        assertEquals("NOT_FOUND",(ownerFailure as BusinessFailure).code)
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
        extendedWorkflow.execute(updated,command("savePersonnelRoster",mapOf("department" to "추가등록허용된부서","entries" to emptyList<Any>()),0))
    }
    @Test fun `server department registry rejects names exceeding storage limits`() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "")
        assertThrows(IllegalStateException::class.java) { Database(JdbcTemplate(source),additionalDepartments="가".repeat(101)).initialize() }
    }
    @Test fun `past personnel and night records survive inactivity and missing status stays missing`() {
        val manager=departmentManager();val ref=addMember(manager)
        val save=command("saveDailyPersonnel",mapOf("department" to "무선반","date" to "2025-01-01","entries" to listOf(mapOf("personRef" to ref,"status" to "leave"))),0)
        workflow.execute(manager,save)
        workflow.execute(manager,command("saveNightDuty",mapOf("department" to "무선반","date" to "2025-01-01","personRefs" to listOf(ref)),0))
        workflow.execute(manager,command("savePersonnelRoster",mapOf("department" to "무선반","entries" to listOf(mapOf("personRef" to ref,"displayName" to "담당 인원","active" to false))),1))
        workflow.execute(manager,save.copy(operationId=UUID.randomUUID().toString(),expectedRevision=1,payload=save.payload+mapOf("entries" to listOf(mapOf("personRef" to ref,"status" to "trip")))))
        assertEquals(1L,((workflow.operations.night(actor("bnoc"),"2025-01-01","무선반")["departments"] as List<*>).single() as Map<*,*>)["revision"])
        val today=workflow.operations.personnel(actor("bnoc"),"2026-01-01","BNOC")
        val department=(today["departments"] as List<*>).single() as Map<*,*>
        assertEquals(false,department["submitted"])
    }
    @Test fun `work personnel from own roster optional and completion actor distinct`() {
        val ref=addMember();val number=create();assign(number)
        val w=db.works(number).single()
        workflow.execute(actor("team-wireless"),command("updateWork",mapOf("nextStatus" to "완료","assignedPersonRefs" to listOf(ref)),w.revision,number,w.number))
        val view=(queries.detail(actor("team-wireless"),number)["workItems"] as List<*>).single() as Map<*,*>
        assertEquals("무선반",view["completionActor"])
        assertEquals(listOf(ref),view["assignedPersonRefs"])
        assertEquals("담당 인원",((view["assignedPersons"] as List<*>).single() as Map<*,*>)["displayName"])
        assertEquals("INVALID_STATE",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("requester"),command("updateRequest",mapOf("detail" to "다른 요청"),db.request(number)!!.revision,number)) }.code)
    }
    @Test fun `completed after action starts unclassified cannot be corrected by team`() {
        val number=workflow.execute(actor("team-wireless"),command("createAfterActionReport",mapOf("category" to "회의 지원","subcategories" to mapOf("meetingType" to "일반회의"),"detail" to "완료 기록","location" to "신청 위치","contact" to "1234","completedConfirmed" to true,"actualRequesterText" to "직접 요청자","actualStartedAt" to "2026-01-01T00:00:00Z","actualCompletedAt" to "2026-01-01T01:00:00Z","reason" to "선조치 기록"))).requestNumber!!
        assertNull(db.request(number)!!.priority,"AFTER_ACTION_MUST_START_UNCLASSIFIED")
        val w=db.works(number).single()
        assertEquals("INVALID_STATE",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("team-wireless"),command("updateWork",mapOf("nextStatus" to "배정"),w.revision,number,w.number)) }.code)
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
        workflow.history(actor("team-wireless"),request,work,"실제 시작 시각",null,"2026-01-01T14:00:00Z")
        workflow.history(actor("team-wireless"),request,work,"완료정보",null,mapOf("completedBy" to "team-wireless","completedAt" to "2026-01-01T15:30:00Z"))
        val before=db.rows("SELECT * FROM bnoc_history WHERE request_number=? ORDER BY history_id",number)
        val history=queries.history(actor("bnoc"),number)
        assertTrue(history.any { it["summary"]=="배정 시각(접수 시간): 2026. 1. 2. 00:20" },"HISTORY_TIME_MUST_USE_SEOUL_DISPLAY")
        assertTrue(history.any { it["field"]=="scheduledAt" && it["summary"]=="희망 일정: 2026. 1. 2. 00:00" })
        assertTrue(history.any { it["field"]=="schedule" && it["summary"]=="작업 일정: 2026. 1. 2. 00:00 → 미정" })
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
        service.execute(storage.actor("requester")!!,command("createRequest",mapOf("category" to "회의 지원","subcategories" to mapOf("meetingType" to "일반회의"),"detail" to "지원 요청","location" to "신청 위치","contact" to "1234")))
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
        assertEquals(1,db.rows("SELECT * FROM bnoc_notifications WHERE request_number=? AND event_name='완료'",number).size)
    }
    @Test fun `BNOC schedule includes team dates with exclusive end and completed unscheduled excluded`() {
        val number=create();assign(number);val w=db.works(number).single()
        workflow.execute(actor("team-wireless"),command("updateWork",mapOf("nextStatus" to "배정","schedule" to "2026-10-14T15:00:00Z"),w.revision,number,w.number))
        assertEquals(0,(queries.schedule(actor("bnoc"),mapOf("from" to "2026-10-14","to" to "2026-10-15"))["entries"] as List<*>).size)
        assertEquals(1,(queries.schedule(actor("bnoc"),mapOf("from" to "2026-10-15","to" to "2026-10-16"))["entries"] as List<*>).size)
        workflow.execute(actor("team-wireless"),command("updateWork",mapOf("nextStatus" to "완료","schedule" to ""),db.work(w.number)!!.revision,number,w.number))
        assertEquals(0,(queries.schedule(actor("bnoc"),emptyMap())["unscheduled"] as List<*>).size)
    }
}
