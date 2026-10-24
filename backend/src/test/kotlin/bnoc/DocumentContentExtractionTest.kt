package bnoc

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test

class DocumentContentExtractionTest {
    private fun extract(html:String):Map<String,Any?> {
        val type=Class.forName("bnoc.DocumentContentExtractor")
        val result=type.getMethod("extractHtml",String::class.java,String::class.java).invoke(null,html,null)
        @Suppress("UNCHECKED_CAST")
        return mapOf(
            "blocks" to result.javaClass.getMethod("getBlocks").invoke(result) as List<Map<String,Any?>>,
            "bodyText" to result.javaClass.getMethod("getBodyText").invoke(result) as String,
            "metadata" to result.javaClass.getMethod("getMetadata").invoke(result) as List<Map<String,Any?>>
        )
    }

    @Test fun `document extraction keeps paragraphs tables and explicit metadata evidence only`() {
        val result=extract("""
            <html><head><title>회의 지원 요청서</title></head><body>
              <p>회의명: 정기회의</p><p>일시: 2026-10-23 10:00</p>
              <table><tr><td>회의 장소</td><td>회의실</td></tr><tr><td>장소 후보</td><td>소회의실</td></tr></table>
              <script>unsafe-script-marker</script><img src=x onerror="unsafe-handler-marker">
            </body></html>
        """.trimIndent())
        val blocks=result["blocks"] as List<Map<String,Any?>>
        val metadata=result["metadata"] as List<Map<String,Any?>>
        assertEquals(listOf("paragraph","paragraph","table"),blocks.map { it["type"] })
        assertTrue((result["bodyText"] as String).contains("정기회의"))
        assertFalse((result["bodyText"] as String).contains("unsafe-"))
        assertEquals(listOf("문서 제목","회의명","일시","장소","장소"),metadata.map { it["label"] })
        assertEquals(listOf("회의실","소회의실"),metadata.takeLast(2).map { it["rawValue"] })
        assertEquals("document-title",metadata.first()["source"])
        assertTrue(metadata.drop(1).all { it["blockId"] != null })
    }

    @Test fun `spaced meeting and event labels become searchable meeting metadata`() {
        val result=extract("<p>회의 명: 월간회의</p><p>행사 명: 간담회</p>")
        val metadata=result["metadata"] as List<Map<String,Any?>>

        assertEquals(listOf("회의명","회의명"),metadata.map { it["label"] })
        assertEquals(listOf("월간회의","간담회"),metadata.map { it["rawValue"] })
    }

    @Test fun `text in inline-only parser markup is retained as a readable block`() {
        val result=extract("<div><span>마이크 점검</span> <span>지원 결과</span></div>")

        assertEquals("마이크 점검 지원 결과",result["bodyText"])
        assertEquals("마이크 점검 지원 결과",((result["blocks"] as List<Map<String,Any?>>).single())["text"])
    }
}
