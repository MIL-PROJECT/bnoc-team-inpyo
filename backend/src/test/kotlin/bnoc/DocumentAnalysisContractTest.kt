package bnoc

import org.apache.pdfbox.pdmodel.PDDocument
import org.apache.pdfbox.pdmodel.PDPage
import org.apache.pdfbox.pdmodel.PDPageContentStream
import org.apache.pdfbox.pdmodel.common.PDRectangle
import org.apache.pdfbox.pdmodel.font.PDType1Font
import org.apache.pdfbox.pdmodel.font.Standard14Fonts
import org.apache.pdfbox.pdmodel.graphics.image.LosslessFactory
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.transaction.support.TransactionTemplate
import java.io.ByteArrayOutputStream
import java.awt.Color
import java.awt.Font
import java.awt.image.BufferedImage
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.util.Comparator
import java.util.UUID

class DocumentAnalysisContractTest {
    private lateinit var db:Database
    private lateinit var query:QueryService
    private lateinit var workflow:WorkflowService
    private lateinit var documents:DocumentAnalysisService
    private lateinit var files:AttachmentService
    private lateinit var transaction:TransactionTemplate
    private lateinit var root:Path
    private lateinit var requester:Actor
    private lateinit var bnoc:Actor

    @BeforeEach fun setup() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE","sa","")
        db=Database(JdbcTemplate(source));db.initialize()
        transaction=TransactionTemplate(DataSourceTransactionManager(source))
        root=Files.createTempDirectory("bnoc-document-analysis")
        workflow=WorkflowService(db,transaction,root.toString());query=QueryService(db,workflow)
        documents=DocumentAnalysisService(db,query,workflow,transaction,root.toString())
        files=AttachmentService(db,query,transaction,root.toString())
        requester=db.actor("requester")!!;bnoc=db.actor("bnoc")!!
    }

    @AfterEach fun cleanup() {
        if(::root.isInitialized && Files.exists(root)) Files.walk(root).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists) }
    }

    private fun createRequest()=workflow.execute(requester,Command("createRequest",UUID.randomUUID().toString(),payload=mapOf(
        "category" to "장비/체계","subcategories" to mapOf("systemType" to "인트라넷","resourceType" to "PC","workType" to "지원"),"detail" to "지원 요청","location" to "회의실","contact" to "군내 1234"
    ))).requestNumber!!

    private fun hwpFixture():ByteArray {
        val source=Path.of("..","frontend","src","preview","fixtures","support.hwp").toAbsolutePath().normalize()
        return Files.readAllBytes(source)
    }

    private fun searchablePdf():ByteArray = ByteArrayOutputStream().use { output ->
        PDDocument().use { document ->
            val page=PDPage();document.addPage(page)
            PDPageContentStream(document,page).use { stream ->
                stream.beginText();stream.setFont(PDType1Font(Standard14Fonts.FontName.HELVETICA),12f);stream.newLineAtOffset(50f,700f);stream.showText("Microphone support request");stream.endText()
            }
            document.save(output)
        }
        output.toByteArray()
    }

    private fun scannedPdf():ByteArray = ByteArrayOutputStream().use { output ->
        val image=BufferedImage(1600,300,BufferedImage.TYPE_INT_RGB)
        val graphics=image.createGraphics()
        try {
            graphics.color=Color.WHITE;graphics.fillRect(0,0,image.width,image.height)
            graphics.color=Color.BLACK;graphics.font=Font(Font.SANS_SERIF,Font.BOLD,96)
            graphics.drawString("SCANNED REQUEST 7319",60,205)
        } finally { graphics.dispose() }
        PDDocument().use { document ->
            val page=PDPage(PDRectangle.LETTER);document.addPage(page)
            val pdfImage=LosslessFactory.createFromImage(document,image)
            PDPageContentStream(document,page).use { it.drawImage(pdfImage,0f,0f,page.mediaBox.width,page.mediaBox.height) }
            document.save(output)
        }
        output.toByteArray()
    }

    private fun attach(number:String,bytes:ByteArray,name:String="회의 지원.HWP",type:String="application/octet-stream"):String {
        val id=UUID.randomUUID().toString();val stored="$id.bin"
        Files.write(root.resolve(stored),bytes)
        db.jdbc.update("INSERT INTO bnoc_attachments(attachment_ref,owner_subject,resource_kind,resource_ref,file_name,content_type,byte_size,stored_name,uploaded_at,was_linked,current_link) VALUES (?,?,?,?,?,?,?,?,?,?,?)",id,requester.id,"request",number,name,type,bytes.size,stored,Instant.now().toString(),true,true)
        return id
    }

    private fun temporaryAttachment(bytes:ByteArray,name:String,type:String):String {
        val id=UUID.randomUUID().toString();val stored="$id.bin"
        Files.write(root.resolve(stored),bytes)
        db.jdbc.update("INSERT INTO bnoc_attachments(attachment_ref,owner_subject,resource_kind,resource_ref,file_name,content_type,byte_size,stored_name,uploaded_at,was_linked,current_link) VALUES (?,?,?,?,?,?,?,?,?,?,?)",id,requester.id,"request",null,name,type,bytes.size,stored,Instant.now().toString(),false,false)
        return id
    }

    private fun createMeetingWithAttachment(type:String,bytes:ByteArray,name:String,contentType:String):Pair<String,String> {
        val attachment=temporaryAttachment(bytes,name,contentType)
        val subcategories=mapOf("meetingType" to type)+(if(type=="화상회의") mapOf("videoPlatform" to "KJCCS") else emptyMap())
        val number=workflow.execute(requester,Command("createRequest",UUID.randomUUID().toString(),payload=mapOf(
            "category" to "회의 지원","subcategories" to subcategories,"detail" to "회의 지원 요청","location" to "회의실","contact" to "군내 1234","attachments" to listOf(attachment)
        ))).requestNumber!!
        return number to attachment
    }

    private fun createEquipmentWithAttachment(bytes:ByteArray,name:String,contentType:String):Pair<String,String> {
        val attachment=temporaryAttachment(bytes,name,contentType)
        val number=workflow.execute(requester,Command("createRequest",UUID.randomUUID().toString(),payload=mapOf(
            "category" to "장비/체계","subcategories" to mapOf("systemType" to "인트라넷","resourceType" to "PC","workType" to "지원"),"detail" to "장비 지원 요청","location" to "사무실","contact" to "군내 1234","attachments" to listOf(attachment)
        ))).requestNumber!!
        return number to attachment
    }

    @Test fun `linked HWP is analyzed asynchronously persisted searched and its original remains unchanged`() {
        val number=createRequest();val bytes=hwpFixture();val id=attach(number,bytes)
        documents.runQueue()

        val saved=db.rows("SELECT source_hash,parser_version,generation,status,body_text,metadata_json,error_code FROM bnoc_document_analysis WHERE attachment_ref=?",id).single()
        assertEquals(1,saved["generation"])
        assertEquals("ready",saved["status"],"analysis error=${saved["error_code"]}")
        assertTrue(saved["body_text"].toString().contains("마이크 점검"))
        assertEquals(64,(saved["source_hash"] as String).length)
        assertEquals(1,db.rows("SELECT * FROM bnoc_document_jobs WHERE attachment_ref=? AND status='done'",id).size)
        assertFalse(query.documentSearchIncomplete(requester,mapOf("q" to "마이크")))
        val search=query.list(requester,mapOf("q" to "마이크 점검")).single()
        assertEquals(number,search["requestNumber"])
        assertTrue((search["matches"] as List<*>).any { (it as Map<*,*>)["attachmentRef"]==id })
        val document=documents.document(requester,id,0,50)
        assertEquals("ready",document["status"])
        assertEquals("apache-tika",document["source"])
        assertFalse(document.containsKey("ocrAvailable"))
        assertTrue((document["blocks"] as List<*>).isNotEmpty())
        assertTrue((document["metadata"] as List<*>).isNotEmpty())
        assertArrayEquals(bytes,files.download(requester,id).second)
        assertThrows(BusinessFailure::class.java) { documents.reprocess(db.actor("team-wireless")!!,id) }
        assertEquals("CONFLICT",assertThrows(BusinessFailure::class.java) { documents.reprocess(requester,id) }.code)

        db.jdbc.update("UPDATE bnoc_document_analysis SET status='failed' WHERE attachment_ref=?",id)
        documents.reprocess(requester,id)
        assertEquals("pending",documents.document(requester,id,0,50)["status"])
        documents.runQueue()
        assertEquals(2,(db.rows("SELECT generation FROM bnoc_document_analysis WHERE attachment_ref=?",id).single()["generation"] as Number).toInt())
        assertEquals("ready",documents.document(requester,id,0,50)["status"],"analysis error=${db.rows("SELECT error_code FROM bnoc_document_analysis WHERE attachment_ref=?",id).single()["error_code"]}")
        assertArrayEquals(bytes,files.download(requester,id).second)

        db.jdbc.update("UPDATE bnoc_attachments SET current_link=FALSE WHERE attachment_ref=?",id)
        val historical=documents.document(requester,id,0,50)
        assertEquals("ready",historical["status"])
        assertEquals(false,historical["canRetry"])
        assertTrue(query.list(requester,mapOf("q" to "마이크 점검")).isEmpty())
        assertArrayEquals(bytes,files.download(requester,id).second)
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) { documents.document(db.actor("requester-secondary")!!,id,0,50) }.code)
    }

    @Test fun `partial document response names the processed range`() {
        val id=attach(createRequest(),searchablePdf(),"요청서.pdf","application/pdf")
        documents.runQueue()
        db.jdbc.update("UPDATE bnoc_document_analysis SET status='partial',processed_range=? WHERE attachment_ref=?","분석 출력 한도 1,000,000자 도달",id)

        val document=documents.document(requester,id,0,50)

        assertEquals("partial",document["status"])
        assertEquals("분석 출력 한도 1,000,000자 도달",document["processedRange"])
    }

    @Test fun `other attachment formats keep originals without analysis search or retries even with existing rows and jobs`() {
        val number=createRequest()
        val imageBytes=byteArrayOf(1,2,3,4)
        val image=attach(number,imageBytes,"현장.png","image/png")
        val officeBytes="legacy document bytes".toByteArray()
        val office=attach(number,officeBytes,"기록.docx","application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        val now=Instant.now().toString()
        val blocks="[{\"id\":\"b1\",\"type\":\"paragraph\",\"text\":\"LEGACY SECRET CONTENT\"}]"
        val metadata="[{\"label\":\"제목\",\"rawValue\":\"LEGACY SECRET METADATA\"}]"
        db.jdbc.update("INSERT INTO bnoc_document_analysis(attachment_ref,source_hash,parser_version,generation,status,body_json,body_text,metadata_json,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",office,"a".repeat(64),DocumentTikaConfig.parserVersion,1,"ready",blocks,"LEGACY SECRET CONTENT",metadata,now)
        db.jdbc.update("INSERT INTO bnoc_document_jobs(attachment_ref,source_hash,parser_version,generation,status,lease_until,attempt_count,updated_at) VALUES (?,?,?,?,?,?,?,?)",office,"a".repeat(64),DocumentTikaConfig.parserVersion,1,"pending",null,0,now)
        documents.runQueue()

        assertEquals(0,db.rows("SELECT * FROM bnoc_document_analysis WHERE attachment_ref=?",image).size)
        assertEquals(0,db.rows("SELECT * FROM bnoc_document_analysis WHERE attachment_ref=?",office).size)
        assertEquals(0,db.rows("SELECT * FROM bnoc_document_jobs WHERE attachment_ref=?",office).size)
        for(ref in listOf(image,office)) {
            val result=documents.document(requester,ref,0,50)
            assertEquals("unsupported",result["status"])
            assertEquals(emptyList<Any>(),result["blocks"])
            assertEquals(emptyList<Any>(),result["metadata"])
            assertEquals(false,result["canRetry"])
            assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { documents.reprocess(requester,ref) }.code)
        }
        assertTrue(query.list(requester,mapOf("q" to "LEGACY SECRET CONTENT")).isEmpty())
        assertTrue(query.list(requester,mapOf("q" to "LEGACY SECRET METADATA")).isEmpty())
        assertEquals(0,query.documentSearchStatus(requester,emptyMap())["total"])
        assertArrayEquals(imageBytes,files.inline(requester,image).second)
        assertArrayEquals(officeBytes,files.download(requester,office).second)
    }

    @Test fun `processing range marks only actual page and parser output limits`() {
        assertNull(processedDocumentRange(true,50,999_999))
        assertEquals("PDF 1~50쪽",processedDocumentRange(true,51,999_999))
        assertNull(processedDocumentRange(false,51,999_999))
        assertEquals("분석 출력 한도 1,000,000자 도달",processedDocumentRange(false,0,1_000_000))
        assertEquals("분석 출력 한도 1,000,000자 도달",processedDocumentRange(true,51,1_000_000))
    }

    @Test fun `v13 processed range migration preserves existing analysis and source file`() {
        val number=createRequest();val bytes=hwpFixture();val id=attach(number,bytes)
        documents.runQueue()
        val original=db.rows("SELECT source_hash,parser_version,generation,status,body_text,metadata_json FROM bnoc_document_analysis WHERE attachment_ref=?",id).single()
        db.jdbc.execute("ALTER TABLE bnoc_document_analysis DROP COLUMN processed_range")
        db.jdbc.update("DELETE FROM bnoc_schema_migrations WHERE version=13")

        db.initialize()

        val migrated=db.rows("SELECT source_hash,parser_version,generation,status,body_text,metadata_json,processed_range FROM bnoc_document_analysis WHERE attachment_ref=?",id).single()
        listOf("source_hash","parser_version","generation","status","body_text","metadata_json").forEach { assertEquals(original[it],migrated[it],"V13_MUST_KEEP_$it") }
        assertNull(migrated["processed_range"])
        assertEquals(1,db.jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_schema_migrations WHERE version=13",Int::class.java))
        assertArrayEquals(bytes,files.download(requester,id).second)
    }

    @Test fun `expired processing lease is reclaimed after restart`() {
        val number=createRequest();val bytes=hwpFixture();val id=attach(number,bytes)
        val hash=java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val parser=DocumentTikaConfig.parserVersion;val expired=Instant.now().minusSeconds(10).toString()
        db.jdbc.update("INSERT INTO bnoc_document_analysis(attachment_ref,source_hash,parser_version,generation,status,metadata_json,updated_at) VALUES (?,?,?,?,?,?,?)",id,hash,parser,1,"processing","[]",expired)
        db.jdbc.update("INSERT INTO bnoc_document_jobs(attachment_ref,source_hash,parser_version,generation,status,lease_until,attempt_count,updated_at) VALUES (?,?,?,?,?,?,?,?)",id,hash,parser,1,"processing",expired,1,expired)

        documents.runQueue()

        assertEquals("ready",documents.document(requester,id,0,50)["status"],"analysis error=${db.rows("SELECT error_code FROM bnoc_document_analysis WHERE attachment_ref=?",id).single()["error_code"]}")
        val job=db.rows("SELECT status,attempt_count,lease_until FROM bnoc_document_jobs WHERE attachment_ref=?",id).single()
        assertEquals("done",job["status"])
        assertEquals(2,(job["attempt_count"] as Number).toInt())
        assertNull(job["lease_until"])
    }

    @Test fun `attachment removed before first queue scan still gets historical analysis`() {
        val number=createRequest();val bytes=hwpFixture();val id=attach(number,bytes)
        db.jdbc.update("UPDATE bnoc_attachments SET current_link=FALSE WHERE attachment_ref=?",id)

        documents.runQueue()

        assertEquals("ready",documents.document(requester,id,0,50)["status"])
        assertFalse(documents.document(requester,id,0,50)["canRetry"] as Boolean)
        assertTrue(query.list(requester,mapOf("q" to "마이크 점검")).isEmpty())
        assertFalse(query.documentSearchIncomplete(requester,mapOf("q" to "마이크")))
        assertArrayEquals(bytes,files.download(requester,id).second)
    }

    @Test fun `searchable PDF text is extracted and safe inline bytes remain unchanged`() {
        val number=createRequest();val bytes=searchablePdf();val id=attach(number,bytes,"support.pdf","application/pdf")
        documents.runQueue()

        val document=documents.document(requester,id,0,50)
        assertEquals("ready",document["status"])
        assertTrue(db.rows("SELECT body_text FROM bnoc_document_analysis WHERE attachment_ref=?",id).single()["body_text"].toString().contains("Microphone support request"))
        assertEquals(number,query.list(requester,mapOf("q" to "microphone")).single()["requestNumber"])
        assertArrayEquals(bytes,files.inline(requester,id).second)
        db.jdbc.update("UPDATE bnoc_attachments SET current_link=FALSE WHERE attachment_ref=?",id)
        assertArrayEquals(bytes,files.inline(requester,id).second)
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) { files.inline(db.actor("requester-secondary")!!,id) }.code)
    }

    @Test fun `scanned PDF stays viewable but is not OCRed or searchable`() {
        val number=createRequest();val bytes=scannedPdf();val id=attach(number,bytes,"scanned.pdf","application/pdf")

        documents.runQueue()

        val saved=db.rows("SELECT status,body_text FROM bnoc_document_analysis WHERE attachment_ref=?",id).single()
        assertEquals("no_text",saved["status"])
        assertEquals("",saved["body_text"])
        assertEquals("no_text",documents.document(requester,id,0,50)["status"])
        assertTrue(query.list(requester,mapOf("q" to "SCANNED REQUEST 7319")).isEmpty())
        assertArrayEquals(bytes,files.download(requester,id).second)
    }

    @Test fun `Tika config uses PDF text extraction without an OCR recognizer`() {
        val config=DocumentTikaConfig.create()
        try {
            val json=Files.readString(config).lowercase()
            assertTrue(json.contains("\"text\": \"extract\""))
            assertTrue(json.contains("\"text-recognizers\": []"))
            assertFalse(json.contains("tesseract"))
            assertFalse(json.contains("\"ocr\""))
        } finally { Files.deleteIfExists(config) }
    }

    @Test fun `legacy OCR analysis stays hidden until reprocessed by the current parser`() {
        val number=createRequest();val id=attach(number,searchablePdf(),"old-scan.pdf","application/pdf")
        val blocks=listOf(mapOf("id" to "old-ocr","type" to "paragraph","text" to "LEGACY OCR SECRET WORD"))
        db.jdbc.update("INSERT INTO bnoc_document_analysis(attachment_ref,source_hash,parser_version,generation,status,body_json,body_text,metadata_json,error_code,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",id,"a".repeat(64),"apache-tika-4.1.0-bnoc1",1,"ready",db.json.writeValueAsString(blocks),"LEGACY OCR SECRET WORD","[]",null,Instant.now().toString())

        val document=documents.document(requester,id,0,50)

        assertEquals("pending",document["status"])
        assertEquals(emptyList<Any>(),document["blocks"])
        assertEquals(emptyList<Any>(),document["metadata"])
        assertTrue(query.list(requester,mapOf("q" to "LEGACY OCR SECRET")).isEmpty())
        val pending=(query.documentSearchStatus(requester,mapOf("q" to "LEGACY OCR SECRET"))["items"] as List<*>).single() as Map<*,*>
        assertEquals("pending",pending["status"])
    }

    @Test fun `meeting support attachment is downloadable but never parsed searched previewed or reprocessed`() {
        val bytes=searchablePdf()
        val (number,id)=createMeetingWithAttachment("화상회의",bytes,"의뢰서.pdf","application/pdf")

        assertEquals(true,db.rows("SELECT content_analysis_excluded FROM bnoc_attachments WHERE attachment_ref=?",id).single()["content_analysis_excluded"],"MEETING_SUPPORT_ATTACHMENT_CONTENT_MUST_STAY_EXCLUDED")
        documents.runQueue()

        val result=documents.document(requester,id,0,50)
        assertEquals("excluded",result["status"])
        assertEquals(emptyList<Any>(),result["blocks"])
        assertEquals(emptyList<Any>(),result["metadata"])
        assertEquals(0,db.rows("SELECT * FROM bnoc_document_analysis WHERE attachment_ref=?",id).size)
        assertEquals(0,db.rows("SELECT * FROM bnoc_document_jobs WHERE attachment_ref=?",id).size)
        assertTrue(query.list(requester,mapOf("q" to "microphone")).isEmpty())
        assertFalse(query.documentSearchIncomplete(requester,mapOf("category" to "회의 지원")))
        assertArrayEquals(bytes,files.download(requester,id).second)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { files.inline(requester,id) }.code)
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { documents.reprocess(requester,id) }.code)
    }

    @Test fun `HWP render source is limited to authorized ordinary HWP attachments`() {
        val bytes=hwpFixture()
        val ordinary=attach(createRequest(),bytes,"ordinary.hwp")
        assertArrayEquals(bytes,files.renderSource(requester,ordinary).second)
        assertEquals("NOT_FOUND",assertThrows(BusinessFailure::class.java) { files.renderSource(db.actor("requester-secondary")!!,ordinary) }.code)

        val pdf=attach(createRequest(),searchablePdf(),"ordinary.pdf","application/pdf")
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { files.renderSource(requester,pdf) }.code)

        val (_,meeting)=createMeetingWithAttachment("일반회의",bytes,"meeting.hwp","application/octet-stream")
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { files.renderSource(requester,meeting) }.code)
        assertArrayEquals(bytes,files.download(requester,meeting).second)
    }

    @Test fun `ordinary equipment request attachments still enter document analysis`() {
        val bytes=searchablePdf()
        val (_,id)=createEquipmentWithAttachment(bytes,"장비지원.pdf","application/pdf")

        assertEquals(false,db.rows("SELECT content_analysis_excluded FROM bnoc_attachments WHERE attachment_ref=?",id).single()["content_analysis_excluded"])
        documents.runQueue()

        assertEquals("ready",documents.document(requester,id,0,50)["status"])
        assertTrue(db.rows("SELECT body_text FROM bnoc_document_analysis WHERE attachment_ref=?",id).single()["body_text"].toString().contains("Microphone support request"))
        assertArrayEquals(bytes,files.inline(requester,id).second)
    }

    @Test fun `v14 migration purges historic meeting document contents and jobs but preserves source bytes and regular analysis`() {
        val (meetingNumber,meetingId)=createMeetingWithAttachment("일반회의",searchablePdf(),"일반회의.pdf","application/pdf")
        val (regularNumber,regularId)=createMeetingWithAttachment("기타",hwpFixture(),"일반요청.hwp","application/octet-stream")
        val regularAnalysis=db.rows("SELECT * FROM bnoc_document_analysis WHERE attachment_ref=?",regularId)
        assertTrue(regularAnalysis.isEmpty())
        val meetingBytes=files.download(requester,meetingId).second
        val regularBytes=files.download(requester,regularId).second
        val now=Instant.now().toString()
        db.jdbc.update("UPDATE bnoc_attachments SET content_analysis_excluded=FALSE,current_link=FALSE WHERE attachment_ref=?",meetingId)
        db.jdbc.update("INSERT INTO bnoc_document_analysis(attachment_ref,source_hash,parser_version,generation,status,body_json,body_text,metadata_json,error_code,processed_range,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",meetingId,"a".repeat(64),"legacy",1,"ready","[]","SECURE MEETING FORM BODY","[{\"label\":\"장소\",\"rawValue\":\"보안장소\"}]",null,null,now)
        db.jdbc.update("INSERT INTO bnoc_document_jobs(attachment_ref,source_hash,parser_version,generation,status,lease_until,attempt_count,updated_at) VALUES (?,?,?,?,?,?,?,?)",meetingId,"a".repeat(64),"legacy",1,"pending",null,0,now)
        db.jdbc.update("INSERT INTO bnoc_document_analysis(attachment_ref,source_hash,parser_version,generation,status,body_json,body_text,metadata_json,error_code,processed_range,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",regularId,"b".repeat(64),"legacy",1,"ready","[]","ORDINARY REQUEST DOCUMENT","[]",null,null,now)
        db.jdbc.update("DELETE FROM bnoc_schema_migrations WHERE version=14")

        db.initialize()

        assertEquals(true,db.rows("SELECT content_analysis_excluded FROM bnoc_attachments WHERE attachment_ref=?",meetingId).single()["content_analysis_excluded"])
        assertEquals(0,db.rows("SELECT * FROM bnoc_document_analysis WHERE attachment_ref=?",meetingId).size)
        assertEquals(0,db.rows("SELECT * FROM bnoc_document_jobs WHERE attachment_ref=?",meetingId).size)
        assertEquals("ORDINARY REQUEST DOCUMENT",db.rows("SELECT body_text FROM bnoc_document_analysis WHERE attachment_ref=?",regularId).single()["body_text"])
        assertArrayEquals(meetingBytes,files.download(requester,meetingId).second)
        assertArrayEquals(regularBytes,files.download(requester,regularId).second)
        assertEquals(meetingNumber,db.request(meetingNumber)?.number)
        assertEquals(regularNumber,db.request(regularNumber)?.number)
    }
}
