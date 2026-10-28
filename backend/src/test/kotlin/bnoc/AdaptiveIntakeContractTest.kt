package bnoc

import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.mock.web.MockMultipartFile
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.nio.file.Files
import java.util.Comparator
import java.util.UUID

class AdaptiveIntakeContractTest {
    private lateinit var db:Database
    private lateinit var workflow:WorkflowService
    private lateinit var query:QueryService
    private val root=Files.createTempDirectory("bnoc-adaptive-contract")
    private lateinit var actor:Actor
    @BeforeEach fun setup(){
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE","sa","")
        db=Database(JdbcTemplate(source));db.initialize();workflow=WorkflowService(db,TransactionTemplate(DataSourceTransactionManager(source)),root.toString());query=QueryService(db,workflow);actor=db.actor("requester")!!
    }
    @AfterEach fun cleanup(){Files.walk(root).use{paths->paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists)}}
    private fun item(system:String?="인트라넷",kind:String="회선",work:String="신설",quantity:Int=1,location:String="첫 위치")=linkedMapOf<String,Any?>("id" to UUID.randomUUID().toString(),"kind" to kind,"workType" to work,"quantity" to quantity,"location" to location,"detail" to "연결 지원","attachmentIds" to emptyList<String>()).apply{if(system!=null)put("systemType",system)}
    private fun payload(items:List<Map<String,Any?>> = listOf(item(),item("인터넷",location="두 번째 위치")),totals:Map<String,Int> = mapOf("회선" to 2))=mapOf<String,Any?>("category" to "장비/체계","intakeVersion" to 1,"itemQuantities" to totals,"requestItems" to items,"contact" to "000-0000","attachments" to emptyList<String>())
    private fun create(value:Map<String,Any?>)=workflow.execute(actor,Command("createRequest",UUID.randomUUID().toString(),payload=value))
    @Suppress("UNCHECKED_CAST") private fun items(number:String)=query.detail(actor,number)["requestItems"] as List<Map<String,Any?>>
    @Test fun `mixed networks persist all items with one request and no automatic work`() {
        val result=create(payload());val number=result.requestNumber!!
        assertEquals(2,items(number).size,"ALL_INTAKE_ITEMS_MUST_PERSIST")
        assertEquals(listOf("인트라넷","인터넷"),items(number).map{it["systemType"]})
        assertEquals(1,db.requests().size);assertTrue(db.works(number).isEmpty())
        db.initialize();assertEquals(2,items(number).size)
    }
    @Test fun `extra information draft choice persists as an optional boolean without changing formal payload`() {
        val row=item(null,"PC","고장").apply{put("answered",listOf("workType","location"));put("reviewed",false);put("splitSourceId",null);put("extraInformation",true)}
        val guided=mapOf("version" to 1,"mode" to "equipment","step" to "symptom","activeId" to row["id"],"items" to listOf(row),"quantities" to mapOf("PC" to 1),"order" to listOf("PC"),"history" to emptyList<Any>(),"returnTo" to "optional","meeting" to mapOf("meetingType" to "","videoPlatform" to "","detail" to "","location" to ""))
        assertEquals(guided,IntakePolicy.draft(guided,emptySet()),"EXTRA_INFORMATION_CHOICE_MUST_PERSIST")
        val legacy=guided+mapOf("items" to listOf(row-"extraInformation"),"returnTo" to null)
        assertEquals(legacy,IntakePolicy.draft(legacy,emptySet()),"LEGACY_DRAFT_WITHOUT_EXTRA_CHOICE_MUST_LOAD")
        assertThrows(BusinessFailure::class.java){IntakePolicy.draft(guided+mapOf("items" to listOf(row+mapOf("extraInformation" to "true"))),emptySet())}
    }
    @Test fun `intent first draft navigation preserves both branches and rejects unknown navigation values`() {
        val empty=mapOf<String,Any?>("version" to 1,"intent" to "","defaultWorkType" to "","mode" to "equipment","step" to "intent","activeId" to null,"items" to emptyList<Any>(),"quantities" to emptyMap<String,Int>(),"order" to emptyList<String>(),"history" to emptyList<Any>(),"returnTo" to null,"meeting" to mapOf("meetingType" to "","videoPlatform" to "","detail" to "","location" to "","attachmentIds" to emptyList<String>()))
        for(step in listOf("intent","supportKind","pick","meetingType")){
            val guided=empty+mapOf("step" to step,"intent" to "지원","defaultWorkType" to "이전","mode" to if(step=="meetingType")"meeting" else "equipment","history" to listOf(mapOf("step" to "intent","activeId" to null,"mode" to "equipment","returnTo" to null)))
            assertEquals(guided,IntakePolicy.draft(guided,emptySet()),"INTENT_DRAFT_PROGRESS_MUST_PERSIST")
        }
        for(field in listOf("intent","defaultWorkType")){
            val error=assertThrows(BusinessFailure::class.java){IntakePolicy.draft(empty+mapOf(field to "unknown-purpose"),emptySet())}
            assertEquals("VALIDATION",error.code,"UNKNOWN_INTENT_DRAFT_VALUE_MUST_BE_REJECTED")
        }
        assertEquals(empty-setOf("intent","defaultWorkType"),IntakePolicy.draft(empty-setOf("intent","defaultWorkType"),emptySet()),"LEGACY_DRAFT_MUST_STILL_LOAD")
    }
    @Test fun `unknown technical information and new equipment types may be submitted`() {
        for(kind in listOf("PC","프린터","전화","비상벨","CCTV","인터컴","기타")){
            val one=item(null,kind,"고장").apply{put("symptom","작동이 안 돼요")}
            val result=create(payload(listOf(one),mapOf(kind to 1)))
            assertEquals(kind,items(result.requestNumber!!).single()["kind"])
            assertNull(items(result.requestNumber).single()["systemType"])
        }
    }
    @Test fun `initial totals and positive integral quantities are enforced atomically`() {
        val mismatch=assertThrows(BusinessFailure::class.java){create(payload(totals=mapOf("회선" to 3)))}
        assertEquals("VALIDATION",mismatch.code,"INTAKE_QUANTITY_TOTAL_MUST_MATCH")
        for(quantity in listOf(0,-1,1.5)){
            val row=item().apply{put("quantity",quantity)}
            assertThrows(BusinessFailure::class.java){create(payload(listOf(row),mapOf("회선" to 1)))}
        }
        assertTrue(db.requests().isEmpty())
    }
    @Test fun `installation never stores hidden equipment model or fault fields`() {
        val row=item(null,"프린터").apply{put("equipmentId","OLD-PRIVATE-MODEL");put("symptom","OLD-SYMPTOM");put("errorCode","OLD-ERROR")}
        val result=create(payload(listOf(row),mapOf("프린터" to 1)));val saved=items(result.requestNumber!!).single()
        assertNull(saved["equipmentId"],"INSTALLATION_MUST_DROP_MODEL")
        assertNull(saved["symptom"]);assertNull(saved["errorCode"])
        assertFalse(query.detail(actor,result.requestNumber)["detail"].toString().contains("OLD-"))
    }
    @Test fun `ordinary updates preserve intake and explicit correction keeps version and owner guards`() {
        val number=create(payload()).requestNumber!!;val before=db.request(number)!!
        workflow.execute(actor,Command("updateRequest",UUID.randomUUID().toString(),number,expectedRevision=before.revision,payload=mapOf("contact" to "111-2222")))
        assertEquals(2,items(number).size)
        val foreign=db.actor("requester-secondary")!!
        assertThrows(BusinessFailure::class.java){workflow.execute(foreign,Command("updateRequest",UUID.randomUUID().toString(),number,expectedRevision=db.request(number)!!.revision,payload=payload()-setOf("category","contact","attachments")))}
        val corrected=items(number).mapIndexed{index,row->row+if(index==1)mapOf("location" to "정정 위치")else emptyMap()}
        workflow.execute(actor,Command("updateRequest",UUID.randomUUID().toString(),number,expectedRevision=db.request(number)!!.revision,payload=mapOf("intakeVersion" to 1,"itemQuantities" to mapOf("회선" to 2),"requestItems" to corrected)))
        assertEquals("정정 위치",items(number)[1]["location"])
    }
    @Test fun `second item location and classification are searchable without exposing foreign requests`() {
        val number=create(payload()).requestNumber!!
        assertEquals(number,query.list(actor,mapOf("q" to "두 번째 위치")).single()["requestNumber"])
        assertEquals(number,query.list(actor,mapOf("location" to "두 번째 위치")).single()["requestNumber"])
        assertTrue(query.list(db.actor("requester-secondary")!!,mapOf("q" to "두 번째 위치")).isEmpty())
    }
    @Test fun `unlinked item attachment references cannot be persisted`() {
        val row=item().apply{put("attachmentIds",listOf(UUID.randomUUID().toString()))}
        assertThrows(BusinessFailure::class.java){create(payload(listOf(row),mapOf("회선" to 1)))}
        assertTrue(db.requests().isEmpty())
    }
    @Test fun `removing an attachment prunes item references and summary fields remain derived`() {
        val files=AttachmentService(db,query,TransactionTemplate(DataSourceTransactionManager(db.jdbc.dataSource!!)),root.toString())
        val file=files.upload(actor,"request",MockMultipartFile("file","intake.txt","text/plain","intake bytes".toByteArray()))
        val row=item().apply{put("attachmentIds",listOf(file["id"]))}
        val number=create(payload(listOf(row),mapOf("회선" to 1))+mapOf("attachments" to listOf(file))).requestNumber!!
        workflow.execute(actor,Command("updateRequest",UUID.randomUUID().toString(),number,expectedRevision=db.request(number)!!.revision,payload=mapOf("attachments" to emptyList<String>(),"detail" to "WRONG-SUMMARY","location" to "WRONG-LOCATION")))
        assertEquals(emptyList<String>(),items(number).single()["attachmentIds"],"REMOVED_ATTACHMENTS_MUST_NOT_LEAVE_ITEM_REFERENCES")
        assertEquals("첫 위치",query.detail(actor,number)["location"],"INTAKE_SUMMARY_MUST_REMAIN_DERIVED")
        assertFalse(query.detail(actor,number)["detail"].toString().contains("WRONG"))
    }
    @Test fun `partial guided progress is an owner scoped draft and not a request`() {
        val guided=mapOf("version" to 1,"splitCount" to "3","mode" to "equipment","step" to "location","activeId" to "item-one","items" to listOf(mapOf("id" to "item-one","kind" to "프린터","quantity" to 2,"workType" to "고장","location" to "미완성 위치","systemType" to "","phoneType" to "","symptom" to "","detail" to "","equipmentId" to "","errorCode" to "","destination" to "","attachmentIds" to emptyList<String>(),"answered" to listOf("workType"),"reviewed" to false,"splitSourceId" to null)),"quantities" to mapOf("프린터" to 2),"order" to listOf("프린터"),"history" to listOf(mapOf("step" to "workType","activeId" to "item-one","mode" to "equipment","returnTo" to null)),"returnTo" to null,"meeting" to mapOf("meetingType" to "","videoPlatform" to "","detail" to "","location" to ""))
        val result=workflow.requestDrafts.save(actor,mapOf("role" to actor.role,"expectedRevision" to 0,"operationId" to UUID.randomUUID().toString(),"input" to mapOf("guidedDraft" to guided,"equipmentId" to "OUTER-OLD-MODEL")))
        assertTrue(db.requests().isEmpty());assertNotNull(result["draft"])
        assertNull(workflow.requestDrafts.get(db.actor("requester-secondary")!!)["draft"])
        @Suppress("UNCHECKED_CAST") val saved=(result["draft"] as Map<String,Any?>)["input"] as Map<String,Any?>
        assertEquals(guided,saved["guidedDraft"],"PARTIAL_GUIDED_DRAFT_MUST_PERSIST")
        assertEquals("",saved["equipmentId"],"GUIDED_DRAFT_MUST_NOT_STORE_UNUSED_ROOT_MODEL")
    }
}
