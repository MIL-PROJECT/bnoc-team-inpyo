package bnoc

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.mock.web.MockMultipartFile
import org.springframework.transaction.support.TransactionTemplate
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.util.UUID

class RequestDraftContractTest {
    @TempDir lateinit var root:Path
    private lateinit var db:Database
    private lateinit var tx:TransactionTemplate
    private lateinit var drafts:RequestDraftService
    private lateinit var workflow:WorkflowService
    private lateinit var files:AttachmentService
    private lateinit var owner:Actor
    private lateinit var other:Actor
    private lateinit var bnoc:Actor
    @BeforeEach fun setup() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE","sa","")
        db=Database(JdbcTemplate(source));db.initialize();tx=TransactionTemplate(DataSourceTransactionManager(source))
        workflow=WorkflowService(db,tx,root.toString());drafts=RequestDraftService(db,tx,root)
        files=AttachmentService(db,QueryService(db,workflow),tx,root.toString())
        owner=db.actor("requester")!!;other=db.actor("requester-secondary")!!;bnoc=db.actor("bnoc")!!
    }
    private fun input()=mapOf<String,Any?>("category" to "장비/체계","systemType" to "인터넷","detail" to "아직 작성 중", "location" to "", "preference2Date" to "2026-10-30","preference2Period" to "","differentTarget" to false,"targetName" to "입력 중")
    private fun save(actor:Actor=owner,revision:Long=0L,value:Map<String,Any?> = input(),operation:String=UUID.randomUUID().toString())=
        drafts.save(actor,mapOf("role" to actor.role,"expectedRevision" to revision,"operationId" to operation,"input" to value))
    private fun delete(actor:Actor=owner,revision:Long,operation:String=UUID.randomUUID().toString())=
        drafts.delete(actor,mapOf("role" to actor.role,"expectedRevision" to revision,"operationId" to operation))
    @Suppress("UNCHECKED_CAST") private fun draft(state:Map<String,Any?>):Map<String,Any?> { assertNotNull(state["draft"],"PARTIAL_DRAFT_MUST_PERSIST");return state["draft"] as Map<String,Any?> }
    @Suppress("UNCHECKED_CAST") private fun savedInput(state:Map<String,Any?>)=draft(state)["input"] as Map<String,Any?>
    private fun revision(state:Map<String,Any?>)=(state["revision"] as Number).toLong()
    private fun reference(state:Map<String,Any?>)=draft(state).filterKeys { it in setOf("id","revision") }
    private fun counts()=listOf("bnoc_requests","bnoc_works","bnoc_history","bnoc_notifications","bnoc_receipts","bnoc_document_analysis","bnoc_document_jobs").associateWith { db.jdbc.queryForObject("SELECT COUNT(*) FROM $it",Long::class.java) }
    private fun upload(actor:Actor=owner)=files.upload(actor,"request",MockMultipartFile("file","draft.txt","text/plain","draft bytes".toByteArray()))
    private fun payload()=mapOf<String,Any?>("category" to "장비/체계","subcategories" to mapOf("systemType" to "인터넷","resourceType" to "PC","workType" to "지원"),"detail" to "정식 신청","location" to "업무 위치","contact" to "000-0000")
    private fun create(value:Map<String,Any?>,operation:String=UUID.randomUUID().toString())=workflow.execute(owner,Command("createRequest",operation,payload=value))

    @Test fun partialDraftPersistsWithoutFormalSideEffects() {
        val before=counts();val sequence=db.rows("SELECT * FROM bnoc_sequences WHERE sequence_key='request'")
        val saved=save();assertEquals("아직 작성 중",savedInput(saved)["detail"])
        assertEquals("2026-10-30",savedInput(saved)["preference2Date"]);assertEquals("",savedInput(saved)["preference2Period"])
        assertEquals("입력 중",savedInput(saved)["targetName"]);assertEquals(1L,revision(saved))
        assertEquals(saved,RequestDraftService(db,tx,root).get(owner));assertEquals(before,counts(),"DRAFT_MUST_NOT_CREATE_BUSINESS_ROWS")
        assertEquals(sequence,db.rows("SELECT * FROM bnoc_sequences WHERE sequence_key='request'"),"DRAFT_MUST_NOT_ALLOCATE_REQUEST_NUMBER")
    }
    @Test fun currentAccountAndRoleOwnTheDraft() {
        val own=save();assertNull(drafts.get(other)["draft"],"OTHER_ACCOUNT_MUST_NOT_READ_DRAFT")
        assertNull(drafts.get(bnoc)["draft"])
        val delegated=save(bnoc,value=input()+mapOf("requesterRef" to owner.subjectRef))
        assertNotEquals(draft(own)["id"],draft(delegated)["id"])
        assertEquals(own,drafts.get(owner),"PROXY_REQUESTER_MUST_NOT_OWN_BNOC_DRAFT")
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java){drafts.get(db.actor("team-wireless")!!)}.code)
        db.jdbc.update("UPDATE bnoc_subjects SET role_name='bnoc' WHERE subject_id=?",owner.id)
        assertNull(drafts.get(owner)["draft"],"ROLE_CHANGE_MUST_NOT_REVEAL_OLD_ROLE_DRAFT")
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java){save()}.code)
        db.jdbc.update("UPDATE bnoc_subjects SET active=FALSE WHERE subject_id=?",owner.id)
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java){drafts.get(owner)}.code)
    }
    @Test fun staleWritesDeletionAndRecreationCannotOverwriteNewDraft() {
        val op=UUID.randomUUID().toString();val first=save(operation=op)
        assertEquals(first,save(operation=op),"SAVE_RETRY_MUST_NOT_INCREMENT_VERSION")
        assertEquals("DUPLICATE_ACTION",assertThrows(BusinessFailure::class.java){save(value=input()+mapOf("detail" to "다른 내용"),operation=op)}.code)
        val next=save(revision=revision(first),value=input()+mapOf("detail" to "새 저장본"))
        assertEquals("CONFLICT",assertThrows(BusinessFailure::class.java){delete(revision=revision(first))}.code)
        assertEquals("CONFLICT",assertThrows(BusinessFailure::class.java){create(payload()+mapOf("draftRef" to reference(first)))}.code)
        val gone=delete(revision=revision(next));assertNull(gone["draft"])
        val recreated=save(revision=revision(gone));assertNotEquals(draft(next)["id"],draft(recreated)["id"])
        assertEquals("CONFLICT",assertThrows(BusinessFailure::class.java){save(revision=revision(next))}.code)
        assertEquals(recreated,drafts.get(owner),"STALE_WRITE_MUST_NOT_DESTROY_NEW_DRAFT")
    }
    @Test fun draftAttachmentsSurviveCleanupAndRequireMatchingSubmission() {
        val file=upload();val id=file["id"] as String
        val saved=save(value=input()+mapOf("attachments" to listOf(file)))
        db.jdbc.update("UPDATE bnoc_attachments SET uploaded_at=? WHERE attachment_ref=?",Instant.now().minusSeconds(172800).toString(),id)
        files.cleanTemporary()
        assertEquals(1,db.rows("SELECT * FROM bnoc_attachments WHERE attachment_ref=?",id).size,"DRAFT_ATTACHMENT_MUST_SURVIVE_CLEANUP")
        val stored=db.rows("SELECT * FROM bnoc_attachments WHERE attachment_ref=?",id).single()
        assertTrue(Files.exists(root.resolve(stored["stored_name"] as String)))
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java){files.download(owner,id)}.code)
        assertThrows(BusinessFailure::class.java){create(payload()+mapOf("attachments" to listOf(mapOf("id" to id))))}
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java){save(other,value=input()+mapOf("attachments" to listOf(file)))}.code)
        val result=create(payload()+mapOf("attachments" to listOf(mapOf("id" to id)),"draftRef" to reference(saved)))
        assertNull(drafts.get(owner)["draft"]);assertNull(db.rows("SELECT draft_ref FROM bnoc_attachments WHERE attachment_ref=?",id).single()["draft_ref"])
        assertArrayEquals("draft bytes".toByteArray(),files.download(owner,id).second)
        assertEquals(id,db.request(result.requestNumber!!)!!.attachments.single()["id"])
    }
    @Test fun protectedFreshFileCannotBeBorrowedWithoutDraftReference() {
        val file=upload();save(value=input()+mapOf("attachments" to listOf(file)))
        assertThrows(BusinessFailure::class.java){create(payload()+mapOf("attachments" to listOf(file)))}
        assertTrue(db.requests().isEmpty(),"PROTECTED_FILE_MUST_NOT_BE_PUBLISHED_FROM_ANOTHER_FORM")
    }
    @Test fun invalidInputAndForeignAttachmentsDoNotReplaceSavedDraft() {
        val first=save();val file=upload(other)
        for(value in listOf(input()+mapOf("status" to "완료"),input()+mapOf("detail" to "x".repeat(10001)),input()+mapOf("differentTarget" to "yes")))
            assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java){save(revision=revision(first),value=value)}.code)
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java){save(revision=revision(first),value=input()+mapOf("attachments" to listOf(file)))}.code)
        assertEquals(first,drafts.get(owner))
    }
    @Test fun submissionFailureRollsBackDraftConsumptionAndReceiptReplayKeepsNewDraft() {
        val file=upload();val first=save(value=input()+mapOf("attachments" to listOf(file)))
        val op=UUID.randomUUID().toString();val value=payload()+mapOf("attachments" to listOf(file),"draftRef" to reference(first))
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java){create(value+mapOf("detail" to ""))}.code)
        assertEquals(first,drafts.get(owner))
        db.jdbc.execute("ALTER TABLE bnoc_notifications ADD CONSTRAINT block_draft_registration CHECK(event_name <> '요청 등록')")
        assertThrows(Exception::class.java){create(value,op)}
        assertEquals(first,drafts.get(owner),"REGISTRATION_FAILURE_MUST_KEEP_DRAFT")
        assertTrue(db.requests().isEmpty());assertTrue(db.rows("SELECT * FROM bnoc_receipts").isEmpty())
        assertEquals(draft(first)["id"],db.rows("SELECT draft_ref FROM bnoc_attachments WHERE attachment_ref=?",file["id"]).single()["draft_ref"])
        db.jdbc.execute("ALTER TABLE bnoc_notifications DROP CONSTRAINT block_draft_registration")
        val created=create(value,op);val empty=drafts.get(owner);assertNull(empty["draft"])
        val newer=save(revision=revision(empty),value=input()+mapOf("detail" to "다음 신청"))
        val replay=create(value,op);assertTrue(replay.replayed);assertEquals(created.requestNumber,replay.requestNumber)
        assertEquals(newer,drafts.get(owner),"OLD_RECEIPT_MUST_NOT_CONSUME_NEW_DRAFT");assertEquals(1,db.requests().size)
    }
    @Test fun deletionReleasesFilesWithFreshTemporaryGracePeriod() {
        val file=upload();val first=save(value=input()+mapOf("attachments" to listOf(file)))
        db.jdbc.update("UPDATE bnoc_attachments SET uploaded_at=? WHERE attachment_ref=?",Instant.now().minusSeconds(172800).toString(),file["id"])
        val gone=delete(revision=revision(first));assertNull(gone["draft"])
        files.cleanTemporary();val row=db.rows("SELECT * FROM bnoc_attachments WHERE attachment_ref=?",file["id"]).single()
        assertNull(row["draft_ref"]);assertTrue(Instant.parse(row["uploaded_at"] as String).isAfter(Instant.now().minusSeconds(60)))
    }
    @Test fun migrationFromVersion14PreservesExistingRequestsHistoryAndFiles() {
        val file=upload();val number=create(payload()+mapOf("attachments" to listOf(file))).requestNumber!!
        val before=db.request(number);val history=db.rows("SELECT * FROM bnoc_history ORDER BY history_id")
        val notifications=db.rows("SELECT * FROM bnoc_notifications ORDER BY notification_id")
        db.jdbc.execute("DROP TABLE bnoc_request_drafts")
        db.jdbc.execute("ALTER TABLE bnoc_attachments DROP COLUMN draft_ref")
        db.jdbc.update("DELETE FROM bnoc_schema_migrations WHERE version=15")
        db.initialize()
        assertEquals(before,db.request(number));assertEquals(history,db.rows("SELECT * FROM bnoc_history ORDER BY history_id"));assertEquals(notifications,db.rows("SELECT * FROM bnoc_notifications ORDER BY notification_id"))
        assertArrayEquals("draft bytes".toByteArray(),files.download(owner,file["id"] as String).second)
        assertEquals(1,db.jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_schema_migrations WHERE version=15",Int::class.java))
        assertNull(drafts.get(owner)["draft"])
    }
}
