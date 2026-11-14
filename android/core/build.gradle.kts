// Plain Kotlin: the secure link, pairing, focus snapshots, colours and spoken-task parsing.
// No Android dependencies, so it's tested on any JVM with `gradle :core:test`.
plugins {
    kotlin("jvm")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    // org.json is built into Android; the JVM build and tests need the same library.
    compileOnly("org.json:json:20251224")
    testImplementation("org.json:json:20251224")
    testImplementation(kotlin("test"))
}

tasks.test { useJUnitPlatform() }
