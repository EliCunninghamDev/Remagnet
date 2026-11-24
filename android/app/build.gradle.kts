plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// Release workflows override these from the tag; local builds keep the defaults.
val releaseVersionName = providers.gradleProperty("remagnet.versionName").orNull
    ?.takeIf { it.isNotBlank() }
val releaseVersionCode = providers.gradleProperty("remagnet.versionCode").orNull
    ?.toIntOrNull()

// The keystore never enters the checkout. Local release builds can export the
// same variables that .github/workflows/release.yml sets.
val releaseStorePath = System.getenv("REMAGNET_KEYSTORE")
val releaseStorePassword = System.getenv("REMAGNET_KEYSTORE_PASSWORD")
val releaseKeyAlias = System.getenv("REMAGNET_KEY_ALIAS")
val releaseKeyPassword = System.getenv("REMAGNET_KEY_PASSWORD")
val hasReleaseKey = listOf(
    releaseStorePath,
    releaseStorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { !it.isNullOrBlank() }

android {
    namespace = "dev.remagnet.app"
    compileSdk = 37
    compileSdkMinor = 2

    defaultConfig {
        applicationId = "app.remagnet"
        minSdk = 26
        targetSdk = 36
        versionCode = releaseVersionCode ?: 1
        versionName = releaseVersionName ?: "0.4.0"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    signingConfigs {
        if (hasReleaseKey) {
            create("release") {
                storeFile = file(releaseStorePath!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // Null without the release variables, which keeps the unsigned
            // release build working for local checks.
            signingConfig = signingConfigs.findByName("release")
        }
    }

    testOptions {
        unitTests {
            // Robolectric needs the merged resources and manifest for the
            // Compose UI tests.
            isIncludeAndroidResources = true
        }
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation(project(":proxy-client"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)
    implementation(libs.gson)
    implementation(libs.zxing.embedded)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.foundation)
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    debugImplementation(libs.compose.ui.tooling)
    debugImplementation(libs.compose.ui.test.manifest)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.compose.ui.test.junit4)
    testImplementation(libs.compose.ui.test.manifest)
}
