# 15분만

주차한 차에서 '15분만'을 누르면, 차가 문을 잠그고 등받이를 눕혀 재운 뒤 실내를 지켜보다가 등받이를 세워 깨워 주는 쪽잠 앱입니다. (현대자동차그룹 차량용 앱 개발 공모전 출품작, Pleos Connect용)

- 한 번 눌러 잠자리 만들기: 문 잠금 → 열린 창문 닫기 → 바깥 공기 들이기 → 등받이 눕히기 → 화면 어둡게
- 자는 동안 지켜보기: 실내가 30℃ 이상·8℃ 이하로 10초 넘게 이어지거나, 문이 열리거나, 브레이크를 밟으면 먼저 깨움
- 등받이가 먼저 깨운다: 시간이 되면 눕힌 만큼 등받이를 세우고 화면과 음성으로 깨움
- 출발 전 2분: 덜 깬 채 출발하지 않도록 2분 동안 몸을 깨우게 안내
- 기어가 P일 때만 동작하고, P를 벗어나면 즉시 멈춤

## 실행 방법

### 1) 브라우저에서 바로 실행 (설치 없음)

`web/index.html`을 크롬이나 엣지로 엽니다. 왼쪽이 차량 화면, 오른쪽이 '가상 차량' 패널입니다.

1. `15분 자기`를 누릅니다.
2. 가상 차량 패널에서 `시연 속도`를 60배로 두면 15분이 15초로 줄어듭니다.
3. 자는 중에 `실내 온도`를 30℃ 이상으로 올리거나, `문 열기`, 기어 `D`를 눌러 예외 동작을 확인합니다.
4. 패널 아래 '차에 보낸 요청' 목록에는 실제 차량에서 호출될 SDK API 이름이 순서대로 찍힙니다.

### 2) Pleos Connect 에뮬레이터에서 실행

1. Pleos Connect 에뮬레이터를 켭니다.
2. APK를 설치합니다: `adb install -r apk/wallsong_15분만_release.apk`
3. 앱 목록에서 `15분만`을 엽니다.
4. Virtual Console에서 기어를 P에 두고 시작합니다. 문·실내 온도·브레이크·기어를 바꿔 예외 동작을 확인합니다.

### 3) 직접 빌드

- Android Studio로 `android/` 폴더를 열고 Run 하거나, `cd android && ./gradlew assembleRelease` (JDK 17)
- 결과물: `android/app/build/outputs/apk/release/app-release.apk`
- Pleos SDK는 `https://nexus-playground.pleos.ai/repository/maven-releases/`에서 내려받습니다(`android/settings.gradle.kts`에 설정됨).
- 이 저장소의 `main` 브랜치에 올리면 GitHub Actions(`APK 만들기`)가 release APK를 만들어 `apk/` 폴더에 넣습니다. APK 이름의 팀명은 `team-name.txt` 첫 줄에서 가져옵니다.

## APK 위치

`apk/wallsong_15분만_release.apk`

## 테스트 환경 및 필요한 설정

| 항목 | 값 |
|---|---|
| 대상 | Pleos Connect (Android Automotive 기반) |
| 에뮬레이터 | Pleos Connect Emulator v2.1.0 (Android 14 / API 34, 2560×1440) |
| SDK | Pleos Vehicle SDK 2.3.2, TextToSpeech SDK 3.3.1 |
| 빌드 도구 | AGP 8.8.2, Kotlin 2.0.0, Gradle 8.10.2, JDK 17 |
| Android | minSdk 28, targetSdk 34, compileSdk 35 |
| 필요한 설정 | 기어 P (P가 아니면 시작하지 않음) |
| 서명 | 심사용으로 디버그 키 서명. 다시 설치할 때 서명이 다르다고 나오면 기존 앱을 지우고 설치 |

사용 권한(선언한 것만 사용)

| 권한 | 용도 |
|---|---|
| `pleos.car.permission.CAR_DRIVE` | 기어, 브레이크 상태 읽기 |
| `pleos.car.permission.CAR_DOORS` / `CONTROL_CAR_DOORS` | 문 열림·잠금 읽기 / 잠그기 |
| `pleos.car.permission.CAR_WINDOWS` / `CONTROL_CAR_WINDOWS` | 창문 위치 읽기 / 닫기 |
| `pleos.car.permission.CAR_CLIMATE` / `CONTROL_CAR_CLIMATE` | 실내 온도·내기/외기·풍량 읽기 / 바꾸기 |
| `pleos.car.permission.CAR_SEATS` / `CONTROL_CAR_SEATS` | 뒷좌석 착좌 읽기 / 등받이 움직이기 |
| `pleos.car.permission.TTS_SERVICE` | 음성 안내 |

## 구조

```
web/                화면과 쪽잠 로직 (HTML·CSS·JS, 빌드 단계 없음)
  js/core.js        쪽잠 상태 기계: 홈 → 준비 → 수면 → 깨우기 → 출발 준비 → 요약
  js/vehicle.js     차량 연결부: 브라우저에서는 가상 차량, 차량에서는 네이티브 다리(NapNative)
  js/app.js         화면
android/            Pleos Connect 앱 (WebView 로 web/ 을 그대로 띄움)
  app/src/main/java/com/nap15/app/
    MainActivity.kt                 화면 띄우기, 밝기
    NapBridge.kt                    화면 ↔ 코틀린 창구 (window.NapNative)
    vehicle/PleosVehicleGateway.kt  Pleos Vehicle SDK 호출
    voice/PleosVoice.kt             Pleos TextToSpeech SDK 호출
tests/              자동 테스트
apk/                release APK
```

화면과 로직의 원본은 `web/` 한 벌입니다. 같은 코드가 브라우저에서는 가상 차량과, 차량에서는 실제 SDK와 연결됩니다. 앱 안의 `android/app/src/main/assets/web`은 `web/`의 복사본이며, GitHub Actions가 빌드 전에 자동으로 다시 복사합니다(직접 빌드할 때 `web/`을 고쳤다면 이 폴더도 같이 바꿉니다).

## 차량 연동

| 영역 | 사용하는 API | 용도 |
|---|---|---|
| 기어 | `getCurrentGearSelectionState`, `registerGearSelection` | P 확인, P 이탈 시 즉시 중단 |
| 브레이크 | `getCurrentBrakePedalStatus`, `registerBrakePedalStatus` | 새로 밟는 순간 깨우기 |
| 도어 | `checkDoorLockCapabilities`, `setDoorLock`, `getDoorLockState`, `registerDoorLockState`, `checkDoorPositionCapabilities`, `getCurrentDoorPosition`, `registerDoorPosition` | 전체 잠금, 문 열림 감지 |
| 창문 | `checkWindowPositionCapabilities`, `getCurrentWindowPosition`, `setWindowPosition`, `registerWindowPosition` | 열려 있는 창문만 닫기 |
| 공조 | `getHvacTemperatureCurrent`, `checkHvacRecirculationCapabilities`, `getHvacRecirculationState`, `setHvacRecirculation`, `checkHvacFanSpeedCapabilities`, `getHvacFanSpeed`, `setHvacFanSpeed` | 실내 온도 감시, 바깥 공기 유입, 깨울 때 풍량 |
| 시트 | `checkMoveSeatBackrestAngleCapabilities`, `moveSeatBackrestAngle`, `checkSeatOccupancyCapabilities`, `getCurrentSeatOccupancy` | 등받이 눕히기·세우기, 뒷좌석 탑승 확인 |
| 음성 | `TextToSpeech(ON_DEVICE)`: `initialize`, `speak`, `stop` | 안내와 기상 음성 |

## 안전 설계

- 기어가 P일 때만 시작합니다. 도중에 P를 벗어나면 쪽잠을 멈추고, 그 상태에서는 등받이를 움직이지 않습니다(화면 로직과 코틀린 양쪽에서 막음).
- 뒷좌석에 사람이 있거나 확인할 수 없으면 등받이를 절반만 눕힙니다.
- 등받이가 움직이는 동안 화면을 누르면 바로 멈춥니다. 화면이 응답하지 않아도 9초 뒤에는 코틀린 쪽에서 정지 명령을 보냅니다.
- 모든 제어는 capability 확인을 통과한 것만 호출합니다. 지원하지 않는 기능은 건너뛰고 화면에 알립니다.
- 주행 중 사용을 선언하지 않았습니다(`distractionOptimized` 없음). 주행 중에는 플랫폼이 화면을 가립니다.

## 검증 상태 (2026-11-15 기준)

확인한 것

- 쪽잠 로직 자동 테스트 18건 통과: `node tests/core.test.js`
- 브라우저에서 전체 흐름 실행, 콘솔 오류 없음: `node tests/shots.js` (Playwright 필요)
- 차량 모드(네이티브 다리)를 흉내 낸 화면 점검 통과: `node tests/native-mode.js` (Playwright 필요)
- GitHub Actions에서 Gradle 전체 빌드 성공, 서명된 release APK 생성(`apk/wallsong_15분만_release.apk`, Vehicle SDK 2.3.2·TextToSpeech SDK 3.3.1 포함)

아직 확인하지 못한 것

- Pleos Connect 에뮬레이터에서 APK 설치·실행
- 실차 동작: 등받이 이동 속도와 범위, 뒷좌석 착좌 값
- 앱이 화면 뒤로 갔을 때 타이머 유지(포그라운드 서비스 적용 예정)
- 제어 권한(`CONTROL_CAR_*`)의 App Market 사전 승인

## 알려진 제한

- SDK에 등받이 각도를 직접 지정하는 API가 없어, 눕힌 시간만큼 되돌려 세우는 방식입니다.
- Gear API는 SDK 2.3.2에서 deprecated 표시가 있습니다(Android 차량 속성 `GEAR_SELECTION` 권장). 기어를 읽지 못하면 앱은 시작을 막습니다.
- 화면 밝기는 앱 창의 밝기를 낮추고 화면을 어둡게 그리는 방식입니다. 차량 디스플레이 자체를 끄지는 않습니다.

## 폰트

숫자에 Overpass(SIL Open Font License 1.1)를 사용했습니다.
