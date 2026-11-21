import java.util.Properties

plugins {
    id("com.android.application")
}

android {
    namespace = "com.tide.browser"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "com.tide.browser"
        minSdk = 26
        targetSdk = 37
        // Keep versionName in step with the desktop version in package.json. versionCode must go up with every release.
        versionCode = 4
        versionName = "1.0.4"
    }

    signingConfigs {
        // Release signing is read from keystore.properties, which git ignores. See android/README.md.
        val keystoreProps = rootProject.file("keystore.properties")
        if (keystoreProps.exists()) {
            val p = Properties().apply { keystoreProps.inputStream().use { load(it) } }
            create("release") {
                storeFile = rootProject.file(p.getProperty("storeFile"))
                storePassword = p.getProperty("storePassword")
                keyAlias = p.getProperty("keyAlias")
                keyPassword = p.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-ktx:1.13.0")
    implementation("androidx.webkit:webkit:1.15.0")
}
