package bnoc

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.transaction.support.TransactionTemplate
import java.time.Instant
import java.util.UUID

class DocumentSearchContractTest {
    private lateinit var db:Database
    private lateinit var workflow:WorkflowService
    private lateinit var query:QueryService
    private lateinit var requester:Actor
    private lateinit var bnoc:Actor

    @BeforeEach fun setup() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE","sa","")
        db=Database(JdbcTemplate(source));db.initialize()
        workflow=WorkflowService(db,TransactionTemplate(DataSourceTransactionManager(source)))
        query=QueryService(db,workflow)
        requester=db.actor("requester")!!;bnoc=db.actor("bnoc")!!
    }

    private fun create(detail:String,location:String="사무실"):String = workflow.execute(requester,Command("createRequest",UUID.randomUUID().toString(),payload=mapOf(
        "category" to "장비/체계","subcategories" to mapOf("systemType" to "인터넷","resourceType" to "PC","workType" to "지원"),
        "detail" to detail,"location" to location,"contact" to "군내 1234","personalContact" to "010-0000-0000"
    ))).requestNumber!!

    private fun addAnalyzedAttachment(number:String,body:String?,metadata:List<Map<String,Any?>> = emptyList(),current:Boolean=true,status:String="ready",blocks:List<Map<String,Any?>>?=null):String {
        val id=UUID.randomUUID().toString();val stored="$id.bin";val bytes="original document".toByteArray()
        db.jdbc.update("INSERT INTO bnoc_attachments(attachment_ref,owner_subject,resource_kind,resource_ref,file_name,content_type,byte_size,stored_name,uploaded_at,was_linked,current_link) VALUES (?,?,?,?,?,?,?,?,?,?,?)",id,requester.id,"request",number,"support.pdf","application/pdf",bytes.size,stored,Instant.now().toString(),true,current)
        val extractedBlocks=blocks ?: body?.let { listOf(mapOf("id" to "b1","type" to "paragraph","text" to it)) }.orEmpty()
        db.jdbc.update("INSERT INTO bnoc_document_analysis(attachment_ref,source_hash,parser_version,generation,status,body_json,body_text,metadata_json,error_code,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",id,"a".repeat(64),DocumentTikaConfig.parserVersion,1,status,db.json.writeValueAsString(extractedBlocks),body,db.json.writeValueAsString(metadata),null,Instant.now().toString())
        return id
    }

    @Test fun `content and explicit metadata search are ORed with filters and use literal normalized substrings`() {
        val documentOnly=create("요청 내용을 찾을 수 없습니다.","회의실")
        addAnalyzedAttachment(documentOnly,"마이크 점검 결과")
        val metadataOnly=create("다른 요청", "사무실")
        addAnalyzedAttachment(metadataOnly,"다른 본문",listOf(mapOf("label" to "회의명","rawValue" to "정기회의 자료","evidence" to "회의명: 정기회의 자료")))
        val detailOnly=create("말 그대로 %_ 기호 입력")
        val requesterResults=query.list(requester,mapOf("q" to "마이크 점검"))
        assertEquals(listOf(documentOnly),requesterResults.map { it["requestNumber"] })
        val match=(requesterResults.single()["matches"] as List<*>).single() as Map<*,*>
        assertEquals("document",match["source"])
        assertEquals(0,match["blockIndex"])
        val metadataMatch=((query.list(requester,mapOf("q" to "정기회의" )).single()["matches"] as List<*>).single() as Map<*,*>)
        assertEquals(0,metadataMatch["metadataIndex"])
        assertEquals(detailOnly,query.list(requester,mapOf("q" to "%_" )).single()["requestNumber"])
        assertEquals(documentOnly,query.list(requester,mapOf("q" to "마이크","location" to "회의실" )).single()["requestNumber"])
        assertTrue((match["text"] as String).length<=160)
        assertEquals(0,query.list(requester,mapOf("q" to "마이크","location" to "사무실" )).size)
        assertFalse(query.documentSearchIncomplete(requester,mapOf("q" to "마이크","location" to "회의실")))
    }

    @Test fun `removed attachment and private phone values never become search matches`() {
        val number=create("요청 본문")
        addAnalyzedAttachment(number,"숨겨진 문서값",current=false)
        assertTrue(query.list(requester,mapOf("q" to "숨겨진 문서값")).isEmpty())
        assertFalse(query.documentSearchIncomplete(requester,mapOf("q" to "숨겨진 문서값")))
        assertTrue(query.list(requester,mapOf("q" to "9999")).isEmpty())
        assertTrue(query.list(bnoc,mapOf("q" to "9999")).isEmpty())
    }

    @Test fun `overlong query is rejected before matching`() {
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { query.list(requester,mapOf("q" to "x".repeat(201))) }.code)
        create("요청 본문")
        assertTrue(query.list(requester,mapOf("q" to " ".repeat(400)+"요청 본문"+" ".repeat(400))).isNotEmpty())
    }

    @Test fun `query text does not silently search the separate location filter`() {
        val number=create("요청 본문에는 해당 단어 없음", "마이크 위치")
        assertTrue(query.list(requester,mapOf("q" to "마이크")).isEmpty())
        assertEquals(number,query.list(requester,mapOf("location" to "마이크")).single()["requestNumber"])
    }

    @Test fun `document hit is shown before request text when both match`() {
        val number=create("마이크 점검 요청")
        val attachment=addAnalyzedAttachment(number,"마이크 점검 결과")

        val matches=query.list(requester,mapOf("q" to "마이크 점검")).single()["matches"] as List<*>

        assertEquals("document",(matches.first() as Map<*,*>)["source"])
        assertEquals(attachment,(matches.first() as Map<*,*>)["attachmentRef"])
    }

    @Test fun `document search returns the matching extracted block for direct viewing`() {
        val number=create("요청 본문에는 검색어 없음")
        addAnalyzedAttachment(number,"본문 요약",listOf(mapOf("label" to "회의명","rawValue" to "정기회의 자료","blockId" to "b2","evidence" to "회의명: 정기회의 자료")),blocks=listOf(
            mapOf("id" to "b1","type" to "paragraph","text" to "첫 문단"),
            mapOf("id" to "b2","type" to "paragraph","text" to "회의명: 정기회의 자료")
        ))

        val match=(query.list(requester,mapOf("q" to "정기회의")).single()["matches"] as List<*>).single() as Map<*,*>

        assertEquals("document",match["source"])
        assertEquals(1,match["blockIndex"])
        assertEquals(0,match["metadataIndex"])
    }

    @Test fun `document processing status identifies visible current attachments`() {
        val visible=create("분석 대기 문서")
        val pendingId=UUID.randomUUID().toString();val stored="$pendingId.bin"
        db.jdbc.update("INSERT INTO bnoc_attachments(attachment_ref,owner_subject,resource_kind,resource_ref,file_name,content_type,byte_size,stored_name,uploaded_at,was_linked,current_link) VALUES (?,?,?,?,?,?,?,?,?,?,?)",pendingId,requester.id,"request",visible,"대기 문서.pdf","application/pdf",0,stored,Instant.now().toString(),true,true)
        val removed=create("제거된 첨부")
        addAnalyzedAttachment(removed,"이전 첨부",current=false)

        val status=query.documentSearchStatus(requester,mapOf("q" to "문서"))

        assertEquals(1,status["total"])
        val item=(status["items"] as List<*>).single() as Map<*,*>
        assertEquals(visible,item["requestNumber"])
        assertEquals(pendingId,item["attachmentRef"])
        assertEquals("대기 문서.pdf",item["fileName"])
        assertEquals("pending",item["status"])
    }

    @Test fun `partial document remains searchable but warns that only extracted text was searched`() {
        val number=create("요청 본문에는 해당 단어 없음")
        val attachment=addAnalyzedAttachment(number,"추출된 일부 본문",current=true,status="partial")

        assertTrue(query.list(requester,mapOf("q" to "추출된 일부")).single()["requestNumber"]==number)
        assertTrue(query.list(requester,mapOf("q" to "나머지 페이지의 단어")).isEmpty())
        assertTrue(query.documentSearchIncomplete(requester,mapOf("q" to "나머지 페이지의 단어")))
        val item=(query.documentSearchStatus(requester,mapOf("q" to "나머지 페이지의 단어"))["items"] as List<*>).single() as Map<*,*>
        assertEquals(attachment,item["attachmentRef"])
        assertEquals("partial",item["status"])
    }

    @Test fun `BNOC search does not expose maintenance target contact or private details`() {
        val number=workflow.execute(bnoc,Command("createRequest",UUID.randomUUID().toString(),payload=mapOf(
            "requesterRef" to requester.subjectRef,"category" to "장비/체계","subcategories" to mapOf("systemType" to "인터넷","resourceType" to "PC","workType" to "지원"),
            "detail" to "일반 요청 본문","location" to "작업 장소","contact" to "군내 1234",
            "maintenanceTarget" to mapOf("department" to "정비 부서","rank" to "상병","name" to "정비 대상자","phone" to "010-0000-0000")
        ))).requestNumber!!
        assertTrue(query.list(bnoc,mapOf("q" to "010-1234")).isEmpty())
        assertTrue(query.list(bnoc,mapOf("q" to "정비 대상자")).isEmpty())
        assertEquals(number,query.list(bnoc,mapOf("q" to "일반 요청 본문")).single()["requestNumber"])
    }
}
