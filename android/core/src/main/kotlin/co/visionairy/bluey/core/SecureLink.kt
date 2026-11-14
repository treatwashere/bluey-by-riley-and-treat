package co.visionairy.bluey.core

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * The secure line protocol shared with the Mac, Windows and iPhone apps (docs/PROTOCOL.md).
 * Server sends {"challenge"}, client answers {"proof"} = HMAC-SHA256(secret, "bluey-pair-v1" + challenge),
 * then each line is base64(nonce ‖ AES-256-GCM(JSON {"sequence","packet"}) ‖ tag) under HKDF direction keys.
 */
object Crypto {
    private val random = SecureRandom()
    fun randomBytes(count: Int) = ByteArray(count).also { random.nextBytes(it) }

    fun hmac(key: ByteArray, data: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(key, "HmacSHA256")); doFinal(data) }

    /** RFC 5869 HKDF-SHA256. */
    fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val prk = hmac(salt, ikm)
        val out = ByteArrayOutputStream()
        var block = ByteArray(0)
        var counter = 1
        while (out.size() < length) {
            block = hmac(prk, block + info + byteArrayOf(counter.toByte()))
            out.write(block); counter++
        }
        return out.toByteArray().copyOf(length)
    }

    fun proof(secret: ByteArray, challenge: ByteArray) = hmac(secret, "bluey-pair-v1".toByteArray() + challenge)
    fun verifies(candidate: ByteArray, secret: ByteArray, challenge: ByteArray) =
        MessageDigest.isEqual(candidate, proof(secret, challenge))
    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)
}

class SecureChannel(secret: ByteArray, challenge: ByteArray, server: Boolean) {
    private val sendKey = key(secret, challenge, if (server) "mac-to-phone" else "phone-to-mac")
    private val receiveKey = key(secret, challenge, if (server) "phone-to-mac" else "mac-to-phone")
    private var sent = 0
    private var received = 0

    private fun key(secret: ByteArray, challenge: ByteArray, direction: String) =
        SecretKeySpec(Crypto.hkdf(secret, challenge, "bluey-v1-$direction".toByteArray(), 32), "AES")

    @Synchronized fun seal(packet: JSONObject): String {
        val nonce = Crypto.randomBytes(12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, sendKey, GCMParameterSpec(128, nonce))
        val record = JSONObject().put("sequence", sent).put("packet", packet)
        sent++
        return Base64.getEncoder().encodeToString(nonce + cipher.doFinal(record.toString().toByteArray()))
    }

    @Synchronized fun open(line: String): JSONObject {
        val data = Base64.getDecoder().decode(line.trim())
        require(data.size >= 28) { "invalid record" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, receiveKey, GCMParameterSpec(128, data, 0, 12))
        val record = JSONObject(String(cipher.doFinal(data, 12, data.size - 12)))
        require(record.getInt("sequence") == received) { "out of order" }
        received++
        return record.getJSONObject("packet")
    }
}

/**
 * One connection. Reads on its own thread and writes on another, so callers (the Android main thread
 * included) never block on the network. Callbacks arrive on the reader thread.
 */
class LineConnection(
    private val socket: Socket,
    private val secret: ByteArray,
    private val server: Boolean,
) {
    var onAuthenticated: () -> Unit = {}
    var onPacket: (JSONObject) -> Unit = {}
    var onClose: () -> Unit = {}

    @Volatile var authenticated = false; private set
    @Volatile private var closed = false
    private var channel: SecureChannel? = null
    private var challenge: ByteArray? = null
    private val writer = Executors.newSingleThreadExecutor { Thread(it, "bluey-link-writer").apply { isDaemon = true } }

    fun start() {
        socket.tcpNoDelay = true
        socket.keepAlive = true
        Thread({ readLoop() }, "bluey-link-reader").apply { isDaemon = true }.start()
        Thread({
            try { Thread.sleep(8000) } catch (_: InterruptedException) {}
            if (!authenticated) cancel()
        }, "bluey-link-timeout").apply { isDaemon = true }.start()
        if (server) {
            val c = Crypto.randomBytes(32); challenge = c
            writeLine(JSONObject().put("challenge", Base64.getEncoder().encodeToString(c)).toString())
        }
    }

    fun send(packet: JSONObject) {
        val ch = channel
        if (!authenticated || ch == null || closed) return
        val line = try { ch.seal(packet) } catch (_: Exception) { cancel(); return }
        writeLine(line)
    }

    fun cancel() {
        if (closed) return
        closed = true
        try { socket.close() } catch (_: Exception) {}
        writer.shutdown()
        onClose()
    }

    private fun writeLine(line: String) {
        if (closed) return
        try {
            writer.execute {
                try {
                    socket.getOutputStream().apply { write((line + "\n").toByteArray()); flush() }
                } catch (_: Exception) { cancel() }
            }
        } catch (_: Exception) { cancel() }
    }

    private fun readLoop() {
        val input = try { socket.getInputStream() } catch (_: Exception) { cancel(); return }
        val buffer = ByteArrayOutputStream()
        val chunk = ByteArray(64 * 1024)
        try {
            while (!closed) {
                val n = input.read(chunk)
                if (n < 0) break
                var start = 0
                for (i in 0 until n) {
                    if (chunk[i] == '\n'.code.toByte()) {
                        buffer.write(chunk, start, i - start)
                        val line = buffer.toString(Charsets.UTF_8.name()); buffer.reset()
                        start = i + 1
                        accept(line)
                        if (closed) return
                    }
                }
                buffer.write(chunk, start, n - start)
                if (buffer.size() > 16 * 1024 * 1024) break
            }
        } catch (_: Exception) {
        }
        cancel()
    }

    private fun accept(line: String) {
        val ch = channel
        if (ch != null) {
            val packet = try { ch.open(line) } catch (_: Exception) { cancel(); return }
            if (!authenticated) {
                if (server || packet.optString("command") != "paired") { cancel(); return }
                authenticated = true
                onAuthenticated()
            } else onPacket(packet)
            return
        }
        val json = try { JSONObject(line) } catch (_: Exception) { cancel(); return }
        if (server) {
            val proof = try { Base64.getDecoder().decode(json.getString("proof")) } catch (_: Exception) { cancel(); return }
            val c = challenge ?: run { cancel(); return }
            if (!Crypto.verifies(proof, secret, c)) { cancel(); return }
            channel = SecureChannel(secret, c, true)
            authenticated = true
            send(JSONObject().put("command", "paired"))
            onAuthenticated()
        } else {
            val c = try { Base64.getDecoder().decode(json.getString("challenge")) } catch (_: Exception) { cancel(); return }
            if (c.size != 32) { cancel(); return }
            channel = SecureChannel(secret, c, false)
            writeLine(JSONObject().put("proof", Base64.getEncoder().encodeToString(Crypto.proof(secret, c))).toString())
        }
    }
}

/** The QR pairing record ("bluey-pair:" + base64 JSON), the same as Swift's PairingRecord. */
data class PairingRecord(val service: String, val secret: ByteArray) {
    /** Public fingerprint matched against the computer's Bonjour/NSD "bluey-id" TXT entry. */
    val identifier: String get() = Crypto.sha256(secret).copyOf(12).joinToString("") { "%02x".format(it) }

    fun toJson(): String = JSONObject().put("version", 1).put("service", service)
        .put("secret", Base64.getEncoder().encodeToString(secret)).toString()

    override fun equals(other: Any?) = other is PairingRecord && other.service == service && other.secret.contentEquals(secret)
    override fun hashCode() = service.hashCode() * 31 + secret.contentHashCode()

    companion object {
        fun parse(text: String): PairingRecord? {
            val trimmed = text.trim()
            if (!trimmed.startsWith("bluey-pair:") || trimmed.length >= 2048) return null
            return try { fromJson(String(Base64.getDecoder().decode(trimmed.substring(11)))) } catch (_: Exception) { null }
        }
        fun fromJson(json: String): PairingRecord? = try {
            val o = JSONObject(json)
            val secret = Base64.getDecoder().decode(o.getString("secret"))
            val service = o.getString("service")
            if (o.getInt("version") != 1 || secret.size != 32 || service.isEmpty()) null else PairingRecord(service, secret)
        } catch (_: Exception) { null }
    }
}
