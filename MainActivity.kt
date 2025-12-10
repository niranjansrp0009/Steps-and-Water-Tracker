package com.niranjangroup.stepwatertracker

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.util.Calendar

class MainActivity : AppCompatActivity(), SensorEventListener {

    private lateinit var sensorManager: SensorManager
    private var stepSensor: Sensor? = null
    private var initialStepCount: Float = -1f
    private var todaySteps: Int = 0

    private lateinit var stepsText: TextView
    private lateinit var waterText: TextView
    private lateinit var waterProgress: ProgressBar
    private lateinit var historyText: TextView
    private lateinit var addWaterButton: Button

    private var waterMl: Int = 0
    private val dailyWaterGoal = 2000 // 2L default goal

    private val prefs by lazy {
        getSharedPreferences("step_water_prefs", Context.MODE_PRIVATE)
    }

    private val CHANNEL_ID = "water_reminder_channel"
    private val PERMISSION_REQUEST_ACTIVITY_RECOGNITION = 1001

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        stepsText = findViewById(R.id.textSteps)
        waterText = findViewById(R.id.textWater)
        waterProgress = findViewById(R.id.progressWater)
        historyText = findViewById(R.id.textHistory)
        addWaterButton = findViewById(R.id.buttonAddWater)

        waterProgress.max = dailyWaterGoal

        createNotificationChannel()
        restoreTodayData()
        setupSensor()
        scheduleWaterRemindersIfNeeded()
        refreshUi()

        addWaterButton.setOnClickListener {
            addWater(250) // default 250 ml glass
        }
    }

    private fun getTodayKey(): String {
        val cal = Calendar.getInstance()
        val year = cal.get(Calendar.YEAR)
        val month = cal.get(Calendar.MONTH) + 1
        val day = cal.get(Calendar.DAY_OF_MONTH)
        return String.format("%04d-%02d-%02d", year, month, day)
    }

    private fun restoreTodayData() {
        val today = getTodayKey()
        val savedDate = prefs.getString("current_date", null)
        if (today != savedDate) {
            // New day, reset values
            prefs.edit().clear().apply()
            prefs.edit().putString("current_date", today).apply()
            todaySteps = 0
            waterMl = 0
            initialStepCount = -1f
        } else {
            todaySteps = prefs.getInt("today_steps", 0)
            waterMl = prefs.getInt("today_water", 0)
            initialStepCount = prefs.getFloat("initial_step_count", -1f)
        }
    }

    private fun setupSensor() {
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        stepSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)

        if (stepSensor == null) {
            Toast.makeText(this, "Step counter sensor not available on this device", Toast.LENGTH_LONG).show()
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val permission = Manifest.permission.ACTIVITY_RECOGNITION
            if (ContextCompat.checkSelfPermission(this, permission) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, arrayOf(permission), PERMISSION_REQUEST_ACTIVITY_RECOGNITION)
            } else {
                registerStepListener()
            }
        } else {
            registerStepListener()
        }
    }

    private fun registerStepListener() {
        stepSensor?.also { sensor ->
            sensorManager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_NORMAL)
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == PERMISSION_REQUEST_ACTIVITY_RECOGNITION) {
            if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                registerStepListener()
            } else {
                Toast.makeText(this, "Activity recognition permission is required for step counting", Toast.LENGTH_LONG).show()
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (::sensorManager.isInitialized && stepSensor != null) {
            registerStepListener()
        }
    }

    override fun onPause() {
        super.onPause()
        if (::sensorManager.isInitialized) {
            sensorManager.unregisterListener(this)
        }
    }

    override fun onSensorChanged(event: android.hardware.SensorEvent?) {
        if (event?.sensor?.type == Sensor.TYPE_STEP_COUNTER) {
            val totalSinceBoot = event.values[0]
            if (initialStepCount < 0) {
                initialStepCount = totalSinceBoot
                prefs.edit().putFloat("initial_step_count", initialStepCount).apply()
            }
            todaySteps = (totalSinceBoot - initialStepCount).toInt()
            if (todaySteps < 0) todaySteps = 0
            prefs.edit().putInt("today_steps", todaySteps).apply()
            updateLogForToday()
            refreshUi()
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
        // Not needed
    }

    private fun addWater(amount: Int) {
        waterMl += amount
        prefs.edit().putInt("today_water", waterMl).apply()
        updateLogForToday()
        refreshUi()
    }

    private fun refreshUi() {
        stepsText.text = "$todaySteps steps today"
        waterText.text = "$waterMl ml / $dailyWaterGoal ml"
        waterProgress.progress = waterMl.coerceAtMost(dailyWaterGoal)
        historyText.text = buildHistoryText()
    }

    private fun updateLogForToday() {
        val today = getTodayKey()
        val logsStr = prefs.getString("logs", "") ?: ""
        val lines = logsStr.split("\n".toRegex()).filter { it.isNotBlank() }.toMutableList()
        var found = false
        for (i in lines.indices) {
            val parts = lines[i].split(",")
            if (parts.size >= 3 && parts[0] == today) {
                lines[i] = "$today,$todaySteps,$waterMl"
                found = true
                break
            }
        }
        if (!found) {
            lines.add("$today,$todaySteps,$waterMl")
        }
        // Keep only last 7 entries
        val trimmed = if (lines.size > 7) lines.takeLast(7) else lines
        prefs.edit().putString("logs", trimmed.joinToString("\n")).apply()
    }

    private fun buildHistoryText(): String {
        val logsStr = prefs.getString("logs", "") ?: ""
        if (logsStr.isBlank()) return "No history yet. Start walking and drinking water today!"
        val lines = logsStr.split("\n".toRegex()).filter { it.isNotBlank() }
        val sb = StringBuilder()
        sb.append("Last days:\n\n")
        // Newest first
        for (line in lines.reversed()) {
            val parts = line.split(",")
            if (parts.size >= 3) {
                val date = parts[0]
                val steps = parts[1]
                val water = parts[2]
                sb.append("$date  •  $steps steps  •  $water ml\n")
            }
        }
        return sb.toString()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val name = "Water reminders"
            val descriptionText = "Reminders to drink water regularly"
            val importance = NotificationManager.IMPORTANCE_DEFAULT
            val channel = NotificationChannel(CHANNEL_ID, name, importance).apply {
                description = descriptionText
            }
            val notificationManager: NotificationManager =
                getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            notificationManager.createNotificationChannel(channel)
        }
    }

    private fun scheduleWaterRemindersIfNeeded() {
        val alreadyScheduled = prefs.getBoolean("reminders_scheduled", false)
        if (alreadyScheduled) return

        val alarmManager = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val intent = Intent(this, WaterReminderReceiver::class.java)
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
        val pendingIntent = PendingIntent.getBroadcast(this, 0, intent, flags)

        val intervalMillis = 2 * 60 * 60 * 1000L // 2 hours

        val calendar = Calendar.getInstance().apply {
            // Start from next even 2-hour slot between 8:00 and 22:00
            if (get(Calendar.HOUR_OF_DAY) < 8) {
                set(Calendar.HOUR_OF_DAY, 8)
                set(Calendar.MINUTE, 0)
                set(Calendar.SECOND, 0)
            } else {
                add(Calendar.HOUR_OF_DAY, 2)
            }
        }

        alarmManager.setInexactRepeating(
            AlarmManager.RTC_WAKEUP,
            calendar.timeInMillis,
            intervalMillis,
            pendingIntent
        )

        prefs.edit().putBoolean("reminders_scheduled", true).apply()
    }
}
