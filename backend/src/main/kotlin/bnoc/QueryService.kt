package bnoc

import com.fasterxml.jackson.module.kotlin.readValue
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import org.springframework.transaction.annotation.Isolation
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.text.Normalizer
import java.util.Locale

@Service
@Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
class QueryService(val db:Database,val workflow:WorkflowService) {
    private val seoul=ZoneId.of("Asia/Seoul")
    private val historyTime=DateTimeFormatter.ofPattern("uuuu. M. d. HH:mm").withZone(seoul)
    private val timeFields=setOf("scheduledAt","schedule","배정 시각(접수 시간)","실제 시작 시각","실제 완료 시각")
    private fun displayHistoryTime(value:Any?):String=if(value==null) "미정" else runCatching { historyTime.format(Instant.parse(value as String)) }.getOrDefault("시각 확인 불가")
    fun summary(r:RequestRecord,actor:Actor?=null):Map<String,Any?> {
        val allWorks=db.works(r.number)
        val progress=RequestStatus.summarize(r,allWorks)
        val byDepartment=progress.departments.map { department ->
            val teamWorks=progress.works.filter { it.teamId==department }
            mapOf("department" to department,"status" to RequestStatus.departmentStatus(teamWorks),"totalWorks" to teamWorks.size,"completedWorks" to teamWorks.count { it.status=="완료" },"returnedWorks" to teamWorks.count { it.status=="반환" })
        }
        val summary=mapOf("requestNumber" to r.number,"requesterDisplayText" to r.requesterDisplayText,"category" to r.category,"status" to progress.requestStatus,"teamIds" to progress.departments,"progress" to mapOf("currentDepartments" to progress.departments.size,"completedDepartments" to progress.completedDepartments.size,"totalWorks" to progress.works.size,"completedWorks" to progress.works.count { it.status=="완료" },"returnedWorks" to progress.returnedWorks,"hadAssignment" to allWorks.any { it.origin=="assigned" && it.assignedAt!=null },"departments" to byDepartment),"afterAction" to (allWorks.isNotEmpty() && allWorks.all { it.origin=="after-action" }),"updatedAt" to r.updatedAt,"priority" to r.priority,"assignedAt" to r.assignedAt)
        val teamId=actor?.takeIf { it.role=="team" }?.teamId ?: return summary
        val ownWorks=progress.works.filter { it.teamId==teamId }
        val participation=if(ownWorks.isNotEmpty()) "current" else if(allWorks.any { it.teamId==teamId }) "past" else "none"
        return summary+mapOf("myTeamWorkStatus" to if(ownWorks.isEmpty()) null else RequestStatus.departmentStatus(ownWorks),"participation" to participation)
    }
    fun requesters(actor:Actor):List<Map<String,Any?>> {
        if(actor.role!="bnoc") reject("FORBIDDEN")
        return db.actors().asSequence().filter { it.active && it.role=="requester" }
            .map { mapOf("requesterRef" to it.subjectRef,"displayName" to it.displayName,"department" to it.department) }
            .toList()
    }
    fun list(actor:Actor,filter:Map<String,String>):List<Map<String,Any?>> {
        validateFilter(filter)
        val q=normalize(filter["q"].orEmpty().trim())
        return db.requests().filter { workflow.visible(actor,it) && matches(it,filter,actor) }.sortedWith(compareByDescending<RequestRecord> { Instant.parse(it.updatedAt) }.thenByDescending { it.number.toLong() }).mapNotNull { request ->
            val base=summary(request,actor)
            if(q.isBlank()) base else searchMatches(request,q,actor).takeIf { it.isNotEmpty() }?.let { base+mapOf("matches" to it) }
        }
    }
    private fun validateFilter(filter:Map<String,String>) {
        listOf("from","to").forEach { filter[it]?.takeIf { value -> value.isNotBlank() }?.let { dateValue(it) } }
        if(filter.any { (key,value) -> key!="q" && value.length>500 }) reject("VALIDATION")
        if((filter["q"]?.trim()?.length ?: 0)>200) reject("VALIDATION",mapOf("q" to "검색어는 200자까지 입력하세요."))
        filter["teamId"]?.takeIf { it.isNotBlank() }?.let { if(it !in db.teams) reject("VALIDATION") }
        filter["priority"]?.takeIf { it.isNotBlank() }?.let { if(it !in listOf("general","urgent","unclassified")) reject("VALIDATION") }
    }
    private fun matches(r:RequestRecord,f:Map<String,String>,actor:Actor):Boolean {
        fun value(key:String)=f[key].orEmpty()
        val registered=Instant.parse(r.registeredAt).atZone(seoul).toLocalDate().toString()
        return (value("from").isBlank() || registered>=value("from")) && (value("to").isBlank() || registered<=value("to")) &&
            (value("status").isBlank() || r.status in value("status").split(',')) && (value("category").isBlank() || r.category==value("category")) &&
            (value("teamId").isBlank() || db.works(r.number).any { it.teamId==value("teamId") }) && (value("location").isBlank() || r.location.contains(value("location"))) &&
            (value("requestNumber").isBlank() || r.number.contains(value("requestNumber"))) && (value("requesterDeptOrName").isBlank() || actor.role!="bnoc" || r.requesterDisplayText.contains(value("requesterDeptOrName"))) &&
            (value("priority").isBlank() || if(value("priority")=="unclassified") r.priority==null else r.priority==value("priority"))
    }
    fun documentSearchStatus(actor:Actor,filter:Map<String,String>):Map<String,Any?> {
        validateFilter(filter)
        val otherFilters=filter-"q"
        val items=mutableListOf<Map<String,Any?>>()
        var total=0
        db.requests().filter { workflow.visible(actor,it) && matches(it,otherFilters,actor) }.forEach { request ->
            db.rows("SELECT a.attachment_ref,a.file_name,d.status,d.parser_version FROM bnoc_attachments a LEFT JOIN bnoc_document_analysis d ON d.attachment_ref=a.attachment_ref WHERE a.resource_kind='request' AND a.resource_ref=? AND a.current_link=TRUE AND a.content_analysis_excluded=FALSE AND (LOWER(a.file_name) LIKE '%.hwp' OR LOWER(a.file_name) LIKE '%.pdf') ORDER BY a.uploaded_at,a.attachment_ref",request.number)
                .forEach { row ->
                    val status=if(row["parser_version"]==DocumentTikaConfig.parserVersion) row["status"] as? String ?: "pending" else "pending"
                    if(status!="ready") {
                        total++
                        if(items.size<50) items.add(mapOf("requestNumber" to request.number,"attachmentRef" to row["attachment_ref"],"fileName" to row["file_name"],"status" to status))
                    }
                }
        }
        return mapOf("items" to items,"total" to total,"truncated" to (total>items.size))
    }
    fun documentSearchIncomplete(actor:Actor,filter:Map<String,String>):Boolean = (documentSearchStatus(actor,filter)["total"] as Int)>0
    private fun normalize(value:String)=Normalizer.normalize(value,Normalizer.Form.NFC).lowercase(Locale.ROOT)
    private fun excerpt(value:String,q:String):String {
        val normalized=Normalizer.normalize(value,Normalizer.Form.NFC)
        val index=normalize(normalized).indexOf(q).coerceAtLeast(0)
        val start=(index-48).coerceAtLeast(0)
        val prefix=if(start>0) "…" else ""
        var end=(start+160-prefix.length).coerceAtMost(normalized.length)
        var suffix=if(end<normalized.length) "…" else ""
        if(suffix.isNotEmpty()) end=(end-1).coerceAtLeast(start)
        return prefix+normalized.substring(start,end)+(if(end<normalized.length) "…" else "")
    }
    private fun searchMatches(request:RequestRecord,q:String,actor:Actor):List<Map<String,Any?>> {
        val matches=mutableListOf<Map<String,Any?>>()
        fun add(source:String,value:String,attachmentRef:String?=null,blockIndex:Int?=null,metadataIndex:Int?=null) {
            if(matches.size>=8 || value.isBlank()) return
            val normalized=normalize(value)
            if(normalized.contains(q)) matches.add(mapOf("source" to source,"attachmentRef" to attachmentRef,"text" to excerpt(value,q),"blockIndex" to blockIndex,"metadataIndex" to metadataIndex))
        }
        db.rows("SELECT a.attachment_ref,d.status,d.parser_version,d.body_text,d.body_json,d.metadata_json FROM bnoc_attachments a LEFT JOIN bnoc_document_analysis d ON d.attachment_ref=a.attachment_ref WHERE a.resource_kind='request' AND a.resource_ref=? AND a.current_link=TRUE AND a.content_analysis_excluded=FALSE AND (LOWER(a.file_name) LIKE '%.hwp' OR LOWER(a.file_name) LIKE '%.pdf') ORDER BY a.uploaded_at,a.attachment_ref",request.number).forEach { row ->
            val ref=row["attachment_ref"] as String
            if(row["parser_version"]==DocumentTikaConfig.parserVersion && row["status"] in setOf("ready","partial","no_text")) {
                val blocks=(row["body_json"] as? String)?.let { runCatching { db.json.readValue<List<Map<String,Any?>>>(it) }.getOrNull() }.orEmpty()
                fun blockText(block:Map<String,Any?>):String = if(block["type"]=="table") {
                    @Suppress("UNCHECKED_CAST")
                    (block["rows"] as? List<List<String>>).orEmpty().joinToString("\n") { it.joinToString(" | ") }
                } else block["text"] as? String ?: ""
                val bodyText=row["body_text"] as? String ?: ""
                val bodyBlockIndex=blocks.indexOfFirst { normalize(blockText(it)).contains(q) }.takeIf { it>=0 }
                add("document",bodyText,ref,bodyBlockIndex)
                val candidates=(row["metadata_json"] as? String)?.let { runCatching { db.json.readValue<List<Map<String,Any?>>>(it) }.getOrNull() }.orEmpty()
                candidates.forEachIndexed { metadataIndex,candidate ->
                    val blockId=candidate["blockId"] as? String
                    val blockIndex=blocks.indexOfFirst { it["id"]==blockId }.takeIf { it>=0 }
                    add("document",listOfNotNull(candidate["label"],candidate["rawValue"]).joinToString(": "),ref,blockIndex,metadataIndex)
                }
            }
        }
        add("request",request.detail)
        add("classification",request.category)
        request.subcategories.forEach { (key,value) -> add("classification","$key: $value") }
        request.equipmentId?.let { add("classification",it) }
        return matches
    }
    fun requireRequest(actor:Actor,number:String):RequestRecord {
        val request=db.request(number) ?: reject("NOT_FOUND")
        if(!workflow.visible(actor,request)) reject("NOT_FOUND")
        return request
    }
    fun detail(actor:Actor,number:String):Map<String,Any?> {
        val request=requireRequest(actor,number)
        val works=db.works(number).map { w ->
            val common=mutableMapOf<String,Any?>("workNumber" to w.number,"teamId" to w.teamId,"status" to w.status,"scheduleIntervals" to w.scheduleIntervals,"previousScheduleIntervals" to w.previousScheduleIntervals,"actualStartedAt" to w.actualStartedAt,"revision" to w.revision,"resolved" to (w.resolutionKind!="open"),"resolutionKind" to w.resolutionKind,"resolutionReason" to w.resolutionReason,"replacementWorkNumbers" to w.replacementWorkNumbers,"editable" to (request.status !in listOf("취소","기각") && actor.role=="team" && actor.teamId==w.teamId && w.origin!="after-action" && w.resolutionKind=="open"),"assignedAt" to w.assignedAt,"origin" to w.origin)
            if(actor.role=="bnoc" || (actor.role=="team" && actor.teamId==w.teamId)) {
                common["memo"]=w.memo;common["returnReason"]=w.returnReason
                common["assignedPersonRefs"]=w.assignedPersonRefs
                common["assignedPersons"]=w.assignedPersonRefs.mapNotNull { ref -> db.rows("SELECT display_name FROM bnoc_roster WHERE person_ref=?",ref).firstOrNull()?.let { mapOf("personRef" to ref,"displayName" to it["display_name"]) } }
                common["completion"]=w.completion?.let { c -> c.filterKeys { it!="completedBy" }+mapOf("completedBy" to (db.actor(c["completedBy"].orEmpty())?.displayName ?: "담당자")) }
                common["completionActor"]=w.completion?.get("completedBy")?.let { db.actor(it)?.displayName ?: "담당자" }
            }
            common
        }
        val current=RequestStatus.summarize(request,db.works(number))
        val canAddTeams=actor.role=="bnoc" && current.requestStatus !in listOf("취소","기각","완료") && request.priority in listOf("general","urgent") && db.works(number).any { it.origin=="assigned" && it.assignedAt!=null } && db.works(number).none { it.origin=="after-action" }
        val maySeePersonalContact=actor.role in listOf("requester","bnoc") || (actor.role=="team" && request.status !in listOf("취소","기각") && db.works(number).any { it.teamId==actor.teamId && it.origin=="assigned" && it.resolutionKind=="open" && it.status in listOf("배정","작업 중","완료") })
        val view=summary(request,actor)+mapOf("detail" to request.detail,"location" to request.location,"contact" to if(actor.role in listOf("requester","bnoc")) request.contact else null,"subcategories" to request.subcategories,"equipmentId" to request.equipmentId,"maintenanceTarget" to if(actor.role=="bnoc") request.maintenanceTarget else null,"schedulePreferences" to request.schedulePreferences,"documentRef" to request.documentRef,"registeredBy" to (db.actor(request.registeredBy)?.displayName ?: "담당자"),"registeredAt" to request.registeredAt,"revision" to request.revision,"workItems" to works,"attachments" to request.attachments,"history" to emptyList<Any>(),"canEdit" to workflow.canEdit(actor,request),"canCancel" to (actor.role=="requester" && request.requesterSubject==actor.id && request.status !in listOf("취소","기각")),"canAssign" to (actor.role=="bnoc" && request.status in listOf("대기","문서 대기") && works.isEmpty()),"canReject" to (actor.role=="bnoc" && request.status in listOf("대기","문서 대기") && works.isEmpty()),"canAddTeams" to canAddTeams,"canChangePriority" to (actor.role=="bnoc" && request.status !in listOf("취소","기각")),"rejectionReason" to if(actor.role in listOf("requester","bnoc") && request.status=="기각") request.rejectionReason else null,"rejectedAt" to if(actor.role in listOf("requester","bnoc") && request.status=="기각") request.rejectedAt else null)
        return view+(if(maySeePersonalContact) mapOf("personalContact" to request.personalContact) else emptyMap())
    }
    fun history(actor:Actor,number:String):List<Map<String,Any?>> {
        requireRequest(actor,number)
        val works=db.works(number).filter { actor.role!="team" || it.teamId==actor.teamId }.map { it.number }
        return db.rows("SELECT * FROM bnoc_history WHERE request_number=? ORDER BY recorded_at DESC,history_id DESC",number).filter { row ->
            val field=row["field_name"] as String;val work=row["work_number"] as? String
            (work==null || work in works) && (actor.role!="requester" || (work==null && field in listOf("등록","상태","기각 사유","detail","location","contact","schedulePreferences","documentRef","attachments","일반·긴급"))) && (actor.role!="team" || field!="contact")
        }.map { row ->
            val subject=row["actor_subject"] as String;val field=row["field_name"] as String
            val label=when(field) {
                "scheduledAt","schedulePreferences" -> "희망 일정";"schedule","scheduleIntervals" -> "작업 일정"
                "detail" -> "내용";"location" -> "위치";"contact" -> "연락처"
                "documentRef" -> "문서 참조정보";"attachments" -> "첨부파일";"memo" -> "작업 메모"
                else -> field
            }
            fun render(value:Any?):String {
                if(value==null) return if(field in timeFields) "미정" else if(field=="일반·긴급") "미분류" else "없음"
                val objectValue=runCatching { db.json.readValue(value as String,Any::class.java) }.getOrNull()
                if(field=="일반·긴급") return when(objectValue) { "general" -> "일반";"urgent" -> "긴급";null -> "미분류";else -> "분류 확인 불가" }
                if(field in timeFields) return displayHistoryTime(objectValue)
                if(field=="완료정보") { val c=objectValue as? Map<*,*> ?: return "없음";return "${db.actor(c["completedBy"].toString())?.displayName ?: "담당자"} · ${displayHistoryTime(c["completedAt"])}" }
                if(field=="담당 인원") return (objectValue as? List<*>)?.mapNotNull { ref -> db.rows("SELECT display_name FROM bnoc_roster WHERE person_ref=?",ref).firstOrNull()?.get("display_name") }?.joinToString(", ").orEmpty().ifBlank { "미선택" }
                if(field=="schedulePreferences") return (objectValue as? List<*>)?.mapNotNull { entry ->
                    val pref=entry as? Map<*,*> ?: return@mapNotNull null
                    "${pref["rank"]}지망 ${pref["date"]} ${if(pref["period"]=="AM") "오전" else "오후"}"
                }?.joinToString(" · ").orEmpty().ifBlank { "없음" }
                if(field=="scheduleIntervals") return (objectValue as? List<*>)?.mapNotNull { entry ->
                    val interval=entry as? Map<*,*> ?: return@mapNotNull null
                    "${displayHistoryTime(interval["startsAt"])}–${displayHistoryTime(interval["endsAt"])}"
                }?.joinToString(" · ").orEmpty().ifBlank { "미정" }
                if(field=="attachments") return (objectValue as? List<*>)?.mapNotNull { item -> (item as? Map<*,*>)?.get("fileName") }?.joinToString(", ").orEmpty().ifBlank { "없음" }
                return objectValue?.toString() ?: "없음"
            }
            val historicalFiles=if(field=="attachments") listOf("before_value","after_value").flatMap { key -> (row[key] as? String)?.let { runCatching { db.json.readValue(it,List::class.java) }.getOrNull()?.mapNotNull { item -> (item as? Map<*,*>)?.get("id") as? String } } ?: emptyList() }.distinct() else emptyList()
            mapOf("at" to row["recorded_at"],"actorLabel" to if(actor.role=="requester" && subject!=actor.id) "담당자" else db.actor(subject)?.displayName ?: "담당자","field" to field,"summary" to if(row["before_value"]==null) "$label: ${render(row["after_value"])}" else "$label: ${render(row["before_value"])} → ${render(row["after_value"])}","attachments" to historicalFiles.mapNotNull { id -> db.rows("SELECT attachment_ref,file_name,byte_size,content_type FROM bnoc_attachments WHERE attachment_ref=?",id).firstOrNull()?.let { mapOf("id" to it["attachment_ref"],"fileName" to it["file_name"],"size" to it["byte_size"],"type" to it["content_type"]) } })
        }
    }
    fun notifications(actor:Actor):List<Map<String,Any?>> = db.rows("SELECT notification_id,event_name,request_number,work_number,recorded_at,is_read FROM bnoc_notifications WHERE recipient_subject=? ORDER BY recorded_at DESC,notification_id DESC",actor.id).filter { row -> db.request(row["request_number"] as String)?.let { workflow.visible(actor,it) } ?: false }.map { mapOf("notificationId" to it["notification_id"],"event" to it["event_name"],"relatedRequestId" to it["request_number"],"relatedWorkItemId" to it["work_number"],"at" to it["recorded_at"],"read" to it["is_read"]) }
    fun unseenNotifications(actor:Actor):Map<String,Any?> = mapOf("unseen" to notifications(actor).count { it["read"]==false })
    fun schedule(actor:Actor,filter:Map<String,String>):Map<String,Any> {
        if(actor.role !in listOf("team","bnoc")) reject("FORBIDDEN")
        fun boundary(value:String)=if(value.matches(Regex("\\d{4}-\\d{2}-\\d{2}"))) LocalDate.parse(dateValue(value)).atStartOfDay(seoul).toInstant() else Instant.parse(instantValue(value)!!)
        val from=filter["from"]?.takeIf { it.isNotBlank() }?.let { boundary(it) } ?: LocalDate.now(seoul).atStartOfDay(seoul).toInstant()
        val to=filter["to"]?.takeIf { it.isNotBlank() }?.let { boundary(it) } ?: from.plusSeconds(86400)
        if(!to.isAfter(from) || to.isAfter(from.plusSeconds(730L*86400))) reject("VALIDATION",mapOf("to" to "조회 기간을 확인하세요."))
        val valid=db.allWorks().filter { (actor.role=="bnoc" || it.teamId==actor.teamId) && it.resolutionKind=="open" && db.request(it.requestNumber)?.status !in listOf("취소","기각") && (it.origin=="assigned" || (it.origin=="after-action" && it.status=="완료")) }
        fun entry(w:WorkRecord):Map<String,Any?> {
            val request=db.request(w.requestNumber)!!
            val common=mutableMapOf<String,Any?>("workNumber" to w.number,"teamId" to w.teamId,"request" to mapOf("requestNumber" to request.number),"status" to w.status,"location" to request.location,"memo" to (w.memo ?: w.completion?.get("memo")),"origin" to w.origin)
            if(w.origin=="after-action") common["actualStartedAt"]=w.actualStartedAt else common["scheduleIntervals"]=w.scheduleIntervals
            if(w.origin=="assigned" && w.status=="완료") common["completedAt"]=w.completion?.get("completedAt")
            return common
        }
        val scheduled=valid.filter { work -> work.origin=="assigned" && work.status in listOf("배정","작업 중") && work.scheduleIntervals.any { interval -> Instant.parse(interval.startsAt).isBefore(to) && Instant.parse(interval.endsAt).isAfter(from) } }
            .sortedWith(compareBy<WorkRecord> { it.scheduleIntervals.firstOrNull()?.startsAt ?: "" }.thenBy { it.number }).map { entry(it) }
        val completedAssigned=valid.filter { work -> work.origin=="assigned" && work.status=="완료" &&
            (work.scheduleIntervals.any { interval -> Instant.parse(interval.startsAt).isBefore(to) && Instant.parse(interval.endsAt).isAfter(from) } ||
                work.completion?.get("completedAt")?.let { Instant.parse(it).let { instant -> !instant.isBefore(from) && instant.isBefore(to) } }==true) }
        val completedAfterAction=valid.filter { work -> work.origin=="after-action" && work.actualStartedAt?.let { Instant.parse(it).let { instant -> !instant.isBefore(from) && instant.isBefore(to) } }==true }
        val completedRecords=(completedAssigned+completedAfterAction)
            .sortedWith(compareBy<WorkRecord> { if(it.origin=="after-action") it.actualStartedAt ?: "" else it.scheduleIntervals.firstOrNull()?.startsAt ?: it.completion?.get("completedAt") ?: "" }.thenBy { it.number })
            .map { entry(it) }
        val unscheduled=valid.filter { work -> work.origin=="assigned" && work.status in listOf("배정","작업 중") && work.scheduleIntervals.isEmpty() }.map { entry(it) }
        return mapOf("entries" to scheduled,"completedRecords" to completedRecords,"unscheduled" to unscheduled,"from" to from.toString(),"to" to to.toString())
    }
    fun overview(actor:Actor,filter:Map<String,String>):Map<String,Any> {
        if(actor.role!="bnoc") reject("FORBIDDEN")
        val list=list(actor,filter-"q")
        return mapOf("total" to list.size,"byStatus" to listOf("대기","문서 대기","배정","작업 중","완료","취소","기각").associateWith { state -> list.count { it["status"]==state } },"list" to list,"teams" to db.teams)
    }
    fun shared(actor:Actor,filter:Map<String,String>):Map<String,Any> {
        validateFilter(filter)
        val requests=db.requests().associateBy { it.number }
        fun match(work:WorkRecord,r:RequestRecord):Boolean=(filter["teamId"].isNullOrBlank() || work.teamId==filter["teamId"]) && (filter["status"].isNullOrBlank() || work.status in filter["status"]!!.split(',')) && (filter["category"].isNullOrBlank() || r.category==filter["category"]) && (filter["systemType"].isNullOrBlank() || r.subcategories["systemType"]==filter["systemType"]) && (filter["workType"].isNullOrBlank() || (r.subcategories["workType"] ?: r.subcategories["meetingType"])==filter["workType"]) && (filter["priority"].isNullOrBlank() || if(filter["priority"]=="unclassified") r.priority==null else r.priority==filter["priority"]) && (filter["requestNumber"].isNullOrBlank() || r.number==filter["requestNumber"])
        val all=db.allWorks()
        val valid=all.filter { work -> val r=requests[work.requestNumber]!!;r.status !in listOf("취소","기각") && work.resolutionKind=="open" && work.origin=="assigned" && match(work,r) }
        val afterActionWorks=all.filter { work ->
            val r=requests[work.requestNumber]!!
            r.status !in listOf("취소","기각") && work.resolutionKind=="open" && work.origin=="after-action" && work.status=="완료" && match(work,r)
        }
        val assignedWorks=valid+afterActionWorks
        fun counts(works:List<WorkRecord>,remainingFrom:List<WorkRecord> = works)=mapOf("total" to works.size,"assigned" to works.size,"completed" to works.count { it.status=="완료" },"remaining" to remainingFrom.count { it.status!="완료" },"returned" to works.count { it.status=="반환" },"inProgress" to works.count { it.status=="작업 중" })
        val requestOnlyFilters=listOf("category","systemType","workType","priority","requestNumber").any { !filter[it].isNullOrBlank() }
        val selectedStatuses=filter["status"].orEmpty().split(',').filter { it.isNotBlank() }
        val planned=db.plannedWorks().filter { work ->
            !requestOnlyFilters && (filter["teamId"].isNullOrBlank() || work.teamId==filter["teamId"]) &&
                (selectedStatuses.isEmpty() || selectedStatuses.any { state ->
                    state=="완료" && work.status=="completed" || state=="진행 중" && work.status=="in_progress"
                })
        }
        val plannedInProgress=planned.count { it.status=="in_progress" }
        val plannedCompleted=planned.count { it.status=="completed" }
        val assignedCounts=counts(assignedWorks,valid)
        val allCount=assignedWorks.size+planned.size
        val summaryCounts=assignedCounts+mapOf("afterAction" to afterActionWorks.size,"planned" to planned.size,"plannedInProgress" to plannedInProgress,"plannedCompleted" to plannedCompleted,
            "all" to allCount,"allCompleted" to (assignedWorks.count { it.status=="완료" }+plannedCompleted),"allRemaining" to (valid.count { it.status!="완료" }+plannedInProgress))
        val bucket=filter["bucket"].orEmpty()
        if(bucket !in listOf("","assigned","completed","remaining","returned","after-action","planned","all","unassigned")) reject("VALIDATION")
        val selectedAssigned=when(bucket) { "completed" -> assignedWorks.filter { it.status=="완료" };"remaining" -> valid.filter { it.status!="완료" };"returned" -> valid.filter { it.status=="반환" };else -> assignedWorks }
        fun workMap(work:WorkRecord,includeSource:Boolean=false):Map<String,Any?> {
            val r=requests[work.requestNumber]!!
            val result=mapOf<String,Any?>("workNumber" to work.number,"requestNumber" to r.number,"department" to work.teamId,"teamId" to work.teamId,"category" to r.category,"workType" to (r.subcategories["workType"] ?: r.subcategories["meetingType"]),"status" to work.status,"priority" to r.priority,"schedule" to work.schedule,"scheduleIntervals" to work.scheduleIntervals,"requesterContact" to r.contact,"origin" to work.origin,"canOpenDetail" to workflow.visible(actor,r))
            return if(includeSource) result+mapOf("source" to if(work.origin=="after-action") "after-action" else "assigned") else result
        }
        fun workRows(works:List<WorkRecord>,includeSource:Boolean=false)=works.sortedWith(compareByDescending<WorkRecord> { work ->
            val recordedAt=work.assignedAt ?: requests[work.requestNumber]?.registeredAt ?: work.completion?.get("completedAt") ?: work.actualStartedAt
            recordedAt?.let { Instant.parse(it) } ?: Instant.EPOCH
        }.thenByDescending { it.requestNumber.toLong() }.thenByDescending { it.number.substringAfterLast('-').toInt() }).map { workMap(it,includeSource) }
        val plannedRows=planned.sortedWith(compareByDescending<PlannedWorkRecord> { it.updatedAt }.thenBy { it.id }).map { work ->
            mapOf<String,Any?>("source" to "planned","plannedWorkId" to work.id,"id" to work.id,"department" to work.teamId,"teamId" to work.teamId,"title" to work.title,"status" to if(work.status=="in_progress") "진행 중" else "완료","firstWorkDate" to work.firstWorkDate,"completedDate" to work.completedDate)
        }
        val workItems=when(bucket) {
            "after-action" -> workRows(afterActionWorks)
            "planned" -> plannedRows
            "all" -> workRows(selectedAssigned,true)+plannedRows
            else -> workRows(selectedAssigned)
        }
        val unassignedRows=requests.values.filter { r -> r.status in listOf("대기","문서 대기") && all.none { it.requestNumber==r.number && it.origin=="assigned" && it.resolutionKind=="open" } && (filter["category"].isNullOrBlank() || filter["category"]==r.category) && (filter["systemType"].isNullOrBlank() || filter["systemType"]==r.subcategories["systemType"]) && (filter["workType"].isNullOrBlank() || filter["workType"]==(r.subcategories["workType"] ?: r.subcategories["meetingType"])) && (filter["priority"].isNullOrBlank() || if(filter["priority"]=="unclassified") r.priority==null else filter["priority"]==r.priority) && filter["teamId"].isNullOrBlank() && filter["status"].isNullOrBlank() && (filter["requestNumber"].isNullOrBlank() || r.number==filter["requestNumber"]) }
        val unassignedItems=unassignedRows.sortedWith(compareByDescending<RequestRecord> { Instant.parse(it.registeredAt) }.thenByDescending { it.number.toLong() }).map { r -> mapOf("requestNumber" to r.number,"category" to r.category,"status" to r.status,"priority" to r.priority,"canOpenDetail" to workflow.visible(actor,r)) }
        val items=if(bucket=="unassigned") unassignedItems else workItems
        val byDepartment=db.teams.map { team ->
            val teamValid=valid.filter { it.teamId==team };val teamAssigned=assignedWorks.filter { it.teamId==team };val teamAfter=afterActionWorks.count { it.teamId==team };val teamPlanned=planned.filter { it.teamId==team }
            mapOf("department" to team)+counts(teamAssigned,teamValid)+mapOf("afterAction" to teamAfter,"planned" to teamPlanned.size,"plannedInProgress" to teamPlanned.count { it.status=="in_progress" },"plannedCompleted" to teamPlanned.count { it.status=="completed" },"all" to (teamAssigned.size+teamPlanned.size),"allCompleted" to (teamAssigned.count { it.status=="완료" }+teamPlanned.count { it.status=="completed" }),"allRemaining" to (teamValid.count { it.status!="완료" }+teamPlanned.count { it.status=="in_progress" }))
        }
        return mapOf("items" to items,"total" to items.size,"counts" to summaryCounts,"byDepartment" to byDepartment,"unassignedRequests" to unassignedRows.size,"afterActionCompleted" to afterActionWorks.size,"basis" to "현재 상태 기준")
    }
}
