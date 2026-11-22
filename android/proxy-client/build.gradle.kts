plugins {
    alias(libs.plugins.android.library)
}

android {
    namespace = "dev.remagnet.proxy"
    compileSdk = 37
    compileSdkMinor = 2

    defaultConfig {
        minSdk = 26
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = false
    }
}

dependencies {
    // The generated Retrofit client uses these directly; expose them so the app
    // can consume response and auth types without repeating versions.
    api(libs.retrofit)
    api(libs.retrofit.converter.gson)
    api(libs.retrofit.converter.scalars)
    api(libs.okhttp.logging)
    api(libs.gson)
    api(libs.kotlinx.coroutines.core)
}
