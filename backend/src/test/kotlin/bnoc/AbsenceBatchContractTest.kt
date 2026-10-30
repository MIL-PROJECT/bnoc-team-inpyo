package bnoc

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.jdbc.datasource.DriverManagerDataSource
import org.springframework.jdbc.datasource.DataSourceTransactionManager
import org.springframework.transaction.support.TransactionTemplate
import java.util.UUID

class AbsenceBatchContractTest {
    lateinit var db:Database
    lateinit var workflow:WorkflowService
    @BeforeEach fun setup() {
        val source=DriverManagerDataSource("jdbc:h2:mem:${UUID.randomUUID()};MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "")
        db=Database(JdbcTemplate(source));db.initialize()
        workflow=WorkflowService(db,TransactionTemplate(DataSourceTransactionManager(source)))
    }
    private fun command(type:String,payload:Map<String,Any?>,revision:Long?=null,id:String=UUID.randomUUID().toString())=Command(type,id,null,null,revision,payload)
    private fun directoryRevision()=(workflow.operations.listCentralRoster(db.actor("bnoc")!!,null)["revision"] as Number).toLong()
    private fun person(name:String="담당인원",active:Boolean=true,department:String="무선반",number:String="100001"):String = workflow.execute(db.actor("bnoc")!!,command("saveCentralPerson",mapOf("department" to department,"category" to "병","rank" to "상병","displayName" to name,"serviceNumber" to number,"internalPhone" to "1234","active" to active),directoryRevision())).publicRef!!
    private fun batch(text:String,role:String="bnoc",id:String=UUID.randomUUID().toString())=workflow.execute(db.actor(role)!!,command("saveAbsenceBatch",mapOf("department" to "무선반","text" to text),directoryRevision(),id))
    private fun count()=db.jdbc.queryForObject("SELECT COUNT(*) FROM bnoc_absences",Int::class.java)
    @Test fun `batch matches exact personnel and writes both date formats with replay protection`() {
        val first=person();val second=person("추가인원",number="100002")
        val text="상병 담당인원 휴가 2026-10-01 2026-10-02\n상병 추가인원 교육 20261003 20261004"
        val id=UUID.randomUUID().toString();val result=batch(text,id=id)
        assertEquals(2,count(),"ABSENCE_BATCH_MUST_WRITE_EVERY_VALID_LINE")
        val replay=batch(text,id=id)
        assertTrue(replay.replayed);assertEquals(result.publicRef,replay.publicRef);assertEquals(2,count())
        val rows=db.rows("SELECT person_ref,absence_type,starts_on,ends_on FROM bnoc_absences ORDER BY starts_on")
        assertEquals(first,rows[0]["person_ref"]);assertEquals(second,rows[1]["person_ref"])
        assertEquals("2026-10-03",rows[1]["starts_on"])
        val summary=workflow.operations.personnelSummary(db.actor("bnoc")!!,"2026-10-03","무선반")
        assertEquals(1,summary["absent"])
    }
    @Test fun `invalid later line rejects entire batch without partial writes`() {
        person()
        val failure=assertThrows(BusinessFailure::class.java) { batch("상병 담당인원 휴가 20261001 20261002\n상병 없는인원 교육 20261003 20261004") }
        assertEquals("VALIDATION",failure.code);assertTrue(failure.fields?.get("text")?.contains("2줄") == true)
        assertEquals(0,count(),"ABSENCE_BATCH_MUST_NOT_PARTIALLY_SAVE")
    }
    @Test fun `ambiguous inactive and foreign department personnel are rejected`() {
        person();person(number="100002")
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { batch("상병 담당인원 휴가 20261001 20261002") }.code)
        person("비활성인원",false,number="100003")
        person("다른부서",department="전장반(전산장비)",number="100004")
        listOf("비활성인원","다른부서").forEach { name -> assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { batch("상병 $name 휴가 20261001 20261002") }.code) }
        assertEquals(0,count())
    }
    @Test fun `malformed dates kinds count and overlapping periods reject atomically`() {
        person()
        listOf("상병 담당인원 휴가 20260230 20260301","상병 담당인원 휴가 20261002 20261001","상병 담당인원 미정 20261001 20261002","상병 담당인원 휴가 20261001 20261002 추가",List(101) { "상병 담당인원 휴가 20261001 20261002" }.joinToString("\n"),"상병 담당인원 휴가 20261001 20261002\n상병 담당인원 교육 20261002 20261003").forEach { text ->
            assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { batch(text) }.code);assertEquals(0,count())
        }
        batch("상병 담당인원 휴가 20261001 20261002")
        assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { batch("상병 담당인원 교육 20261002 20261003") }.code)
        assertEquals(1,count())
    }
    @Test fun `only bnoc may batch absence or replay a bnoc receipt`() {
        person();val id=UUID.randomUUID().toString();val text="상병 담당인원 휴가 20261001 20261002"
        listOf("team-wireless","requester","access-admin").forEach { role -> assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { batch(text,role) }.code) }
        batch(text,id=id)
        assertEquals("FORBIDDEN",assertThrows(BusinessFailure::class.java) { batch(text,"team-wireless",id) }.code)
        assertEquals(1,count())
    }
    @Test fun `notice supports bounded fonts sizes and italic without accepting arbitrary styles`() {
        val run=mapOf("text" to "공지 내용","font" to "serif","size" to 36,"italic" to true)
        fun save(value:Map<String,Any?>)=workflow.execute(db.actor("bnoc")!!,command("createDirective",mapOf("title" to "공지","body" to "공지 내용","bodyDocument" to mapOf("version" to 1,"blocks" to listOf(mapOf("type" to "paragraph","runs" to listOf(value)))),"attachmentRefs" to emptyList<String>())))
        val result=save(run)
        val stored=db.rows("SELECT body_document FROM bnoc_notices WHERE notice_ref=?",result.publicRef).single()["body_document"] as String
        assertTrue(stored.contains("serif"));assertTrue(stored.contains("36"));assertTrue(stored.contains("italic"))
        listOf(run+("font" to "url(evil)"),run+("size" to 49),run+("size" to 12.5),run+("italic" to "true"),run+("style" to "display:none")).forEach { value -> assertEquals("VALIDATION",assertThrows(BusinessFailure::class.java) { save(value) }.code) }
    }
}
