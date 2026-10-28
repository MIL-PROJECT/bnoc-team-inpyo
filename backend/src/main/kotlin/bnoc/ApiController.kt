package bnoc

import jakarta.servlet.http.HttpServletRequest
import org.springframework.web.bind.annotation.*
import org.springframework.web.multipart.MultipartFile
import org.springframework.http.ResponseEntity
import org.springframework.http.HttpHeaders
import org.springframework.http.ContentDisposition
import org.springframework.http.MediaType
import org.springframework.transaction.annotation.Transactional
import org.springframework.transaction.annotation.Isolation
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

@RestController
@RequestMapping("/api")
class ApiController(val auth:AuthService,val db:Database,val workflow:WorkflowService,val query:QueryService,val files:AttachmentService,val situation:SituationService,val operationsStatus:OperationsStatusService,val plannedWorks:PlannedWorkService,val documents:DocumentAnalysisService) {
    private fun actor(request:HttpServletRequest)=auth.actor(request) ?: reject("UNAUTHENTICATED")
    private fun envelope(data:Any?):Map<String,Any?> = mapOf("data" to data,"queriedAt" to Instant.now().toString())
    @GetMapping("/request-draft") fun requestDraft(request:HttpServletRequest)=envelope(workflow.requestDrafts.get(actor(request)))
    @PutMapping("/request-draft") fun saveRequestDraft(request:HttpServletRequest,@RequestBody body:Map<String,Any?>)=envelope(workflow.requestDrafts.save(actor(request),body))
    @DeleteMapping("/request-draft") fun deleteRequestDraft(request:HttpServletRequest,@RequestBody body:Map<String,Any?>)=envelope(workflow.requestDrafts.delete(actor(request),body))
    private fun page(params:Map<String,String>,items:List<Any?>):Map<String,Any?> {
        val page=params["page"]?.toIntOrNull() ?: if(params["page"]==null) 0 else reject("VALIDATION")
        val size=params["size"]?.toIntOrNull() ?: if(params["size"]==null) 20 else reject("VALIDATION")
        if(page<0 || size !in 1..100 || page>1000000) reject("VALIDATION",mapOf("page" to "페이지 조건을 확인하세요."))
        val start=(page.toLong()*size).coerceAtMost(items.size.toLong()).toInt()
        return mapOf("items" to items.drop(start).take(size),"total" to items.size,"page" to page,"size" to size)
    }
    private fun pageEnvelope(data:Map<String,Any?>):Map<String,Any?> = envelope(data)+data.filterKeys { it in setOf("total","page","size") }
    @GetMapping("/auth/start") fun start(request:HttpServletRequest)=envelope(auth.start(request))
    fun proxyIdentity(request:HttpServletRequest)=auth.proxyIdentity(request)
    @PostMapping("/auth/complete") fun complete(request:HttpServletRequest,@RequestBody payload:Map<String,Any?>)=auth.complete(request,payload)
    @PostMapping("/auth/logout") fun logout(request:HttpServletRequest):Map<String,Boolean> { request.getSession(false)?.invalidate();return mapOf("ok" to true) }
    @GetMapping("/session") fun session(request:HttpServletRequest)=envelope(mapOf("actor" to actor(request).view(),"teams" to db.teams,"departments" to db.departments,"csrfToken" to auth.csrf(request),"sourceMode" to "simulation"))
    @GetMapping("/requesters") fun requesters(request:HttpServletRequest)=envelope(query.requesters(actor(request)))
    @GetMapping("/requests") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun requests(request:HttpServletRequest,@RequestParam params:Map<String,String>):Map<String,Any?> {
        val currentActor=actor(request);val filter=filters(request,params);val items=query.list(currentActor,filter)
        val paged=page(params,items)
        return pageEnvelope(if(filter["q"].orEmpty().isBlank()) paged else {
            val documentSearchStatus=query.documentSearchStatus(currentActor,filter)
            paged+mapOf("documentSearchIncomplete" to ((documentSearchStatus["total"] as Int)>0),"documentSearchStatuses" to documentSearchStatus)
        })
    }
    @GetMapping("/requests/{number}") fun detail(request:HttpServletRequest,@PathVariable number:String)=envelope(query.detail(actor(request),number))
    @GetMapping("/requests/{number}/history") fun history(request:HttpServletRequest,@PathVariable number:String,@RequestParam params:Map<String,String>)=pageEnvelope(page(params,query.history(actor(request),number)))
    @GetMapping("/notifications") fun notifications(request:HttpServletRequest,@RequestParam params:Map<String,String>)=pageEnvelope(page(params,query.notifications(actor(request))))
    @GetMapping("/notifications/unseen") fun unseenNotifications(request:HttpServletRequest)=envelope(query.unseenNotifications(actor(request)))
    @GetMapping("/schedule") fun schedule(request:HttpServletRequest,@RequestParam params:Map<String,String>)=envelope(query.schedule(actor(request),params))
    @GetMapping("/overview") fun overview(request:HttpServletRequest,@RequestParam params:Map<String,String>):Map<String,Any?> {
        val data=query.overview(actor(request),filters(request,params))
        @Suppress("UNCHECKED_CAST") val pagination=page(params,data["list"] as List<Any?>)
        return pageEnvelope(data+mapOf("list" to pagination["items"])+pagination.filterKeys { it!="items" })
    }
    @GetMapping("/work-overview") fun shared(request:HttpServletRequest,@RequestParam params:Map<String,String>):Map<String,Any?> {
        val data=query.shared(actor(request),filters(request,params))
        @Suppress("UNCHECKED_CAST") val pagination=page(params,data["items"] as List<Any?>)
        return pageEnvelope(data+pagination)
    }
    @GetMapping("/planned-works") fun plannedWorkList(request:HttpServletRequest,@RequestParam params:Map<String,String>):Map<String,Any?> {
        if(params.keys.any { it!="workDate" }) reject("VALIDATION")
        val workDate=params["workDate"] ?: LocalDate.now(ZoneId.of("Asia/Seoul")).toString()
        return envelope(plannedWorks.list(actor(request),workDate))
    }
    private fun plannedBody(input:Map<String,Any?>,allowed:Set<String>) {
        if(input.keys.any { it !in allowed }) reject("VALIDATION")
    }
    private fun optionalIntParam(params:Map<String,String>,key:String):Int? = params[key]?.toIntOrNull() ?: if(key !in params) null else reject("VALIDATION",mapOf(key to "숫자 입력을 확인하세요."))
    private fun plannedText(input:Map<String,Any?>,key:String,max:Int,required:Boolean=true):String=text(input,key,max,required)
    private fun plannedRevision(input:Map<String,Any?>):Long {
        val number=input["revision"] as? Number ?: reject("VALIDATION",mapOf("revision" to "버전이 필요합니다."))
        if(number.toDouble()!=number.toLong().toDouble() || number.toLong()<=0) reject("VALIDATION",mapOf("revision" to "버전을 확인하세요."))
        return number.toLong()
    }
    private fun plannedCommandResult(result:Map<String,Any?>)=mapOf("plannedWork" to result,"replayed" to (result["replayed"]==true))
    @PostMapping("/planned-works") fun createPlannedWork(request:HttpServletRequest,@RequestBody input:Map<String,Any?>):Map<String,Any?> {
        plannedBody(input,setOf("operationId","title","firstWorkDate"))
        return envelope(plannedCommandResult(plannedWorks.create(actor(request),plannedText(input,"title",160),plannedText(input,"firstWorkDate",10),plannedText(input,"operationId",128))))
    }
    @PatchMapping("/planned-works/{id}") fun updatePlannedWork(request:HttpServletRequest,@PathVariable id:String,@RequestBody input:Map<String,Any?>):Map<String,Any?> {
        plannedBody(input,setOf("operationId","revision","title","firstWorkDate"))
        val title=if(input.containsKey("title")) plannedText(input,"title",160) else null
        val firstDate=if(input.containsKey("firstWorkDate")) plannedText(input,"firstWorkDate",10) else null
        return envelope(plannedCommandResult(plannedWorks.update(actor(request),id,plannedRevision(input),title,firstDate,plannedText(input,"operationId",128))))
    }
    @PostMapping("/planned-works/{id}/complete") fun completePlannedWork(request:HttpServletRequest,@PathVariable id:String,@RequestBody input:Map<String,Any?>):Map<String,Any?> {
        plannedBody(input,setOf("operationId","revision","completedDate"))
        return envelope(plannedCommandResult(plannedWorks.complete(actor(request),id,plannedRevision(input),plannedText(input,"completedDate",10),plannedText(input,"operationId",128))))
    }
    @DeleteMapping("/planned-works/{id}") fun deletePlannedWork(request:HttpServletRequest,@PathVariable id:String,@RequestHeader("If-Match",required=false) ifMatch:String?):Map<String,Any?> {
        val revision=ifMatch?.trim()?.removeSurrounding("\"")?.toLongOrNull()?.takeIf { it>0 } ?: reject("VALIDATION",mapOf("If-Match" to "버전이 필요합니다."))
        return envelope(plannedWorks.delete(actor(request),id,revision))
    }
    @GetMapping("/department-contacts") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun departmentContacts(request:HttpServletRequest):Map<String,Any?> { actor(request);return envelope(workflow.operations.departmentContacts()) }
    @GetMapping("/personnel-roster","/roster") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun roster(request:HttpServletRequest,@RequestParam(required=false) department:String?)=envelope(workflow.operations.listCentralRoster(actor(request),department))
    @GetMapping("/personnel") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun personnel(request:HttpServletRequest,@RequestParam(required=false) date:String?,@RequestParam(required=false) department:String?)=envelope(workflow.operations.personnelSummary(actor(request),date ?: LocalDate.now(ZoneId.of("Asia/Seoul")).toString(),department))
    @GetMapping("/night-duty") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun night(request:HttpServletRequest,@RequestParam(required=false) date:String?,@RequestParam(required=false) department:String?)=envelope(workflow.operations.night(actor(request),date ?: LocalDate.now(ZoneId.of("Asia/Seoul")).toString(),department))
    @GetMapping("/duty-schedules") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun dutySchedules(request:HttpServletRequest,@RequestParam month:String,@RequestParam(required=false) seat:String?)=envelope(workflow.operations.listDutySchedules(actor(request),month,seat))
    @GetMapping("/situation") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun situations(request:HttpServletRequest):Map<String,Any?> { actor(request);return envelope(mapOf("gps" to situation.snapshot("gps"),"cpcon" to situation.snapshot("cpcon"))) }
    @GetMapping("/operations/status") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun operationsStatus(request:HttpServletRequest):Map<String,Any?> { actor(request); return envelope(operationsStatus.snapshot()) }
    @GetMapping("/situation/{kind}") fun situation(request:HttpServletRequest,@PathVariable kind:String):Map<String,Any?> { actor(request);return envelope(situation.snapshot(kind)) }
    @GetMapping("/notices") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun notices(request:HttpServletRequest,@RequestParam params:Map<String,String>)=pageEnvelope(page(params,workflow.operations.notices(actor(request))))
    @GetMapping("/notices/{ref}") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun notice(request:HttpServletRequest,@PathVariable ref:String)=envelope(workflow.operations.notice(actor(request),ref))
    @GetMapping("/access-assignments","/access") @Transactional(readOnly=true,isolation=Isolation.REPEATABLE_READ)
    fun access(request:HttpServletRequest,@RequestParam params:Map<String,String>)=pageEnvelope(page(params,workflow.operations.access(actor(request))))
    @GetMapping("/operations/{id}") fun receipt(request:HttpServletRequest,@PathVariable id:String)=workflow.receipt(actor(request),id)
    private fun filters(request:HttpServletRequest,params:Map<String,String>)=params+(request.getParameterValues("status")?.let { mapOf("status" to it.joinToString(",")) } ?: emptyMap())
    @PostMapping("/commands") fun command(request:HttpServletRequest,@RequestBody input:Map<String,Any?>):CommandResult {
        if(input.keys.any { it !in setOf("type","operationId","requestNumber","workNumber","expectedRevision","payload") }) reject("VALIDATION")
        val payload=input["payload"] as? Map<*,*> ?: reject("VALIDATION")
        if(payload.keys.any { it !is String }) reject("VALIDATION")
        @Suppress("UNCHECKED_CAST") val typed=payload as Map<String,Any?>
        val revision=input["expectedRevision"]?.let { val n=it as? Number ?: reject("VALIDATION");if(n.toDouble()!=n.toLong().toDouble() || n.toLong()<0) reject("VALIDATION");n.toLong() }
        for(key in listOf("requestNumber","workNumber")) if(input[key]!=null && input[key] !is String) reject("VALIDATION")
        return workflow.execute(actor(request),Command(input["type"] as? String ?: reject("VALIDATION"),input["operationId"] as? String ?: reject("VALIDATION"),input["requestNumber"] as? String,input["workNumber"] as? String,revision,typed))
    }
    @PostMapping("/attachments") fun upload(request:HttpServletRequest,@RequestParam resourceKind:String,@RequestPart file:MultipartFile)=envelope(files.upload(actor(request),resourceKind,file))
    @GetMapping("/attachments/{id}","/attachments/{id}/download") fun download(request:HttpServletRequest,@PathVariable id:String):ResponseEntity<ByteArray> {
        val data=files.download(actor(request),id)
        return ResponseEntity.ok().header(HttpHeaders.CONTENT_DISPOSITION,ContentDisposition.attachment().filename(data.first["file_name"] as String,Charsets.UTF_8).build().toString()).header("X-Content-Type-Options","nosniff").header("Cache-Control","no-store").contentType(MediaType.parseMediaType(data.first["content_type"] as String)).body(data.second)
    }
    @GetMapping("/attachments/{id}/inline") fun inline(request:HttpServletRequest,@PathVariable id:String):ResponseEntity<ByteArray> {
        val data=files.inline(actor(request),id)
        return ResponseEntity.ok().header(HttpHeaders.CONTENT_DISPOSITION,ContentDisposition.inline().filename(data.first["file_name"] as String,Charsets.UTF_8).build().toString()).header("X-Content-Type-Options","nosniff").header("X-Frame-Options","SAMEORIGIN").header("Cross-Origin-Resource-Policy","same-origin").header("Content-Security-Policy","default-src 'none'; sandbox").header("Cache-Control","no-store").contentType(MediaType.parseMediaType(data.first["content_type"] as String)).body(data.second)
    }
    @GetMapping("/attachments/{id}/render-source") fun renderSource(request:HttpServletRequest,@PathVariable id:String):ResponseEntity<ByteArray> {
        val data=files.renderSource(actor(request),id)
        return ResponseEntity.ok().header(HttpHeaders.CONTENT_DISPOSITION,ContentDisposition.attachment().filename(data.first["file_name"] as String,Charsets.UTF_8).build().toString()).header("X-Content-Type-Options","nosniff").header("Cross-Origin-Resource-Policy","same-origin").header("Content-Security-Policy","default-src 'none'; sandbox").header("Cache-Control","no-store").contentType(MediaType.APPLICATION_OCTET_STREAM).body(data.second)
    }
    @GetMapping("/attachments/{id}/document") fun document(request:HttpServletRequest,@PathVariable id:String,@RequestParam params:Map<String,String>):Map<String,Any?> {
        if(params.keys.any { it !in setOf("offset","limit") }) reject("VALIDATION")
        return envelope(documents.document(actor(request),id,optionalIntParam(params,"offset"),optionalIntParam(params,"limit")))
    }
    @PostMapping("/attachments/{id}/reprocess") fun reprocess(request:HttpServletRequest,@PathVariable id:String)=envelope(documents.reprocess(actor(request),id))
}
