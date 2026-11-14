# How the phone and computer talk

Every Bluey app speaks the same protocol, so any phone works with any computer:

| | iPhone | Android |
|---|---|---|
| **Mac** | ✓ | ✓ |
| **Windows** | ✓ | ✓ |

Implementations: `Shared/SecurePairing.swift` + `Shared/GooglyLink.swift` (Mac, iPhone), `windows/src/link.js` (Windows),
`android/core/src/main/kotlin/co/visionairy/bluey/core/SecureLink.kt` (Android). The Windows and Android versions are
tested against each other.

## Finding each other

The computer advertises `_googly._tcp` on the local network (Bonjour / mDNS / Android NSD) with a TXT entry
`bluey-id` = the first 12 bytes of SHA-256(secret), as hex. The phone connects only to the computer whose `bluey-id`
matches its pairing. The fingerprint is public; it doesn't let anyone connect.

## Pairing

The computer shows a QR code (Android can also paste it as text):
`bluey-pair:` + base64(JSON `{"version":1,"service":"<computer name>","secret":"<base64 of 32 random bytes>"}`).
The secret is a credential: never log, sync or screenshot it.

## Handshake

Lines of UTF-8 text ending in `\n` over TCP.

1. Computer → phone: `{"challenge":"<base64 of 32 random bytes>"}`
2. Phone → computer: `{"proof":"<base64 HMAC-SHA256(secret, "bluey-pair-v1" ‖ challenge)>"}`
3. Both derive two keys with HKDF-SHA256(ikm = secret, salt = challenge, info = `bluey-v1-mac-to-phone` or
   `bluey-v1-phone-to-mac`, 32 bytes). The computer always uses `mac-to-phone` to send, Windows included.
4. Computer → phone (encrypted): `{"command":"paired"}`. Anything else closes the connection. Unauthenticated
   connections close after 8 seconds.

## Records

Each later line is base64(12-byte nonce ‖ AES-256-GCM ciphertext ‖ 16-byte tag) of the JSON
`{"sequence": n, "packet": {...}}`. Each direction counts from 0; a wrong sequence number, failed tag or bad
JSON closes the connection (no replay, reordering or tampering).

## Packets

A packet is a JSON object with optional fields: `face`, `hello`, `command`, `callID`, `tool`, `text`, `image`,
`audio`, `speech`, `volume`. Unknown fields are ignored, so apps can add new ones safely.

| Command | Direction | Meaning |
|---|---|---|
| `hello` field | both | Device name, sent once after pairing |
| `face` field | computer → phone | `{"gazeX":-1…1,"gazeY":-1…1,"mood":"listening|resting|thinking|talking|pointing|happy|sleepy","talk":0…1}` |
| `focusStart`, `focusPause`, `focusResume`, `focusEnd`, `focusTestNudge`, `focusDeveloperMode` | phone → computer | `text` = JSON args (`task`, `minutes`, `developerMode`); reply `focusReply` with the same `callID` |
| `focusPing` | phone → computer | Heartbeat every second; monitoring pauses after 5 s without one |
| `focusSync` | phone → computer | Ask for the current state |
| `focusState` | computer → phone | `text` = FocusSync JSON in Swift Codable form (dates are seconds since 2001‑01‑01, ids uppercase UUIDs) |
| `focusChirp` | computer → phone | A nudge: show `text`, chirp |
| `colour` | both | `text` = `bluey`, `greenie`, `reddie`, `azure`, `purply`, `pinky`, `sunny` or `orangey`. Sent by the computer after pairing and whenever it changes |
| `aiProvider` | both | `text` = `chatgpt`, `claude`, `gemini`, `deepseek` or `all`. The keys themselves never leave the computer |
| `realtimeToken`, `tool`, `caption`, `captionDone`, `awake`, `asleep`, `wake`, `sleep` | iPhone voice | Short-lived OpenAI Realtime keys and tool calls (Mac and Windows) |
| `transcribe`, `notes`, `codexNote`, `codexChirp` | iPhone ↔ Mac | Meeting notes and Codex (Mac only) |
