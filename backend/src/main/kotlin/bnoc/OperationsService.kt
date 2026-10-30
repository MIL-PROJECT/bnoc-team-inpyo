package bnoc

import com.fasterxml.jackson.module.kotlin.readValue
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID

class OperationsService(val db:Database) {
    companion object {
        private val officerDutySeats=setOf("duty_officer","communications_battalion_day_officer","battalion_b_day_officer")
        val fields=mapOf("savePersonnelRoster" to setOf("department","entries"),"saveDailyPersonnel" to setOf("department","date","entries"),
            "saveNightDuty" to setOf("department","date","personRefs"),"createDirective" to setOf("title","body","bodyDocument","attachmentRefs"),
            "updateDirective" to setOf("noticeRef","title","body","bodyDocument","attachmentRefs"),"changeAccess" to setOf("subjectRef","role","department","teamId","departmentManager","active"),
            "saveDepartmentContact" to setOf("department","phone"),
            "saveCentralPerson" to setOf("personRef","department","category","rank","displayName","serviceNumber","internalPhone","active"),
            "saveAbsence" to setOf("absenceRef","personRef","absenceType","startDate","endDate"),
            "saveAbsenceBatch" to setOf("department","text"),
            "saveDutySchedule" to setOf("month","date","seat","personRefs"),
            "saveDutyScheduleBatch" to setOf("month","seat","entries","text","mode"))
    }
    private fun now()=Instant.now().toString()
    private fun requireDepartmentReader(actor:Actor) { if(actor.role !in listOf("bnoc","team") && !actor.departmentManager) reject("FORBIDDEN") }
    fun authorize(actor:Actor,command:Command) {
        when(command.type) {
            "savePersonnelRoster","saveDailyPersonnel","saveNightDuty" -> reject("FORBIDDEN")
            "saveCentralPerson","saveAbsence","saveAbsenceBatch" -> if(actor.role!="bnoc") reject("FORBIDDEN")
            "saveDutySchedule" -> {
                val seat=text(command.payload,"seat",48,true)
                if(!((actor.role=="bnoc" && seat in officerDutySeats) || (actor.role=="team" && seat=="team_night"))) reject("FORBIDDEN")
            }
            "saveDutyScheduleBatch" -> {
                val seat=text(command.payload,"seat",48,true)
                if(!((actor.role=="bnoc" && seat in officerDutySeats) || (actor.role=="team" && seat=="team_night"))) reject("FORBIDDEN")
            }
            "createDirective","updateDirective" -> if(actor.role!="bnoc") reject("FORBIDDEN")
            "saveDepartmentContact" -> if(actor.role!="admin") reject("FORBIDDEN")
            "changeAccess" -> if(!actor.accessAdmin || actor.role!="admin") reject("FORBIDDEN")
            else -> reject("VALIDATION")
        }
    }
    fun authorizeReceipt(actor:Actor,type:String,result:CommandResult) {
        when(type) {
            "savePersonnelRoster","saveDailyPersonnel","saveNightDuty" -> reject("FORBIDDEN")
            "saveCentralPerson","saveAbsence","saveAbsenceBatch" -> if(actor.role!="bnoc") reject("FORBIDDEN")
            "saveDutySchedule" -> {
                val parts=result.publicRef?.split('|') ?: emptyList()
                if(parts.size!=4 || !((actor.role=="bnoc" && parts[2] in officerDutySeats && parts[3]=="BNOC") || (actor.role=="team" && parts[2]=="team_night" && parts[3]==actor.teamId))) reject("FORBIDDEN")
            }
            "saveDutyScheduleBatch" -> {
                val parts=result.publicRef?.split('|') ?: emptyList()
                if(parts.size!=4 || parts[1]!="batch" || !((actor.role=="bnoc" && parts[2] in officerDutySeats && parts[3]=="BNOC") || (actor.role=="team" && parts[2]=="team_night" && parts[3]==actor.teamId))) reject("FORBIDDEN")
            }
            "createDirective","updateDirective" -> if(actor.role!="bnoc") reject("FORBIDDEN")
            "saveDepartmentContact" -> if(actor.role!="admin") reject("FORBIDDEN")
            "changeAccess" -> if(!actor.accessAdmin || actor.role!="admin") reject("FORBIDDEN")
        }
    }
    fun execute(actor:Actor,command:Command,workflow:WorkflowService):CommandResult=when(command.type) {
        "savePersonnelRoster" -> saveRoster(actor,command)
        "saveDailyPersonnel" -> saveDaily(actor,command)
        "saveNightDuty" -> saveNight(actor,command)
        "saveDepartmentContact" -> saveDepartmentContact(actor,command)
        "saveCentralPerson" -> saveCentralPerson(actor,command)
        "saveAbsence" -> saveAbsence(actor,command)
        "saveAbsenceBatch" -> saveAbsenceBatch(actor,command)
        "saveDutySchedule" -> saveDutySchedule(actor,command)
        "saveDutyScheduleBatch" -> saveDutyScheduleBatch(actor,command)
        "createDirective","updateDirective" -> saveDirective(actor,command,workflow)
        "changeAccess" -> changeAccess(actor,command)
        else -> reject("VALIDATION")
    }
    private fun revision(command:Command,actual:Long) { if(command.expectedRevision==null) reject("VALIDATION",mapOf("expectedRevision" to "버전이 필요합니다."));if(command.expectedRevision!=actual) reject("CONFLICT") }
    fun departmentContacts():Map<String,Any?> = mapOf("items" to db.teams.mapNotNull { department ->
        db.rows("SELECT phone,revision FROM bnoc_department_contacts WHERE department=?",department).firstOrNull()?.let {
            mapOf("department" to department,"phone" to it["phone"],"revision" to it["revision"])
        }
    })
    private fun saveDepartmentContact(actor:Actor,command:Command):CommandResult {
        val department=text(command.payload,"department",100,true)
        if(department !in db.teams) reject("VALIDATION",mapOf("department" to "작업반을 선택하세요."))
        db.lockResource("department-contact:$department")
        val before=db.rows("SELECT phone,revision FROM bnoc_department_contacts WHERE department=? FOR UPDATE",department).firstOrNull() ?: reject("NOT_FOUND")
        val currentRevision=(before["revision"] as Number).toLong()
        revision(command,currentRevision)
        val phone=phoneText(command.payload,"phone",true)
        if(phone==before["phone"]) return CommandResult(publicRef=department,revision=currentRevision)
        db.jdbc.update("UPDATE bnoc_department_contacts SET phone=?,revision=? WHERE department=?",phone,currentRevision+1,department)
        db.operationsHistory(actor,"department-contact",department,before,mapOf("phone" to phone,"revision" to currentRevision+1))
        return CommandResult(publicRef=department,revision=currentRevision+1)
    }
    fun listRoster(actor:Actor,department:String):Map<String,Any?> {
        requireDepartmentReader(actor)
        if(department !in db.departments) reject("VALIDATION",mapOf("department" to "부서를 선택하세요."))
        val version=db.rows("SELECT revision FROM bnoc_roster_versions WHERE department=?",department).firstOrNull()?.get("revision") as? Number
        return mapOf("department" to department,"revision" to (version?.toLong() ?: 0),"entries" to roster(department))
    }
    fun roster(department:String):List<Map<String,Any?>> = db.rows("SELECT person_ref,display_name,active FROM bnoc_roster WHERE department=? ORDER BY display_name,person_ref",department).map { mapOf("personRef" to it["person_ref"],"displayName" to it["display_name"],"active" to it["active"]) }
    private val ranksByCategory=mapOf(
        "병" to listOf("이병","일병","상병","병장"),
        "간부" to listOf("하사","중사","상사","원사","준위","소위","중위","대위","소령","중령","대령","준장","소장","중장","대장"),
        "군무원" to (1..9).map { "${it}급" }
    )
    private val absenceTypes=listOf("휴가","외박","출장","파견","교육","기타")
    private val dutySeats=officerDutySeats+"team_night"
    private fun directoryRevision()=(db.rows("SELECT revision FROM bnoc_personnel_directory_versions WHERE version_key=1").firstOrNull()?.get("revision") as? Number)?.toLong() ?: 0L
    private fun absenceRows(personRef:String):List<Map<String,Any?>> = db.rows("SELECT absence_ref,absence_type,starts_on,ends_on,revision FROM bnoc_absences WHERE person_ref=? ORDER BY starts_on,ends_on,absence_ref",personRef).map { row -> mapOf("absenceRef" to row["absence_ref"],"absenceType" to row["absence_type"],"startDate" to row["starts_on"],"endDate" to row["ends_on"],"revision" to row["revision"]) }
    fun listCentralRoster(actor:Actor,department:String?):Map<String,Any?> {
        if(actor.role !in listOf("bnoc","team")) reject("FORBIDDEN")
        val selected=department?.takeIf { it.isNotBlank() }
        if(selected!=null && selected !in db.departments) reject("VALIDATION",mapOf("department" to "부서를 선택하세요."))
        if(actor.role=="team" && selected!=null && selected!=actor.teamId) reject("FORBIDDEN")
        val scope=if(actor.role=="team") actor.teamId else selected
        val rows=if(scope==null) db.rows("SELECT r.person_ref,r.department,r.display_name,r.active,p.person_category,p.rank_name,p.service_number,p.internal_phone FROM bnoc_roster r LEFT JOIN bnoc_personnel_profiles p ON p.person_ref=r.person_ref ORDER BY r.department,r.display_name,r.person_ref")
            else db.rows("SELECT r.person_ref,r.department,r.display_name,r.active,p.person_category,p.rank_name,p.service_number,p.internal_phone FROM bnoc_roster r LEFT JOIN bnoc_personnel_profiles p ON p.person_ref=r.person_ref WHERE r.department=? ORDER BY r.display_name,r.person_ref",scope)
        val entries=rows.map { row ->
            val ref=row["person_ref"] as String
            mutableMapOf<String,Any?>("personRef" to ref,"department" to row["department"],"displayName" to row["display_name"],"active" to row["active"],"category" to row["person_category"],"rank" to row["rank_name"],"complete" to (row["service_number"]!=null),"absences" to absenceRows(ref)).also { entry ->
                if(actor.role=="bnoc") { entry["serviceNumber"]=row["service_number"];entry["internalPhone"]=row["internal_phone"] }
            }
        }
        return mapOf("department" to selected,"revision" to directoryRevision(),"entries" to entries,"categories" to ranksByCategory.mapValues { it.value })
    }
    private fun saveCentralPerson(actor:Actor,command:Command):CommandResult {
        db.lockResource("personnel-directory")
        val beforeRevision=directoryRevision();revision(command,beforeRevision)
        val payload=command.payload
        val personRef=when(val value=payload["personRef"]) { null -> UUID.randomUUID().toString();is String -> value;else -> reject("VALIDATION") }
        val before=db.rows("SELECT r.person_ref,r.department,r.display_name,r.active,p.person_category,p.rank_name,p.service_number,p.internal_phone FROM bnoc_roster r LEFT JOIN bnoc_personnel_profiles p ON p.person_ref=r.person_ref WHERE r.person_ref=?",personRef).firstOrNull()
        if(payload["personRef"]!=null && before==null) reject("NOT_FOUND")
        val department=text(payload,"department",100,true)
        if(department !in db.departments) reject("VALIDATION",mapOf("department" to "부서를 선택하세요."))
        val category=text(payload,"category",16,true)
        val rank=text(payload,"rank",32,true)
        if(rank !in ranksByCategory[category].orEmpty()) reject("VALIDATION",mapOf("rank" to "인원 구분에 맞는 계급을 선택하세요."))
        val name=text(payload,"displayName",100,true)
        val serviceNumber=text(payload,"serviceNumber",64,true)
        if(serviceNumber.any { it.isISOControl() } || serviceNumber.any { it.isWhitespace() }) reject("VALIDATION",mapOf("serviceNumber" to "군번을 확인하세요."))
        val duplicate=db.rows("SELECT person_ref FROM bnoc_personnel_profiles WHERE service_number=? AND person_ref<>?",serviceNumber,personRef).isNotEmpty()
        if(duplicate) reject("VALIDATION",mapOf("serviceNumber" to "이미 등록된 군번입니다."))
        val phone=phoneText(payload,"internalPhone",existing=before?.get("internal_phone") as? String).ifBlank { null }
        val active=payload["active"] as? Boolean ?: reject("VALIDATION",mapOf("active" to "활성 여부를 확인하세요."))
        val beforeView=before?.let { it+mapOf("absences" to absenceRows(personRef)) }
        db.jdbc.update("INSERT INTO bnoc_roster(person_ref,department,display_name,active) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE department=VALUES(department),display_name=VALUES(display_name),active=VALUES(active)",personRef,department,name,active)
        db.jdbc.update("INSERT INTO bnoc_personnel_profiles(person_ref,person_category,rank_name,service_number,internal_phone) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE person_category=VALUES(person_category),rank_name=VALUES(rank_name),service_number=VALUES(service_number),internal_phone=VALUES(internal_phone)",personRef,category,rank,serviceNumber,phone)
        val after=mapOf("personRef" to personRef,"department" to department,"displayName" to name,"category" to category,"rank" to rank,"serviceNumber" to serviceNumber,"internalPhone" to phone,"active" to active)
        db.jdbc.update("INSERT INTO bnoc_personnel_directory_versions(version_key,revision) VALUES (1,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision)",beforeRevision+1)
        (listOfNotNull(before?.get("department") as? String,department)).distinct().forEach { dept ->
            val version=(db.rows("SELECT revision FROM bnoc_roster_versions WHERE department=?",dept).firstOrNull()?.get("revision") as? Number)?.toLong() ?: 0L
            db.jdbc.update("INSERT INTO bnoc_roster_versions(department,revision) VALUES (?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision)",dept,version+1)
        }
        db.operationsHistory(actor,"personnel-directory",personRef,beforeView,after)
        return CommandResult(publicRef=personRef,revision=beforeRevision+1)
    }
    private fun saveAbsence(actor:Actor,command:Command):CommandResult {
        val ref=when(val value=command.payload["absenceRef"]) { null -> UUID.randomUUID().toString();is String -> value;else -> reject("VALIDATION") }
        db.lockResource("absence:$ref")
        val before=db.rows("SELECT * FROM bnoc_absences WHERE absence_ref=?",ref).firstOrNull()
        if(command.payload["absenceRef"]!=null && before==null) reject("NOT_FOUND")
        val actual=(before?.get("revision") as? Number)?.toLong() ?: 0L;revision(command,actual)
        val personRef=text(command.payload,"personRef",36,true)
        if(db.rows("SELECT r.person_ref FROM bnoc_roster r JOIN bnoc_personnel_profiles p ON p.person_ref=r.person_ref WHERE r.person_ref=?",personRef).isEmpty()) reject("VALIDATION",mapOf("personRef" to "중앙 명부에 등록된 인원을 선택하세요."))
        val type=text(command.payload,"absenceType",16,true)
        if(type !in absenceTypes) reject("VALIDATION",mapOf("absenceType" to "부재 종류를 선택하세요."))
        val start=dateValue(text(command.payload,"startDate",10,true));val end=dateValue(text(command.payload,"endDate",10,true))
        if(end<start) reject("VALIDATION",mapOf("endDate" to "종료일은 시작일 이후로 입력하세요."))
        val beforeView=before?.let { it+mapOf("absenceRef" to ref) }
        val now=now();val next=actual+1
        if(before==null) db.jdbc.update("INSERT INTO bnoc_absences(absence_ref,person_ref,absence_type,starts_on,ends_on,revision,recorded_by,recorded_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",ref,personRef,type,start,end,next,actor.id,now,now)
        else db.jdbc.update("UPDATE bnoc_absences SET person_ref=?,absence_type=?,starts_on=?,ends_on=?,revision=?,updated_at=? WHERE absence_ref=? AND revision=?",personRef,type,start,end,next,now,ref,actual).also { if(it!=1) reject("CONFLICT") }
        val after=mapOf("absenceRef" to ref,"personRef" to personRef,"absenceType" to type,"startDate" to start,"endDate" to end,"revision" to next)
        db.operationsHistory(actor,"personnel-absence",ref,beforeView,after)
        return CommandResult(publicRef=ref,revision=next)
    }
    private fun saveAbsenceBatch(actor:Actor,command:Command):CommandResult {
        db.lockResource("personnel-directory")
        revision(command,directoryRevision())
        val department=text(command.payload,"department",100,true)
        if(department !in db.departments) reject("VALIDATION",mapOf("department" to "부서를 선택하세요."))
        val raw=text(command.payload,"text",20000,true)
        val lines=raw.split(Regex("\\r?\\n")).mapIndexedNotNull { index,value -> value.trim().takeIf { it.isNotEmpty() }?.let { (index+1) to it } }
        if(lines.isEmpty() || lines.size>100) reject("VALIDATION",mapOf("text" to "부재 목록은 1~100줄로 입력하세요."))
        data class Entry(val line:Int,val personRef:String,val type:String,val start:String,val end:String)
        val entries=lines.map { (line,value) ->
            fun invalid(message:String):Nothing=reject("VALIDATION",mapOf("text" to "${line}줄: $message"))
            val parts=value.split(Regex("\\s+"))
            if(parts.size<5) invalid("계급 이름 구분 시작일 종료일 형식으로 입력하세요.")
            val rank=parts.first();val name=parts.subList(1,parts.size-3).joinToString(" ");val type=parts[parts.size-3]
            if(type !in absenceTypes) invalid("구분은 휴가·외박·출장·파견·교육·기타 중 하나로 입력하세요.")
            fun day(value:String):String {
                val normalized=if(value.matches(Regex("\\d{8}"))) "${value.substring(0,4)}-${value.substring(4,6)}-${value.substring(6,8)}" else value
                return runCatching { dateValue(normalized) }.getOrElse { invalid("실제 날짜를 YYYY-MM-DD 또는 YYYYMMDD로 입력하세요.") }
            }
            val start=day(parts[parts.size-2]);val end=day(parts.last())
            if(end<start) invalid("종료일은 시작일 이후로 입력하세요.")
            val candidates=db.rows("SELECT r.person_ref FROM bnoc_roster r JOIN bnoc_personnel_profiles p ON p.person_ref=r.person_ref WHERE r.department=? AND r.display_name=? AND p.rank_name=? AND r.active=TRUE",department,name,rank)
            if(candidates.size!=1) invalid("선택 부서의 활성 명부에서 계급·이름이 정확히 한 명과 일치해야 합니다.")
            val ref=candidates.single()["person_ref"] as String
            if(db.rows("SELECT absence_ref FROM bnoc_absences WHERE person_ref=? AND starts_on<=? AND ends_on>=?",ref,end,start).isNotEmpty()) invalid("기존 부재 기간과 겹칩니다.")
            Entry(line,ref,type,start,end)
        }
        entries.forEachIndexed { index,entry ->
            if(entries.take(index).any { it.personRef==entry.personRef && it.start<=entry.end && it.end>=entry.start })
                reject("VALIDATION",mapOf("text" to "${entry.line}줄: 입력 목록의 같은 인원 부재 기간과 겹칩니다."))
        }
        // Validate every row before the first write; the command transaction also covers history and receipt.
        entries.forEach { entry -> saveAbsence(actor,command.copy(expectedRevision=0,payload=mapOf("personRef" to entry.personRef,"absenceType" to entry.type,"startDate" to entry.start,"endDate" to entry.end))) }
        return CommandResult(publicRef="absence-batch|$department",revision=1)
    }
    fun personnelSummary(actor:Actor,date:String,department:String?):Map<String,Any?> {
        if(actor.role !in listOf("bnoc","team")) reject("FORBIDDEN")
        val day=dateValue(date);val selected=department?.takeIf { it.isNotBlank() }
        if(selected!=null && selected !in db.departments) reject("VALIDATION")
        if(actor.role=="team" && selected!=null && selected!=actor.teamId) reject("FORBIDDEN")
        val departments=if(actor.role=="team") listOf(actor.teamId ?: reject("FORBIDDEN")) else selected?.let(::listOf) ?: db.departments
        val results=departments.map { dept ->
            val people=db.rows("SELECT person_ref FROM bnoc_roster WHERE department=? AND active=TRUE",dept)
            val refs=people.map { it["person_ref"] as String }
            val absences=if(refs.isEmpty()) emptyList() else db.rows("SELECT person_ref,absence_type FROM bnoc_absences WHERE starts_on<=? AND ends_on>=? AND person_ref IN (${refs.joinToString(",") { "?" }})",day,day,*refs.toTypedArray())
            val absent=absences.map { it["person_ref"] as String }.toSet()
            mapOf("department" to dept,"total" to refs.size,"absent" to absent.size,"current" to refs.size-absent.size,"byAbsenceType" to absenceTypes.associateWith { type -> absences.filter { it["absence_type"]==type }.map { it["person_ref"] }.distinct().size })
        }
        return mapOf("date" to day,"departments" to results,"total" to results.sumOf { it["total"] as Int },"absent" to results.sumOf { it["absent"] as Int },"current" to results.sumOf { it["current"] as Int })
    }
    private fun saveDutySchedule(actor:Actor,command:Command):CommandResult {
        val month=text(command.payload,"month",7,true)
        if(!month.matches(Regex("\\d{4}-\\d{2}")) || runCatching { LocalDate.parse("$month-01") }.isFailure) reject("VALIDATION",mapOf("month" to "근무표 월을 확인하세요."))
        val day=dateValue(text(command.payload,"date",10,true));if(!day.startsWith("$month-")) reject("VALIDATION",mapOf("date" to "선택한 월에 속한 날짜를 입력하세요."))
        val seat=text(command.payload,"seat",48,true);if(seat !in dutySeats) reject("VALIDATION",mapOf("seat" to "근무 자리를 확인하세요."))
        val scope=when {
            actor.role=="bnoc" && seat in officerDutySeats -> "BNOC"
            actor.role=="team" && seat=="team_night" -> actor.teamId ?: reject("FORBIDDEN")
            else -> reject("FORBIDDEN")
        }
        val key="$month|$day|$seat|$scope";db.lockResource("duty:$key")
        val before=db.rows("SELECT * FROM bnoc_duty_schedules WHERE month_key=? AND duty_date=? AND seat=? AND scope_key=?",month,day,seat,scope).firstOrNull()
        val actual=(before?.get("revision") as? Number)?.toLong() ?: 0L;revision(command,actual)
        val refs=stringRefs(command.payload["personRefs"],"personRefs")
        if(refs.isEmpty()) reject("VALIDATION",mapOf("personRefs" to "근무자 한 명 이상을 선택하세요."))
        val beforeRefs=before?.get("person_refs")?.let { db.json.readValue<List<String>>(it as String) } ?: emptyList()
        val people=refs.map { ref ->
            val member=db.rows("SELECT r.department,r.active,p.person_category FROM bnoc_roster r JOIN bnoc_personnel_profiles p ON p.person_ref=r.person_ref WHERE r.person_ref=?",ref).firstOrNull() ?: reject("VALIDATION",mapOf("personRefs" to "중앙 명부의 인원을 선택하세요."))
            if(ref !in beforeRefs && (member["active"]!=true || (seat=="team_night" && member["department"]!=scope) || (seat!="team_night" && member["person_category"]!="간부"))) reject("VALIDATION",mapOf("personRefs" to "근무 자리에 맞는 활성 인원을 선택하세요."))
            if(ref !in beforeRefs && db.rows("SELECT absence_ref FROM bnoc_absences WHERE person_ref=? AND starts_on<=? AND ends_on>=?",ref,day,day).isNotEmpty()) reject("VALIDATION",mapOf("personRefs" to "부재 기간과 겹치는 인원은 근무자로 저장할 수 없습니다."))
            ref
        }
        val next=actual+1;val now=now();val json=db.json.writeValueAsString(people)
        if(before==null) db.jdbc.update("INSERT INTO bnoc_duty_schedules(month_key,duty_date,seat,scope_key,person_refs,revision,saved_by,saved_at) VALUES (?,?,?,?,?,?,?,?)",month,day,seat,scope,json,next,actor.id,now)
        else db.jdbc.update("UPDATE bnoc_duty_schedules SET person_refs=?,revision=?,saved_by=?,saved_at=? WHERE month_key=? AND duty_date=? AND seat=? AND scope_key=? AND revision=?",json,next,actor.id,now,month,day,seat,scope,actual).also { if(it!=1) reject("CONFLICT") }
        db.operationsHistory(actor,"duty-schedule",key,before?.get("person_refs")?.let { db.json.readValue<List<String>>(it as String) },people)
        return CommandResult(publicRef=key,revision=next)
    }
    private fun saveDutyScheduleBatch(actor:Actor,command:Command):CommandResult {
        val month=text(command.payload,"month",7,true)
        if(!month.matches(Regex("\\d{4}-(0[1-9]|1[0-2])"))) reject("VALIDATION",mapOf("month" to "근무표 월을 확인하세요."))
        val seat=text(command.payload,"seat",48,true);if(seat !in dutySeats) reject("VALIDATION",mapOf("seat" to "근무 자리를 확인하세요."))
        val scope=when {
            actor.role=="bnoc" && seat in officerDutySeats -> "BNOC"
            actor.role=="team" && seat=="team_night" -> actor.teamId ?: reject("FORBIDDEN")
            else -> reject("FORBIDDEN")
        }
        val hasText="text" in command.payload;val hasEntries="entries" in command.payload
        if(hasText==hasEntries) reject("VALIDATION",mapOf("entries" to "텍스트 또는 날짜별 근무자 입력을 선택하세요."))
        val mode=command.payload["mode"] as? String
        if("mode" in command.payload && mode !in listOf("append","replace")) reject("VALIDATION",mapOf("mode" to "편성 방식을 확인하세요."))
        data class Change(val date:String,val refs:List<String>,val revision:Long?,val line:Int?,val beforeRefs:List<String> = emptyList(),val inputCount:Int=0,val mergeExisting:Boolean=false)
        val changes=if(hasText) {
            val raw=text(command.payload,"text",20000,true)
            val lines=raw.split(Regex("\\r?\\n")).mapIndexedNotNull { index,value -> value.trim().takeIf { it.isNotEmpty() }?.let { (index+1) to it } }
            if(lines.isEmpty() || lines.size>500) reject("VALIDATION",mapOf("text" to "근무자 목록을 입력하세요."))
            val parsed=lines.map { (line,value) ->
                val parts=value.split(Regex("\\s+"))
                if(parts.size<3 || !parts[0].matches(Regex("\\d{8}"))) reject("VALIDATION",mapOf("text" to "${line}행: YYYYMMDD 계급 이름 형식으로 입력하세요."))
                val date=runCatching { dateValue("${parts[0].substring(0,4)}-${parts[0].substring(4,6)}-${parts[0].substring(6,8)}") }.getOrElse { reject("VALIDATION",mapOf("text" to "${line}행: 실제 날짜를 입력하세요.")) }
                if(!date.startsWith("$month-")) reject("VALIDATION",mapOf("text" to "${line}행: 선택한 월의 날짜를 입력하세요."))
                val rank=parts[1];val name=parts.drop(2).joinToString(" ")
                val candidates=db.rows("SELECT r.person_ref FROM bnoc_roster r JOIN bnoc_personnel_profiles p ON p.person_ref=r.person_ref WHERE r.display_name=? AND p.rank_name=? AND r.active=TRUE AND "+(if(seat=="team_night") "r.department=?" else "p.person_category='간부'"),*(if(seat=="team_night") arrayOf(name,rank,scope) else arrayOf(name,rank)))
                if(candidates.size!=1) reject("VALIDATION",mapOf("text" to "${line}행: 편성 가능한 계급·이름을 명부에서 하나만 찾을 수 있어야 합니다."))
                val ref=candidates.single()["person_ref"] as String
                val existingRefs=db.rows("SELECT person_refs FROM bnoc_duty_schedules WHERE month_key=? AND duty_date=? AND seat=? AND scope_key=?",month,date,seat,scope).firstOrNull()?.get("person_refs")?.let { db.json.readValue<List<String>>(it as String) }.orEmpty()
                if(ref !in existingRefs && db.rows("SELECT absence_ref FROM bnoc_absences WHERE person_ref=? AND starts_on<=? AND ends_on>=?",ref,date,date).isNotEmpty()) reject("VALIDATION",mapOf("text" to "${line}행: 부재 기간과 겹치는 인원입니다."))
                Triple(date,ref,line)
            }
            if(parsed.map { "${it.first}|${it.second}" }.distinct().size!=parsed.size) reject("VALIDATION",mapOf("text" to "같은 날짜에 같은 인원을 두 번 입력했습니다."))
            parsed.groupBy { it.first }.toSortedMap().map { (date,items) ->
                val key="$month|$date|$seat|$scope";db.lockResource("duty:$key")
                val existing=db.rows("SELECT person_refs,revision FROM bnoc_duty_schedules WHERE month_key=? AND duty_date=? AND seat=? AND scope_key=? FOR UPDATE",month,date,seat,scope).firstOrNull()
                val before=existing?.get("person_refs")?.let { db.json.readValue<List<String>>(it as String) }.orEmpty()
                val actual=(existing?.get("revision") as? Number)?.toLong() ?: 0L
                val additions=items.map { it.second }.filter { it !in before }
                Change(date,before+additions,actual,null,before,items.size,mergeExisting=true)
            }
        } else {
            val raw=command.payload["entries"] as? List<*> ?: reject("VALIDATION",mapOf("entries" to "날짜별 근무자 목록을 확인하세요."))
            if(raw.isEmpty() || raw.size>31) reject("VALIDATION",mapOf("entries" to "한 달의 날짜별 입력만 저장할 수 있습니다."))
            val rows=raw.map { item ->
                val row=item as? Map<*,*> ?: reject("VALIDATION")
                if(row.keys.any { it !in setOf("date","personRefs","expectedRevision") }) reject("VALIDATION")
                @Suppress("UNCHECKED_CAST") val values=row as Map<String,Any?>
                val date=dateValue(text(values,"date",10,true));if(!date.startsWith("$month-")) reject("VALIDATION",mapOf("date" to "선택한 월에 속한 날짜를 입력하세요."))
                val refs=stringRefs(values["personRefs"],"personRefs");if(refs.isEmpty()) reject("VALIDATION",mapOf("personRefs" to "근무자 한 명 이상을 선택하세요."))
                val expected=(values["expectedRevision"] as? Number)?.toLong() ?: reject("VALIDATION",mapOf("expectedRevision" to "근무표 버전이 필요합니다."))
                if((values["expectedRevision"] as Number).toDouble()!=expected.toDouble() || expected<0) reject("VALIDATION",mapOf("expectedRevision" to "근무표 버전을 확인하세요."))
                Change(date,refs,expected,null,mergeExisting=mode=="append" || (mode==null && raw.size>1))
            }
            if(rows.map { it.date }.distinct().size!=rows.size) reject("VALIDATION",mapOf("entries" to "날짜별 입력은 한 번씩만 포함하세요."))
            rows.sortedBy { it.date }.onEach { db.lockResource("duty:$month|${it.date}|$seat|$scope") }
        }
        var added=0;var already=0;var lastRevision=0L
        val validated=changes.map { change ->
            val key="$month|${change.date}|$seat|$scope"
            val before=db.rows("SELECT * FROM bnoc_duty_schedules WHERE month_key=? AND duty_date=? AND seat=? AND scope_key=? FOR UPDATE",month,change.date,seat,scope).firstOrNull()
            val actual=(before?.get("revision") as? Number)?.toLong() ?: 0L
            if(change.revision!=null && change.revision!=actual) reject("CONFLICT")
            if(change.line==null && change.refs.isEmpty()) reject("VALIDATION",mapOf("personRefs" to "근무자 한 명 이상을 선택하세요."))
            val beforeRefs=before?.get("person_refs")?.let { db.json.readValue<List<String>>(it as String) }.orEmpty()
            val refs=if(change.mergeExisting) beforeRefs+change.refs.filterNot { it in beforeRefs } else change.refs
            if(refs.distinct().size!=refs.size) reject("VALIDATION",mapOf("personRefs" to "중복 인원을 제거하세요."))
            refs.forEach { ref ->
                val member=db.rows("SELECT r.department,r.active,p.person_category FROM bnoc_roster r JOIN bnoc_personnel_profiles p ON p.person_ref=r.person_ref WHERE r.person_ref=?",ref).firstOrNull() ?: reject("VALIDATION",mapOf("personRefs" to "중앙 명부의 인원을 선택하세요."))
                if(ref !in beforeRefs && (member["active"]!=true || (seat=="team_night" && member["department"]!=scope) || (seat!="team_night" && member["person_category"]!="간부"))) reject("VALIDATION",mapOf("personRefs" to "근무 자리에 맞는 활성 인원을 선택하세요."))
                if(ref !in beforeRefs && db.rows("SELECT absence_ref FROM bnoc_absences WHERE person_ref=? AND starts_on<=? AND ends_on>=?",ref,change.date,change.date).isNotEmpty()) reject("VALIDATION",mapOf("personRefs" to "부재 기간과 겹치는 인원은 근무자로 저장할 수 없습니다."))
            }
            val newRefs=if(hasText) refs.filter { it !in beforeRefs } else refs
            added+=newRefs.size;already+=(if(hasText) change.inputCount-newRefs.size else 0)
            Change(change.date,if(hasText) beforeRefs+newRefs else refs,actual,null,beforeRefs,mergeExisting=change.mergeExisting)
        }
        var savedDates=0
        validated.forEach { change ->
            val key="$month|${change.date}|$seat|$scope";val next=change.revision!!+1;val now=now();val json=db.json.writeValueAsString(change.refs)
            if((hasText||change.mergeExisting) && change.refs==change.beforeRefs) return@forEach
            if(next==1L) db.jdbc.update("INSERT INTO bnoc_duty_schedules(month_key,duty_date,seat,scope_key,person_refs,revision,saved_by,saved_at) VALUES (?,?,?,?,?,?,?,?)",month,change.date,seat,scope,json,next,actor.id,now)
            else db.jdbc.update("UPDATE bnoc_duty_schedules SET person_refs=?,revision=?,saved_by=?,saved_at=? WHERE month_key=? AND duty_date=? AND seat=? AND scope_key=? AND revision=?",json,next,actor.id,now,month,change.date,seat,scope,change.revision).also { if(it!=1) reject("CONFLICT") }
            db.operationsHistory(actor,"duty-schedule",key,change.beforeRefs,change.refs);lastRevision=maxOf(lastRevision,next)
            savedDates++
        }
        val state=if(hasText) "${added}명 추가${if(already>0) " · ${already}명 기존 편성" else ""}" else if(savedDates==0) "변경 없음" else "${savedDates}일 저장"
        return CommandResult(publicRef="$month|batch|$seat|$scope",revision=lastRevision,state=state)
    }
    fun listDutySchedules(actor:Actor,month:String,seat:String?=null):Map<String,Any?> {
        if(actor.role !in listOf("bnoc","team","requester","admin")) reject("FORBIDDEN")
        if(!month.matches(Regex("\\d{4}-\\d{2}")) || runCatching { LocalDate.parse("$month-01") }.isFailure) reject("VALIDATION",mapOf("month" to "근무표 월을 확인하세요."))
        if(seat!=null && seat !in dutySeats) reject("VALIDATION")
        val rows=when {
            seat!=null -> db.rows("SELECT * FROM bnoc_duty_schedules WHERE month_key=? AND seat=? ORDER BY duty_date,scope_key",month,seat)
            else -> db.rows("SELECT * FROM bnoc_duty_schedules WHERE month_key=? ORDER BY duty_date,seat,scope_key",month)
        }
        val entries=rows.map { row ->
            val refs=db.json.readValue<List<String>>(row["person_refs"] as String)
            val people=refs.map { ref ->
                val member=db.rows("SELECT r.display_name,r.department,r.active,p.rank_name,p.person_category FROM bnoc_roster r LEFT JOIN bnoc_personnel_profiles p ON p.person_ref=r.person_ref WHERE r.person_ref=?",ref).firstOrNull()
                val absence=absenceRows(ref).filter { (it["startDate"] as String)<=row["duty_date"] as String && (it["endDate"] as String)>=row["duty_date"] as String }
                val mayEditPerson=actor.role=="bnoc" || (actor.role=="team" && row["seat"]=="team_night" && row["scope_key"]==actor.teamId)
                if(mayEditPerson) mapOf("personRef" to ref,"displayName" to member?.get("display_name"),"department" to member?.get("department"),"active" to member?.get("active"),"rank" to member?.get("rank_name"),"category" to member?.get("person_category"),"conflict" to absence.isNotEmpty())
                else mapOf("displayName" to member?.get("display_name"),"rank" to member?.get("rank_name"))
            }
            mapOf("month" to row["month_key"],"date" to row["duty_date"],"seat" to row["seat"],"scopeKey" to row["scope_key"],"revision" to row["revision"],"people" to people)
        }
        return mapOf("month" to month,"entries" to entries)
    }
    fun validateMembers(department:String,refs:List<String>,existing:List<String> = emptyList()):List<Map<String,Any?>> {
        if(refs.distinct().size!=refs.size) reject("VALIDATION",mapOf("personRefs" to "중복 인원을 제거하세요."))
        return refs.map { ref ->
            val row=db.rows("SELECT * FROM bnoc_roster WHERE person_ref=?",ref).firstOrNull() ?: reject("VALIDATION",mapOf("personRefs" to "부서 명부의 인원을 선택하세요."))
            if(row["department"]!=department || (row["active"]!=true && ref !in existing)) reject("VALIDATION",mapOf("personRefs" to "자기 부서의 활성 명부에서 선택하세요."))
            mapOf("personRef" to ref,"displayName" to row["display_name"])
        }
    }
    fun validateWorkMembers(department:String,refs:List<String>,existing:List<String>,intervals:List<WorkScheduleInterval>) {
        if(refs.distinct().size!=refs.size) reject("VALIDATION",mapOf("assignedPersonRefs" to "중복 인원을 제거하세요."))
        val dates=intervals.flatMap { interval ->
            val start=Instant.parse(interval.startsAt).atZone(ZoneId.of("Asia/Seoul")).toLocalDate()
            val last=Instant.parse(interval.endsAt).minusNanos(1).atZone(ZoneId.of("Asia/Seoul")).toLocalDate()
            generateSequence(start) { previous -> if(previous<last) previous.plusDays(1) else null }.toList()
        }.distinct()
        refs.forEach { ref ->
            val member=db.rows("SELECT r.department,r.display_name,r.active,p.person_category,p.rank_name FROM bnoc_roster r LEFT JOIN bnoc_personnel_profiles p ON p.person_ref=r.person_ref WHERE r.person_ref=?",ref).firstOrNull() ?: reject("VALIDATION",mapOf("assignedPersonRefs" to "중앙 명부의 인원을 선택하세요."))
            val preserved=ref in existing
            if(member["department"]!=department || (member["active"]!=true && !preserved)) reject("VALIDATION",mapOf("assignedPersonRefs" to "자기 작업반의 활성 인원을 선택하세요."))
            if(!preserved && member["rank_name"]==null) reject("VALIDATION",mapOf("assignedPersonRefs" to "계급·이름 정보가 완성된 중앙 명부 인원만 선택할 수 있습니다."))
            if(dates.isNotEmpty()) {
                if(member["rank_name"]==null) reject("VALIDATION",mapOf("assignedPersonRefs" to "일정이 있는 작업에는 명부 정보가 완성된 담당자가 필요합니다."))
                val conflict=dates.firstOrNull { date -> db.rows("SELECT absence_ref FROM bnoc_absences WHERE person_ref=? AND starts_on<=? AND ends_on>=?",ref,date.toString(),date.toString()).isNotEmpty() }
                if(conflict!=null) reject("VALIDATION",mapOf("assignedPersonRefs" to "부재 기간과 겹치는 담당자는 선택할 수 없습니다."))
            }
        }
    }
    private fun saveRoster(actor:Actor,command:Command):CommandResult {
        val department=actor.department;db.lockResource("roster:$department")
        val before=roster(department);val actual=(db.rows("SELECT revision FROM bnoc_roster_versions WHERE department=?",department).firstOrNull()?.get("revision") as? Number)?.toLong() ?: 0
        revision(command,actual)
        val entries=command.payload["entries"] as? List<*> ?: reject("VALIDATION",mapOf("entries" to "명부를 확인하세요."))
        if(entries.size>500) reject("VALIDATION")
        val seen=mutableSetOf<String>()
        val updated=entries.map { item ->
            val row=item as? Map<*,*> ?: reject("VALIDATION")
            if(row.keys.any { it !in setOf("personRef","displayName","active") }) reject("VALIDATION")
            @Suppress("UNCHECKED_CAST") val p=row as Map<String,Any?>
            val ref=when(val input=p["personRef"]) { null -> UUID.randomUUID().toString();is String -> input;else -> reject("VALIDATION") }
            if(!seen.add(ref)) reject("VALIDATION",mapOf("entries" to "중복 인원을 제거하세요."))
            if(p["personRef"]!=null && before.none { it["personRef"]==ref }) reject("VALIDATION",mapOf("entries" to "자기 부서의 명부 참조를 확인하세요."))
            val active=p["active"] as? Boolean ?: reject("VALIDATION",mapOf("active" to "활성 여부를 확인하세요."))
            mapOf("personRef" to ref,"displayName" to text(p,"displayName",100,true),"active" to active)
        }
        val after=(updated+before.filter { it["personRef"] !in seen }.map { it+mapOf("active" to false) }).sortedBy { it["personRef"].toString() }
        val changed=before.sortedBy { it["personRef"].toString() }!=after
        if(changed) {
            after.forEach { entry -> db.jdbc.update("INSERT INTO bnoc_roster(person_ref,department,display_name,active) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE display_name=VALUES(display_name),active=VALUES(active)",entry["personRef"],department,entry["displayName"],entry["active"]) }
            db.jdbc.update("INSERT INTO bnoc_roster_versions(department,revision) VALUES (?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision)",department,actual+1)
            db.operationsHistory(actor,"roster",department,before,after)
        }
        return CommandResult(publicRef=department,revision=if(changed) actual+1 else actual)
    }
    private fun savedRecords(table:String,department:String,date:String):Map<String,Any?>?=db.rows("SELECT * FROM $table WHERE department=? AND record_date=?",department,date).firstOrNull()
    private fun past(date:String)=LocalDate.parse(date).isBefore(LocalDate.now(ZoneId.of("Asia/Seoul")))
    private fun saveDaily(actor:Actor,command:Command):CommandResult {
        val date=dateValue(text(command.payload,"date",10,true));val department=actor.department;db.lockResource("personnel:$department:$date")
        val saved=savedRecords("bnoc_personnel",department,date);val actual=(saved?.get("revision") as? Number)?.toLong() ?: 0;revision(command,actual)
        val before=saved?.get("records_json")?.let { db.json.readValue<List<Map<String,Any?>>>(it as String) } ?: emptyList()
        val entries=command.payload["entries"] as? List<*> ?: reject("VALIDATION")
        val refs=entries.map { (it as? Map<*,*>)?.get("personRef") as? String ?: reject("VALIDATION") }
        val members=validateMembers(department,refs,before.map { it["personRef"] as String }).associateBy { it["personRef"] }
        val after=entries.map { item ->
            val entry=item as Map<*,*>
            if(entry.keys.any { it !in setOf("personRef","status") } || entry["status"] !in listOf("leave","trip","available")) reject("VALIDATION",mapOf("status" to "휴가·출장·가용 중 선택하세요."))
            val ref=entry["personRef"] as String
            val display=if(past(date)) before.firstOrNull { it["personRef"]==ref }?.get("displayName") ?: members[ref]!!["displayName"] else members[ref]!!["displayName"]
            mapOf("personRef" to ref,"displayName" to display,"status" to entry["status"])
        }.sortedBy { it["personRef"].toString() }
        val changed=saved==null || before.sortedBy { it["personRef"].toString() }!=after
        if(changed) { persistRecords("bnoc_personnel",actor,date,actual+1,after);db.operationsHistory(actor,"personnel","$department|$date",before,after) }
        return CommandResult(publicRef="$department|$date",revision=if(changed) actual+1 else actual)
    }
    private fun saveNight(actor:Actor,command:Command):CommandResult {
        val date=dateValue(text(command.payload,"date",10,true));val department=actor.department;db.lockResource("night:$department:$date")
        val saved=savedRecords("bnoc_night_duty",department,date);val actual=(saved?.get("revision") as? Number)?.toLong() ?: 0;revision(command,actual)
        val before=saved?.get("records_json")?.let { db.json.readValue<List<Map<String,Any?>>>(it as String) } ?: emptyList()
        val refs=stringRefs(command.payload["personRefs"],"personRefs")
        val members=validateMembers(department,refs,before.map { it["personRef"] as String })
        val after=members.map { entry -> if(past(date)) entry+mapOf("displayName" to (before.firstOrNull { it["personRef"]==entry["personRef"] }?.get("displayName") ?: entry["displayName"])) else entry }.sortedBy { it["personRef"].toString() }
        val changed=saved==null || before.sortedBy { it["personRef"].toString() }!=after
        if(changed) { persistRecords("bnoc_night_duty",actor,date,actual+1,after);db.operationsHistory(actor,"night-duty","$department|$date",before,after) }
        return CommandResult(publicRef="$department|$date",revision=if(changed) actual+1 else actual)
    }
    private fun persistRecords(table:String,actor:Actor,date:String,revision:Long,entries:List<Map<String,Any?>>)=db.jdbc.update("INSERT INTO $table(department,record_date,revision,records_json,saved_by,saved_at) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE revision=VALUES(revision),records_json=VALUES(records_json),saved_by=VALUES(saved_by),saved_at=VALUES(saved_at)",actor.department,date,revision,db.json.writeValueAsString(entries),actor.id,now())
    fun personnel(actor:Actor,date:String,department:String?):Map<String,Any?> {
        requireDepartmentReader(actor);dateValue(date)
        val departments=selectedDepartments(department).map { d ->
            val row=savedRecords("bnoc_personnel",d,date)
            val saved=row?.get("records_json")?.let { db.json.readValue<List<Map<String,Any?>>>(it as String) } ?: emptyList()
            val recorded=saved.map { it["personRef"] as String }.toSet()
            val entries=saved+roster(d).filter { it["active"]==true && it["personRef"] !in recorded }.map { mapOf("personRef" to it["personRef"],"displayName" to it["displayName"],"status" to null) }
            mapOf("department" to d,"revision" to ((row?.get("revision") as? Number)?.toLong() ?: 0),"submitted" to (row!=null),"entries" to entries,"counts" to mapOf("leave" to saved.count { it["status"]=="leave" },"trip" to saved.count { it["status"]=="trip" },"available" to saved.count { it["status"]=="available" },"unrecorded" to entries.count { it["status"]==null }))
        }
        return mapOf("date" to date,"departments" to departments)
    }
    fun night(actor:Actor,date:String,department:String?):Map<String,Any?> {
        requireDepartmentReader(actor);dateValue(date)
        return mapOf("date" to date,"departments" to selectedDepartments(department).map { d ->
            val row=savedRecords("bnoc_night_duty",d,date)
            val entries=row?.get("records_json")?.let { db.json.readValue<List<Map<String,Any?>>>(it as String) } ?: emptyList()
            mapOf("department" to d,"revision" to ((row?.get("revision") as? Number)?.toLong() ?: 0),"submitted" to (row!=null),"entries" to entries)
        })
    }
    private fun selectedDepartments(department:String?):List<String> {
        if(department.isNullOrBlank()) return db.departments
        if(department !in db.departments) reject("VALIDATION")
        return listOf(department)
    }
    private fun saveDirective(actor:Actor,command:Command,workflow:WorkflowService):CommandResult {
        val payload=command.payload;val creating=command.type=="createDirective"
        val ref=if(creating) UUID.randomUUID().toString() else text(payload,"noticeRef",36,true)
        db.lockResource("notice:$ref")
        val before=if(creating) null else notice(actor,ref)
        val actual=(before?.get("revision") as? Number)?.toLong() ?: 0
        if(!creating) revision(command,actual)
        val title=text(payload,"title",200,true)
        val previousDocument=before?.get("body_document") as? String
        if(!creating && previousDocument!=null && "bodyDocument" !in payload) reject("VALIDATION",mapOf("bodyDocument" to "서식 본문을 함께 보내세요."))
        val normalizedDocument=if("bodyDocument" in payload && payload["bodyDocument"]!=null) validateNoticeDocument(payload["bodyDocument"]) else null
        val plain=text(payload,"body",10000)
        val body=normalizedDocument?.second ?: plain
        if(body.length>10000 || body.isBlank()) reject("VALIDATION",mapOf("body" to "본문 내용을 입력하세요."))
        if(normalizedDocument!=null && plain.isNotBlank() && plain!=body) reject("VALIDATION",mapOf("body" to "서식 본문과 일반 본문이 일치하지 않습니다."))
        val documentJson=normalizedDocument?.first
        val beforeAttachments=if(creating) emptyList() else db.attachmentMetadata("notice",ref)
        val afterAttachments=workflow.linkAttachments(actor,"notice",ref,payload["attachmentRefs"])
        val changed=creating || before!!["title"]!=title || before["body"]!=body || previousDocument!=documentJson || beforeAttachments.map { it["id"] }!=afterAttachments.map { it["id"] }
        if(changed) {
            if(creating) db.jdbc.update("INSERT INTO bnoc_notices(notice_ref,title,body,created_by,created_at,revision,updated_at,body_document) VALUES (?,?,?,?,?,?,?,?)",ref,title,body,actor.id,now(),1,now(),documentJson)
            else db.jdbc.update("UPDATE bnoc_notices SET title=?,body=?,body_document=?,revision=?,updated_at=? WHERE notice_ref=?",title,body,documentJson,actual+1,now(),ref)
            db.operationsHistory(actor,"notice",ref,before?.let { mapOf("title" to it["title"],"body" to it["body"],"bodyDocument" to previousDocument?.let { json -> db.json.readValue<Map<String,Any?>>(json) },"attachments" to beforeAttachments) },mapOf("title" to title,"body" to body,"bodyDocument" to normalizedDocument?.let { db.json.readValue<Map<String,Any?>>(it.first) },"attachments" to afterAttachments))
        }
        return CommandResult(publicRef=ref,revision=if(changed) actual+1 else actual)
    }
    fun notices(actor:Actor):List<Map<String,Any?>> = db.rows("SELECT * FROM bnoc_notices ORDER BY updated_at DESC,notice_ref DESC").map { noticeDto(it) }
    fun notice(actor:Actor,ref:String):Map<String,Any?> = noticeDto(db.rows("SELECT * FROM bnoc_notices WHERE notice_ref=?",ref).firstOrNull() ?: reject("NOT_FOUND"))
    private fun noticeDto(row:Map<String,Any?>):Map<String,Any?> = mapOf("noticeRef" to row["notice_ref"],"title" to row["title"],"body" to row["body"],"bodyDocument" to (row["body_document"] as? String)?.let { db.json.readValue<Map<String,Any?>>(it) },"createdAt" to row["created_at"],"updatedAt" to row["updated_at"],"createdBy" to "BNOC","revision" to row["revision"],"attachments" to db.attachmentMetadata("notice",row["notice_ref"] as String),"history" to db.rows("SELECT recorded_at,actor_subject FROM bnoc_operations_history WHERE resource_kind='notice' AND resource_ref=? ORDER BY recorded_at,history_ref",row["notice_ref"]).map { mapOf("at" to it["recorded_at"],"actorLabel" to "BNOC","field" to "공지 수정","summary" to "공지 제목·본문·첨부 저장") })
    private fun validateNoticeDocument(value:Any?):Pair<String,String> {
        val document=value as? Map<*,*> ?: reject("VALIDATION",mapOf("bodyDocument" to "서식 구조를 확인하세요."))
        val version=document["version"] as? Number
        if(document.keys.any { it !in setOf("version","blocks") } || version?.toDouble()!=1.0) reject("VALIDATION",mapOf("bodyDocument" to "지원하는 서식 구조가 아닙니다."))
        val blocks=document["blocks"] as? List<*> ?: reject("VALIDATION",mapOf("bodyDocument" to "본문 단락을 확인하세요."))
        if(blocks.isEmpty() || blocks.size>1000) reject("VALIDATION",mapOf("bodyDocument" to "본문 단락 수를 확인하세요."))
        val normalizedBlocks=blocks.mapIndexed { index, blockValue ->
            val block=blockValue as? Map<*,*> ?: reject("VALIDATION")
            if(block.keys.any { it !in setOf("type","list","runs") }) reject("VALIDATION")
            val type=block["type"] as? String ?: reject("VALIDATION")
            val list=block["list"] as? String
            if(type !in listOf("paragraph","listItem") || (type=="paragraph" && list!=null) || (type=="listItem" && list !in listOf("bullet","ordered"))) reject("VALIDATION")
            val runs=block["runs"] as? List<*> ?: reject("VALIDATION")
            if(runs.isEmpty() || runs.size>1000) reject("VALIDATION")
            val normalizedRuns=runs.map { runValue ->
                val run=runValue as? Map<*,*> ?: reject("VALIDATION")
                if(run.keys.any { it !in setOf("text","bold","italic","underline","size","color","font") }) reject("VALIDATION")
                val text=run["text"] as? String ?: reject("VALIDATION")
                if(text.any { it=='\u0000' } || text.length>10000) reject("VALIDATION")
                if(listOf("bold","italic","underline").any { run[it]!=null && run[it] !is Boolean }) reject("VALIDATION")
                val size=run["size"] as? Number
                if(run["size"]!=null && (size==null || size.toInt() !in 12..48 || size.toDouble()!=size.toInt().toDouble())) reject("VALIDATION")
                if(run["font"]!=null && run["font"] !in listOf("sans-serif","serif","monospace")) reject("VALIDATION")
                if(run["color"]!=null && run["color"] !in listOf("default","#1d4ed8","#b91c1c","#166534")) reject("VALIDATION")
                mutableMapOf<String,Any?>("text" to text).also { normalized -> listOf("bold","italic","underline","size","color","font").filter { run.containsKey(it) }.forEach { normalized[it]=run[it] } }
            }
            mutableMapOf<String,Any?>("type" to type).also { normalized -> if(list!=null) normalized["list"]=list;normalized["runs"]=normalizedRuns }
        }
        val plain=normalizedBlocks.map { block -> (block["runs"] as List<Map<String,Any?>>).joinToString("") { it["text"] as String } }.joinToString("\n")
        val json=db.json.writeValueAsString(mapOf("version" to 1,"blocks" to normalizedBlocks))
        if(json.toByteArray(Charsets.UTF_8).size>64*1024) reject("VALIDATION",mapOf("bodyDocument" to "서식 본문은 64KiB 이하여야 합니다."))
        return json to plain
    }
    fun access(actor:Actor):List<Map<String,Any?>> {
        if(!actor.accessAdmin || actor.role!="admin") reject("FORBIDDEN")
        return db.actors().map { a -> mapOf("subjectRef" to a.subjectRef,"displayName" to a.displayName,"role" to a.role,"department" to a.department,"teamId" to a.teamId,"departmentManager" to a.departmentManager,"active" to a.active,"revision" to a.revision) }
    }
    private fun changeAccess(actor:Actor,command:Command):CommandResult {
        val p=command.payload;val ref=text(p,"subjectRef",36,true);val target=db.actorByRef(ref,true) ?: reject("NOT_FOUND");revision(command,target.revision)
        val role=text(p,"role",32,true)
        if(role !in listOf("requester","bnoc","team","admin")) reject("VALIDATION",mapOf("role" to "역할을 확인하세요."))
        val manager=p["departmentManager"] as? Boolean ?: reject("VALIDATION");val active=p["active"] as? Boolean ?: reject("VALIDATION")
        val department=text(p,"department",100);val team=text(p,"teamId",100).ifBlank { null }
        if((department.isNotEmpty() && department !in db.departments) || (manager && (department.isEmpty() || role in listOf("bnoc","admin"))) || (role=="team" && (team !in db.teams || department!=team)) || (role!="team" && team!=null)) reject("VALIDATION")
        if(target.id==actor.id && (role!=target.role || (manager && !target.departmentManager) || (active && !target.active) || team!=target.teamId)) reject("FORBIDDEN")
        val changed=target.role!=role || target.department!=department || target.teamId!=team || target.departmentManager!=manager || target.active!=active
        if(changed) {
            db.jdbc.update("UPDATE bnoc_subjects SET role_name=?,department=?,team_id=?,department_manager=?,active=?,access_admin=?,revision=? WHERE subject_ref=?",role,department,team,manager,active,role=="admin",target.revision+1,ref)
            db.operationsHistory(actor,"access",ref,target.view(),db.actorByRef(ref)!!.view())
        }
        return CommandResult(publicRef=ref,revision=if(changed) target.revision+1 else target.revision)
    }
}
