package com.nap15.app.vehicle

import ai.pleos.playground.vehicle.Vehicle
import ai.pleos.playground.vehicle.api.model.area.DoorArea
import ai.pleos.playground.vehicle.api.model.area.SeatArea
import ai.pleos.playground.vehicle.api.model.area.WindowArea
import ai.pleos.playground.vehicle.api.model.capability.AccessType
import ai.pleos.playground.vehicle.api.model.capability.AreaBounds
import ai.pleos.playground.vehicle.api.model.capability.CapabilityConfig
import ai.pleos.playground.vehicle.constant.area.SeatValue
import ai.pleos.playground.vehicle.constant.control.MoveControl
import ai.pleos.playground.vehicle.constant.control.VehicleGear
import ai.pleos.playground.vehicle.constant.unit.TemperatureUnit
import ai.pleos.playground.vehicle.listener.BrakePedalStatusListener
import ai.pleos.playground.vehicle.listener.DoorLockStateListener
import ai.pleos.playground.vehicle.listener.DoorPositionListener
import ai.pleos.playground.vehicle.listener.GearSelectionListener
import ai.pleos.playground.vehicle.listener.WindowPositionListener
import android.content.Context
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Pleos Connect Vehicle SDK 2.3.2 연결부.
 *
 * 하는 일은 두 가지뿐이다.
 *  1) 차량 신호를 모아 1초마다(그리고 바뀔 때마다) 화면(WebView)으로 보낸다.
 *  2) 화면이 요청한 제어(act)를 SDK 호출로 바꾼다.
 *
 * 쪽잠 흐름(언제 눕히고 언제 깨울지)은 web/js/core.js 가 정한다. 여기에는 안전장치만 둔다.
 *  - 등받이는 기어가 P일 때만 움직인다. 움직이는 중 P를 벗어나면 화면과 상관없이 즉시 멈춘다.
 *  - 등받이 이동 명령은 [SEAT_WATCHDOG_MS] 뒤 자동으로 STOP 한다(화면이 멈춰도 계속 움직이지 않게).
 *  - 모든 제어는 capability(지원·쓰기 가능 여부)를 먼저 확인한 것만 보낸다.
 */
class PleosVehicleGateway(
    context: Context,
    private val onSignals: (String) -> Unit,
    private val onTrace: (String) -> Unit,
) {
    private val vehicle = Vehicle(context.applicationContext)
    private val main = Handler(Looper.getMainLooper())

    private val driverSeat = SeatArea(SeatValue.ROW_1_LEFT)          // 국내 좌핸들 기준 운전석
    private val seatBehindDriver = SeatArea(SeatValue.ROW_2_LEFT)

    // ---- 차량 신호 (SDK 콜백 스레드에서 쓰고, 메인 스레드에서 읽는다) ----
    @Volatile private var gear = "?"
    @Volatile private var brake: Boolean? = null
    @Volatile private var rearOccupied: Boolean? = null
    @Volatile private var cabinTempC: Float? = null
    @Volatile private var recircOn: Boolean? = null
    @Volatile private var fan: Int? = null
    private val doorOpenByArea = ConcurrentHashMap<String, Boolean>()
    private val doorLockedByArea = ConcurrentHashMap<String, Boolean>()
    private val windowOpenByArea = ConcurrentHashMap<String, Boolean>()

    // ---- 제어할 수 있는 것 (capability 확인 결과) ----
    @Volatile private var lockAreas: List<DoorArea> = emptyList()
    @Volatile private var windowBounds: Map<WindowArea, AreaBounds<Int>> = emptyMap()
    @Volatile private var recircArea: SeatArea? = null
    @Volatile private var fanArea: SeatArea? = null
    @Volatile private var backrestArea: SeatArea? = null
    @Volatile private var occupancyArea: SeatArea? = null

    @Volatile private var started = false
    @Volatile private var gearSubscribed = false
    @Volatile private var brakeSubscribed = false
    @Volatile private var doorsSubscribed = false
    @Volatile private var locksSubscribed = false
    @Volatile private var windowsSubscribed = false
    @Volatile private var capabilitiesProbed = false
    @Volatile private var seatMoving = false
    private var ticks = 0
    private val cleanups = ArrayList<() -> Unit>()

    // ---------------------------------------------------------------- 수명주기

    fun start() {
        if (started) return
        started = true
        try {
            vehicle.initialize()
            trace("Vehicle.initialize() → OK")
        } catch (t: Throwable) {
            trace("Vehicle.initialize() → 실패 ${t.message}")
        }
        main.postDelayed(loop, 300)
    }

    fun release() {
        if (!started) return
        started = false
        main.removeCallbacks(loop)
        main.removeCallbacks(seatWatchdog)
        stopSeat("앱 종료")
        synchronized(cleanups) {
            for (c in cleanups) runCatching { c() }
            cleanups.clear()
        }
        runCatching { vehicle.release() }
    }

    /** 1초마다: 연결이 안 된 것은 다시 시도하고, 리스너가 없는 값은 읽어 오고, 화면으로 신호를 보낸다. */
    private val loop = object : Runnable {
        override fun run() {
            if (!started) return
            ticks++
            safely("subscribe") { subscribeMissing() }
            if (!capabilitiesProbed || ticks % 30 == 0) safely("probe") { probeCapabilities() }
            if (ticks % 2 == 0) safely("poll") { pollValues() }
            push()
            main.postDelayed(this, 1000)
        }
    }

    // ---------------------------------------------------------------- 읽기

    /**
     * 처음 한 번 값을 읽는 데 성공한 뒤에 리스너를 건다.
     * initialize()에는 "연결됨" 콜백이 없어서, 첫 호출이 서비스 연결보다 빠르면 실패할 수 있기 때문이다.
     */
    private fun subscribeMissing() {
        // Gear API 는 SDK 2.3.2 에서 deprecated 표시가 붙어 있다(안드로이드 차량 속성 GEAR_SELECTION 권장).
        // 지금은 에뮬레이터에서 동작이 확인된 Pleos API 를 쓰고, 값을 못 읽으면 화면이 시작을 막는다.
        if (!gearSubscribed) {
            val api = vehicle.getGear()
            api.getCurrentGearSelectionState({ g ->
                gear = gearLetter(g)
                if (!gearSubscribed) {
                    gearSubscribed = true
                    val l = object : GearSelectionListener {
                        override fun onSelected(gear: VehicleGear?) {
                            this@PleosVehicleGateway.gear = gearLetter(gear)
                            if (this@PleosVehicleGateway.gear != "P") stopSeat("기어가 P를 벗어남")
                            push()
                        }
                        override fun onFailed(e: Exception) = trace("Gear 리스너 → ${e.message}")
                    }
                    safely("Gear.registerGearSelection") { api.registerGearSelection(l) }
                    addCleanup { api.unregisterGearSelection(l) }
                    trace("Gear.registerGearSelection → OK (지금 $gear)")
                }
                push()
            }, { e -> quiet("Gear.getCurrentGearSelectionState", e) })
        }

        if (!brakeSubscribed) {
            val api = vehicle.getBrake()
            api.getCurrentBrakePedalStatus({ pressed ->
                brake = pressed == true
                if (!brakeSubscribed) {
                    brakeSubscribed = true
                    val l = object : BrakePedalStatusListener {
                        override fun onBrakePedalStatusUpdated(pressed: Boolean?) {
                            brake = pressed == true
                            push()
                        }
                        override fun onFailed(e: Exception) = trace("Brake 리스너 → ${e.message}")
                    }
                    safely("Brake.registerBrakePedalStatus") { api.registerBrakePedalStatus(l) }
                    addCleanup { api.unregisterBrakePedalStatus(l) }
                    trace("Brake.registerBrakePedalStatus → OK")
                }
            }, { e -> quiet("Brake.getCurrentBrakePedalStatus", e) })
        }

        if (!doorsSubscribed) {
            val api = vehicle.getDoor()
            api.checkDoorPositionCapabilities({ _, areaBounds ->
                if (!doorsSubscribed) {
                    doorsSubscribed = true
                    for ((area, bounds) in areaBounds) {
                        val key = area.values.joinToString("+")
                        val closedAt = bounds.minValue
                        api.getCurrentDoorPosition(area, { pos -> if (pos != null) doorOpenByArea[key] = pos > closedAt }, { e -> quiet("Door.getCurrentDoorPosition", e) })
                        val l = object : DoorPositionListener {
                            override fun onPositionUpdated(pos: Int?) {
                                if (pos != null) doorOpenByArea[key] = pos > closedAt
                                push()
                            }
                            override fun onFailed(e: Exception) = trace("Door 리스너 → ${e.message}")
                        }
                        safely("Door.registerDoorPosition") { api.registerDoorPosition(area, l) }
                        addCleanup { api.unregisterDoorPosition(area, l) }
                    }
                    trace("Door.registerDoorPosition → OK (${areaBounds.size}개 영역)")
                }
            }, { e -> quiet("Door.checkDoorPositionCapabilities", e) })
        }

        if (!locksSubscribed) {
            val api = vehicle.getDoor()
            api.checkDoorLockCapabilities({ cfg, areas ->
                if (!locksSubscribed) {
                    locksSubscribed = true
                    if (cfg.canWrite()) lockAreas = areas
                    for (area in areas) {
                        val key = area.values.joinToString("+")
                        api.getDoorLockState(area, { locked ->
                            if (locked != null) doorLockedByArea[key] = locked
                            push()
                        }, { e -> quiet("Door.getDoorLockState", e) })
                        val l = object : DoorLockStateListener {
                            override fun onDoorLockStateUpdated(value: Boolean?) {
                                if (value != null) doorLockedByArea[key] = value
                                push()
                            }
                            override fun onFailed(e: Exception) = trace("DoorLock 리스너 → ${e.message}")
                        }
                        safely("Door.registerDoorLockState") { api.registerDoorLockState(area, l) }
                        addCleanup { api.unregisterDoorLockState(area, l) }
                    }
                    trace("Door.checkDoorLockCapabilities → ${cfg.accessType} (${areas.size}개 영역)")
                }
            }, { e -> quiet("Door.checkDoorLockCapabilities", e) })
        }

        if (!windowsSubscribed) {
            val api = vehicle.getWindow()
            api.checkWindowPositionCapabilities({ cfg, bounds ->
                if (!windowsSubscribed) {
                    windowsSubscribed = true
                    if (cfg.canWrite()) windowBounds = bounds
                    for ((area, b) in bounds) {
                        val key = area.values.joinToString("+")
                        val closedAt = b.minValue
                        api.getCurrentWindowPosition(area, { pos -> if (pos != null) windowOpenByArea[key] = pos > closedAt }, { e -> quiet("Window.getCurrentWindowPosition", e) })
                        val l = object : WindowPositionListener {
                            override fun onWindowPositionUpdated(value: Int?) {
                                if (value != null) windowOpenByArea[key] = value > closedAt
                                push()
                            }
                            override fun onFailed(e: Exception) = trace("Window 리스너 → ${e.message}")
                        }
                        safely("Window.registerWindowPosition") { api.registerWindowPosition(area, l) }
                        addCleanup { api.unregisterWindowPosition(area, l) }
                    }
                    trace("Window.checkWindowPositionCapabilities → ${cfg.accessType} (${bounds.size}개 영역)")
                }
            }, { e -> quiet("Window.checkWindowPositionCapabilities", e) })
        }
    }

    /** 제어 가능 여부 확인. 차종마다 다르므로 추측하지 않고 매번 물어본다. */
    private fun probeCapabilities() {
        val hvac = vehicle.getHVAC()
        val seat = vehicle.getSeat()

        hvac.checkHvacRecirculationCapabilities({ cfg, areas ->
            capabilitiesProbed = true
            recircArea = if (cfg.canWrite()) areas.pickDriver() else null
        }, { e -> quiet("HVAC.checkHvacRecirculationCapabilities", e) })

        hvac.checkHvacFanSpeedCapabilities({ cfg, bounds ->
            capabilitiesProbed = true
            fanArea = if (cfg.canWrite()) bounds.keys.pickDriver() else null
        }, { e -> quiet("HVAC.checkHvacFanSpeedCapabilities", e) })

        seat.checkMoveSeatBackrestAngleCapabilities({ cfg, areas ->
            capabilitiesProbed = true
            backrestArea = if (cfg.canWrite()) areas.pickDriver() else null
        }, { e -> quiet("Seat.checkMoveSeatBackrestAngleCapabilities", e) })

        seat.checkSeatOccupancyCapabilities({ _, areas ->
            capabilitiesProbed = true
            occupancyArea = areas.firstOrNull { SeatValue.ROW_2_LEFT in it.values }
        }, { e -> quiet("Seat.checkSeatOccupancyCapabilities", e) })
    }

    /** 리스너 없이 주기적으로 읽는 값: 실내 온도, 내기/외기, 풍량, 뒷좌석 착좌. */
    private fun pollValues() {
        val hvac = vehicle.getHVAC()
        hvac.getHvacTemperatureCurrent(driverSeat, TemperatureUnit.CELSIUS, { c -> if (c != null) cabinTempC = c }, { e -> quiet("HVAC.getHvacTemperatureCurrent", e) })
        hvac.getHvacRecirculationState(recircArea ?: driverSeat, { on -> if (on != null) recircOn = on }, { e -> quiet("HVAC.getHvacRecirculationState", e) })
        hvac.getHvacFanSpeed(fanArea ?: driverSeat, { v -> if (v != null) fan = v }, { e -> quiet("HVAC.getHvacFanSpeed", e) })

        val area = occupancyArea
        if (area == null) {
            rearOccupied = null
        } else {
            vehicle.getSeat().getCurrentSeatOccupancy(area, { occupied ->
                // 값이 없으면 "모름"으로 둔다. 화면은 모름을 "사람이 있을 수 있음"으로 다뤄 등받이를 절반만 눕힌다.
                rearOccupied = if (occupied == null) null else (occupied != OCCUPANCY_TRUE_MEANS_VACANT)
            }, { e ->
                rearOccupied = null
                quiet("Seat.getCurrentSeatOccupancy", e)
            })
        }
    }

    // ---------------------------------------------------------------- 화면으로 보내기

    fun capabilitiesJson(): String = JSONObject()
        .put("doorLock", lockAreas.isNotEmpty())
        .put("windows", windowBounds.isNotEmpty())
        .put("recirc", recircArea != null)
        .put("backrest", backrestArea != null)
        .put("fan", fanArea != null)
        .toString()

    private fun signalsJson(): String {
        val doorOpen: Any = if (doorOpenByArea.isEmpty()) JSONObject.NULL else doorOpenByArea.values.any { it }
        val windowsOpen: Any = if (windowOpenByArea.isEmpty()) JSONObject.NULL else windowOpenByArea.values.any { it }
        val doorLocked: Any = if (doorLockedByArea.isEmpty()) JSONObject.NULL else doorLockedByArea.values.all { it }
        return JSONObject()
            .put("gear", gear)
            .put("brake", brake ?: JSONObject.NULL)
            .put("doorOpen", doorOpen)
            .put("doorLocked", doorLocked)
            .put("windowsOpen", windowsOpen)
            .put("rearOccupied", rearOccupied ?: JSONObject.NULL)
            .put("cabinTempC", cabinTempC?.toDouble() ?: JSONObject.NULL)
            .put("recircOn", recircOn ?: JSONObject.NULL)
            .put("fan", fan ?: JSONObject.NULL)
            .put("capabilities", JSONObject(capabilitiesJson()))
            .toString()
    }

    private fun push() {
        val json = try { signalsJson() } catch (t: Throwable) { return }
        main.post { if (started) onSignals(json) }
    }

    // ---------------------------------------------------------------- 제어

    /**
     * 화면의 요청을 받는다. 이 차에서 할 수 있는 요청이면 true 를 돌려주고, SDK 호출은 메인 스레드에서 한다.
     * (화면 쪽 호출은 WebView 의 별도 스레드에서 들어온다.) 결과는 추적 로그로 화면에 보인다.
     */
    fun act(kind: String, value: String): Boolean {
        val possible = when (kind) {
            "lockDoors" -> lockAreas.isNotEmpty()
            "closeWindows" -> windowBounds.isNotEmpty()
            "recirc" -> recircArea != null
            "fan" -> fanArea != null && value.toIntOrNull() != null
            "backrest" -> backrestArea != null && (value == "STOP" || gear == "P")
            else -> false
        }
        if (!possible) return false
        main.post {
            if (!started) return@post
            try {
                when (kind) {
                    "lockDoors" -> lockDoors()
                    "closeWindows" -> closeWindows()
                    "recirc" -> setRecirculation(value == "true")
                    "fan" -> setFan(value.toInt())
                    "backrest" -> moveBackrest(value)
                }
            } catch (t: Throwable) { // 권한이 없으면 SecurityException 이 날 수 있다
                trace("act($kind) → 실패 ${t.message}")
            }
        }
        return true
    }

    private fun lockDoors(): Boolean {
        val areas = lockAreas
        if (areas.isEmpty()) return false
        val door = vehicle.getDoor()
        for (area in areas) {
            val call = "Door.setDoorLock(${area.values.joinToString("+")}, true)"
            door.setDoorLock(area, true, { _, _ -> trace("$call → OK") }, { e -> trace("$call → ${e.message}") })
        }
        return true
    }

    private fun closeWindows(): Boolean {
        val bounds = windowBounds
        if (bounds.isEmpty()) return false
        val window = vehicle.getWindow()
        for ((area, b) in bounds) {
            val key = area.values.joinToString("+")
            if (windowOpenByArea[key] != true) continue
            val call = "Window.setWindowPosition($key, ${b.minValue})"
            window.setWindowPosition(area, b.minValue, { _, _ -> trace("$call → OK") }, { e -> trace("$call → ${e.message}") })
        }
        return true
    }

    private fun setRecirculation(on: Boolean): Boolean {
        val area = recircArea ?: return false
        val call = "HVAC.setHvacRecirculation(${area.values.joinToString("+")}, $on)"
        vehicle.getHVAC().setHvacRecirculation(area, on, { _, _ -> trace("$call → OK") }, { e -> trace("$call → ${e.message}") })
        return true
    }

    private fun setFan(level: Int): Boolean {
        val area = fanArea ?: return false
        val call = "HVAC.setHvacFanSpeed(${area.values.joinToString("+")}, $level)"
        vehicle.getHVAC().setHvacFanSpeed(area, level, { _, _ -> trace("$call → OK") }, { e -> trace("$call → ${e.message}") })
        return true
    }

    private fun moveBackrest(direction: String): Boolean {
        val area = backrestArea ?: return false
        val control = when (direction) {
            "BACKWARD" -> MoveControl.BACKWARD   // 눕히기
            "FORWARD" -> MoveControl.FORWARD     // 세우기
            else -> MoveControl.STOP
        }
        if (control != MoveControl.STOP && gear != "P") {
            trace("Seat.moveSeatBackrestAngle($direction) → 거부: 기어가 P가 아님")
            return false
        }
        val call = "Seat.moveSeatBackrestAngle(${area.values.joinToString("+")}, $control)"
        vehicle.getSeat().moveSeatBackrestAngle(area, control, { _, _ -> trace("$call → OK") }, { e -> trace("$call → ${e.message}") })
        main.removeCallbacks(seatWatchdog)
        seatMoving = control != MoveControl.STOP
        if (seatMoving) main.postDelayed(seatWatchdog, SEAT_WATCHDOG_MS)
        return true
    }

    /** 화면과 상관없이 등받이를 멈춘다. */
    fun stopSeat(reason: String) {
        if (!seatMoving) return
        seatMoving = false
        main.removeCallbacks(seatWatchdog)
        val area = backrestArea ?: return
        safely("Seat.moveSeatBackrestAngle(STOP)") {
            vehicle.getSeat().moveSeatBackrestAngle(area, MoveControl.STOP, { _, _ -> trace("등받이 멈춤 ($reason)") }, { e -> trace("등받이 멈춤 실패 → ${e.message}") })
        }
    }

    private val seatWatchdog = Runnable { stopSeat("안전 시간 초과") }

    // ---------------------------------------------------------------- 도우미

    private fun gearLetter(g: VehicleGear?): String = when (g) {
        VehicleGear.GEAR_PARK -> "P"
        VehicleGear.GEAR_REVERSE -> "R"
        VehicleGear.GEAR_NEUTRAL -> "N"
        null, VehicleGear.GEAR_UNKNOWN -> "?"
        else -> "D"   // GEAR_DRIVE, GEAR_1..GEAR_9
    }

    private fun CapabilityConfig.canWrite(): Boolean =
        accessType == AccessType.WRITE || accessType == AccessType.READ_WRITE

    /** 운전석이 들어 있는 영역을 고른다. 여러 좌석이 한 영역으로 묶여 오는 차도 있다. */
    private fun Collection<SeatArea>.pickDriver(): SeatArea? =
        firstOrNull { SeatValue.ROW_1_LEFT in it.values }

    private fun addCleanup(block: () -> Unit) {
        synchronized(cleanups) { cleanups.add(block) }
    }

    private inline fun safely(what: String, block: () -> Unit) {
        try { block() } catch (t: Throwable) { trace("$what → 실패 ${t.message}") }
    }

    /** 연결 전 실패나 미지원처럼 반복되는 실패는 한 번만 기록한다. */
    private val reported = ConcurrentHashMap<String, Boolean>()
    private fun quiet(call: String, e: Exception) {
        val key = call + "|" + e.message
        if (reported.putIfAbsent(key, true) == null) trace("$call → ${e.message}")
    }

    private fun trace(line: String) {
        main.post { if (started) onTrace(line) }
    }

    companion object {
        /** 화면이 STOP을 보내지 못해도 이 시간 뒤에는 등받이를 멈춘다. */
        private const val SEAT_WATCHDOG_MS = 9_000L

        /**
         * 착좌 값의 뜻. 기본은 true = 사람이 앉아 있음.
         * 다른 개발자의 에뮬레이터 실측에서는 값이 반대로 내려왔다는 기록이 있다(실차 미확인).
         * 반대로 읽으면 사람이 있는데도 끝까지 눕힐 수 있으므로, 실차에서 확인하기 전에는 바꾸지 않는다.
         */
        private const val OCCUPANCY_TRUE_MEANS_VACANT = false
    }
}
