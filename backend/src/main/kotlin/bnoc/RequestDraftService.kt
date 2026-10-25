package bnoc

import com.fasterxml.jackson.module.kotlin.readValue
import org.springframework.dao.PessimisticLockingFailureException
import org.springframework.transaction.support.TransactionTemplate
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID

class RequestDraftService(private val db:Database,private val transaction:TransactionTemplate,private val root:Path) {
    data class Reference(val id:String,val revision:Long)
    private val stringLimits=mapOf("requesterDisplayText" to 500,"requesterRef" to 128,"category" to 100,"systemType" to 100,"resourceType" to 100,"workType" to 100,"meetingType" to 100,"videoPlatform" to 100,"phoneType" to 100,"detail" to 10000,"location" to 200,"contact" to 50,"personalContact" to 50,"equipmentId" to 200,"preference1Date" to 10,"preference1Period" to 2,"preference2Date" to 10,"preference2Period" to 2,"documentRef" to 500,"targetDepartment" to 100,"targetRank" to 100,"targetName" to 100,"targetPhone" to 50)
    private fun fresh(caller:Actor):Actor = db.actor(caller.id,true)?.takeIf { it.active && it.role in setOf("requester","bnoc") } ?: reject("FORBIDDEN")
    private fun row(actor:Actor,lock:Boolean=false)=db.rows("SELECT * FROM bnoc_request_drafts WHERE actor_subject=? AND role_name=?"+(if(lock) " FOR UPDATE" else ""),actor.id,actor.role).firstOrNull()
    private fun state(row:Map<String,Any?>?):Map<String,Any?> {
        val revision=(row?.get("revision") as? Number)?.toLong() ?: 0L
        val draft=if(row?.get("input_json")==null) null else mapOf("id" to row["draft_id"],"revision" to revision,"savedAt" to row["updated_at"],"input" to db.json.readValue<Map<String,Any?>>(row["input_json"] as String))
        return mapOf("draft" to draft,"revision" to revision)
    }
    private fun version(value:Any?):Long {
        val number=value as? Number ?: reject("VALIDATION")
        val revision=number.toLong()
        if(revision<0 || revision>9007199254740991L || number.toDouble()!=revision.toDouble()) reject("VALIDATION")
        return revision
    }
    private fun operation(value:Any?):String=(value as? String)?.takeIf { it.matches(Regex("[A-Za-z0-9_-]{8,128}")) } ?: reject("VALIDATION")
    private fun fingerprint(value:Any?):String {
        fun canonical(item:Any?):Any?=when(item) { is Map<*,*> -> item.entries.associate { it.key.toString() to canonical(it.value) }.toSortedMap();is List<*> -> item.map(::canonical);else -> item }
        return MessageDigest.getInstance("SHA-256").digest(db.json.writeValueAsBytes(canonical(value))).joinToString("") { "%02x".format(it) }
    }
    private fun <T> write(block:()->T):T {
        for(attempt in 0..2) try { return transaction.execute { block() }!! } catch(error:PessimisticLockingFailureException) { if(attempt==2) reject("SAVE_FAILED") }
        reject("SAVE_FAILED")
    }
    fun get(caller:Actor):Map<String,Any?> = write { val actor=fresh(caller);state(row(actor)) }
    private fun begin(caller:Actor,body:Map<String,Any?>,saving:Boolean):Triple<Actor,Map<String,Any?>?,String> {
        if(body.keys.any { it !in if(saving) setOf("role","expectedRevision","operationId","input") else setOf("role","expectedRevision","operationId") }) reject("VALIDATION")
        val actor=fresh(caller)
        if(body["role"]!=actor.role) reject("FORBIDDEN")
        db.lockResource("request-draft:${actor.id}:${actor.role}")
        return Triple(actor,row(actor,true),operation(body["operationId"]))
    }
    private fun checkWrite(row:Map<String,Any?>?,body:Map<String,Any?>,op:String,fp:String):Boolean {
        if(row?.get("last_operation_id")==op) {
            if(row["last_fingerprint"]!=fp) reject("DUPLICATE_ACTION")
            return false
        }
        if(version(body["expectedRevision"])!=((row?.get("revision") as? Number)?.toLong() ?: 0L)) reject("CONFLICT")
        return true
    }
    private fun input(raw:Any?):MutableMap<String,Any?> {
        val value=raw as? Map<*,*> ?: reject("VALIDATION")
        if(value.keys.any { it !in stringLimits.keys+setOf("differentTarget","attachments") } || db.json.writeValueAsBytes(value).size>65536) reject("VALIDATION")
        val result=linkedMapOf<String,Any?>()
        stringLimits.forEach { (key,max) ->
            val text=value[key] ?: ""
            if(text !is String || text.length>max || text.contains('\u0000')) reject("VALIDATION",mapOf(key to "임시저장 입력의 형식·길이를 확인하세요."))
            result[key]=text
        }
        val different=value["differentTarget"] ?: false
        if(different !is Boolean) reject("VALIDATION")
        result["differentTarget"]=different
        val attachments=value["attachments"] ?: emptyList<Any>()
        if(attachments !is List<*> || attachments.size>10) reject("VALIDATION")
        result["attachments"]=attachments
        return result
    }
    private fun attachmentIds(value:Any?):List<String> {
        val refs=(value as List<*>).map { item ->
            val entry=item as? Map<*,*> ?: reject("VALIDATION")
            if(entry.keys.any { it !in setOf("id","fileName","size","type") }) reject("VALIDATION")
            (entry["id"] as? String)?.takeIf { it.length<=36 && it.isNotBlank() } ?: reject("VALIDATION")
        }
        if(refs.distinct().size!=refs.size) reject("VALIDATION")
        return refs
    }
    fun save(caller:Actor,body:Map<String,Any?>):Map<String,Any?> = write {
        val (actor,old,op)=begin(caller,body,true)
        val value=input(body["input"]);val fp=fingerprint(mapOf("action" to "save","body" to body))
        if(!checkWrite(old,body,op,fp)) return@write state(old)
        val id=old?.get("draft_id") as? String ?: UUID.randomUUID().toString()
        val ids=attachmentIds(value["attachments"])
        var bytes=0L
        val metadata=ids.map { ref ->
            val file=db.rows("SELECT * FROM bnoc_attachments WHERE attachment_ref=? FOR UPDATE",ref).firstOrNull() ?: reject("VALIDATION",mapOf("attachments" to "첨부파일을 다시 업로드하세요."))
            if(file["owner_subject"]!=actor.id || file["resource_kind"]!="request" || file["resource_ref"]!=null || file["was_linked"]==true || (file["draft_ref"]!=null && file["draft_ref"]!=id)) reject("FORBIDDEN")
            if(file["draft_ref"]==null && Instant.parse(file["uploaded_at"] as String).isBefore(Instant.now().minusSeconds(86400))) reject("VALIDATION",mapOf("attachments" to "임시 첨부의 유효시간이 지났습니다. 다시 업로드하세요."))
            val path=root.resolve(file["stored_name"] as String).normalize()
            if(!path.startsWith(root) || !Files.isRegularFile(path)) reject("VALIDATION",mapOf("attachments" to "첨부파일을 다시 업로드하세요."))
            val size=(file["byte_size"] as Number).toLong();if(size !in 1..10L*1024*1024) reject("VALIDATION");bytes+=size
            mapOf("id" to ref,"fileName" to file["file_name"],"size" to size,"type" to file["content_type"])
        }
        if(bytes>50L*1024*1024) reject("VALIDATION",mapOf("attachments" to "첨부 합계는50MiB 이하여야 합니다."))
        value["attachments"]=metadata
        val at=Instant.now().toString();val revision=version(body["expectedRevision"])+1
        release(id,ids)
        ids.forEach { db.jdbc.update("UPDATE bnoc_attachments SET draft_ref=? WHERE attachment_ref=?",id,it) }
        if(old==null) db.jdbc.update("INSERT INTO bnoc_request_drafts(actor_subject,role_name,draft_id,input_json,revision,updated_at,last_operation_id,last_fingerprint) VALUES (?,?,?,?,?,?,?,?)",actor.id,actor.role,id,db.json.writeValueAsString(value),revision,at,op,fp)
        else db.jdbc.update("UPDATE bnoc_request_drafts SET draft_id=?,input_json=?,revision=?,updated_at=?,last_operation_id=?,last_fingerprint=? WHERE actor_subject=? AND role_name=?",id,db.json.writeValueAsString(value),revision,at,op,fp,actor.id,actor.role)
        state(row(actor))
    }
    private fun release(id:String,keep:List<String> = emptyList()) {
        db.rows("SELECT attachment_ref FROM bnoc_attachments WHERE draft_ref=? AND resource_ref IS NULL FOR UPDATE",id).forEach { file ->
            if(file["attachment_ref"] !in keep) db.jdbc.update("UPDATE bnoc_attachments SET draft_ref=NULL,uploaded_at=? WHERE attachment_ref=? AND draft_ref=? AND resource_ref IS NULL",Instant.now().toString(),file["attachment_ref"],id)
        }
    }
    fun delete(caller:Actor,body:Map<String,Any?>):Map<String,Any?> = write {
        val (actor,old,op)=begin(caller,body,false);val fp=fingerprint(mapOf("action" to "delete","body" to body))
        if(!checkWrite(old,body,op,fp)) return@write state(old)
        if(old==null || old["draft_id"]==null) reject("CONFLICT")
        release(old["draft_id"] as String)
        db.jdbc.update("UPDATE bnoc_request_drafts SET draft_id=NULL,input_json=NULL,revision=revision+1,updated_at=?,last_operation_id=?,last_fingerprint=? WHERE actor_subject=? AND role_name=?",Instant.now().toString(),op,fp,actor.id,actor.role)
        state(row(actor))
    }
    // Called only inside WorkflowService's existing write transaction, after receipt replay.
    fun lockReference(actor:Actor,value:Any?):Reference {
        val ref=value as? Map<*,*> ?: reject("VALIDATION")
        if(ref.keys!=setOf("id","revision")) reject("VALIDATION")
        val id=ref["id"] as? String ?: reject("VALIDATION")
        if(id.length!=36) reject("VALIDATION")
        val revision=version(ref["revision"])
        db.lockResource("request-draft:${actor.id}:${actor.role}")
        val stored=row(actor,true) ?: reject("CONFLICT")
        if(stored["draft_id"]!=id || (stored["revision"] as Number).toLong()!=revision || stored["input_json"]==null) reject("CONFLICT")
        return Reference(id,revision)
    }
    fun consume(actor:Actor,ref:Reference) {
        release(ref.id)
        val changed=db.jdbc.update("UPDATE bnoc_request_drafts SET draft_id=NULL,input_json=NULL,revision=revision+1,updated_at=?,last_operation_id=NULL,last_fingerprint=NULL WHERE actor_subject=? AND role_name=? AND draft_id=? AND revision=?",Instant.now().toString(),actor.id,actor.role,ref.id,ref.revision)
        if(changed!=1) reject("CONFLICT")
    }
}
