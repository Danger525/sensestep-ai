// ======================================================
// SenseStep - Intelligent Haptic Cane
// 4-Sensor Directional Array + Multi-Motor Haptic System
// ======================================================

// Sensor Pin Definitions
#define CENTER_TRIG_PIN  5
#define CENTER_ECHO_PIN  18

#define GROUND_TRIG_PIN  16
#define GROUND_ECHO_PIN  17

#define LEFT_TRIG_PIN    26
#define LEFT_ECHO_PIN    27

#define RIGHT_TRIG_PIN   32
#define RIGHT_ECHO_PIN   33

// Haptic Motor Output Pins
#define LEFT_HAPTIC_PIN    19  // Left directional haptic motor (Yellow LED)
#define CENTER_HAPTIC_PIN  21  // Center directional haptic motor (Green LED)
#define RIGHT_HAPTIC_PIN   22  // Right directional haptic motor (Blue LED)
#define DROP_HAPTIC_PIN    25  // Ground Drop / Pothole indicator (Red LED)

// Obstacle threshold
const float OBSTACLE_THRESHOLD = 100.0; // cm

// Non-blocking timing intervals
unsigned long lastSensorTime = 0;
const unsigned long SENSOR_INTERVAL = 120; // Sample all 4 sensors every 120 ms

unsigned long lastSerialTime = 0;
const unsigned long SERIAL_INTERVAL = 500; // Serial Monitor update every 500 ms

// Measured distances (cm)
float leftDistance   = 200.0;
float centerDistance = 200.0;
float rightDistance  = 200.0;
float groundDistance = 30.0; // Normal ground level is ~20-40 cm

// Debouncing for ground drop detection
int dropConsecutiveCount = 0;
const int DROP_DEBOUNCE_THRESHOLD = 3; // Require 3 consecutive readings (>50 cm)
bool dropConfirmed = false;

// Low-level ultrasonic pulse helper
float readUltrasonic(int trigPin, int echoPin) {
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  long duration = pulseIn(echoPin, HIGH, 30000);
  if (duration == 0) {
    return 400.0; // Out of range default
  }
  return duration * 0.034 / 2.0;
}

// Dedicated sensor reading functions
float getLeftDistance() {
  return readUltrasonic(LEFT_TRIG_PIN, LEFT_ECHO_PIN);
}

float getCenterDistance() {
  return readUltrasonic(CENTER_TRIG_PIN, CENTER_ECHO_PIN);
}

float getRightDistance() {
  return readUltrasonic(RIGHT_TRIG_PIN, RIGHT_ECHO_PIN);
}

float getGroundDistance() {
  return readUltrasonic(GROUND_TRIG_PIN, GROUND_ECHO_PIN);
}

// Centralized haptic motor controller
void updateHapticOutputs(const char* hazardState, unsigned long currentMillis) {
  bool leftVal   = LOW;
  bool centerVal = LOW;
  bool rightVal  = LOW;
  bool dropVal   = LOW;

  if (strcmp(hazardState, "LEFT") == 0) {
    // Left haptic: 2 short pulses (600 ms cycle)
    unsigned long phase = currentMillis % 600;
    leftVal = (phase < 100) || (phase >= 200 && phase < 300);
  } else if (strcmp(hazardState, "CENTER") == 0) {
    // Center haptic: continuous vibration
    centerVal = HIGH;
  } else if (strcmp(hazardState, "RIGHT") == 0) {
    // Right haptic: 3 short pulses (900 ms cycle)
    unsigned long phase = currentMillis % 900;
    rightVal = (phase < 100) || (phase >= 200 && phase < 300) || (phase >= 400 && phase < 500);
  } else if (strcmp(hazardState, "DROP") == 0) {
    // Drop haptic on GPIO 25: 3 short pulses (900 ms cycle)
    unsigned long phase = currentMillis % 900;
    dropVal = (phase < 100) || (phase >= 200 && phase < 300) || (phase >= 400 && phase < 500);
  } else if (strcmp(hazardState, "CRITICAL") == 0) {
    // Front Critical: Center haptic continuous vibration
    centerVal = HIGH;
  }

  digitalWrite(LEFT_HAPTIC_PIN, leftVal);
  digitalWrite(CENTER_HAPTIC_PIN, centerVal);
  digitalWrite(RIGHT_HAPTIC_PIN, rightVal);
  digitalWrite(DROP_HAPTIC_PIN, dropVal);
}

void setup() {
  Serial.begin(115200);

  // Configure Center Sensor
  pinMode(CENTER_TRIG_PIN, OUTPUT);
  pinMode(CENTER_ECHO_PIN, INPUT);

  // Configure Ground Sensor
  pinMode(GROUND_TRIG_PIN, OUTPUT);
  pinMode(GROUND_ECHO_PIN, INPUT);

  // Configure Left Sensor
  pinMode(LEFT_TRIG_PIN, OUTPUT);
  pinMode(LEFT_ECHO_PIN, INPUT);

  // Configure Right Sensor
  pinMode(RIGHT_TRIG_PIN, OUTPUT);
  pinMode(RIGHT_ECHO_PIN, INPUT);

  // Configure All Haptic Motor Outputs
  pinMode(LEFT_HAPTIC_PIN, OUTPUT);
  pinMode(CENTER_HAPTIC_PIN, OUTPUT);
  pinMode(RIGHT_HAPTIC_PIN, OUTPUT);
  pinMode(DROP_HAPTIC_PIN, OUTPUT);

  digitalWrite(LEFT_HAPTIC_PIN, LOW);
  digitalWrite(CENTER_HAPTIC_PIN, LOW);
  digitalWrite(RIGHT_HAPTIC_PIN, LOW);
  digitalWrite(DROP_HAPTIC_PIN, LOW);

  Serial.println("========================================");
  Serial.println("  SENSESTEP MULTI-MOTOR SYSTEM READY    ");
  Serial.println("========================================");
}

void loop() {
  unsigned long currentMillis = millis();

  // 1. Periodic non-blocking sensor sampling
  if (currentMillis - lastSensorTime >= SENSOR_INTERVAL) {
    lastSensorTime = currentMillis;

    leftDistance = getLeftDistance();
    delayMicroseconds(400);
    centerDistance = getCenterDistance();
    delayMicroseconds(400);
    rightDistance = getRightDistance();
    delayMicroseconds(400);
    groundDistance = getGroundDistance();

    // 2. Debouncing for Ground Drop detection
    if (groundDistance > 50.0) {
      if (dropConsecutiveCount < DROP_DEBOUNCE_THRESHOLD) {
        dropConsecutiveCount++;
      }
      if (dropConsecutiveCount >= DROP_DEBOUNCE_THRESHOLD) {
        dropConfirmed = true;
      }
    } else {
      dropConsecutiveCount = 0;
      dropConfirmed = false;
    }
  }

  // 3. Directional Obstacle Detection among Front Sensors
  const char* obstacleDirection = "NONE";
  float closestFrontDistance = 400.0;

  bool leftObstacle   = (leftDistance < OBSTACLE_THRESHOLD);
  bool centerObstacle = (centerDistance < OBSTACLE_THRESHOLD);
  bool rightObstacle  = (rightDistance < OBSTACLE_THRESHOLD);

  if (leftObstacle || centerObstacle || rightObstacle) {
    closestFrontDistance = 400.0;

    if (leftObstacle && leftDistance < closestFrontDistance) {
      closestFrontDistance = leftDistance;
      obstacleDirection = "LEFT";
    }
    if (centerObstacle && centerDistance < closestFrontDistance) {
      closestFrontDistance = centerDistance;
      obstacleDirection = "CENTER";
    }
    if (rightObstacle && rightDistance < closestFrontDistance) {
      closestFrontDistance = rightDistance;
      obstacleDirection = "RIGHT";
    }
  }

  // 4. Hazard Priority Ladder:
  //    1. CRITICAL DROP / DEEP DROP (ground > 100 cm)
  //    2. FRONT CRITICAL (closest front obstacle < 50 cm)
  //    3. DROP / POTHOLE (ground > 50 cm)
  //    4. CLOSEST FRONT OBSTACLE DIRECTION (LEFT, CENTER, RIGHT)
  //    5. SAFE
  const char* hazardType    = "SAFE";
  const char* directionType = obstacleDirection;
  const char* hapticType    = "OFF";
  const char* hapticOutput  = "OFF";

  if (dropConfirmed && groundDistance > 100.0) {
    // Severe / Deep drop
    hazardType    = "DROP";
    directionType = "NONE";
    hapticType    = "DROP";
    hapticOutput  = "DROP MOTOR";
  } else if (closestFrontDistance < 50.0) {
    // Imminent front collision (<50 cm)
    hazardType    = "CRITICAL";
    hapticType    = "CRITICAL";
    hapticOutput  = "CRITICAL MOTOR";
  } else if (dropConfirmed) {
    // Standard drop / pothole (>50 cm) overrides ordinary directional obstacles
    hazardType    = "DROP";
    directionType = "NONE";
    hapticType    = "DROP";
    hapticOutput  = "DROP MOTOR";
  } else if (strcmp(obstacleDirection, "NONE") != 0) {
    // Front directional obstacle detected within threshold (<100 cm)
    hazardType = obstacleDirection; // "LEFT", "CENTER", or "RIGHT"
    hapticType = obstacleDirection;
    if (strcmp(obstacleDirection, "LEFT") == 0) {
      hapticOutput = "LEFT MOTOR";
    } else if (strcmp(obstacleDirection, "CENTER") == 0) {
      hapticOutput = "CENTER MOTOR";
    } else {
      hapticOutput = "RIGHT MOTOR";
    }
  } else {
    // Path clear & normal ground
    hazardType    = "SAFE";
    directionType = "NONE";
    hapticType    = "OFF";
    hapticOutput  = "OFF";
  }

  // 5. Centralized Haptic Motor Drive (Non-blocking)
  updateHapticOutputs(hazardType, currentMillis);

  // 6. Formatted Serial Telemetry
  if (currentMillis - lastSerialTime >= SERIAL_INTERVAL) {
    lastSerialTime = currentMillis;

    Serial.println("========================================");
    Serial.println("              SENSESTEP                 ");
    Serial.println("========================================");
    Serial.print("Left Distance    : ");
    Serial.print((int)leftDistance);
    Serial.println(" cm");

    Serial.print("Center Distance  : ");
    Serial.print((int)centerDistance);
    Serial.println(" cm");

    Serial.print("Right Distance   : ");
    Serial.print((int)rightDistance);
    Serial.println(" cm");

    Serial.print("Ground Distance  : ");
    Serial.print((int)groundDistance);
    Serial.println(" cm");
    Serial.println();

    Serial.print("Hazard           : ");
    Serial.println(hazardType);

    Serial.print("Direction        : ");
    Serial.println(directionType);

    Serial.print("Haptic           : ");
    Serial.println(hapticType);

    Serial.print("Haptic Output    : ");
    Serial.println(hapticOutput);
    Serial.println("========================================");
    Serial.println();
  }
}