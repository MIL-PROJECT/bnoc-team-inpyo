package bnoc

data class IntakeItem(val id:String,val kind:String,val workType:String,val quantity:Int,val location:String,val systemType:String?=null,val phoneType:String?=null,val symptom:String?=null,val detail:String?=null,val equipmentId:String?=null,val errorCode:String?=null,val destination:String?=null,val attachmentIds:List<String> = emptyList())
data class IntakeRecord(val version:Int=1,val quantities:Map<String,Int>,val items:List<IntakeItem>)

object IntakePolicy {
    val kinds=setOf("PC","프린터","회선","전화","비상벨","CCTV","인터컴","기타")
    private val works=setOf("고장","신설","지원","대여","점검","이전","기타")
    private val systems=setOf("인트라넷","인터넷","AFCCS","KJCCS","기타")
    private val itemFields=setOf("id","kind","workType","quantity","location","systemType","phoneType","symptom","detail","equipmentId","errorCode","destination","attachmentIds")
    private val uiFields=setOf("workType","phoneType","location","systemType","symptom","detail","equipmentId","errorCode","destination")
    private val phases=uiFields+setOf("intent","supportKind","pick","itemReview","difference","splitCount","contact","requester","review","meetingType","videoPlatform","meetingDetail","meetingLocation","meetingAttachment","optional")
    private fun fail(field:String="requestItems",message:String="대상 정보와 수량을 확인하세요."):Nothing=reject("VALIDATION",mapOf(field to message))
    private fun string(value:Any?,max:Int,field:String,required:Boolean=false):String? {
        if(value==null)return if(required)fail(field) else null
        val text=value as? String ?: fail(field)
        if(text.length>max||text.contains('\u0000'))fail(field)
        return text.trim().takeIf{it.isNotEmpty()&&it!="unknown"} ?: if(required)fail(field) else null
    }
    private fun count(value:Any?,field:String):Int {
        val number=value as? Number ?: fail(field)
        val count=number.toInt();if(number.toDouble()!=count.toDouble()||count !in 1..999)fail(field,"수량은 1~999 사이 정수로 입력하세요.")
        return count
    }
    private fun refs(value:Any?,field:String):List<String> {
        val list=value as? List<*> ?: if(value==null)return emptyList() else fail(field)
        if(list.size>10)fail(field)
        val result=list.map{string(it,36,field,true)!!};if(result.distinct().size!=result.size)fail(field)
        return result
    }
    private fun totals(value:Any?):Map<String,Int> {
        val map=value as? Map<*,*> ?: fail("itemQuantities")
        if(map.keys.any{it !in kinds})fail("itemQuantities")
        return map.entries.associate{it.key as String to count(it.value,"itemQuantities")}
    }
    fun parse(payload:Map<String,Any?>,attachmentIds:Set<String>):IntakeRecord? {
        if(listOf("intakeVersion","itemQuantities","requestItems").none{it in payload})return null
        if(payload["intakeVersion"] !is Number||(payload["intakeVersion"] as Number).toDouble()!=1.0||payload["category"]!="장비/체계")fail()
        val raw=payload["requestItems"] as? List<*> ?: fail()
        if(raw.isEmpty()||raw.size>50)fail()
        val items=raw.mapIndexed{index,value->
            val field="requestItems.$index";val item=value as? Map<*,*> ?: fail(field)
            if(item.keys.any{it !in itemFields})fail(field)
            val id=string(item["id"],36,field,true)!!;if(runCatching{java.util.UUID.fromString(id)}.isFailure)fail(field)
            val kind=string(item["kind"],100,field,true)!!;if(kind !in kinds)fail(field)
            val work=string(item["workType"],100,field,true)!!;if(work !in works)fail(field)
            val phone=if(kind=="전화")string(item["phoneType"],100,field)?.also{if(it !in setOf("IP","아날로그"))fail(field)} else null
            val system=if(kind in setOf("PC","프린터","회선","CCTV")||(kind=="전화"&&phone=="IP"))string(item["systemType"],100,field)?.also{if(it !in systems)fail(field)} else null
            val symptom=if(work=="고장")string(item["symptom"],500,field) else null
            val detail=string(item["detail"],2000,field)
            if(symptom==null&&detail==null)fail(field,"증상을 선택하거나 요청 내용을 입력하세요.")
            val files=refs(item["attachmentIds"],field);if(files.any{it !in attachmentIds})fail("attachments","대상의 첨부파일을 다시 확인하세요.")
            IntakeItem(id,kind,work,count(item["quantity"],field),string(item["location"],200,field,true)!!,system,phone,symptom,detail,
                if(work!="신설"&&kind in setOf("PC","프린터","CCTV"))string(item["equipmentId"],200,field) else null,
                if(work=="고장"&&symptom in setOf("오류가 표시돼요","프로그램에 문제가 있어요"))string(item["errorCode"],500,field) else null,
                if(work=="이전")string(item["destination"],200,field) else null,files)
        }
        if(items.map{it.id}.distinct().size!=items.size)fail()
        val counts=totals(payload["itemQuantities"])
        if(items.groupBy{it.kind}.mapValues{(_,values)->values.sumOf{it.quantity}}!=counts)fail("itemQuantities","선택한 수량과 대상별 수량 합계가 일치하지 않습니다.")
        return IntakeRecord(1,counts,items)
    }
    fun classifications(intake:IntakeRecord):Map<String,String> {
        fun common(values:List<String?>):String {val distinct=values.map{it?:"미확인"}.distinct();return if(distinct.size==1)distinct.single() else "복수"}
        return mapOf("resourceType" to common(intake.items.map{it.kind}),"workType" to common(intake.items.map{it.workType}),"systemType" to common(intake.items.map{it.systemType}))
    }
    fun describe(item:IntakeItem)=listOf("${if(item.kind=="PC")"컴퓨터" else if(item.kind=="전화")"전화기" else item.kind} ${item.workType} ${item.quantity}${if(item.kind=="회선")"개" else "대"}",item.location,item.systemType,item.phoneType,item.symptom,item.detail,item.equipmentId,item.errorCode,item.destination).filterNotNull().joinToString(" / ")
    fun description(intake:IntakeRecord)=intake.items.joinToString("\n",transform=::describe).take(10000)
    fun location(intake:IntakeRecord):String {val values=intake.items.map{it.location}.distinct();return values.first().take(if(values.size>1)180 else 200)+(if(values.size>1)" 외 ${values.size-1}곳" else "")}
    fun draft(raw:Any?,attachmentIds:Set<String>):Map<String,Any?>? {
        if(raw==null)return null
        val value=raw as? Map<*,*> ?: fail("guidedDraft")
        val allowed=setOf("version","splitCount","intent","defaultWorkType","mode","step","activeId","items","quantities","order","history","returnTo","meeting")
        if(value.keys.any{it !in allowed}||value["version"]!=1||value["mode"] !in setOf("equipment","meeting")||value["step"] !in phases)fail("guidedDraft")
        if("intent" in value&&value["intent"] !in setOf("","고장","신설","지원","기타"))fail("guidedDraft")
        if("defaultWorkType" in value&&value["defaultWorkType"] !in works+"")fail("guidedDraft")
        string(value["splitCount"],12,"guidedDraft")
        val rawItems=value["items"] as? List<*> ?: fail("guidedDraft");if(rawItems.size>50)fail("guidedDraft")
        val ids=mutableSetOf<String>()
        val items=rawItems.map{rawItem->
            val item=rawItem as? Map<*,*> ?: fail("guidedDraft")
            if(item.keys.any{it !in itemFields+setOf("answered","reviewed","splitSourceId","inheritedWorkType","extraInformation")})fail("guidedDraft")
            if("inheritedWorkType" in item&&item["inheritedWorkType"] !is Boolean)fail("guidedDraft")
            if("extraInformation" in item&&item["extraInformation"] !is Boolean)fail("guidedDraft")
            val id=string(item["id"],80,"guidedDraft",true)!!;if(!ids.add(id)||item["kind"] !in kinds)fail("guidedDraft")
            count(item["quantity"],"guidedDraft")
            for(field in uiFields){val max=when(field){"detail"->2000;"symptom","errorCode"->500;"location","equipmentId","destination"->200;else->100};string(item[field],max,"guidedDraft")}
            if(item["reviewed"] !is Boolean)fail("guidedDraft")
            val answered=item["answered"] as? List<*> ?: fail("guidedDraft");if(answered.size>12||answered.any{it !in uiFields}||answered.distinct().size!=answered.size)fail("guidedDraft")
            string(item["splitSourceId"],80,"guidedDraft")
            if(refs(item["attachmentIds"],"guidedDraft").any{it !in attachmentIds})fail("attachments")
            @Suppress("UNCHECKED_CAST") (item as Map<String,Any?>).toMutableMap().apply{if(this["workType"]=="신설")this["equipmentId"]=""}
        }
        val quantities=totals(value["quantities"])
        if(items.groupBy{it["kind"] as String}.mapValues{(_,rows)->rows.sumOf{(it["quantity"] as Number).toInt()}}!=quantities)fail("guidedDraft")
        val active=string(value["activeId"],80,"guidedDraft");if(active!=null&&active !in ids)fail("guidedDraft")
        val order=value["order"] as? List<*> ?: fail("guidedDraft");if(order.size>8||order.distinct().size!=order.size||order.toSet()!=quantities.keys)fail("guidedDraft")
        val history=value["history"] as? List<*> ?: fail("guidedDraft");if(history.size>128)fail("guidedDraft")
        history.forEach{rawFrame->val frame=rawFrame as? Map<*,*> ?: fail("guidedDraft");if(frame.keys!=setOf("step","activeId","mode","returnTo")||frame["step"] !in phases||frame["mode"] !in setOf("equipment","meeting")||(frame["activeId"]!=null&&frame["activeId"] !in ids)||(frame["returnTo"]!=null&&frame["returnTo"] !in phases))fail("guidedDraft")}
        if(value["returnTo"]!=null&&value["returnTo"] !in phases)fail("guidedDraft")
        val meeting=value["meeting"] as? Map<*,*> ?: fail("guidedDraft");if(meeting.keys.any{it !in setOf("meetingType","videoPlatform","detail","location","attachmentIds")}||!meeting.keys.containsAll(setOf("meetingType","videoPlatform","detail","location")))fail("guidedDraft")
        meeting.forEach{(key,text)->if(key=="attachmentIds"){if(refs(text,"guidedDraft").any{it !in attachmentIds})fail("attachments")}else string(text,if(key=="detail")10000 else if(key=="location")200 else 100,"guidedDraft")}
        @Suppress("UNCHECKED_CAST") return (value as Map<String,Any?>).toMutableMap().apply{this["items"]=items}
    }
}
