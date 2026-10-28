package bnoc

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.transaction.support.TransactionTemplate
import java.util.UUID

class ScheduleAfterActionContractTest {
    private lateinit var db: Database
    private lateinit var workflow: WorkflowService
    private lateinit var queries: QueryService

    @BeforeEach fun setup() {
        val source = DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "")
        db = Database(JdbcTemplate(source)); db.initialize()
        workflow = WorkflowService(db, TransactionTemplate(DataSourceTransactionManager(source)))
        queries = QueryService(db, workflow)
    }

    private fun op(type: String, number: String? = null, work: String? = null, revision: Long? = null, payload: Map<String, Any?> = emptyMap()) =
        Command(type, UUID.randomUUID().toString(), number, work, revision, payload)

    private fun createRequest(preferences: List<Map<String, Any?>> = emptyList()): String = workflow.execute(db.actor("requester")!!,
        op("createRequest", payload = mapOf("category" to "장비/체계", "subcategories" to mapOf("systemType" to "인터넷", "resourceType" to "PC", "workType" to "지원"),
            "detail" to "지원 요청", "location" to "공작사 2층", "contact" to "1234", "schedulePreferences" to preferences))).requestNumber!!

    private fun assigned(number: String): WorkRecord {
        workflow.execute(db.actor("bnoc")!!, op("assignTeams", number, revision = db.request(number)!!.revision,
            payload = mapOf("teamIds" to listOf("무선반"), "priority" to "general")))
        return db.works(number).single()
    }

    private fun slot(start: String, end: String) = mapOf("startsAt" to start, "endsAt" to end)

    @Test fun `preferences retain two ranked date period choices and reject second choice without first`() {
        assertEquals(0, db.request(createRequest())!!.schedulePreferences.size)
        val number = createRequest(listOf(mapOf("rank" to 1, "date" to "2026-10-22", "period" to "AM"), mapOf("rank" to 2, "date" to "2026-10-23", "period" to "PM")))
        assertEquals(listOf("2026-10-22" to "AM", "2026-10-23" to "PM"), db.request(number)!!.schedulePreferences.map { it.date to it.period })
        assertEquals("2026-10-23", (queries.detail(db.actor("requester")!!, number)["schedulePreferences"] as List<SchedulePreference>)[1].date)

        val failure = assertThrows(BusinessFailure::class.java) { createRequest(listOf(mapOf("rank" to 2, "date" to "2026-10-23", "period" to "PM"))) }
        assertEquals("VALIDATION", failure.code, "SECOND_PREFERENCE_MUST_REQUIRE_FIRST")
        assertEquals("VALIDATION", assertThrows(BusinessFailure::class.java) { createRequest(listOf(mapOf("rank" to 1, "date" to "2026-10-22", "period" to "EVENING"))) }.code)
    }

    @Test fun `team can save multiple hourly intervals and return correction restores the entire previous set`() {
        val number = createRequest(); var work = assigned(number)
        val intervals = listOf(slot("2026-10-22T01:00:00Z", "2026-10-22T03:00:00Z"), slot("2026-10-22T05:00:00Z", "2026-10-22T06:00:00Z"))
        workflow.execute(db.actor("team-wireless")!!, op("updateWork", number, work.number, work.revision,
            mapOf("nextStatus" to "배정", "scheduleIntervals" to intervals)))
        work = db.work(work.number)!!
        assertEquals(intervals.map { it["startsAt"] to it["endsAt"] }, queries.detail(db.actor("bnoc")!!, number).let {
            ((it["workItems"] as List<*>).single() as Map<*, *>) ["scheduleIntervals"] as List<WorkScheduleInterval>
        }.map { it.startsAt to it.endsAt })

        workflow.execute(db.actor("team-wireless")!!, op("updateWork", number, work.number, work.revision,
            mapOf("nextStatus" to "반환", "returnReason" to "작업 범위 확인")))
        work = db.work(work.number)!!
        assertEquals(2, work.previousScheduleIntervals.size, "RETURN_MUST_PRESERVE_EVERY_INTERVAL")
        assertTrue(work.scheduleIntervals.isEmpty(), "RETURNED_WORK_MUST_NOT_KEEP_CURRENT_INTERVALS")
        assertEquals("VALIDATION", assertThrows(BusinessFailure::class.java) { workflow.execute(db.actor("team-wireless")!!,
            op("updateWork", number, work.number, work.revision, mapOf("nextStatus" to "배정"))) }.code)
        workflow.execute(db.actor("team-wireless")!!, op("updateWork", number, work.number, work.revision,
            mapOf("nextStatus" to "배정", "reusePreviousSchedule" to true, "scheduleIntervals" to emptyList<Any>())))
        assertEquals(intervals, db.work(work.number)!!.scheduleIntervals.map { mapOf("startsAt" to it.startsAt, "endsAt" to it.endsAt) })
    }

    @Test fun `completed assigned work leaves current plans and is returned as a separate recorded completion`() {
        val number = createRequest(); var work = assigned(number); val team = db.actor("team-wireless")!!
        workflow.execute(team, op("updateWork", number, work.number, work.revision, mapOf(
            "nextStatus" to "작업 중", "scheduleIntervals" to listOf(slot("2026-10-22T01:00:00Z", "2026-10-22T03:00:00Z")))))
        work = db.work(work.number)!!
        workflow.execute(team, op("updateWork", number, work.number, work.revision, mapOf("nextStatus" to "완료", "completionMemo" to "완료 기록")))

        val schedule = queries.schedule(team, mapOf("from" to "2026-10-22", "to" to "2026-10-23"))
        assertTrue((schedule["entries"] as List<*>).isEmpty(), "COMPLETED_ASSIGNED_WORK_MUST_NOT_REMAIN_PLANNED")
        val completed=(schedule["completedRecords"] as List<*>).single() as Map<*, *>
        assertEquals("완료",completed["status"])
        assertTrue((completed["scheduleIntervals"] as List<*>).isNotEmpty(),"COMPLETION_RECORD_MUST_RETAIN_ITS_ORIGINAL_PLAN")
        assertTrue(completed["completedAt"] is String,"COMPLETION_RECORD_MUST_KEEP_THE_ACTUAL_COMPLETION_TIME")
        assertTrue((schedule["unscheduled"] as List<*>).isEmpty())
    }

    @Test fun `returned work stays outside the active unscheduled schedule list`() {
        val number = createRequest(); val work = assigned(number); val team = db.actor("team-wireless")!!
        workflow.execute(team, op("updateWork", number, work.number, work.revision,
            mapOf("nextStatus" to "반환", "returnReason" to "다른 부서 작업 대기")))

        val schedule = queries.schedule(team, mapOf("from" to "2026-10-22", "to" to "2026-10-23"))
        assertTrue((schedule["entries"] as List<*>).isEmpty())
        assertTrue((schedule["unscheduled"] as List<*>).isEmpty(), "RETURNED_WORK_MUST_REMAIN_IN_THE_SEPARATE_RETURN_QUEUE")
    }

    @Test fun `schedule interval validation requires whole hour same day and rejects overlap`() {
        val number = createRequest(); val work = assigned(number); val team = db.actor("team-wireless")!!
        val invalid = listOf(
            listOf(slot("2026-10-22T01:30:00Z", "2026-10-22T02:30:00Z")),
            listOf(slot("2026-10-22T14:00:00Z", "2026-10-22T16:00:00Z")),
            listOf(slot("2026-10-22T01:00:00Z", "2026-10-22T03:00:00Z"), slot("2026-10-22T02:00:00Z", "2026-10-22T04:00:00Z"))
        )
        invalid.forEach { intervals ->
            val failure = assertThrows(BusinessFailure::class.java) { workflow.execute(team, op("updateWork", number, work.number, work.revision,
                mapOf("nextStatus" to "배정", "scheduleIntervals" to intervals))) }
            assertEquals("VALIDATION", failure.code)
            assertTrue(db.work(work.number)!!.scheduleIntervals.isEmpty(), "INVALID_INTERVALS_MUST_NOT_PARTIALLY_SAVE")
        }
        workflow.execute(team, op("updateWork", number, work.number, work.revision,
            mapOf("nextStatus" to "배정", "scheduleIntervals" to listOf(slot("2026-10-22T01:00:00Z", "2026-10-22T02:00:00Z"), slot("2026-10-22T02:00:00Z", "2026-10-22T03:00:00Z")))))
        assertEquals(1, db.work(work.number)!!.scheduleIntervals.size, "ADJACENT_HOURLY_CHOICES_MUST_FORM_ONE_RANGE")
        assertEquals("2026-10-22T03:00:00Z", db.work(work.number)!!.scheduleIntervals.single().endsAt)
    }

    @Test fun `after action is counted once as completed and appears as a private field safe team calendar record`() {
        val result = workflow.execute(db.actor("team-wireless")!!, op("createAfterActionReport", payload = mapOf(
            "requesterRef" to db.actor("requester")!!.subjectRef, "category" to "장비/체계", "subcategories" to mapOf("systemType" to "인터넷", "resourceType" to "PC", "workType" to "고장"),
            "detail" to "네트워크 연결 오류", "location" to "공작사 2층", "contact" to "9123", "completedConfirmed" to true,
            "actualStartedAt" to "2026-10-22T04:13:00Z", "actualCompletedAt" to "2026-10-22T04:29:00Z", "reason" to "선조치", "completionMemo" to "회선 재연결")))
        val number = result.requestNumber!!; val overview = queries.shared(db.actor("requester")!!, mapOf("requestNumber" to number))
        assertEquals(true, queries.summary(db.request(number)!!)["afterAction"], "AFTER_ACTION_SUMMARY_MUST_NOT_SHOW_NORMAL_REQUEST_PHASES")
        val counts = overview["counts"] as Map<*, *>
        assertEquals(1, counts["assigned"]); assertEquals(1, counts["completed"]); assertEquals(0, counts["remaining"])
        assertEquals(1, overview["afterActionCompleted"], "AFTER_ACTION_MUST_BE_A_COMPLETED_SUBSET_NOT_ADDED_TWICE")
        val department = (overview["byDepartment"] as List<*>).map { it as Map<*, *> }.single { it["department"] == "무선반" }
        assertEquals(1, department["assigned"]); assertEquals(1, department["completed"])
        val row = (overview["items"] as List<*>).single() as Map<*, *>
        assertEquals("after-action", row["origin"], "AFTER_ACTION_SOURCE_MUST_REMAIN_VISIBLE")

        val schedule = queries.schedule(db.actor("team-wireless")!!, mapOf("from" to "2026-10-22", "to" to "2026-10-23"))
        assertTrue((schedule["entries"] as List<*>).isEmpty(), "AFTER_ACTION_MUST_NOT_BE_A_PLANNED_INTERVAL")
        val record = (schedule["completedRecords"] as List<*>).single() as Map<*, *>
        assertEquals("2026-10-22T04:13:00Z", record["actualStartedAt"])
        assertEquals("공작사 2층", record["location"]); assertEquals("회선 재연결", record["memo"])
        assertEquals("after-action", record["origin"])
        assertEquals(setOf("workNumber", "teamId", "request", "actualStartedAt", "status", "location", "memo", "origin"), record.keys)
        assertEquals(setOf("requestNumber"), (record["request"] as Map<*, *>).keys)
        assertTrue(!record.containsKey("requesterContact") && !record.containsKey("detail"), "CALENDAR_MUST_EXCLUDE_PHONE_AND_REQUEST_DETAIL")
        val requesterCalendar=queries.schedule(db.actor("requester")!!,emptyMap())
        assertTrue((requesterCalendar["entries"] as List<*>).isEmpty())
        assertTrue((requesterCalendar["completedRecords"] as List<*>).isEmpty())
        assertTrue((requesterCalendar["unscheduled"] as List<*>).isEmpty())
        assertEquals(setOf("entries","completedRecords","unscheduled","plans","from","to"),requesterCalendar.keys)
    }

    @Test fun `v8 schedule data migrates from an empty v9 schema while retaining exact legacy values and history`() {
        assertEquals(1, db.jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_schema_migrations WHERE version=9", Int::class.java))
        val number = createRequest(); val work = assigned(number)
        val requestTime = "2026-10-20T15:23:07Z"
        val workTime = "2026-10-20T15:07:11Z"
        val previousTime = "2026-10-20T18:09:13Z"
        db.jdbc.update("UPDATE bnoc_requests SET requested_schedule=? WHERE request_number=?", requestTime, number)
        db.jdbc.update("UPDATE bnoc_works SET schedule=?,previous_schedule=? WHERE work_number=?", workTime, previousTime, work.number)
        workflow.history(db.actor("team-wireless")!!, db.request(number)!!, work, "실제 시작 시각", null, "2026-10-20T15:31:17Z")
        val historyCount = db.rows("SELECT * FROM bnoc_history WHERE request_number=?", number).size

        db.jdbc.update("DELETE FROM bnoc_schema_migrations WHERE version=9")
        db.jdbc.execute("DROP TABLE bnoc_request_schedule_legacy")
        db.jdbc.execute("DROP TABLE bnoc_request_schedule_preferences")
        db.jdbc.execute("DROP TABLE bnoc_work_schedule_intervals")
        db.jdbc.execute("ALTER TABLE bnoc_works DROP COLUMN actual_started_at")

        db.initialize()

        val migratedRequest = db.request(number)!!
        assertEquals(listOf("2026-10-21" to "AM"), migratedRequest.schedulePreferences.map { it.date to it.period })
        assertEquals(requestTime, db.jdbc.queryForObject("SELECT original_schedule FROM bnoc_request_schedule_legacy WHERE request_number=?", String::class.java, number))
        assertNull(db.jdbc.queryForObject("SELECT requested_schedule FROM bnoc_requests WHERE request_number=?", String::class.java, number))
        val migratedWork = db.work(work.number)!!
        assertEquals(workTime, migratedWork.scheduleIntervals.single().startsAt, "LEGACY_WORK_START_MUST_NOT_BE_ROUNDED")
        assertEquals("2026-10-20T16:07:11Z", migratedWork.scheduleIntervals.single().endsAt)
        assertEquals(previousTime, migratedWork.previousScheduleIntervals.single().startsAt)
        assertEquals("2026-10-20T19:09:13Z", migratedWork.previousScheduleIntervals.single().endsAt)
        assertEquals("2026-10-20T15:31:17Z", migratedWork.actualStartedAt)
        assertEquals(historyCount, db.rows("SELECT * FROM bnoc_history WHERE request_number=?", number).size, "MIGRATION_MUST_KEEP_HISTORY")
        assertEquals(1, db.jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_schema_migrations WHERE version=9", Int::class.java))
        db.initialize()
        assertEquals(1, db.request(number)!!.schedulePreferences.size, "MIGRATION_RETRY_MUST_NOT_DUPLICATE_PREFERENCES")
        assertEquals(1, db.work(work.number)!!.scheduleIntervals.size, "MIGRATION_RETRY_MUST_NOT_DUPLICATE_INTERVALS")
        val preservedWork=db.work(work.number)!!
        workflow.execute(db.actor("team-wireless")!!,op("updateWork",number,work.number,preservedWork.revision,mapOf(
            "nextStatus" to "배정", "scheduleIntervals" to listOf(
                slot(workTime,"2026-10-20T16:07:11Z"),slot("2026-10-20T18:00:00Z","2026-10-20T19:00:00Z")
            )
        )))
        assertEquals(listOf(workTime,"2026-10-20T18:00:00Z"),db.work(work.number)!!.scheduleIntervals.map { it.startsAt },
            "AN_EXACT_LEGACY_INTERVAL_MAY_BE_RETAINED_WHILE_NEW_HOURLY_SLOTS_ARE_ADDED")
    }
}
