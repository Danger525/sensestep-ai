# SenseStep — Real-World Camera Hazard Demonstration

This module provides a **real-world visual demonstration** of the **SenseStep** intelligent haptic cane system using your laptop webcam and Python + OpenCV.

It serves as a live visual proof-of-concept for hackathons and presentations when physical hardware (cane frame, ultrasonic sensors, and ERM/LRA vibration motors) is not physically deployed on stage.

---

## ⚠️ Important Architectural Context

1. **Demonstration Scope**:
   This camera prototype demonstrates the **real-world spatial hazard classification concept** (detecting directional obstacles and ground drops, then mapping them to localized tactile feedback patterns).
2. **Physical Hardware Reality**:
   The final production version of SenseStep relies on **directional ultrasonic transducers (HC-SR04 / waterproof JSN-SR04T) and tactile vibration motors**, as modeled in the accompanying ESP32 Wokwi simulation.
3. **No Direct HC-SR04 Validation**:
   This webcam prototype performs real-time optical contour and geometric analysis; it does **not** directly validate or replicate ultrasonic flight times or acoustic wave physics.
4. **100% Local**:
   Runs completely offline on your computer. No cloud APIs, paid subscriptions, or external network calls are required.

---

## 🛠️ Installation & Setup

### 1. Prerequisites
- **Python 3.8+** installed on your system.
- A built-in laptop webcam or USB camera.

### 2. Install Dependencies
Open a PowerShell or Command Prompt terminal in your project directory and run:

```powershell
pip install -r camera_demo/requirements.txt
```

*(Note: If you already have `opencv-python` and `numpy` installed, you are ready to launch immediately.)*

---

## 🚀 How to Run the Demonstration

From the root project directory, run:

```powershell
python camera_demo/main.py
```

A live video window titled **`SenseStep - Real-World Hazard Demonstration`** will appear with an interactive Heads-Up Display (HUD).

---

## 🧠 How AUTO Detection Mode Works

When running in **`AUTO`** mode, the system analyzes the camera feed in real time:

1. **Three-Zone Spatial Grid**:
   - The view is split into three vertical corridors: **LEFT**, **CENTER**, and **RIGHT**.
2. **Contour & Proximity Weighting**:
   - Applies Gaussian smoothing, Canny edge detection, and morphological dilation to identify foreground objects.
   - Objects closer to the cane appear lower in the frame and occupy larger bounding box areas; the algorithm weights lower bounding boxes with higher hazard proximity.
3. **Hazard Classification**:
   - **LEFT / CENTER / RIGHT**: Dominant obstacle centroid localized to that zone.
   - **CRITICAL**: Large obstacle filling $> 28\%$ of the frame (imminent collision).
   - **SAFE**: No significant foreground obstacle detected.

---

## ⌨️ Live Presentation Keyboard Controls

During a live hackathon pitch or presentation, you can switch between real-time computer vision and guaranteed instant state overrides using your keyboard:

| Key | Mode / Action | Simulated Hazard State | Haptic Feedback Pattern |
| :---: | :---: | :---: | :---: |
| **`A`** | **AUTO Mode** | Computer-vision automated detection | Dynamic based on scene |
| **`V`** | **Virtual Mode** | Toggle between live webcam & virtual corridor | Tests obstacles even if camera lens is closed |
| **`L`** | **Manual Override** | `LEFT` Obstacle | **LEFT HAPTIC: 2 PULSES** |
| **`C`** | **Manual Override** | `CENTER` Obstacle | **CENTER HAPTIC: CONTINUOUS** |
| **`R`** | **Manual Override** | `RIGHT` Obstacle | **RIGHT HAPTIC: 3 PULSES** |
| **`D`** | **Manual Override** | `DROP` / Pothole / Curb | **DROP HAPTIC: 3 PULSES** |
| **`X`** | **Manual Override** | `CRITICAL` Front Collision | **CRITICAL HAPTIC: CONTINUOUS** |
| **`S`** | **Manual Override** | `SAFE` (Clear Path) | **HAPTIC: OFF** |
| **`Q`** or `Esc` | **Quit** | Exit application | Closes camera feed |

---

## 💡 Troubleshooting: Camera LED is ON but Screen is Black

If your laptop camera LED indicator turns on but the video feed is solid black:
1. **Physical Privacy Shutter (HP / Lenovo / Dell)**:
   - Check the very top bezel above your screen. Many laptops (like HP Victus / Envy / Pavilion) have a tiny physical sliding switch directly over the webcam lens. Slide it sideways until the lens is visible.
2. **Camera Privacy / Mute Key**:
   - Look at the top row function keys (F1–F12). Press the key with a **camera icon** (usually **`F10`** or **`Fn + F10`**) to toggle the privacy kill-switch.
3. **Press `[V]` for Virtual Mode**:
   - If you cannot unblock your physical lens right now, press **`V`** in the application window to switch to the built-in **Virtual Test Corridor**, which animates simulated moving obstacles across the zones!

---

## 📊 On-Screen HUD Elements

- **Telemetry Box (Top-Left)**:
  - `Hazard` — Current active threat classification.
  - `Direction` — Directional orientation (`LEFT`, `CENTER`, `RIGHT`, `NONE`).
  - `Haptic` — Output channel active.
  - `Haptic Feedback Line` — Detailed vibration pattern text.
  - `Mode Badge` — Displays `[MODE: AUTO VISION]` in green or `[MODE: MANUAL (<STATE>)]` in orange.
- **Zone Column Highlights**:
  - The active hazard zone is illuminated with a transparent colored tint (Yellow for Left, Green for Center, Blue for Right, Purple for Drop).
- **Virtual Vibration Motors (Top-Right)**:
  - Four circular indicators labeled **`L`**, **`C`**, **`R`**, and **`D`** animate in real-time with the exact microsecond pulsing cadence programmed in the ESP32 firmware!
