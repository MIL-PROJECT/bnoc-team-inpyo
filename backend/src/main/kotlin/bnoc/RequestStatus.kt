package bnoc

data class EffectiveWorkSummary(val works:List<WorkRecord>,val departments:List<String>,val completedDepartments:List<String>,val returnedWorks:Int,val requestStatus:String)

object RequestStatus {
    fun summarize(request:RequestRecord,works:List<WorkRecord>):EffectiveWorkSummary {
        val effective=if(request.status=="취소") emptyList() else works.filter { it.resolutionKind=="open" }
        val departments=effective.map { it.teamId }.distinct().sorted()
        val completed=departments.filter { department -> effective.filter { it.teamId==department }.all { it.status=="완료" } }
        val status=when {
            request.status=="취소" || request.status=="문서 대기" -> request.status
            effective.any { it.status=="작업 중" } -> "작업 중"
            effective.any { it.status=="반환" } -> "대기"
            effective.isNotEmpty() && effective.all { it.status=="완료" } -> "완료"
            effective.isNotEmpty() -> "배정"
            else -> "대기"
        }
        return EffectiveWorkSummary(effective,departments,completed,effective.count { it.status=="반환" },status)
    }
    fun derive(request:RequestRecord,works:List<WorkRecord>):String=summarize(request,works).requestStatus
    fun departmentStatus(works:List<WorkRecord>):String=when {
        works.isEmpty() -> "미배정"
        works.all { it.status=="완료" } -> "완료"
        works.any { it.status=="작업 중" } -> "작업 중"
        works.any { it.status=="반환" } -> "반환"
        else -> "배정"
    }
}
