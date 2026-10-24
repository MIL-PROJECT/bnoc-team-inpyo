package bnoc

import org.apache.tika.config.TimeoutLimits
import org.apache.tika.metadata.Metadata
import org.apache.tika.metadata.TikaCoreProperties
import org.apache.tika.pipes.fork.PipesForkParser
import org.apache.tika.pipes.fork.PipesForkParserConfig
import org.apache.tika.pipes.api.ParseMode
import org.apache.tika.sax.BasicContentHandlerFactory.HANDLER_TYPE
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path

class DocumentParserProbeTest {
    @Test fun `valid HWP fixture extracts body with packaged parser`() {
        val file=Path.of("..","frontend","src","preview","fixtures","support.hwp").toAbsolutePath().normalize()
        val tikaConfig=DocumentTikaConfig.create()
        val config=PipesForkParserConfig()
            .setHandlerType(HANDLER_TYPE.HTML)
            .setParseMode(ParseMode.CONCATENATE)
            .setNumClients(1)
            .setWriteLimit(1_000_000)
            .setJvmArgs(listOf("-Xmx512m","-cp",DocumentTikaConfig.forkClasspath()))
            .setTimeoutLimits(TimeoutLimits(120_000,120_000))
            .setUserConfigPath(tikaConfig)

        try { PipesForkParser(config).use { parser ->
            val metadata=Metadata().apply {
                set("Content-Type","application/x-hwp-v5")
                set(TikaCoreProperties.RESOURCE_NAME_KEY,"support.hwp")
            }
            val result=parser.parse(file,metadata)
            assertTrue(result.isSuccess,"HWP parse status: ${result.status}; ${result.message}")
            assertTrue(!result.isTaskException,"HWP parse failure: ${result.message}")
            val extracted=DocumentContentExtractor.extractHtml(result.content.orEmpty(),result.metadata.get(TikaCoreProperties.TITLE))
            assertTrue(extracted.bodyText.contains("마이크 점검"),"raw HWP body was not extracted: ${result.content?.take(300)}")
        } } finally { Files.deleteIfExists(tikaConfig) }
    }
}
