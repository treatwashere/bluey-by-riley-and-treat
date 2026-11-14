package co.visionairy.bluey.android

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import co.visionairy.bluey.core.LineConnection
import co.visionairy.bluey.core.PairingRecord
import org.json.JSONObject
import java.net.InetSocketAddress
import java.net.Socket
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.Executors
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Keeps the QR pairing secret encrypted with a key that never leaves this phone's Android Keystore. */
class PairingStore(context: Context) {
    private val prefs = context.getSharedPreferences("pairing", Context.MODE_PRIVATE)
    private val alias = "bluey-pairing"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build())
        return generator.generateKey()
    }

    fun load(): PairingRecord? = try {
        prefs.getString("record", null)?.let { stored ->
            val data = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, data, 0, 12))
            PairingRecord.fromJson(String(cipher.doFinal(data, 12, data.size - 12)))
        }
    } catch (_: Exception) { null }

    fun save(record: PairingRecord): Boolean = try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(record.toJson().toByteArray())
        prefs.edit().putString("record", Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
        true
    } catch (_: Exception) { false }

    fun clear() = prefs.edit().remove("record").apply()
}

/**
 * Finds the paired Mac or Windows PC with Android's NSD (Bonjour), matching the "bluey-id" fingerprint in
 * its TXT record, connects with the secure link and reconnects when the Wi-Fi blips.
 * Every callback is delivered on the main thread.
 */
class ComputerLink(context: Context, private val pairing: PairingStore) {
    var onConnectionChanged: (Boolean, String?) -> Unit = { _, _ -> }
    var onPacket: (JSONObject) -> Unit = {}

    var connected = false; private set
    var computerName: String? = null; private set

    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()
    private var discovery: NsdManager.DiscoveryListener? = null
    private var link: LineConnection? = null
    private var connecting = false
    private var running = false
    private val waiting = mutableMapOf<String, (JSONObject?) -> Unit>()
    private val found = ArrayDeque<NsdServiceInfo>()
    private var resolving = false

    fun start() {
        if (running) return
        running = true
        discover()
    }

    fun stop() {
        running = false
        discovery?.let { try { nsd.stopServiceDiscovery(it) } catch (_: Exception) {} }
        discovery = null
        link?.cancel(); link = null
        setConnected(false)
    }

    fun repair(record: PairingRecord): Boolean {
        if (!pairing.save(record)) return false
        stop(); start()
        return true
    }

    fun send(packet: JSONObject) { link?.send(packet) }

    /** Sends a request and calls back with the computer's reply (null if it went away or took too long). */
    fun request(packet: JSONObject, done: (JSONObject?) -> Unit) {
        val current = link
        if (current == null || !connected) { done(null); return }
        val id = UUID.randomUUID().toString()
        packet.put("callID", id)
        waiting[id] = done
        main.postDelayed({ waiting.remove(id)?.invoke(null) }, 12_000)
        current.send(packet)
    }

    private fun setConnected(value: Boolean) {
        connected = value
        if (!value) {
            val pending = waiting.values.toList(); waiting.clear()
            pending.forEach { it(null) }
        }
        onConnectionChanged(value, computerName)
    }

    private fun discover() {
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { retryLater() }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceLost(service: NsdServiceInfo) {}
            override fun onServiceFound(service: NsdServiceInfo) {
                main.post { found.addLast(service); resolveNext() }
            }
        }
        discovery = listener
        try { nsd.discoverServices("_googly._tcp", NsdManager.PROTOCOL_DNS_SD, listener) } catch (_: Exception) { retryLater() }
    }

    private fun retryLater() {
        main.postDelayed({
            if (!running) return@postDelayed
            discovery?.let { try { nsd.stopServiceDiscovery(it) } catch (_: Exception) {} }
            discovery = null
            discover()
        }, 3000)
    }

    /** Older Android versions resolve one service at a time, so found services queue up here. */
    @Suppress("DEPRECATION")
    private fun resolveNext() {
        if (resolving || connecting || link != null) return
        val service = found.removeFirstOrNull() ?: return
        resolving = true
        nsd.resolveService(service, object : NsdManager.ResolveListener {
            override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                main.post { resolving = false; resolveNext() }
            }
            override fun onServiceResolved(info: NsdServiceInfo) {
                main.post { resolving = false; resolved(info); resolveNext() }
            }
        })
    }

    @Suppress("DEPRECATION")
    private fun resolved(info: NsdServiceInfo) {
        val record = pairing.load() ?: return
        val id = info.attributes["bluey-id"]?.let { String(it) }
        if (id != record.identifier || link != null || connecting) return
        val host = if (Build.VERSION.SDK_INT >= 34) info.hostAddresses.firstOrNull() else info.host
        host ?: return
        connecting = true
        computerName = info.serviceName
        io.execute {
            val socket = try {
                Socket().apply { connect(InetSocketAddress(host, info.port), 5000) }
            } catch (_: Exception) {
                main.post { connecting = false; reconnectSoon() }
                return@execute
            }
            main.post { attach(LineConnection(socket, record.secret, server = false)) }
        }
    }

    private fun attach(connection: LineConnection) {
        connecting = false
        link = connection
        connection.onAuthenticated = {
            main.post {
                if (link !== connection) return@post
                connection.send(JSONObject().put("hello", Build.MODEL ?: "Android"))
                connection.send(JSONObject().put("command", "focusSync"))
                setConnected(true)
            }
        }
        connection.onPacket = { packet ->
            main.post {
                if (link !== connection) return@post
                if (packet.has("hello")) computerName = packet.optString("hello")
                val callID = packet.optString("callID", "")
                val done = if (callID.isNotEmpty()) waiting.remove(callID) else null
                if (done != null) done(packet) else onPacket(packet)
            }
        }
        connection.onClose = {
            main.post {
                if (link !== connection) return@post
                link = null
                setConnected(false)
                reconnectSoon()
            }
        }
        connection.start()
    }

    /** Rediscovers after a drop: the computer may have a new address or port. */
    private fun reconnectSoon() {
        main.postDelayed({
            if (!running || link != null) return@postDelayed
            discovery?.let { try { nsd.stopServiceDiscovery(it) } catch (_: Exception) {} }
            discovery = null
            found.clear()
            discover()
        }, 1500)
    }
}
