package bnoc

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.util.Comparator
import java.util.UUID

class MeetingRequestContractTest {
    private lateinit var db:Database
    private lateinit var workflow:WorkflowService
    private lateinit var requester:Actor
    private lateinit var team:Actor
    private lateinit var attachmentRoot:Path

    @BeforeEach fun setup() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "")
        db=Database(JdbcTemplate(source));db.initialize()
        attachmentRoot=Files.createTempDirectory("bnoc-meeting-contract")
        workflow=WorkflowService(db,TransactionTemplate(DataSourceTransactionManager(source)),attachmentRoot.toString())
        requester=db.actor("requester")!!;team=db.actor("team-wireless")!!
    }

    @AfterEach fun cleanup() {
        if(::attachmentRoot.isInitialized && Files.exists(attachmentRoot))
            Files.walk(attachmentRoot).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists) }
    }

    private fun command(actor:Actor,type:String,payload:Map<String,Any?>)=workflow.execute(actor,Command(type,UUID.randomUUID().toString(),payload=payload))
    private fun attachment():String {
        val id=UUID.randomUUID().toString();val stored="$id.bin";val bytes="synthetic meeting attachment".toByteArray()
        Files.write(attachmentRoot.resolve(stored),bytes)
        db.jdbc.update("INSERT INTO bnoc_attachments(attachment_ref,owner_subject,resource_kind,resource_ref,file_name,content_type,byte_size,stored_name,uploaded_at,was_linked,current_link) VALUES (?,?,?,?,?,?,?,?,?,?,?)",id,requester.id,"request",null,"support-form-fixture.txt","text/plain",bytes.size,stored,Instant.now().toString(),false,false)
        return id
    }
    private fun meeting(meetingType:String,attachments:List<String> = emptyList(),videoPlatform:String?=null):Map<String,Any?> = mapOf(
        "category" to "회의 지원",
        "subcategories" to mapOf("meetingType" to meetingType)+(videoPlatform?.let { mapOf("videoPlatform" to it) } ?: emptyMap()),
        "detail" to "회의 지원 요청","location" to "회의실","contact" to "1234","attachments" to attachments
    )

    @Test fun `general and video meeting requests require an attached support form`() {
        for(payload in listOf(meeting("일반회의"),meeting("화상회의",videoPlatform="KJCCS"))) {
            val error=assertThrows(BusinessFailure::class.java) { command(requester,"createRequest",payload) }
            assertEquals("VALIDATION",error.code)
            assertEquals(0,db.requests().size)
        }
    }

    @Test fun `video meeting requires one approved platform and persists it with its form attachment`() {
        val file=attachment()
        val missingPlatform=assertThrows(BusinessFailure::class.java) { command(requester,"createRequest",meeting("화상회의",listOf(file))) }
        assertEquals("VALIDATION",missingPlatform.code)
        for(platform in listOf("Zoom")) {
            val error=assertThrows(BusinessFailure::class.java) { command(requester,"createRequest",meeting("화상회의",listOf(file),platform)) }
            assertEquals("VALIDATION",error.code)
        }
        val result=command(requester,"createRequest",meeting("화상회의",listOf(file),"KJCCS"))
        assertEquals("KJCCS",db.request(result.requestNumber!!)!!.subcategories["videoPlatform"])
        assertEquals(file,db.request(result.requestNumber)!!.attachments.single()["id"])
    }

    @Test fun `non video meeting cannot carry a video platform and other meeting types need no form`() {
        val invalid=assertThrows(BusinessFailure::class.java) { command(requester,"createRequest",meeting("일반회의",listOf(attachment()),"KJCCS")) }
        assertEquals("VALIDATION",invalid.code)
        val other=command(requester,"createRequest",meeting("기타"))
        assertEquals("기타",db.request(other.requestNumber!!)!!.subcategories["meetingType"])
    }

    @Test fun `editing an existing required meeting form cannot remove its last attachment`() {
        val file=attachment()
        val created=command(requester,"createRequest",meeting("일반회의",listOf(file)))
        val request=db.request(created.requestNumber!!)!!
        val error=assertThrows(BusinessFailure::class.java) {
            workflow.execute(requester,Command("updateRequest",UUID.randomUUID().toString(),request.number,expectedRevision=request.revision,payload=mapOf("attachments" to emptyList<String>())))
        }
        assertEquals("VALIDATION",error.code)
        assertEquals(listOf(file),db.request(request.number)!!.attachments.map { it["id"] })
    }

    @Test fun `after action meeting report keeps its existing attachment and video platform rules`() {
        val result=command(team,"createAfterActionReport",meeting("화상회의")+mapOf(
            "requesterRef" to db.actor("requester")!!.subjectRef,"completedConfirmed" to true,
            "actualStartedAt" to "2026-10-24T01:00:00Z","actualCompletedAt" to "2026-10-24T02:00:00Z",
            "reason" to "선조치 후 보고"
        ))
        assertEquals("완료",db.request(result.requestNumber!!)!!.status)
        assertTrue(db.request(result.requestNumber)!!.attachments.isEmpty())
        assertNull(db.request(result.requestNumber)!!.subcategories["videoPlatform"])
    }
    @Test fun `after action requires an active requester account and notifies its owner`() {
        val selected=db.actor("requester-secondary")!!
        val choices=QueryService(db,workflow).requesters(team)
        assertTrue(choices.any { it["requesterRef"]==selected.subjectRef })
        val result=command(team,"createAfterActionReport",meeting("일반회의")+mapOf(
            "requesterRef" to selected.subjectRef,"completedConfirmed" to true,
            "actualStartedAt" to "2026-10-24T01:00:00Z","actualCompletedAt" to "2026-10-24T02:00:00Z","reason" to "선조치 후 보고"
        ))
        val saved=db.request(result.requestNumber!!)!!
        assertEquals(selected.id,saved.requesterSubject)
        val recipients=db.rows("SELECT recipient_subject FROM bnoc_notifications WHERE request_number=? AND event_name='선조치 후보고'",saved.number).map { it["recipient_subject"] }.toSet()
        assertTrue(selected.id in recipients)
        assertTrue(db.actors().filter { it.active&&it.role=="bnoc" }.all { it.id in recipients })
        assertFalse(requester.id in recipients)
        val textOnly=runCatching { command(team,"createAfterActionReport",meeting("일반회의")+mapOf("actualRequesterText" to requester.displayName,"completedConfirmed" to true,"actualStartedAt" to "2026-10-24T01:00:00Z","actualCompletedAt" to "2026-10-24T02:00:00Z","reason" to "선조치")) }.exceptionOrNull() as BusinessFailure
        assertEquals("VALIDATION",textOnly.code)
        assertEquals(1,db.requests().count { it.registeredBy==team.id })
    }
}
