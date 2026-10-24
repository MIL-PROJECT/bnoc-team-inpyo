package bnoc

import org.jsoup.Jsoup
import org.jsoup.nodes.Element

data class ExtractedDocument(val blocks:List<Map<String,Any?>>,val bodyText:String,val metadata:List<Map<String,Any?>>)

object DocumentContentExtractor {
    @JvmStatic fun extractHtml(html:String,documentTitle:String?):ExtractedDocument {
        val document=Jsoup.parse(html)
        document.select("script,style,iframe,object,embed,form,input,button,svg").remove()
        val blocks=mutableListOf<Map<String,Any?>>()
        var nextPage=1
        fun visit(element:Element,page:Int?) {
            val name=element.normalName()
            val currentPage=if(element.classNames().any { it.contains("page",true) }) {
                element.attr("data-page").toIntOrNull() ?: nextPage++
            } else page
            when {
                name=="table" -> {
                    val rows=element.select("tr").map { row -> row.select("th,td").map { it.text().trim() } }.filter { it.any(String::isNotBlank) }
                    if(rows.isNotEmpty()) blocks.add(mapOf("id" to "b${blocks.size+1}","type" to "table","rows" to rows,"page" to currentPage))
                }
                name in setOf("p","h1","h2","h3","h4","h5","h6","li","pre","blockquote") -> {
                    val text=element.text().trim()
                    if(text.isNotBlank()) blocks.add(mapOf("id" to "b${blocks.size+1}","type" to "paragraph","text" to text,"page" to currentPage))
                }
                else -> element.children().forEach { visit(it,currentPage) }
            }
        }
        document.body().children().forEach { visit(it,null) }
        var bodyText=blocks.joinToString("\n") { block ->
            when(block["type"]) {
                "table" -> (block["rows"] as List<List<String>>).joinToString("\n") { it.joinToString(" | ") }
                else -> block["text"] as String
            }
        }.take(1_000_000)
        if(bodyText.isBlank()) {
            bodyText=document.body().text().trim().take(1_000_000)
            if(bodyText.isNotBlank()) blocks.add(mapOf("id" to "b1","type" to "paragraph","text" to bodyText,"page" to null))
        }
        val metadata=mutableListOf<Map<String,Any?>>()
        val title=(documentTitle?.takeIf(String::isNotBlank)
            ?: document.selectFirst("meta[name=dc:title]")?.attr("content")?.takeIf(String::isNotBlank)
            ?: document.title().takeIf(String::isNotBlank))?.trim()
        if(title!=null) metadata.add(mapOf("label" to "문서 제목","rawValue" to title,"normalizedValue" to null,"blockId" to null,"page" to null,"source" to "document-title","evidence" to title))
        val labels=mapOf(
            "회의명" to "회의명","회의 명" to "회의명","회의 제목" to "회의명","행사명" to "회의명","행사 명" to "회의명",
            "회의 일시" to "일시","회의일시" to "일시","일시" to "일시","날짜" to "일시",
            "회의 장소" to "장소","회의장소" to "장소","장소 후보" to "장소","장소" to "장소","위치" to "장소"
        )
        fun addCandidate(rawLabel:String,rawValue:String,block:Map<String,Any?>,evidence:String) {
            val label=labels[rawLabel.trim().replace(Regex("\\s+")," ")] ?: return
            val value=rawValue.trim().trimStart(':','：','-','–').trim()
            if(value.isBlank()) return
            metadata.add(mapOf("label" to label,"rawValue" to value,"normalizedValue" to null,"blockId" to block["id"],"page" to block["page"],"source" to "block","evidence" to evidence))
        }
        blocks.forEach { block ->
            if(block["type"]=="table") {
                @Suppress("UNCHECKED_CAST")
                val rows=block["rows"] as List<List<String>>
                rows.forEach { row ->
                    if(row.size>1) addCandidate(row[0],row.drop(1).joinToString(" "),block,row.joinToString(" | "))
                    row.forEach { cell ->
                        val match=Regex("^\\s*(회의\\s*명|회의\\s*제목|행사\\s*명|회의\\s*일시|일시|날짜|회의\\s*장소|장소\\s*후보|장소|위치)\\s*[:：]\\s*(.+?)\\s*$").matchEntire(cell)
                        if(match!=null) addCandidate(match.groupValues[1],match.groupValues[2],block,cell)
                    }
                }
            } else {
                val text=block["text"] as String
                val match=Regex("^\\s*(회의\\s*명|회의\\s*제목|행사\\s*명|회의\\s*일시|일시|날짜|회의\\s*장소|장소\\s*후보|장소|위치)\\s*[:：]\\s*(.+?)\\s*$").matchEntire(text)
                if(match!=null) addCandidate(match.groupValues[1],match.groupValues[2],block,text)
            }
        }
        return ExtractedDocument(blocks,bodyText,metadata)
    }
}
