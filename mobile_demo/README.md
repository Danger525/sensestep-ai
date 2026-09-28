# SenseStep Mobile — Calibrated Assistive Spatial Prototype

An audited, standalone, mobile-first web prototype that uses your smartphone's rear camera, browser-based computer vision (TensorFlow.js COCO-SSD), **Walking Corridor (Path of Travel) spatial filtering**, **multi-point empirical optical calibration**, **temporal persistence tracking**, and the **Web Speech API** for natural voice navigation, with honest capability detection for browser vibration and comprehensive iOS multimodal fallback.

---

## 🧭 Upgraded Detection & Distance Pipeline

## 🧭 Detection Pipeline & High Recall Balance

SenseStep prioritizes **reliable obstacle detection first; distance estimation is secondary**.

```
PHONE CAMERA (6-8 FPS)
    ↓
RAW COCO-SSD INFERENCE (Counts raw detections)
    ↓
CONFIDENCE FILTER (Default MIN_CONFIDENCE = 0.50; adjustable 0.35–0.85)
    ↓
SUPPORTED PHYSICAL OBSTACLES (Person, chair, backpack, bottle, car, bicycle, etc.)
    ↓
WALKING CORRIDOR FILTER (Horizontal 20%-80%, top 15%, overlap threshold 5%)
    ↓
TEMPORAL PERSISTENCE (1 detection = POSSIBLE, 2 consecutive = CONFIRMED)
    ↓
DIRECTION HYSTERESIS (<40% LEFT, 40%-60% CENTER, >60% RIGHT)
    ↓
DISTANCE ESTIMATION (Secondary! Displays UNKNOWN if uncalibrated; does NOT reject obstacle)
    ↓
HAZARD STATE MACHINE (SAFE → POSSIBLE → CONFIRMED → CRITICAL)
    ↓
MULTIMODAL ASSISTIVE FEEDBACK (Voice + Haptics + Visual Cards)
```

---

## 🔍 Continuous Detection Test Strip

Directly below the status badges, a live diagnostic test strip continuously displays:
- **`RAW: X`**: Number of raw objects identified by COCO-SSD before any spatial or confidence filtering.
- **`VALID: Y`**: Number of detected obstacles that pass confidence ($\ge 0.50$), physical class check, and corridor overlap ($\ge 0.05$).
- **`HAZARD: SAFE / ACTIVE`**: Real-time hazard state.
- **Diagnostic Message**:
  - If `RAW == 0`: Displays *"AI is not detecting objects."*
  - If `RAW > 0` but `VALID == 0`: Displays *"Detection is being filtered."*
  - If `VALID > 0`: Displays *"Obstacle active: [OBJECT] ([DIRECTION])"*

---

## 🚶‍♂️ 1. Walking Corridor (Path of Travel)

SenseStep uses a relaxed walking corridor to ensure objects in the path are reliably detected:

- **Corridor Geometry**:
  - Horizontal: 20% to 80% of camera width.
  - Vertical: 15% to 100% of camera height (ground level up to eye level).
  - Ceiling fixtures are excluded while normal sitting and standing obstacles are cleanly preserved.
- **Overlap Threshold**:
  - Configurable in Settings (`PATH_OVERLAP_THRESHOLD`, default **0.05 / 5%**).
  - Any obstacle meaningfully in the walking corridor triggers guidance.

---

## 🛡️ 2. Alert Severity & False Alarm Protection

Instead of aggressively rejecting detections, SenseStep uses **alert severity levels**:

- **LEVEL 1: POSSIBLE OBSTACLE**
  - Triggered after **1 valid detection**.
  - Visual status and instruction card only; no aggressive repeated voice alarms.
- **LEVEL 2: CONFIRMED OBSTACLE**
  - Triggered after **2 consecutive detections**.
  - Spoken direction navigation (*"Obstacle ahead. Move left or right."*) + haptics if supported + directional audio chime.
- **LEVEL 3: CRITICAL COLLISION**
  - Triggered when calibrated distance $< 0.50\,\text{m}$ or obstacle fills $> 75\%$ of corridor height.
  - High-urgency collision warnings (*"Critical obstacle ahead. Stop."*) + continuous vibration + fast warning tone.

---

## 🚦 3. Hazard State Machine

```
   SAFE
    │ (Object detected, persistence < 3)
    ▼
 POSSIBLE (Subtle visual indication; no aggressive alarms)
    │ (Persistence ≥ 3 frames & within walking corridor)
    ▼
CONFIRMED (Directional action: MOVE LEFT / MOVE RIGHT / MOVE LEFT OR RIGHT; voice announced once)
    │ (Distance < 0.50m with GOOD/FAIR confidence, or extreme corridor overlap > 70%)
    ▼
CRITICAL (Action: STOP; collision alert sound and speech)
```

- **Voice Triggering Rules**:
  - Voice announces **only** on state transitions: `POSSIBLE` $\rightarrow$ `CONFIRMED`, `CONFIRMED` $\rightarrow$ `CRITICAL`, direction change while `CONFIRMED`, or transition to `SAFE` (*"Path clear."* once).
  - Strict 2.0s cooldown between normal warnings.
  - Persistent `CRITICAL` hazards repeat a reminder after approximately 2.2s.

---

## 📐 4. Multi-Point Empirical Distance Calibration

The prototype replaces naive single-number formulas with a real multi-point empirical calibration system stored in `localStorage`.

### Mathematical Empirical Model
Because monocular distance follows pinhole optical geometry:
$$d \approx m \cdot \left(\frac{1000}{h_{\text{pixels}}}\right) + c$$

When you capture $\ge 3$ samples at known distances for an object class (e.g. Person, Chair, Backpack), the system computes a linear least-squares regression fit for $(1000/h_i, d_i)$.

### Calibration Quality Ratings:
- **`GOOD`**: $\ge 4$ multi-point samples spanning a diverse distance range ($\ge 0.8\text{m}$ spread).
- **`FAIR`**: 3 samples captured for the object class.
- **`POOR (INSUFFICIENT)`**: $< 3$ samples captured. Distance confidence falls back to uncalibrated estimate.

### Distance Confidence Levels:
- **`GOOD`**: Class-specific multi-point calibration active.
- **`FAIR`**: Single/dual sample or standard known height table.
- **`LOW`**: Ambiguous optical bounds (< 0.25m or > 4.5m).
- **`UNKNOWN`**: Object class uncalibrated and unknown physical size $\rightarrow$ **Displays `EST. DISTANCE: UNKNOWN`** (no fake numbers).

### Rolling Median Distance Smoothing:
- Frame-to-frame optical measurements fluctuate due to bounding box jitter.
- SenseStep applies a **rolling median over the last 5 valid estimates**.
- Outliers (e.g. `0.7m, 1.4m, 0.6m, 0.7m, 0.8m` $\rightarrow$ median is `0.7m`) are eliminated.

---

## 📈 5. Approaching Object Detection

- Tracks the bounding box area over a rolling 7-frame window.
- When area increases by $> 15\%$: Tagged as **`APPROACHING`**.
- When area decreases by $> 15\%$: Tagged as **`MOVING AWAY`**.
- Otherwise: Tagged as **`STABLE`**.
- Serves as supplementary telemetry in the HUD and Debug overlay.

---

## 🐞 6. Live Debug Mode (Section 17)

Tap **`DEBUG`** in the top header to toggle the live engineering telemetry overlay:
```text
🔬 LIVE DETECTION & TRACKING DEBUG             APPROACH: APPROACHING
--------------------------------------------------------------------
OBJECT: PERSON                               AI CONF: 84%
PATH OVERLAP: 72%                            EST DISTANCE: ~0.82 m
DIST CONF: GOOD                              DIRECTION: CENTER (STABLE)
PERSISTENCE: 4/3                             HAZARD STATE: CONFIRMED
```

---

## ⚙️ 7. How to Perform Calibration

Tap **`⚙️ CALIBRATE`** in the navigation bar:

1. **Step 1: Point at Reference Object**
   - Point camera at the object type you wish to calibrate (e.g., a person, office chair, or backpack).
   - Verify live target detection readout shows the object class, bounding height in pixels, and AI confidence.
2. **Step 2: Place at Known Distance**
   - Place reference object at **0.5 m** (tape-measured).
   - Tap **`0.5 m`** button.
   - Tap **`📸 Capture Calibration Sample`**.
3. **Step 3: Repeat Multi-Point Samples**
   - Move to **1.0 m**, select **`1.0 m`**, tap **`Capture`**.
   - Move to **1.5 m**, select **`1.5 m`**, tap **`Capture`**.
   - Move to **2.0 m**, select **`2.0 m`**, tap **`Capture`**.
4. **Step 4: Verify Quality**
   - Samples badge will update: `SAMPLES: 4`.
   - Quality will update to: **`GOOD (4+ MULTI-POINT)`**.
   - Tap **`View Samples Table`** to review or delete individual samples.

> [!NOTE]
> *"Calibration works best with the same phone, camera, and object type you will use during testing."*

---

## 🎯 8. How to Perform the Real-World Accuracy Test

1. Open **`⚙️ CALIBRATE`** and switch to tab **`2. TEST ACCURACY`**.
2. Select your test ground truth distance: **`0.5 m`**, **`1.0 m`**, **`1.5 m`**, or **`2.0 m`**.
3. Stand at that exact measured distance from your reference object.
4. Observe the live readout:
   - **`Expected Distance`**: `1.00 m`
   - **`Measured Estimate`**: `~1.03 m`
   - **`Error Deviation`**: `+0.03 m (±3%)`
   - **`Distance Confidence`**: `GOOD`
5. Verify whether calibration improved relative estimation accuracy.

---

## ⚠️ 9. Important Architectural Limitation

> [!IMPORTANT]
> **Camera distance is an optical estimate based on empirical calibration. It is not equivalent to ultrasonic acoustic time-of-flight measurement.**
>
> The physical SenseStep cane utilizes 4× HC-SR04 ultrasonic acoustic transducers driven by an ESP32 for true acoustic time-of-flight measurements in centimeters. The mobile web application serves as a software demonstration prototype.

---

## 📳 10. Browser Vibration & iOS Compatibility

```javascript
const supportsVibration =
  "vibrate" in navigator &&
  typeof navigator.vibrate === "function";
```

- **Android Chrome**: Web Vibration API supported $\rightarrow$ pulses physical temporal patterns.
- **iPhone (iOS Safari & Chrome)**: Web Vibration API unsupported in iOS WebKit $\rightarrow$ displays **`HAPTIC: NOT SUPPORTED BY THIS BROWSER`** and provides reliable **Spoken Voice Guidance + Directional Audio Beeps + High-Contrast Visual Cards**.
- **Does NOT pretend the phone vibrated.**

---

## 📡 11. Exact Server Command

From the repository root:
```powershell
python mobile_demo/serve.py
```

Outputs:
```text
====================================================================
      SenseStep Mobile — Local Demonstration Server (AUDITED)     
====================================================================
SERVER:
  STATUS: READY
  BOUND : 0.0.0.0:8443 (HTTPS)

LOCAL ACCESS (Laptop):
  https://localhost:8443

PHONE ACCESS (Over Mobile Hotspot or Wi-Fi):
  --> https://<YOUR-IP>:8443 <--
```

### iPhone Setup:
1. Open URL in Safari or Chrome.
2. Tap **Show Details** $\rightarrow$ **visit this website**.
3. Flip the physical **Ring/Silent switch** so orange is NOT visible. Turn up media volume.
4. Tap **`Enable Voice, Camera & Sound`**.
