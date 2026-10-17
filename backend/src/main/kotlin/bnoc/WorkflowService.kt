package bnoc

import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import org.springframework.transaction.TransactionDefinition
import org.springframework.dao.PessimisticLockingFailureException
import org.springframework.beans.factory.annotation.Value
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

@Service
class WorkflowService(val db:Database,transaction:TransactionTemplate,@param:Value("\${bnoc.file-root:runtime/data/attachments}") fileRoot:String="runtime/data/attachments") {
    // Writes must see other committed changes after acquiring locks; query snapshots remain separate.
    private val writeTransaction=TransactionTemplate(checkNotNull(transaction.transactionManager),transaction).apply { isolationLevel=TransactionDefinition.ISOLATION_READ_COMMITTED }
    private val fileRoot=Path.of(fileRoot).toAbsolutePath().normalize()
    val operations=OperationsService(db)
    private val inflight=ConcurrentHashMap<String,String>()
    private fun now()=Instant.now().toString()
    private val createFields=setOf("category","subcategories","detail","location","contact","equipmentId","maintenanceTarget","scheduledAt","documentRef","attachments","requesterDisplayText")
    private val fields=mapOf(
        "createRequest" to createFields,"updateRequest" to setOf("detail","location","contact","scheduledAt","documentRef","attachments"),
        "cancelRequest" to emptySet(),"moveToDocumentWaiting" to emptySet(),"assignTeams" to setOf("teamIds","priority"),"changePriority" to setOf("priority"),
        "updateWork" to setOf("nextStatus","schedule","memo","returnReason","completionMemo","assignedPersonRefs","reusePreviousSchedule"),"returnWork" to setOf("returnReason","reason","schedule","memo"),
        "updateWorkDetails" to setOf("schedule","memo"),"reassignReturnedWork" to setOf("teamIds"),"reassignAssignedWork" to setOf("teamIds"),"addTeams" to setOf("teamIds"),"withdrawReturnedWork" to emptySet(),"markNotificationsSeen" to setOf("notificationIds"),
        "createAfterActionReport" to (createFields-setOf("requesterDisplayText","scheduledAt")+setOf("completedConfirmed","actualRequesterText","actualStartedAt","actualCompletedAt","reason","completionMemo"))
    )+OperationsService.fields
    fun visible(actor:Actor,request:RequestRecord):Boolean=actor.role=="bnoc" || (actor.role=="requester" && request.requesterSubject==actor.id) || (actor.role=="team" && db.works(request.number).any { it.teamId==actor.teamId })
    fun canEdit(actor:Actor,request:RequestRecord):Boolean {
        if(request.status=="취소") return false
        if(actor.role=="bnoc") return true
        if(actor.role!="requester" || request.requesterSubject!=actor.id) return false
        return db.works(request.number).filter { it.resolutionKind=="open" }.all { it.status=="배정" }
    }
    fun execute(caller:Actor,command:Command):CommandResult {
        val actor=current(caller)
        val allowed=fields[command.type] ?: reject("VALIDATION",mapOf("type" to "허용된 명령이 아닙니다."))
        if(command.payload.keys.any { it !in allowed }) reject("VALIDATION",mapOf("payload" to "허용되지 않은 입력입니다."))
        if(!command.operationId.matches(Regex("[A-Za-z0-9_-]{8,128}"))) reject("VALIDATION",mapOf("operationId" to "제출 식별값을 확인하세요."))
        val fp=fingerprint(command);val key="${actor.id}:${command.operationId}"
        val pending=inflight.putIfAbsent(key,fp)
        if(pending!=null) {
            authorizeBefore(actor,command)
            if(pending!=fp) reject("DUPLICATE_ACTION")
            reject("PROCESSING")
        }
        try {
            for(attempt in 0..2) {
                try { return writeTransaction.execute { process(actor,command,fp) }!! }
                catch(error:PessimisticLockingFailureException) { if(attempt==2) reject("SAVE_FAILED") }
            }
            reject("SAVE_FAILED")
        } finally { inflight.remove(key,fp) }
    }
    private fun current(caller:Actor):Actor=db.actor(caller.id)?.takeIf { it.active } ?: reject("FORBIDDEN")
    private fun process(caller:Actor,command:Command,fp:String):CommandResult {
        val actor=current(caller)
        val creating=command.type in setOf("createRequest","createAfterActionReport","createDirective")
        val operational=command.type in OperationsService.fields
        val notificationCommand=command.type=="markNotificationsSeen"
        if(creating && (command.requestNumber!=null || command.workNumber!=null || command.expectedRevision!=null)) reject("VALIDATION")
        if(operational && (command.requestNumber!=null || command.workNumber!=null)) reject("VALIDATION")
        if(notificationCommand && (command.requestNumber!=null || command.workNumber!=null || command.expectedRevision!=null)) reject("VALIDATION")
        if(!creating && !operational && !notificationCommand && command.requestNumber==null && command.workNumber==null) reject("VALIDATION")
        db.jdbc.update("INSERT INTO bnoc_operation_locks(actor_subject,operation_id) VALUES (?,?) ON DUPLICATE KEY UPDATE operation_id=VALUES(operation_id)",actor.id,command.operationId)
        db.jdbc.queryForObject("SELECT operation_id FROM bnoc_operation_locks WHERE actor_subject=? AND operation_id=? FOR UPDATE",String::class.java,actor.id,command.operationId)
        var work=command.workNumber?.let { db.work(it) ?: reject("NOT_FOUND") }
        val number=command.requestNumber ?: work?.requestNumber
        if(command.requestNumber!=null && work!=null && work.requestNumber!=command.requestNumber) reject("NOT_FOUND")
        val request=number?.let { db.request(it,true) ?: reject("NOT_FOUND") }
        if(work!=null) work=db.work(work.number,true) ?: reject("NOT_FOUND")
        val fresh=db.actor(actor.id,true)?.takeIf { it.active } ?: reject("FORBIDDEN")
        if(operational) operations.authorize(fresh,command) else if(!notificationCommand) authorize(fresh,command.type,request,work)
        val receipt=db.rows("SELECT fingerprint,result_json FROM bnoc_receipts WHERE actor_subject=? AND operation_id=?",fresh.id,command.operationId).firstOrNull()
        if(receipt!=null) {
            if(receipt["fingerprint"]!=fp) reject("DUPLICATE_ACTION")
            return db.json.readValue(receipt["result_json"] as String,CommandResult::class.java).copy(replayed=true)
        }
        if(!creating && !operational && !notificationCommand) {
            val revision=if(command.type in setOf("updateWork","returnWork","updateWorkDetails","reassignReturnedWork","reassignAssignedWork","withdrawReturnedWork")) work?.revision ?: reject("VALIDATION") else request!!.revision
            if(command.expectedRevision==null) reject("VALIDATION",mapOf("expectedRevision" to "버전이 필요합니다."))
            if(command.expectedRevision!=revision) reject("CONFLICT")
        }
        val result=if(operational) operations.execute(fresh,command,this) else if(notificationCommand) markNotificationsSeen(fresh,command) else {
            val resultNumber=when(command.type) {
                "createRequest" -> createRequest(fresh,command.payload)
                "createAfterActionReport" -> createAfterAction(fresh,command.payload)
                "updateRequest" -> { updateRequest(fresh,request!!,command.payload);request.number }
                "changePriority" -> { changePriority(fresh,request!!,command.payload);request.number }
                "cancelRequest" -> { if(request!!.status=="취소") reject("INVALID_STATE");changeRequest(fresh,request,"취소");request.number }
                "moveToDocumentWaiting" -> { if(request!!.status!="대기" || db.works(request.number).isNotEmpty()) reject("INVALID_STATE");changeRequest(fresh,request,"문서 대기");request.number }
                "assignTeams" -> { assign(fresh,request!!,command.payload);request.number }
                "addTeams" -> { addTeams(fresh,request!!,command.payload);request.number }
                "updateWork","returnWork","updateWorkDetails" -> { updateWork(fresh,request!!,work!!,command.payload,command.type);request.number }
                "reassignReturnedWork","reassignAssignedWork" -> { reassign(fresh,request!!,work!!,command.payload,command.type=="reassignAssignedWork");request.number }
                "withdrawReturnedWork" -> { withdrawReturnedWork(fresh,request!!,work!!);request.number }
                else -> reject("VALIDATION")
            }
            val saved=db.request(resultNumber)!!;val savedWork=command.workNumber?.let { db.work(it) }
            CommandResult(requestNumber=resultNumber,workNumber=savedWork?.number,revision=savedWork?.revision ?: saved.revision,state=savedWork?.status ?: saved.status,priority=saved.priority)
        }
        db.jdbc.update("INSERT INTO bnoc_receipts VALUES (?,?,?,?,?,?)",fresh.id,command.operationId,fp,result.requestNumber ?: result.publicRef,command.type,db.json.writeValueAsString(result))
        return result
    }
    private fun authorizeBefore(actor:Actor,command:Command) {
        if(command.type=="markNotificationsSeen") return
        if(command.type in OperationsService.fields) { operations.authorize(actor,command);return }
        val work=command.workNumber?.let { db.work(it) ?: reject("NOT_FOUND") }
        val request=(command.requestNumber ?: work?.requestNumber)?.let { db.request(it) ?: reject("NOT_FOUND") }
        authorize(actor,command.type,request,work)
    }
    fun receipt(caller:Actor,id:String):CommandResult {
        val actor=current(caller)
        if(!id.matches(Regex("[A-Za-z0-9_-]{8,128}"))) reject("VALIDATION")
        val row=db.rows("SELECT command_type,result_json FROM bnoc_receipts WHERE actor_subject=? AND operation_id=?",actor.id,id).firstOrNull()
        if(row==null) { if(inflight.containsKey("${actor.id}:$id")) reject("PROCESSING");reject("NOT_FOUND") }
        val result=db.json.readValue(row["result_json"] as String,CommandResult::class.java)
        val type=row["command_type"] as String
        if(type in OperationsService.fields) operations.authorizeReceipt(actor,type,result) else if(type!="markNotificationsSeen") {
            val request=result.requestNumber?.let { db.request(it) ?: reject("NOT_FOUND") }
            val work=result.workNumber?.let { db.work(it) }
            authorize(actor,type,request,work)
        }
        return result.copy(replayed=true)
    }
    private fun authorize(actor:Actor,type:String,request:RequestRecord?,work:WorkRecord?) {
        val permitted=when(type) {
            "createRequest" -> actor.role in listOf("requester","bnoc")
            "createAfterActionReport" -> actor.role=="team" && actor.teamId in db.teams
            "updateRequest" -> actor.role=="bnoc" || (actor.role=="requester" && request?.requesterSubject==actor.id)
            "cancelRequest" -> actor.role=="requester" && request?.requesterSubject==actor.id
            "assignTeams","addTeams","changePriority","moveToDocumentWaiting","reassignReturnedWork","reassignAssignedWork","withdrawReturnedWork" -> actor.role=="bnoc"
            "updateWork","returnWork","updateWorkDetails" -> actor.role=="team" && work?.teamId==actor.teamId
            else -> false
        }
        if(!permitted) { if(request!=null && !visible(actor,request)) reject("NOT_FOUND");reject("FORBIDDEN") }
    }
    private fun fingerprint(command:Command):String {
        fun canonical(value:Any?):Any?=when(value) { is Map<*,*> -> value.entries.associate { it.key.toString() to canonical(it.value) }.toSortedMap();is List<*> -> value.map { canonical(it) };else -> value }
        val bytes=db.json.writeValueAsBytes(canonical(mapOf("type" to command.type,"requestNumber" to command.requestNumber,"workNumber" to command.workNumber,"expectedRevision" to command.expectedRevision,"payload" to command.payload)))
        return MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
    fun history(actor:Actor,request:RequestRecord,work:WorkRecord?,field:String,before:Any?,after:Any?)=db.jdbc.update("INSERT INTO bnoc_history VALUES (?,?,?,?,?,?,?,?)",UUID.randomUUID().toString(),request.number,work?.number,actor.id,now(),field,before?.let { db.json.writeValueAsString(it) },after?.let { db.json.writeValueAsString(it) })
    fun notify(type:String,request:RequestRecord,works:List<WorkRecord> = emptyList()) {
        val recipients=when(type) {
            "요청 등록","작업 반환","반환 정정","선조치 후보고" -> db.actors().filter { it.active && it.role=="bnoc" }.map { it.id }
            "작업 배정","배정 변경" -> db.actors().filter { it.active && it.role=="team" && it.teamId in works.map { w -> w.teamId } }.map { it.id }
            else -> listOfNotNull(request.requesterSubject)
        }
        recipients.distinct().forEach { db.jdbc.update("INSERT INTO bnoc_notifications VALUES (?,?,?,?,?,?,?)",UUID.randomUUID().toString(),it,type,request.number,works.singleOrNull()?.number,now(),false) }
    }
    private fun validateRequest(payload:Map<String,Any?>) {
        text(payload,"detail",10000,true);text(payload,"location",200,true);text(payload,"contact",50,true)
        text(payload,"equipmentId",200);text(payload,"documentRef",500)
        val category=text(payload,"category",100,true)
        if(category !in listOf("장비/체계","회의 지원")) reject("VALIDATION",mapOf("category" to "요청 유형을 선택하세요."))
        val sub=payload["subcategories"] as? Map<*,*> ?: reject("VALIDATION",mapOf("subcategories" to "유형을 선택하세요."))
        val values=mapOf("systemType" to listOf("인트라넷","인터넷","AFCCS","KJCCS","기타"),"resourceType" to listOf("회선","전화","PC","컴퓨터","프린터","기타"),"workType" to listOf("신설","고장","지원","대여","이전","점검","기타"),"meetingType" to listOf("화상회의","일반회의","기타"),"phoneType" to listOf("IP","아날로그","인터컴","비상벨"))
        if(sub.keys.any { it !in values.keys } || sub.entries.any { (k,v) -> v !is String || v !in values[k].orEmpty() }) reject("VALIDATION",mapOf("subcategories" to "허용된 값을 선택하세요."))
        val required=if(category=="장비/체계") listOf("systemType","resourceType","workType") else listOf("meetingType")
        required.forEach { if(sub[it] !in values[it]!!) reject("VALIDATION",mapOf(it to "유형을 선택하세요.")) }
        val target=payload["maintenanceTarget"]
        if(target!=null) {
            if(target !is Map<*,*> || target.keys.any { it !in listOf("department","rank","name","phone") }) reject("VALIDATION",mapOf("maintenanceTarget" to "정비 대상자를 확인하세요."))
            @Suppress("UNCHECKED_CAST") val typed=target as Map<String,Any?>
            listOf("department","rank","name","phone").forEach { text(typed,it,if(it=="phone") 50 else 100,true) }
        }
    }
    @Suppress("UNCHECKED_CAST") private fun createRequest(actor:Actor,payload:Map<String,Any?>):String {
        validateRequest(payload)
        if(actor.role=="requester" && "requesterDisplayText" in payload) reject("VALIDATION")
        val requester=if(actor.role=="requester") actor.displayName else text(payload,"requesterDisplayText",500,true)
        val request=RequestRecord(db.nextNumber(),if(actor.role=="requester") actor.id else null,requester,actor.id,text(payload,"category",100),payload["subcategories"] as Map<String,String>,text(payload,"detail",10000),text(payload,"location",200),text(payload,"contact",50),text(payload,"equipmentId",200).ifBlank { null },payload["maintenanceTarget"] as? Map<String,String>,instantValue(text(payload,"scheduledAt",64),"scheduledAt"),text(payload,"documentRef",500).ifBlank { null },registeredAt=now())
        db.insertRequest(request);linkAttachments(actor,"request",request.number,payload["attachments"])
        history(actor,request,null,"등록",null,"대기");notify("요청 등록",request);return request.number
    }
    private fun changeRequest(actor:Actor,request:RequestRecord,status:String) {
        val before=request.status;request.status=status;request.revision++;request.updatedAt=now();db.saveRequest(request)
        history(actor,request,null,"상태",before,status);notify(status,request)
    }
    private fun changePriority(actor:Actor,request:RequestRecord,payload:Map<String,Any?>) {
        if(request.status=="취소") reject("INVALID_STATE")
        val priority=payload["priority"] as? String
        if(priority !in listOf("general","urgent")) reject("VALIDATION",mapOf("priority" to "일반 또는 긴급을 선택하세요."))
        if(priority!=request.priority) { val before=request.priority;request.priority=priority;request.revision++;request.updatedAt=now();db.saveRequest(request);history(actor,request,null,"일반·긴급",before,priority) }
    }
    private fun updateRequest(actor:Actor,request:RequestRecord,payload:Map<String,Any?>) {
        if(!canEdit(actor,request)) reject("INVALID_STATE")
        if(payload.isEmpty()) reject("VALIDATION")
        var changed=false
        payload.forEach { (field,_) ->
            if(field=="attachments") {
                val before=db.attachmentMetadata("request",request.number);val after=linkAttachments(actor,"request",request.number,payload[field])
                if(before.map { it["id"] }!=after.map { it["id"] }) { changed=true;history(actor,request,null,field,before,after) }
            } else {
                var next=text(payload,field,when(field) { "detail" ->10000;"location" ->200;"contact" ->50;"scheduledAt" ->64;else ->500 },field in listOf("detail","location","contact")).ifBlank { null }
                if(field=="scheduledAt") next=instantValue(next,"scheduledAt")
                val before=when(field) { "detail"->request.detail;"location"->request.location;"contact"->request.contact;"scheduledAt"->request.scheduledAt;"documentRef"->request.documentRef;else->null }
                if(before!=next) {
                    changed=true;history(actor,request,null,field,before,next)
                    when(field) { "detail"->request.detail=next!!;"location"->request.location=next!!;"contact"->request.contact=next!!;"scheduledAt"->request.scheduledAt=next;"documentRef"->request.documentRef=next }
                }
            }
        }
        if(changed) { request.revision++;request.updatedAt=now();db.saveRequest(request) }
    }
    private fun teamIds(payload:Map<String,Any?>,previous:String?=null):List<String> {
        val teams=stringRefs(payload["teamIds"],"teamIds")
        if(teams.isEmpty() || teams.any { it !in db.teams || it==previous }) reject("VALIDATION",mapOf("teamIds" to "작업반을 확인하세요."))
        return teams
    }
    private fun assign(actor:Actor,request:RequestRecord,payload:Map<String,Any?>) {
        if(request.status !in listOf("대기","문서 대기") || db.works(request.number).isNotEmpty()) reject("INVALID_STATE")
        val teams=teamIds(payload);val priority=payload["priority"] as? String
        if(priority !in listOf("general","urgent")) reject("VALIDATION",mapOf("priority" to "일반 또는 긴급을 선택하세요."))
        val at=now();history(actor,request,null,"일반·긴급",request.priority,priority);request.priority=priority;request.assignedAt=at
        val works=teams.mapIndexed { index,team -> WorkRecord("${request.number}-${index+1}",request.number,team,assignedAt=at) }
        works.forEach { db.insertWork(it);history(actor,request,it,"배정",null,it.teamId);history(actor,request,it,"배정 시각(접수 시간)",null,at) }
        changeRequest(actor,request,"배정");notify("작업 배정",request,works)
    }
    private fun recalculate(actor:Actor,request:RequestRecord,alreadyVersioned:Boolean=false) {
        val status=RequestStatus.derive(request,db.works(request.number))
        if(status!=request.status) { val before=request.status;request.status=status;if(!alreadyVersioned) request.revision++;request.updatedAt=now();db.saveRequest(request);history(actor,request,null,"상태",before,status);if(status in listOf("배정","작업 중","완료")) notify(status,request) }
    }
    private fun updateWork(actor:Actor,request:RequestRecord,work:WorkRecord,payload:Map<String,Any?>,type:String) {
        if(request.status=="취소" || work.resolutionKind!="open" || work.origin=="after-action") reject("INVALID_STATE")
        if(type=="updateWorkDetails" && (work.status !in listOf("배정","작업 중") || payload.isEmpty())) reject("INVALID_STATE")
        val nextStatus=if(type=="returnWork") "반환" else if(type=="updateWorkDetails") work.status else payload["nextStatus"] as? String
        if(nextStatus !in listOf("배정","작업 중","완료","반환")) reject("VALIDATION",mapOf("nextStatus" to "작업 상태를 선택하세요."))
        val returnReason=if("returnReason" in payload) text(payload,"returnReason",2000) else if("reason" in payload) text(payload,"reason",2000) else work.returnReason.orEmpty()
        if(nextStatus=="반환" && returnReason.isBlank()) reject("VALIDATION",mapOf("returnReason" to "반환 사유를 입력하세요."))
        val beforeStatus=work.status;val wasReturned=beforeStatus=="반환";val isReturning=nextStatus=="반환" && !wasReturned;var changed=false
        val completionMemo=if("completionMemo" in payload) text(payload,"completionMemo",2000) else work.completion?.get("memo").orEmpty()
        if(nextStatus!=work.status) {
            changed=true;history(actor,request,work,"상태",work.status,nextStatus);work.status=nextStatus!!
            val before=work.completion
            if(beforeStatus=="완료") work.completion=null
            if(nextStatus=="완료") work.completion=mapOf("completedBy" to actor.id,"completedAt" to now())+(if(completionMemo.isNotBlank()) mapOf("memo" to completionMemo) else emptyMap())
            if(before!=work.completion) history(actor,request,work,"완료정보",before,work.completion)
        } else if(nextStatus=="완료" && completionMemo!=work.completion?.get("memo").orEmpty()) {
            changed=true;history(actor,request,work,"완료 메모",work.completion?.get("memo"),completionMemo.ifBlank { null });work.completion=work.completion!!.filterKeys { it!="memo" }+(if(completionMemo.isNotBlank()) mapOf("memo" to completionMemo) else emptyMap())
        }
        val reason=if(nextStatus=="반환") returnReason else null
        if(reason!=work.returnReason) { changed=true;history(actor,request,work,"반환 사유",work.returnReason,reason);work.returnReason=reason }
        if(wasReturned && nextStatus!="반환") {
            val reuse=payload["reusePreviousSchedule"] as? Boolean ?: reject("VALIDATION",mapOf("reusePreviousSchedule" to "이전 일정 재사용 여부를 선택하세요."))
            val supplied=text(payload,"schedule",64)
            val chosen=if(reuse) {
                if(supplied.isNotBlank()) reject("VALIDATION",mapOf("schedule" to "이전 일정 재사용과 새 일정 입력은 함께 할 수 없습니다."))
                work.previousSchedule
            } else instantValue(supplied.ifBlank { null },"schedule")
            if(work.schedule!=chosen) { changed=true;history(actor,request,work,"schedule",work.schedule,chosen);work.schedule=chosen }
        }
        for(field in listOf("schedule","memo")) if(field in payload && !(field=="schedule" && (wasReturned || isReturning))) {
            var value=text(payload,field,if(field=="schedule") 64 else 2000).ifBlank { null }
            if(field=="schedule") value=instantValue(value,"schedule")
            val before=if(field=="schedule") work.schedule else work.memo
            if(before!=value) { changed=true;history(actor,request,work,field,before,value);if(field=="schedule") work.schedule=value else work.memo=value }
        }
        if(isReturning) {
            val previous=if("schedule" in payload) instantValue(text(payload,"schedule",64).ifBlank { null },"schedule") else work.schedule
            if(work.previousSchedule!=previous) { history(actor,request,work,"반환 전 일정",work.previousSchedule,previous);work.previousSchedule=previous;changed=true }
            if(work.schedule!=null) { history(actor,request,work,"schedule",work.schedule,null);work.schedule=null;changed=true }
        }
        if("assignedPersonRefs" in payload) {
            val refs=stringRefs(payload["assignedPersonRefs"],"assignedPersonRefs")
            operations.validateMembers(work.teamId,refs,work.assignedPersonRefs)
            if(refs!=work.assignedPersonRefs) { history(actor,request,work,"담당 인원",work.assignedPersonRefs,refs);work.assignedPersonRefs=refs;changed=true }
        }
        if(changed) {
            work.revision++;db.saveWork(work);recalculate(actor,request)
            if(beforeStatus!="반환" && nextStatus=="반환") notify("작업 반환",request,listOf(work)) else if(beforeStatus=="반환" && nextStatus!="반환") notify("반환 정정",request,listOf(work))
        }
    }
    private fun reassign(actor:Actor,request:RequestRecord,old:WorkRecord,payload:Map<String,Any?>,direct:Boolean=false) {
        val requiredStatus=if(direct) "배정" else "반환"
        if(request.status=="취소" || old.status!=requiredStatus || old.resolutionKind!="open" || old.origin=="after-action") reject("INVALID_STATE")
        val existing=db.works(request.number)
        val teams=teamIds(payload,old.teamId)
        val currentTeams=existing.filter { it.resolutionKind=="open" }.map { it.teamId }.toSet()
        if(teams.any { it in currentTeams }) reject("VALIDATION",mapOf("teamIds" to "이미 담당 중인 작업반으로 재배정할 수 없습니다."))
        val last=existing.maxOfOrNull { it.number.substringAfterLast('-').toIntOrNull() ?: 0 } ?: 0
        val at=now();val created=teams.mapIndexed { i,team -> WorkRecord("${request.number}-${last+i+1}",request.number,team,replaces=old.number,assignedAt=at) }
        old.resolvedBy=created.map { it.number };old.resolutionKind="reassigned";old.resolutionReason=if(direct) "사지센 직접 배정 변경" else "다른 작업반에 재배정";old.resolvedAt=at;old.resolvedByActor=actor.id;old.replacementWorkNumbers=created.map { it.number };old.revision++;db.saveWork(old)
        history(actor,request,old,if(direct) "배정 변경" else "재배정",old.teamId,teams)
        if(direct) notify("배정 변경",request,listOf(old))
        created.forEach { db.insertWork(it);history(actor,request,it,"배정",null,it.teamId);history(actor,request,it,"배정 시각(접수 시간)",null,at) }
        val beforeRevision=request.revision;recalculate(actor,request);if(request.revision==beforeRevision) { request.revision++;request.updatedAt=at;db.saveRequest(request) };notify("작업 배정",request,created)
    }
    private fun addTeams(actor:Actor,request:RequestRecord,payload:Map<String,Any?>) {
        val all=db.works(request.number);val summary=RequestStatus.summarize(request,all)
        if(summary.requestStatus in listOf("취소","완료") || request.priority !in listOf("general","urgent") || all.none { it.origin=="assigned" && it.assignedAt!=null } || all.any { it.origin=="after-action" }) reject("INVALID_STATE")
        val teams=teamIds(payload)
        if(teams.any { it in summary.departments }) reject("VALIDATION",mapOf("teamIds" to "이미 담당 중인 작업반을 선택했습니다."))
        val last=all.maxOfOrNull { it.number.substringAfterLast('-').toIntOrNull() ?: 0 } ?: 0
        val at=now();val created=teams.mapIndexed { i,team -> WorkRecord("${request.number}-${last+i+1}",request.number,team,assignedAt=at) }
        created.forEach { db.insertWork(it);history(actor,request,it,"배정",null,it.teamId);history(actor,request,it,"배정 시각(접수 시간)",null,at) }
        request.revision++;request.updatedAt=at;db.saveRequest(request);history(actor,request,null,"부서 추가",null,teams);notify("작업 배정",request,created)
        recalculate(actor,request,alreadyVersioned=true)
    }
    private fun withdrawReturnedWork(actor:Actor,request:RequestRecord,work:WorkRecord) {
        if(request.status=="취소" || work.status!="반환" || work.resolutionKind!="open" || work.origin=="after-action") reject("INVALID_STATE")
        val beforeRevision=request.revision;val at=now();work.resolutionKind="withdrawn";work.resolutionReason="해당 부서 작업 불필요";work.resolvedAt=at;work.resolvedByActor=actor.id;work.replacementWorkNumbers=emptyList();work.resolvedBy=emptyList();work.revision++
        db.saveWork(work);history(actor,request,work,"반환 배정 해제",null,work.resolutionReason);recalculate(actor,request)
        if(request.revision==beforeRevision) { request.revision++;request.updatedAt=at;db.saveRequest(request) }
    }
    private fun markNotificationsSeen(actor:Actor,command:Command):CommandResult {
        val raw=command.payload["notificationIds"] as? List<*> ?: reject("VALIDATION",mapOf("notificationIds" to "알림 항목을 확인하세요."))
        val ids=raw.map { it as? String ?: reject("VALIDATION") }.distinct()
        if(ids.isEmpty() || ids.size>100) reject("VALIDATION",mapOf("notificationIds" to "1~100개의 알림을 선택하세요."))
        val rows=ids.map { id -> db.rows("SELECT notification_id,request_number,recipient_subject FROM bnoc_notifications WHERE notification_id=? FOR UPDATE",id).firstOrNull() ?: reject("NOT_FOUND") }
        if(rows.any { it["recipient_subject"]!=actor.id || db.request(it["request_number"] as String)?.let { request -> visible(actor,request) }!=true }) reject("FORBIDDEN")
        ids.forEach { id -> db.jdbc.update("UPDATE bnoc_notifications SET is_read=TRUE WHERE notification_id=? AND recipient_subject=? AND is_read=FALSE",id,actor.id) }
        return CommandResult(revision=ids.size.toLong(),state="확인")
    }
    @Suppress("UNCHECKED_CAST") private fun createAfterAction(actor:Actor,payload:Map<String,Any?>):String {
        validateRequest(payload)
        val requester=text(payload,"actualRequesterText",500,true);val reason=text(payload,"reason",2000,true)
        if(payload["completedConfirmed"]!=true) reject("VALIDATION",mapOf("completedConfirmed" to "완료된 작업만 후보고할 수 있습니다."))
        val started=instantValue(text(payload,"actualStartedAt",64,true),"actualStartedAt")!!;val completed=instantValue(text(payload,"actualCompletedAt",64,true),"actualCompletedAt")!!
        if(Instant.parse(completed).isBefore(Instant.parse(started))) reject("VALIDATION",mapOf("actualCompletedAt" to "완료 시각을 확인하세요."))
        val memo=text(payload,"completionMemo",2000)
        val request=RequestRecord(db.nextNumber(),null,requester,actor.id,text(payload,"category",100),payload["subcategories"] as Map<String,String>,text(payload,"detail",10000),text(payload,"location",200),text(payload,"contact",50),text(payload,"equipmentId",200).ifBlank{null},payload["maintenanceTarget"] as? Map<String,String>,documentRef=text(payload,"documentRef",500).ifBlank{null},status="완료",registeredAt=now(),priority=null)
        db.insertRequest(request);linkAttachments(actor,"request",request.number,payload["attachments"])
        val work=WorkRecord("${request.number}-1",request.number,actor.teamId!!,status="완료",completion=mapOf("completedBy" to actor.id,"completedAt" to completed)+(if(memo.isNotBlank()) mapOf("memo" to memo) else emptyMap()),origin="after-action")
        db.insertWork(work);history(actor,request,null,"선조치 후보고",null,reason);history(actor,request,work,"실제 시작 시각",null,started);history(actor,request,work,"완료정보",null,work.completion);history(actor,request,work,"상태",null,"완료");notify("선조치 후보고",request,listOf(work));return request.number
    }
    fun linkAttachments(actor:Actor,kind:String,ref:String,value:Any?):List<Map<String,Any?>> {
        val list=(value ?: emptyList<Any>()) as? List<*> ?: reject("VALIDATION")
        if(list.size>10) reject("VALIDATION",mapOf("attachments" to "첨부는 최대 10개입니다."))
        val ids=list.map { item -> if(item is String) item else (item as? Map<*,*>)?.get("id") as? String ?: reject("VALIDATION") }
        if(ids.distinct().size!=ids.size) reject("VALIDATION")
        var bytes=0L
        ids.forEach { id ->
            val row=db.rows("SELECT * FROM bnoc_attachments WHERE attachment_ref=? FOR UPDATE",id).firstOrNull() ?: reject("VALIDATION",mapOf("attachments" to "첨부파일을 확인하세요."))
            val bound=row["resource_ref"] as? String
            if(row["resource_kind"]!=kind || (bound!=null && bound!=ref) || (bound==null && row["owner_subject"]!=actor.id)) reject("FORBIDDEN")
            if(bound==null && Instant.parse(row["uploaded_at"] as String).isBefore(Instant.now().minusSeconds(86400))) reject("VALIDATION",mapOf("attachments" to "임시 첨부의 유효시간이 지났습니다. 다시 업로드하세요."))
            val stored=fileRoot.resolve(row["stored_name"] as String).normalize()
            if(!stored.startsWith(fileRoot) || !Files.isRegularFile(stored)) reject("VALIDATION",mapOf("attachments" to "첨부파일을 다시 업로드하세요."))
            bytes+=(row["byte_size"] as Number).toLong()
        }
        if(bytes>50L*1024*1024) reject("VALIDATION",mapOf("attachments" to "첨부 합계는 50MiB 이하여야 합니다."))
        db.jdbc.update("UPDATE bnoc_attachments SET current_link=FALSE WHERE resource_kind=? AND resource_ref=?",kind,ref)
        ids.forEach { db.jdbc.update("UPDATE bnoc_attachments SET resource_ref=?,was_linked=TRUE,current_link=TRUE WHERE attachment_ref=?",ref,it) }
        return db.attachmentMetadata(kind,ref)
    }
}
