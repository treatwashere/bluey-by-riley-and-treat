package co.visionairy.bluey.core

import org.json.JSONObject
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CoreTest {
    @Test fun hkdfMatchesRfc5869TestCase1() {
        val ikm = ByteArray(22) { 0x0b }
        val salt = ByteArray(13) { it.toByte() }
        val info = ByteArray(10) { (0xf0 + it).toByte() }
        val okm = Crypto.hkdf(ikm, salt, info, 42).joinToString("") { "%02x".format(it) }
        assertEquals("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865", okm)
    }

    @Test fun pairingRoundTripAndIdentifier() {
        val record = PairingRecord("Riley's PC", Crypto.randomBytes(32))
        val text = "bluey-pair:" + java.util.Base64.getEncoder().encodeToString(record.toJson().toByteArray())
        assertEquals(record, PairingRecord.parse(text))
        assertEquals(24, record.identifier.length)
        assertNull(PairingRecord.parse("bluey-pair:nope"))
        assertNull(PairingRecord.parse("hello"))
    }

    @Test fun channelRejectsReplayAndTampering() {
        val secret = Crypto.randomBytes(32); val challenge = Crypto.randomBytes(32)
        val pc = SecureChannel(secret, challenge, true)
        val phone = SecureChannel(secret, challenge, false)
        val a = pc.seal(JSONObject().put("command", "a"))
        val b = pc.seal(JSONObject().put("command", "b"))
        assertEquals("a", phone.open(a).getString("command"))
        assertFailsWith<Exception> { phone.open(a) }
        val bad = java.util.Base64.getDecoder().decode(b).also { it[20] = (it[20].toInt() xor 1).toByte() }
        assertFailsWith<Exception> { phone.open(java.util.Base64.getEncoder().encodeToString(bad)) }
    }

    @Test fun phoneAndComputerPairOverTcp() {
        val secret = Crypto.randomBytes(32)
        val server = ServerSocket(0)
        val got = CountDownLatch(2)
        var serverSaw = ""; var phoneSaw = ""
        Thread {
            val link = LineConnection(server.accept(), secret, true)
            link.onAuthenticated = { link.send(JSONObject().put("hello", "PC")) }
            link.onPacket = { serverSaw = it.optString("command"); got.countDown() }
            link.start()
        }.start()
        val phone = LineConnection(Socket("127.0.0.1", server.localPort), secret, false)
        phone.onAuthenticated = { phone.send(JSONObject().put("command", "focusPing")) }
        phone.onPacket = { phoneSaw = it.optString("hello"); got.countDown() }
        phone.start()
        assertTrue(got.await(5, TimeUnit.SECONDS))
        assertEquals("focusPing", serverSaw); assertEquals("PC", phoneSaw)
        phone.cancel(); server.close()
    }

    @Test fun wrongSecretIsRefused() {
        val server = ServerSocket(0)
        Thread { LineConnection(server.accept(), Crypto.randomBytes(32), true).start() }.start()
        val closed = CountDownLatch(1)
        val phone = LineConnection(Socket("127.0.0.1", server.localPort), Crypto.randomBytes(32), false)
        phone.onClose = { closed.countDown() }
        phone.start()
        assertTrue(closed.await(5, TimeUnit.SECONDS))
        assertFalse(phone.authenticated)
        server.close()
    }

    @Test fun parsesSwiftFocusSync() {
        val json = """{"current":{"id":"A1B2","task":"Write","duration":1500,"startedAt":785000000.5,"elapsed":90,
            "status":"running","detail":"On task","checks":[{"id":"C","elapsed":30,"activity":"on_task","probability":0.1,
            "confidence":0.9,"probabilities":{"on_task":0.8,"off_task":0.1,"uncertain":0.1},"nudged":false,"providers":["claude","gemini"]},
            {"id":"D","elapsed":60,"activity":"off_task","probability":0.7,"confidence":0.6,"nudged":true}],"developerMode":true},
            "history":[],"revision":7,"sentAt":785000100,"developerMode":true}"""
        val sync = assertNotNull(FocusJson.parseSync(json))
        val s = assertNotNull(sync.current)
        assertEquals("23:30", FocusJson.clock(s.remaining))
        assertEquals("off_task", s.lastResult?.activity)
        assertEquals(listOf("claude", "gemini"), s.checks[0].providers)
        assertEquals(0.5, s.onTaskShare)
        assertEquals(7, sync.revision)
        assertNull(FocusJson.parseSync("{}"))
    }

    @Test fun parsesSpokenTasks() {
        assertEquals(TaskParser.Parsed("I'm making a Codex video", 30.0), TaskParser.parse("I'm making a Codex video for 30 minutes"))
        assertEquals(45.0, TaskParser.parse("Editing the launch video for 45 mins")?.minutes)
        assertEquals(120.0, TaskParser.parse("revising for two hours")?.minutes)
        assertEquals(30.0, TaskParser.parse("ok Bluey, maths homework for half an hour")?.minutes)
        assertEquals("Maths homework", TaskParser.parse("ok Bluey, maths homework for half an hour")?.task)
        assertEquals(30.0, TaskParser.parse("Writing my essay")?.minutes)
        assertEquals(240.0, TaskParser.parse("Coding for 9 hours")?.minutes)
        assertNull(TaskParser.parse("for 20 minutes"))
    }

    @Test fun coloursAndProviders() {
        assertEquals(Palette.greenie, Palette.named("GREENIE"))
        assertEquals(8, Palette.all.map { it.id }.toSet().size)
        assertEquals(AIProvider.ALL, AIProvider.from("all"))
    }
}
