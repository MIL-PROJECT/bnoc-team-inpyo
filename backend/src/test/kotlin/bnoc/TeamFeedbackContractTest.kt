package bnoc

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.mock.web.MockMultipartFile
import java.nio.file.Files
import java.nio.file.Path
import java.util.UUID

class TeamFeedbackContractTest {
    lateinit var db:Database
    lateinit var workflow:WorkflowService
    lateinit var query:QueryService
    lateinit var files:AttachmentService
    lateinit var documents:DocumentAnalysisService
    lateinit var root:Path
    @BeforeEach fun setup() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE","sa","")
        db=Database(JdbcTemplate(source));db.initialize()
        root=Files.createTempDirectory("bnoc-team-feedback-")
        val tx=TransactionTemplate(DataSourceTransactionManager(source))
        workflow=WorkflowService(db,tx,root.toString());query=QueryService(db,workflow);files=AttachmentService(db,query,tx,root.toString())
        documents=DocumentAnalysisService(db,query,workflow,tx,root.toString())
    }
    @AfterEach fun cleanup() { Files.walk(root).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach { Files.deleteIfExists(it) } } }
    fun actor(id:String)=db.actor(id)!!
    fun command(type:String,payload:Map<String,Any?> = emptyMap(),revision:Long?=null,number:String?=null,work:String?=null,id:String=UUID.randomUUID().toString())=Command(type,id,number,work,revision,payload)
    fun payload()=mapOf<String,Any?>("category" to "장비/체계","subcategories" to mapOf("systemType" to "인터넷","resourceType" to "PC","workType" to "고장"),"detail" to "지원 요청","location" to "신청 위치","contact" to "123-4567")
    fun create()=workflow.execute(actor("requester"),command("createRequest",payload())).requestNumber!!
    @Test fun `request number sorting ignores updated time and is numeric`() {
        for((number,updated) in listOf("9" to "2027-01-01T00:00:00Z","100" to "2026-01-01T00:00:00Z","10" to "2026-02-01T00:00:00Z"))
            db.insertRequest(RequestRecord(number,"requester","요청자","requester","장비/체계",emptyMap(),"내용","위치","1234",registeredAt="2026-01-01T00:00:00Z",updatedAt=updated))
        assertEquals(listOf("100","10","9"),query.list(actor("requester"),emptyMap()).map { it["requestNumber"] },"REQUEST_NUMBER_ORDER_MUST_IGNORE_UPDATES")
    }
    @Test fun `requester sees only current departments and their representative phone`() {
        val number=create()
        workflow.execute(actor("bnoc"),command("assignTeams",mapOf("teamIds" to listOf("무선반","유선반"),"priority" to "general"),db.request(number)!!.revision,number))
        val old=db.works(number).first { it.teamId=="무선반" }
        workflow.execute(actor("team-wireless"),command("returnWork",mapOf("returnReason" to "다른 부서 확인"),old.revision,number,old.number))
        val requester=query.detail(actor("requester"),number)
        assertEquals(listOf("유선반"),requester["teamIds"],"REQUESTER_RETURNED_DEPARTMENT_MUST_BE_HIDDEN")
        val works=requester["workItems"] as List<*>
        assertEquals(1,works.size,"REQUESTER_MUST_NOT_RECEIVE_RETURNED_WORK")
        assertEquals("000-1002",(works.single() as Map<*,*>)["departmentPhone"])
        assertEquals(2,(query.detail(actor("bnoc"),number)["workItems"] as List<*>).size)
        assertEquals(2,db.works(number).size)
        val current=db.works(number).first { it.teamId=="유선반" }
        for(status in listOf("배정","작업 중","완료")) {
            db.jdbc.update("UPDATE bnoc_works SET status=? WHERE work_number=?",status,current.number)
            val shown=(query.detail(actor("requester"),number)["workItems"] as List<*>).single() as Map<*,*>
            assertEquals(status,shown["status"]);assertEquals("000-1002",shown["departmentPhone"])
        }
        db.jdbc.update("UPDATE bnoc_works SET status='배정' WHERE work_number=?",current.number)
        workflow.execute(actor("bnoc"),command("reassignReturnedWork",mapOf("teamIds" to listOf("정체반")),db.work(old.number)!!.revision,number,old.number))
        assertEquals(setOf("유선반","정체반"),(query.detail(actor("requester"),number)["workItems"] as List<*>).map { (it as Map<*,*>)["teamId"] }.toSet())
        assertEquals(3,db.works(number).size,"OLD_WORK_HISTORY_MUST_BE_PRESERVED")
    }
    @Test fun `admin manages representative phones with revision replay and additive migration`() {
        val change=command("saveDepartmentContact",mapOf("department" to "무선반","phone" to "000-2345"),1)
        val saved=workflow.execute(actor("access-admin"),change)
        assertEquals(2L,saved.revision,"ADMIN_DEPARTMENT_CONTACT_SAVE_REQUIRED")
        assertTrue(workflow.execute(actor("access-admin"),change).replayed)
        assertEquals("CONFLICT",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("access-admin"),command("saveDepartmentContact",mapOf("department" to "무선반","phone" to "000-3456"),1)) }.code)
        db.initialize()
        val row=db.rows("SELECT phone,revision FROM bnoc_department_contacts WHERE department=?","무선반").single()
        assertEquals("000-2345",row["phone"]);assertEquals(2L,(row["revision"] as Number).toLong())
        for(id in listOf("requester","bnoc","team-wireless")) assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { workflow.execute(actor(id),command("saveDepartmentContact",mapOf("department" to "무선반","phone" to "000-9999"),2)) }.code)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("access-admin"),command("saveDepartmentContact",mapOf("department" to "무선반","phone" to "abc-123"),2)) }.code)
    }
    @Test fun `own never linked request attachment is previewable without analysis`() {
        val bytes="%PDF-1.4\npreview".toByteArray()
        val file=files.upload(actor("requester"),"request",MockMultipartFile("file","before.pdf","application/pdf",bytes))
        val ref=file["id"] as String
        assertArrayEquals(bytes,files.inline(actor("requester"),ref).second,"OWN_TEMP_ATTACHMENT_PREVIEW_REQUIRED")
        val doc=documents.document(actor("requester"),ref,0,50)
        assertEquals("temporary",doc["status"]);assertEquals(false,doc["canRetry"])
        assertTrue((doc["blocks"] as List<*>).isEmpty());assertEquals(0,db.rows("SELECT * FROM bnoc_document_analysis WHERE attachment_ref=?",ref).size)
        for(id in listOf("requester-secondary","bnoc","team-wireless","access-admin")) {
            assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) { files.inline(actor(id),ref) }.code,"TEMP_ATTACHMENT_OWNER_REQUIRED")
            assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) { documents.document(actor(id),ref,0,50) }.code)
        }
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) { documents.reprocess(actor("requester"),ref) }.code)
        db.jdbc.update("UPDATE bnoc_attachments SET was_linked=TRUE WHERE attachment_ref=?",ref)
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) { files.download(actor("requester"),ref) }.code,"TEMP_ATTACHMENT_MUST_NEVER_HAVE_BEEN_LINKED")
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) { documents.document(actor("requester"),ref,0,50) }.code)
        val notice=files.upload(actor("bnoc"),"notice",MockMultipartFile("file","notice.pdf","application/pdf",bytes))["id"] as String
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) { files.download(actor("bnoc"),notice) }.code)
    }
    @Test fun `HWPX original source allows owner and linked readers without server analysis`() {
        val bytes=java.io.ByteArrayOutputStream().use { output ->
            java.util.zip.ZipOutputStream(output).use { zip ->
                for((name,value) in mapOf("mimetype" to "application/hwp+zip","Contents/content.hpf" to "<package/>","Contents/section0.xml" to "<section/>")) {
                    zip.putNextEntry(java.util.zip.ZipEntry(name));zip.write(value.toByteArray());zip.closeEntry()
                }
            }
            output.toByteArray()
        }
        val file=files.upload(actor("requester"),"request",MockMultipartFile("file","source.hwpx","application/octet-stream",bytes))
        val ref=file["id"] as String
        assertArrayEquals(bytes,files.renderSource(actor("requester"),ref).second,"HWPX_ORIGINAL_BYTES_REQUIRED")
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) { files.renderSource(actor("requester-secondary"),ref) }.code)
        assertEquals("temporary",documents.document(actor("requester"),ref,0,50)["status"])
        workflow.execute(actor("requester"),command("createRequest",payload()+mapOf("attachments" to listOf(file))))
        assertArrayEquals(bytes,files.renderSource(actor("requester"),ref).second)
        assertEquals("unsupported",documents.document(actor("requester"),ref,0,50)["status"])
        assertEquals(0,db.rows("SELECT * FROM bnoc_document_analysis WHERE attachment_ref=?",ref).size)
    }
    @Test fun `phone values reject characters in request target personal and updates`() {
        for(value in listOf("군내 1234","123 4567","+82-1234567","123(45)","---","１２３４")) {
            assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("requester"),command("createRequest",payload()+mapOf("contact" to value))) }.code,"PHONE_ALLOWED_CHARACTERS_REQUIRED")
        }
        for(value in listOf("+82 10 1234 5678","010(1234)5678")) assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("requester"),command("createRequest",payload()+mapOf("personalContact" to value))) }.code)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("requester"),command("createRequest",payload()+mapOf("maintenanceTarget" to mapOf("department" to "부서","rank" to "계급","name" to "대상","phone" to "전화 1234")))) }.code)
        val number=create()
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("requester"),command("updateRequest",mapOf("contact" to "문자1234"),db.request(number)!!.revision,number)) }.code)
    }
    @Test fun `list reuse eligibility matches detail ownership without exposing account ids`() {
        val direct=create()
        val proxy=workflow.execute(actor("bnoc"),command("createRequest",payload()+mapOf("requesterRef" to actor("requester").subjectRef))).requestNumber!!
        val list=query.list(actor("requester"),emptyMap()).associateBy { it["requestNumber"] }
        assertEquals(true,list[direct]!!["canReuse"]);assertEquals(false,list[proxy]!!["canReuse"])
        assertEquals("지원 요청",list[direct]!!["detailPreview"]);assertEquals("신청 위치",list[direct]!!["location"])
        assertEquals("지원 요청",list[proxy]!!["detailPreview"]);assertEquals("신청 위치",list[proxy]!!["location"])
        assertFalse(list[direct]!!.containsKey("registeredBy"));assertFalse(list[direct]!!.containsKey("requesterSubject"))
        assertEquals(listOf(direct),query.list(actor("requester"),mapOf("reusableOnly" to "true")).map { it["requestNumber"] },"REUSE_FILTER_MUST_RUN_BEFORE_PAGING")
        assertEquals(2,query.list(actor("requester"),mapOf("reusableOnly" to "false")).size)
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { query.list(actor("bnoc"),mapOf("reusableOnly" to "true")) }.code)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { query.list(actor("requester"),mapOf("reusableOnly" to "yes")) }.code)
    }
    @Test fun `central personnel phone rejects characters but unchanged legacy phone remains editable`() {
        val person=mapOf<String,Any?>("department" to "무선반","category" to "간부","rank" to "하사","displayName" to "등록 인원","serviceNumber" to "roster-phone-fixture","internalPhone" to "군내1234","active" to true)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { workflow.execute(actor("bnoc"),command("saveCentralPerson",person,0)) }.code,"ROSTER_PHONE_ALLOWED_CHARACTERS_REQUIRED")
        val saved=workflow.execute(actor("bnoc"),command("saveCentralPerson",person+mapOf("internalPhone" to "123-4567"),0))
        db.jdbc.update("UPDATE bnoc_personnel_profiles SET internal_phone=? WHERE person_ref=?","군내1234",saved.publicRef)
        workflow.execute(actor("bnoc"),command("saveCentralPerson",person+mapOf("personRef" to saved.publicRef,"displayName" to "수정 인원"),saved.revision))
        assertEquals("군내1234",db.rows("SELECT internal_phone FROM bnoc_personnel_profiles WHERE person_ref=?",saved.publicRef).single()["internal_phone"])
    }
    @Test fun `unchanged legacy phone survives unrelated updates`() {
        val number=create()
        db.jdbc.update("UPDATE bnoc_requests SET contact=?,personal_contact=? WHERE request_number=?","군내 1234","+82 10 1234 5678",number)
        workflow.execute(actor("requester"),command("updateRequest",mapOf("detail" to "수정 내용","contact" to "군내 1234","personalContact" to "+82 10 1234 5678"),db.request(number)!!.revision,number))
        assertEquals("군내 1234",db.request(number)!!.contact);assertEquals("+82 10 1234 5678",db.request(number)!!.personalContact)
    }
}
