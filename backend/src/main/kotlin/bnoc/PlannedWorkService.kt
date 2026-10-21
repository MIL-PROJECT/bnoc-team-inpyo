package bnoc

import org.springframework.stereotype.Service
import org.springframework.transaction.TransactionDefinition
import org.springframework.transaction.support.TransactionTemplate
import java.security.MessageDigest
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID

@Service
class PlannedWorkService(val db:Database,transaction:TransactionTemplate) {
    private val writeTransaction=TransactionTemplate(checkNotNull(transaction.transactionManager),transaction).apply { isolationLevel=TransactionDefinition.ISOLATION_READ_COMMITTED }
    private val seoul=ZoneId.of("Asia/Seoul")
    private fun today()=LocalDate.now(seoul)
    private fun now()=Instant.now().toString()
    private fun operationId(value:String):String {
        if(!value.matches(Regex("[A-Za-z0-9_-]{8,128}"))) reject("VALIDATION",mapOf("operationId" to "제출 식별값을 확인하세요."))
        return value
    }
    private fun title(value:String):String {
        val clean=value.trim()
        if(clean.isBlank() || clean.length>160) reject("VALIDATION",mapOf("title" to if(clean.isBlank()) "작업 제목을 입력하세요." else "작업 제목은 160자 이하여야 합니다."))
        if(clean.any { it.isISOControl() }) reject("VALIDATION",mapOf("title" to "제어 문자를 사용할 수 없습니다."))
        return clean
    }
    private fun date(value:String,field:String):LocalDate {
        if(!value.matches(Regex("\\d{4}-\\d{2}-\\d{2}"))) reject("VALIDATION",mapOf(field to "날짜를 확인하세요."))
        return runCatching { LocalDate.parse(value) }.getOrElse { reject("VALIDATION",mapOf(field to "날짜를 확인하세요.")) }
    }
    private fun current(caller:Actor):Actor=db.actor(caller.id)?.takeIf { it.active } ?: reject("FORBIDDEN")
    private fun team(caller:Actor):Actor {
        val actor=current(caller)
        if(actor.role!="team" || actor.teamId.isNullOrBlank()) reject("FORBIDDEN")
        return actor
    }
    private fun record(id:String,actor:Actor,lock:Boolean=false):PlannedWorkRecord {
        if(!id.matches(Regex("[0-9a-fA-F-]{36}"))) reject("NOT_FOUND")
        val work=db.plannedWork(id,lock) ?: reject("NOT_FOUND")
        if(work.teamId!=actor.teamId) reject("NOT_FOUND")
        return work
    }
    private fun fingerprint(action:String,workId:String?,revision:Long?,values:Map<String,Any?>):String = hash(db.json.writeValueAsString(listOf(action,workId,revision,values)))
    private fun operationHash(actor:Actor,id:String)=hash("${actor.id}:$id")
    private fun globalOperationHash(id:String)=hash(id)
    private fun hash(value:String)=MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    private fun viewMap(work:PlannedWorkRecord,replayed:Boolean=false):Map<String,Any?> = mapOf("id" to work.id,"plannedWorkId" to work.id,"teamId" to work.teamId,"department" to work.teamId,"title" to work.title,"status" to if(work.status=="in_progress") "진행 중" else "완료","firstWorkDate" to work.firstWorkDate,"completedDate" to work.completedDate,"revision" to work.revision,"updatedAt" to work.updatedAt,"replayed" to replayed)
    private fun completedDate(date:String?,first:String):LocalDate {
        val parsed=date?.let { date(it,"completedDate") } ?: reject("VALIDATION",mapOf("completedDate" to "완료일을 선택하세요."))
        if(parsed.isBefore(date(first,"firstWorkDate")) || parsed.isAfter(today())) reject("VALIDATION",mapOf("completedDate" to "완료일은 업무 기준일 이후, 오늘 이하로 선택하세요."))
        return parsed
    }
    private fun receipt(actor:Actor,id:String):Map<String,Any?>?=db.rows("SELECT r.fingerprint,r.result_json,w.team_id FROM bnoc_planned_operation_receipts r JOIN bnoc_planned_works w ON w.planned_work_id=r.planned_work_id WHERE r.actor_subject=? AND r.operation_id=? FOR UPDATE",actor.id,id).firstOrNull()
    private fun replayOrReject(actor:Actor,id:String,fp:String):Map<String,Any?>? {
        val row=receipt(actor,id) ?: return null
        if(row["team_id"]!=actor.teamId) reject("OPERATION_NOT_AVAILABLE")
        if(row["fingerprint"]!=fp) reject("DUPLICATE_ACTION")
        @Suppress("UNCHECKED_CAST")
        val result=db.json.readValue(row["result_json"] as String,Map::class.java) as Map<String,Any?>
        return result+mapOf("replayed" to true)
    }
    private fun beginOperation(actor:Actor,id:String,fp:String):Map<String,Any?>? {
        replayOrReject(actor,id,fp)?.let { return it }
        val key=operationHash(actor,id)
        val inserted=db.jdbc.update("INSERT IGNORE INTO bnoc_planned_operation_uses(key_hash) VALUES (?)",key)==1
        if(!inserted) return replayOrReject(actor,id,fp) ?: reject("DUPLICATE_ACTION")
        val globallyInserted=db.jdbc.update("INSERT IGNORE INTO bnoc_planned_operation_ids(key_hash) VALUES (?)",globalOperationHash(id))==1
        if(!globallyInserted) reject("OPERATION_NOT_AVAILABLE")
        return null
    }
    private fun finishOperation(actor:Actor,id:String,fp:String,work:PlannedWorkRecord,result:Map<String,Any?>) {
        db.jdbc.update("INSERT INTO bnoc_planned_operation_receipts(actor_subject,operation_id,fingerprint,planned_work_id,result_json) VALUES (?,?,?,?,?)",actor.id,id,fp,work.id,db.json.writeValueAsString(result))
    }

    fun list(caller:Actor,workDate:String):Map<String,Any?> {
        val actor=team(caller)
        val selected=date(workDate,"workDate").toString()
        val works=db.plannedWorks(actor.teamId!!)
        val progress=works.filter { it.status=="in_progress" && it.firstWorkDate<=selected }.map(::viewMap)
        val complete=works.filter { it.status=="completed" }.sortedWith(compareByDescending<PlannedWorkRecord> { it.completedDate }.thenByDescending { it.updatedAt }).map(::viewMap)
        return mapOf("workDate" to selected,"inProgress" to progress,"completed" to complete)
    }

    fun create(caller:Actor,rawTitle:String,rawDate:String,rawOperationId:String):Map<String,Any?> {
        val actor=team(caller);val cleanTitle=title(rawTitle);val firstDate=date(rawDate,"firstWorkDate").toString();val id=operationId(rawOperationId)
        val values=mapOf("title" to cleanTitle,"firstWorkDate" to firstDate)
        val fp=fingerprint("create",null,null,values)
        return writeTransaction.execute {
            val fresh=team(actor)
            beginOperation(fresh,id,fp)?.let { return@execute it }
            val at=now();val work=PlannedWorkRecord(UUID.randomUUID().toString(),fresh.teamId!!,cleanTitle,"in_progress",firstDate,null,1,at,at)
            db.jdbc.update("INSERT INTO bnoc_planned_works(planned_work_id,team_id,title,status,first_work_date,completed_date,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",work.id,work.teamId,work.title,work.status,work.firstWorkDate,null,work.revision,work.createdAt,work.updatedAt)
            val result=viewMap(work)
            finishOperation(fresh,id,fp,work,result)
            result
        }!!
    }

    fun update(caller:Actor,workId:String,rawRevision:Long?,rawTitle:String?,rawFirstDate:String?,rawOperationId:String):Map<String,Any?> {
        val actor=team(caller);val revision=rawRevision?.takeIf { it>0 } ?: reject("VALIDATION",mapOf("revision" to "버전이 필요합니다."));val id=operationId(rawOperationId)
        if(rawTitle==null && rawFirstDate==null) reject("VALIDATION")
        val cleanTitle=rawTitle?.let(::title);val firstDate=rawFirstDate?.let { date(it,"firstWorkDate").toString() }
        val values=linkedMapOf<String,Any?>();if(cleanTitle!=null) values["title"]=cleanTitle;if(firstDate!=null) values["firstWorkDate"]=firstDate
        val fp=fingerprint("update",workId,revision,values)
        return writeTransaction.execute {
            val fresh=team(actor)
            val work=record(workId,fresh,true)
            beginOperation(fresh,id,fp)?.let { return@execute it }
            if(work.revision!=revision) reject("CONFLICT")
            val nextTitle=cleanTitle ?: work.title;val nextDate=firstDate ?: work.firstWorkDate
            if(work.status=="completed" && nextDate>work.completedDate!!) reject("VALIDATION",mapOf("firstWorkDate" to "업무 기준일은 완료일보다 늦을 수 없습니다."))
            val at=now();val next=work.copy(title=nextTitle,firstWorkDate=nextDate,revision=work.revision+1,updatedAt=at)
            db.jdbc.update("UPDATE bnoc_planned_works SET title=?,first_work_date=?,revision=?,updated_at=? WHERE planned_work_id=? AND revision=?",next.title,next.firstWorkDate,next.revision,next.updatedAt,next.id,work.revision).also { if(it!=1) reject("CONFLICT") }
            val result=viewMap(next);finishOperation(fresh,id,fp,next,result);result
        }!!
    }

    fun complete(caller:Actor,workId:String,rawRevision:Long?,rawDate:String,rawOperationId:String):Map<String,Any?> {
        val actor=team(caller);val revision=rawRevision?.takeIf { it>0 } ?: reject("VALIDATION",mapOf("revision" to "버전이 필요합니다."));val id=operationId(rawOperationId)
        val completed=date(rawDate,"completedDate").also { if(it.isAfter(today())) reject("VALIDATION",mapOf("completedDate" to "완료일은 오늘 이하로 선택하세요.")) }.toString()
        val values=mapOf("completedDate" to completed)
        val fp=fingerprint("complete",workId,revision,values)
        return writeTransaction.execute {
            val fresh=team(actor);val work=record(workId,fresh,true)
            beginOperation(fresh,id,fp)?.let { return@execute it }
            if(work.revision!=revision) reject("CONFLICT")
            if(work.status!="in_progress") reject("INVALID_STATE")
            completedDate(completed,work.firstWorkDate)
            val at=now();val next=work.copy(status="completed",completedDate=completed,revision=work.revision+1,updatedAt=at)
            db.jdbc.update("UPDATE bnoc_planned_works SET status=?,completed_date=?,revision=?,updated_at=? WHERE planned_work_id=? AND revision=?",next.status,next.completedDate,next.revision,next.updatedAt,next.id,work.revision).also { if(it!=1) reject("CONFLICT") }
            val result=viewMap(next);finishOperation(fresh,id,fp,next,result);result
        }!!
    }

    fun delete(caller:Actor,workId:String,rawRevision:Long?):Map<String,Any?> {
        val actor=team(caller);val revision=rawRevision?.takeIf { it>0 } ?: reject("VALIDATION",mapOf("revision" to "If-Match 버전이 필요합니다."))
        return writeTransaction.execute {
            val fresh=team(actor);val work=record(workId,fresh,true)
            if(work.revision!=revision) reject("CONFLICT")
            db.jdbc.update("DELETE FROM bnoc_planned_operation_receipts WHERE planned_work_id=?",work.id)
            val removed=db.jdbc.update("DELETE FROM bnoc_planned_works WHERE planned_work_id=? AND revision=?",work.id,revision)
            if(removed!=1) reject("CONFLICT")
            mapOf("deleted" to true,"id" to work.id)
        }!!
    }
}
