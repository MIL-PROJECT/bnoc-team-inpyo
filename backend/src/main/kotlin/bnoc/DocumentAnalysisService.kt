package bnoc

import org.apache.tika.config.TimeoutLimits
import org.apache.tika.metadata.Metadata
import org.apache.tika.metadata.TikaCoreProperties
import org.apache.tika.pipes.api.ParseMode
import org.apache.tika.pipes.fork.PipesForkParser
import org.apache.tika.pipes.fork.PipesForkParserConfig
import org.apache.tika.sax.BasicContentHandlerFactory.HANDLER_TYPE
import com.fasterxml.jackson.module.kotlin.readValue
import org.springframework.beans.factory.annotation.Value
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Service
import org.springframework.transaction.support.TransactionTemplate
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.time.Instant
import java.util.Locale
import java.util.zip.ZipFile

private data class DocumentJob(val attachmentRef:String,val sourceHash:String,val generation:Int)

internal fun isAnalyzedDocument(fileName:String):Boolean = fileName.endsWith(".hwp",ignoreCase=true) || fileName.endsWith(".pdf",ignoreCase=true)

internal fun processedDocumentRange(isPdf:Boolean,pageCount:Int,parserOutputLength:Int):String? = listOfNotNull(
    if(parserOutputLength<1_000_000 && isPdf && pageCount>50) "PDF 1~50쪽" else null,
    if(parserOutputLength>=1_000_000) "분석 출력 한도 1,000,000자 도달" else null
).joinToString(" · ").ifBlank { null }

internal object DocumentTikaConfig {
    const val parserVersion="apache-tika-4.1.0-bnoc2"
    private val forkClasspath by lazy { resolveForkClasspath() }

    fun forkClasspath():String = forkClasspath

    private fun resolveForkClasspath():String {
        val runtimeClasspath=System.getProperty("java.class.path")
        val candidates=(runtimeClasspath.split(java.io.File.pathSeparator).mapNotNull { runCatching { Path.of(it) }.getOrNull() }+
            listOfNotNull(runCatching { Path.of(DocumentTikaConfig::class.java.protectionDomain.codeSource.location.toURI()) }.getOrNull()))
            .distinct()
        val bootJar=candidates.firstOrNull { candidate ->
            if(!Files.isRegularFile(candidate)) false
            else runCatching { ZipFile(candidate.toFile()).use { it.getEntry("BOOT-INF/lib/")!=null || it.entries().asSequence().any { entry -> entry.name.startsWith("BOOT-INF/lib/") && entry.name.endsWith(".jar") } } }.getOrDefault(false)
        } ?: return runtimeClasspath
        val libraryRoot=Files.createTempDirectory("bnoc-tika-libraries-")
        var extracted=0
        try {
            ZipFile(bootJar.toFile()).use { archive ->
                val entries=archive.entries()
                while(entries.hasMoreElements()) {
                    val entry=entries.nextElement()
                    if(entry.isDirectory || !entry.name.startsWith("BOOT-INF/lib/") || !entry.name.endsWith(".jar")) continue
                    val libraryName=Path.of(entry.name).fileName.toString()
                    val target=libraryRoot.resolve(libraryName)
                    archive.getInputStream(entry).use { input -> Files.copy(input,target,StandardCopyOption.REPLACE_EXISTING) }
                    extracted++
                }
            }
        } catch(error:Exception) {
            Files.walk(libraryRoot).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists) }
            throw error
        }
        if(extracted==0) {
            Files.walk(libraryRoot).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists) }
            return System.getProperty("java.class.path")
        }
        Runtime.getRuntime().addShutdownHook(Thread {
            runCatching { Files.walk(libraryRoot).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists) } }
        })
        return libraryRoot.resolve("*").toString()
    }

    fun create():Path {
        val contents=checkNotNull(DocumentTikaConfig::class.java.getResourceAsStream("/tika-config.json")) { "Document parser configuration is missing" }.use { it.readBytes() }
        return Files.createTempFile("bnoc-tika-config-",".json").also { Files.write(it,contents) }
    }
}

@Service
class DocumentAnalysisService(
    private val db:Database,
    private val query:QueryService,
    private val workflow:WorkflowService,
    private val transaction:TransactionTemplate,
    @param:Value("\${bnoc.file-root:runtime/data/attachments}") root:String
) {
    private val root=Path.of(root).toAbsolutePath().normalize().also { Files.createDirectories(it) }
    private val parserVersion=DocumentTikaConfig.parserVersion

    fun document(actor:Actor,ref:String,offsetValue:Int?,limitValue:Int?):Map<String,Any?> {
        val offset=offsetValue ?: 0
        val limit=limitValue ?: 50
        if(offset<0 || limit !in 1..100 || offset>1_000_000) reject("VALIDATION",mapOf("offset" to "문서 위치를 확인하세요."))
        val attachment=authorizedAttachment(actor,ref)
        val temporary=attachment["resource_ref"]==null
        val excluded=attachment["content_analysis_excluded"]==true
        if(temporary || excluded || !isAnalyzedDocument(attachment["file_name"] as String)) return mapOf(
            "attachmentRef" to ref,"fileName" to attachment["file_name"],"status" to if(temporary) "temporary" else if(excluded) "excluded" else "unsupported","processedRange" to null,
            "blocks" to emptyList<Any>(),"offset" to offset,"limit" to limit,"totalBlocks" to 0,
            "metadata" to emptyList<Any>(),"source" to if(temporary) "temporary" else if(excluded) "excluded" else "unsupported","parserVersion" to parserVersion,"errorCode" to null,"canRetry" to false
        )
        val row=db.rows("SELECT * FROM bnoc_document_analysis WHERE attachment_ref=?",ref).firstOrNull()
        val currentParser=row?.get("parser_version")==parserVersion
        val status=if(currentParser) row?.get("status") as? String ?: "pending" else "pending"
        val blocks=if(currentParser) row?.get("body_json")?.let { runCatching { db.json.readValue<List<Map<String,Any?>>>(it as String) }.getOrNull() }.orEmpty() else emptyList()
        val metadata=if(currentParser) row?.get("metadata_json")?.let { runCatching { db.json.readValue<List<Map<String,Any?>>>(it as String) }.getOrNull() }.orEmpty() else emptyList()
        return mapOf(
            "attachmentRef" to ref,
            "fileName" to attachment["file_name"],
            "status" to status,
            "processedRange" to if(currentParser) row?.get("processed_range") else null,
            "blocks" to blocks.drop(offset).take(limit),
            "offset" to offset,
            "limit" to limit,
            "totalBlocks" to blocks.size,
            "metadata" to metadata,
            "source" to "apache-tika",
            "parserVersion" to parserVersion,
            "errorCode" to if(currentParser) row?.get("error_code") else null,
            "canRetry" to (currentParser && attachment["current_link"]==true && workflow.canEdit(actor,query.requireRequest(actor,attachment["resource_ref"] as String)) && status in setOf("failed","unreadable"))
        )
    }

    fun reprocess(actor:Actor,ref:String):Map<String,Any?> {
        val next=transaction.execute {
            val attachment=db.rows("SELECT * FROM bnoc_attachments WHERE attachment_ref=? AND resource_kind='request' AND current_link=TRUE FOR UPDATE",ref).firstOrNull() ?: reject("NOT_FOUND")
            val requestRef=attachment["resource_ref"] as? String ?: reject("NOT_FOUND")
            val request=query.requireRequest(actor,requestRef)
            if(!workflow.canEdit(actor,request)) reject("FORBIDDEN")
            if(attachment["content_analysis_excluded"]==true) reject("VALIDATION",mapOf("document" to "회의 지원 양식은 분석 대상이 아닙니다."))
            if(!isAnalyzedDocument(attachment["file_name"] as String)) reject("VALIDATION",mapOf("document" to "본문 분석을 지원하지 않는 파일입니다."))
            val file=storedPath(attachment["stored_name"] as String)
            if(!Files.isRegularFile(file)) reject("NOT_FOUND")
            val hash=sha256(Files.readAllBytes(file))
            val previous=db.rows("SELECT generation,status FROM bnoc_document_analysis WHERE attachment_ref=? FOR UPDATE",ref).firstOrNull() ?: reject("CONFLICT")
            if(previous["status"] !in setOf("failed","unreadable")) reject("CONFLICT")
            val generation=((previous["generation"] as? Number)?.toInt() ?: 0)+1
            val now=Instant.now().toString()
            db.jdbc.update("UPDATE bnoc_document_analysis SET source_hash=?,parser_version=?,generation=?,status='pending',body_json=NULL,body_text=NULL,metadata_json='[]',error_code=NULL,processed_range=NULL,updated_at=? WHERE attachment_ref=?",hash,parserVersion,generation,now,ref)
            val jobExists=db.rows("SELECT attachment_ref FROM bnoc_document_jobs WHERE attachment_ref=? FOR UPDATE",ref).isNotEmpty()
            if(jobExists) db.jdbc.update("UPDATE bnoc_document_jobs SET source_hash=?,parser_version=?,generation=?,status='pending',lease_until=NULL,attempt_count=0,updated_at=? WHERE attachment_ref=?",hash,parserVersion,generation,now,ref)
            else db.jdbc.update("INSERT INTO bnoc_document_jobs(attachment_ref,source_hash,parser_version,generation,status,lease_until,attempt_count,updated_at) VALUES (?,?,?,?,?,NULL,0,?)",ref,hash,parserVersion,generation,"pending",now)
            generation
        } ?: reject("SAVE_FAILED")
        return mapOf("attachmentRef" to ref,"status" to "pending","generation" to next)
    }

    @Scheduled(fixedDelay=5000,initialDelay=2000)
    fun runQueue() {
        runCatching { cleanupUnsupported() }
        runCatching { enqueueMissing() }
        val job=runCatching { claimOne() }.getOrNull() ?: return
        runCatching { parse(job) }.onFailure { finishFailure(job,if(it.message.orEmpty().contains("timeout",true)) "timeout" else "parse_failed","failed") }
    }

    private fun cleanupUnsupported() {
        db.rows("SELECT a.attachment_ref FROM bnoc_attachments a WHERE NOT (LOWER(a.file_name) LIKE '%.hwp' OR LOWER(a.file_name) LIKE '%.pdf') AND (EXISTS (SELECT 1 FROM bnoc_document_analysis d WHERE d.attachment_ref=a.attachment_ref) OR EXISTS (SELECT 1 FROM bnoc_document_jobs j WHERE j.attachment_ref=a.attachment_ref)) ORDER BY a.attachment_ref LIMIT 100")
            .forEach { row ->
                val ref=row["attachment_ref"] as String
                transaction.execute {
                    val attachment=db.rows("SELECT file_name FROM bnoc_attachments WHERE attachment_ref=? FOR UPDATE",ref).firstOrNull() ?: return@execute
                    if(isAnalyzedDocument(attachment["file_name"] as String)) return@execute
                    db.jdbc.update("DELETE FROM bnoc_document_jobs WHERE attachment_ref=?",ref)
                    db.jdbc.update("DELETE FROM bnoc_document_analysis WHERE attachment_ref=?",ref)
                }
            }
    }

    private fun enqueueMissing() {
        db.rows("SELECT a.attachment_ref FROM bnoc_attachments a LEFT JOIN bnoc_document_analysis d ON d.attachment_ref=a.attachment_ref LEFT JOIN bnoc_document_jobs j ON j.attachment_ref=a.attachment_ref WHERE a.resource_kind='request' AND a.resource_ref IS NOT NULL AND a.content_analysis_excluded=FALSE AND (LOWER(a.file_name) LIKE '%.hwp' OR LOWER(a.file_name) LIKE '%.pdf') AND (d.attachment_ref IS NULL OR d.parser_version<>? OR (d.status='pending' AND j.attachment_ref IS NULL))",parserVersion)
            .forEach { enqueue(it["attachment_ref"] as String) }
    }

    private fun enqueue(ref:String) {
        transaction.execute {
            val attachment=db.rows("SELECT * FROM bnoc_attachments WHERE attachment_ref=? AND resource_kind='request' AND resource_ref IS NOT NULL AND content_analysis_excluded=FALSE FOR UPDATE",ref).firstOrNull() ?: return@execute
            val previous=db.rows("SELECT * FROM bnoc_document_analysis WHERE attachment_ref=? FOR UPDATE",ref).firstOrNull()
            val existingJob=db.rows("SELECT attachment_ref FROM bnoc_document_jobs WHERE attachment_ref=? FOR UPDATE",ref).isNotEmpty()
            if(previous!=null && previous["parser_version"]==parserVersion && ((previous["status"] as? String)!="pending" || existingJob)) return@execute
            val file=storedPath(attachment["stored_name"] as String)
            if(!isAnalyzedDocument(attachment["file_name"] as String) || !Files.isRegularFile(file)) return@execute
            val hash=sha256(Files.readAllBytes(file));val generation=((previous?.get("generation") as? Number)?.toInt() ?: 0)+1;val now=Instant.now().toString()
            if(previous==null) db.jdbc.update("INSERT INTO bnoc_document_analysis(attachment_ref,source_hash,parser_version,generation,status,body_json,body_text,metadata_json,error_code,updated_at) VALUES (?,?,?,?,?,NULL,NULL,'[]',NULL,?)",ref,hash,parserVersion,generation,"pending",now)
            else db.jdbc.update("UPDATE bnoc_document_analysis SET source_hash=?,parser_version=?,generation=?,status='pending',body_json=NULL,body_text=NULL,metadata_json='[]',error_code=NULL,processed_range=NULL,updated_at=? WHERE attachment_ref=?",hash,parserVersion,generation,now,ref)
            if(existingJob) db.jdbc.update("UPDATE bnoc_document_jobs SET source_hash=?,parser_version=?,generation=?,status='pending',lease_until=NULL,attempt_count=0,updated_at=? WHERE attachment_ref=?",hash,parserVersion,generation,now,ref)
            else db.jdbc.update("INSERT INTO bnoc_document_jobs(attachment_ref,source_hash,parser_version,generation,status,lease_until,attempt_count,updated_at) VALUES (?,?,?,?,?,NULL,0,?)",ref,hash,parserVersion,generation,"pending",now)
        }
    }

    private fun claimOne():DocumentJob? = transaction.execute {
        val now=Instant.now()
        val row=db.rows("SELECT j.* FROM bnoc_document_jobs j JOIN bnoc_attachments a ON a.attachment_ref=j.attachment_ref WHERE a.content_analysis_excluded=FALSE AND (LOWER(a.file_name) LIKE '%.hwp' OR LOWER(a.file_name) LIKE '%.pdf') AND (j.status='pending' OR (j.status='processing' AND j.lease_until<?)) ORDER BY j.updated_at,j.attachment_ref LIMIT 1 FOR UPDATE",now.toString()).firstOrNull() ?: return@execute null
        val job=DocumentJob(row["attachment_ref"] as String,row["source_hash"] as String,(row["generation"] as Number).toInt())
        val lease=now.plusSeconds(150).toString()
        db.jdbc.update("UPDATE bnoc_document_jobs SET status='processing',lease_until=?,attempt_count=attempt_count+1,updated_at=? WHERE attachment_ref=?",lease,now.toString(),job.attachmentRef)
        db.jdbc.update("UPDATE bnoc_document_analysis SET status='processing',updated_at=? WHERE attachment_ref=? AND generation=? AND source_hash=?",now.toString(),job.attachmentRef,job.generation,job.sourceHash)
        job
    }

    private fun parse(job:DocumentJob) {
        val attachment=db.rows("SELECT * FROM bnoc_attachments WHERE attachment_ref=? AND resource_kind='request' AND resource_ref IS NOT NULL AND content_analysis_excluded=FALSE",job.attachmentRef).firstOrNull() ?: return finishFailure(job,"attachment_unavailable","failed")
        if(!isAnalyzedDocument(attachment["file_name"] as String)) return
        val source=storedPath(attachment["stored_name"] as String)
        if(!Files.isRegularFile(source)) return finishFailure(job,"attachment_unavailable","failed")
        val bytes=Files.readAllBytes(source)
        if(sha256(bytes)!=job.sourceHash) return finishFailure(job,"source_changed","failed")
        val extension=(attachment["file_name"] as String).substringAfterLast('.',"").lowercase(Locale.ROOT)
        val temp=Files.createTempFile("bnoc-document-",".$extension")
        val tikaConfig=DocumentTikaConfig.create()
        try {
            Files.write(temp,bytes)
            val config=PipesForkParserConfig().setHandlerType(HANDLER_TYPE.HTML).setParseMode(ParseMode.CONCATENATE).setNumClients(1).setWriteLimit(1_000_000).setJvmArgs(listOf("-Xmx512m","-cp",DocumentTikaConfig.forkClasspath())).setTimeoutLimits(TimeoutLimits(120_000,120_000)).setUserConfigPath(tikaConfig)
            val metadata=Metadata().apply {
                if(extension=="hwp") set("Content-Type","application/x-hwp-v5")
                if(extension=="pdf") set("Content-Type","application/pdf")
                set(TikaCoreProperties.RESOURCE_NAME_KEY,temp.fileName.toString())
            }
            PipesForkParser(config).use { parser ->
                val result=parser.parse(temp,metadata)
                if(!result.isSuccess || result.isTaskException) {
                    val detail=result.message.orEmpty()
                    val encrypted=detail.contains("encrypt",true) || detail.contains("password",true)
                    finishFailure(job,if(encrypted) "encrypted" else if(detail.contains("timeout",true)) "timeout" else "parse_failed",if(encrypted) "unreadable" else "failed")
                } else {
                    val resultMetadata=result.metadata
                    val extracted=DocumentContentExtractor.extractHtml(result.content.orEmpty(),resultMetadata.get(TikaCoreProperties.TITLE))
                    if(extracted.bodyText.isBlank()) finishResult(job,"no_text",extracted.blocks,extracted.bodyText,extracted.metadata,null)
                    else {
                        val pageCount=listOf("xmpTPg:NPages","meta:page-count","meta:pageCount").mapNotNull { resultMetadata.get(it)?.toIntOrNull() }.maxOrNull() ?: 0
                        val processedRange=processedDocumentRange(extension=="pdf",pageCount,result.content?.length ?: 0)
                        finishResult(job,if(processedRange!=null) "partial" else "ready",extracted.blocks,extracted.bodyText,extracted.metadata,null,processedRange)
                    }
                }
            }
        } finally { Files.deleteIfExists(temp);Files.deleteIfExists(tikaConfig) }
    }

    private fun finishFailure(job:DocumentJob,error:String,status:String) {
        transaction.execute {
            val now=Instant.now().toString()
            db.jdbc.update("UPDATE bnoc_document_analysis SET status=?,error_code=?,processed_range=NULL,updated_at=? WHERE attachment_ref=? AND generation=? AND source_hash=? AND EXISTS (SELECT 1 FROM bnoc_attachments a WHERE a.attachment_ref=? AND a.content_analysis_excluded=FALSE)",status,error,now,job.attachmentRef,job.generation,job.sourceHash,job.attachmentRef)
            db.jdbc.update("UPDATE bnoc_document_jobs SET status='failed',lease_until=NULL,updated_at=? WHERE attachment_ref=? AND generation=? AND source_hash=? AND EXISTS (SELECT 1 FROM bnoc_attachments a WHERE a.attachment_ref=? AND a.content_analysis_excluded=FALSE)",now,job.attachmentRef,job.generation,job.sourceHash,job.attachmentRef)
        }
    }

    private fun finishResult(job:DocumentJob,status:String,blocks:List<Map<String,Any?>>,bodyText:String,metadata:List<Map<String,Any?>>,error:String?,processedRange:String?=null) {
        transaction.execute {
            val now=Instant.now().toString()
            db.jdbc.update("UPDATE bnoc_document_analysis SET status=?,body_json=?,body_text=?,metadata_json=?,error_code=?,processed_range=?,updated_at=? WHERE attachment_ref=? AND generation=? AND source_hash=? AND EXISTS (SELECT 1 FROM bnoc_attachments a WHERE a.attachment_ref=? AND a.content_analysis_excluded=FALSE)",status,db.json.writeValueAsString(blocks),bodyText,db.json.writeValueAsString(metadata),error,processedRange,now,job.attachmentRef,job.generation,job.sourceHash,job.attachmentRef)
            db.jdbc.update("UPDATE bnoc_document_jobs SET status='done',lease_until=NULL,updated_at=? WHERE attachment_ref=? AND generation=? AND source_hash=? AND EXISTS (SELECT 1 FROM bnoc_attachments a WHERE a.attachment_ref=? AND a.content_analysis_excluded=FALSE)",now,job.attachmentRef,job.generation,job.sourceHash,job.attachmentRef)
        }
    }

    private fun authorizedAttachment(actor:Actor,ref:String):Map<String,Any?> {
        val row=db.rows("SELECT * FROM bnoc_attachments WHERE attachment_ref=? AND resource_kind='request'",ref).firstOrNull() ?: reject("NOT_FOUND")
        val resource=row["resource_ref"] as? String
        if(resource==null) {
            if(row["owner_subject"]!=actor.id || row["was_linked"]!=false) reject("NOT_FOUND")
        } else query.requireRequest(actor,resource)
        return row
    }

    private fun storedPath(name:String):Path {
        val path=root.resolve(name).normalize()
        if(!path.startsWith(root)) reject("NOT_FOUND")
        return path
    }

    private fun sha256(bytes:ByteArray)=MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
