plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "uk.whattowatch.scrobbler"
    compileSdk = 34

    defaultConfig {
        applicationId = "uk.whattowatch.scrobbler"
        minSdk = 25
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "ENDPOINT", "\"${property("wtw.endpoint")}\"")
        buildConfigField("String", "TOKEN", "\"${property("wtw.token")}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}
