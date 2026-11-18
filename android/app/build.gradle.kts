import java.util.Base64
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Single source of truth for the version. See README.md for the release steps.
val versionProps = Properties().apply {
    rootProject.file("version.properties").inputStream().use { load(it) }
}

// The Play package name comes from the environment. Local and PR builds use the fallback.
val appId = System.getenv("HEADLAMPS_APPLICATION_ID")?.takeIf { it.isNotBlank() } ?: "app.headlamps"

// The upload key comes from the environment. Without all four values, release stays unsigned.
val uploadEnv = listOf(
    "HEADLAMPS_UPLOAD_KEYSTORE_BASE64",
    "HEADLAMPS_UPLOAD_STORE_PASSWORD",
    "HEADLAMPS_UPLOAD_KEY_ALIAS",
    "HEADLAMPS_UPLOAD_KEY_PASSWORD",
).associateWith { System.getenv(it) }
val hasUploadKey = uploadEnv.values.all { !it.isNullOrBlank() }

android {
    namespace = "app.headlamps"
    compileSdk = 36

    defaultConfig {
        applicationId = appId
        minSdk = 26
        targetSdk = 36
        versionCode = versionProps.getProperty("versionCode").toInt()
        versionName = versionProps.getProperty("versionName")
    }

    if (hasUploadKey) {
        signingConfigs {
            create("release") {
                val keystore = layout.buildDirectory.file("signing/upload.jks").get().asFile
                keystore.parentFile.mkdirs()
                keystore.writeBytes(
                    Base64.getDecoder().decode(uploadEnv.getValue("HEADLAMPS_UPLOAD_KEYSTORE_BASE64")!!),
                )
                storeFile = keystore
                storePassword = uploadEnv.getValue("HEADLAMPS_UPLOAD_STORE_PASSWORD")
                keyAlias = uploadEnv.getValue("HEADLAMPS_UPLOAD_KEY_ALIAS")
                keyPassword = uploadEnv.getValue("HEADLAMPS_UPLOAD_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            if (hasUploadKey) signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.glance.appwidget)
    implementation(libs.glance.material3)
    implementation(libs.work.runtime)
    implementation(libs.datastore.preferences)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
}
