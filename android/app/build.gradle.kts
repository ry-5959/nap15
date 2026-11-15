plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.nap15.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.nap15.app"
        minSdk = 28            // Pleos Connect 요구사항
        targetSdk = 34         // Pleos Connect 에뮬레이터 v2.1.0 = Android 14
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // 공모전 심사용: 디버그 키로 서명해 바로 adb install 할 수 있게 한다.
            // App Market에 올릴 때는 전용 키스토어로 바꿔야 한다.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

// 화면(웹)은 저장소 루트의 web/ 폴더가 원본이고, src/main/assets/web 은 그 복사본이다.
// web/ 을 고치면 복사본도 같이 바꾼다(GitHub Actions 는 빌드 전에 자동으로 복사한다).

dependencies {
    implementation(libs.vehicle.sdk)
    implementation(libs.tts.sdk)
    // SDK가 끌어오는 kotlin-reflect(1.9.x)와 버전이 어긋나지 않게 맞춘다(공식 샘플과 같은 처리).
    implementation(libs.kotlin.reflect)
}
