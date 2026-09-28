"""
SenseStep - Real-World Camera-Based Hazard Demonstration
=========================================================
Demonstrates real-world obstacle and drop hazard classification using a laptop
webcam and OpenCV computer vision techniques.

Simulates the haptic feedback patterns (Left, Center, Right, Drop, Critical, Safe)
matching the physical SenseStep smart cane specification.

Keyboard Shortcuts:
  [A] - Return to AUTO Detection Mode
  [L] - Force LEFT Obstacle
  [C] - Force CENTER Obstacle
  [R] - Force RIGHT Obstacle
  [D] - Force DROP / POTHOLE Hazard
  [X] - Force CRITICAL Front Collision
  [S] - Force SAFE (Clear Path)
  [Q] - Quit Application
"""

import cv2
import numpy as np
import time
import sys

# -------------------------------------------------------------
# Configuration Constants
# -------------------------------------------------------------
WINDOW_NAME = "SenseStep - Real-World Hazard Demonstration"
FRAME_WIDTH = 960
FRAME_HEIGHT = 540

# Minimum contour area (pixels) to qualify as a valid obstacle
MIN_OBSTACLE_AREA = 4500
CRITICAL_AREA_RATIO = 0.28  # If obstacle fills > 28% of frame -> CRITICAL

# Color palette (BGR format for OpenCV)
COLOR_BG_HUD       = (20, 24, 28)
COLOR_TEXT_PRIMARY = (255, 255, 255)
COLOR_TEXT_MUTED   = (170, 180, 190)
COLOR_SAFE         = (60, 200, 60)      # Green
COLOR_WARNING      = (0, 200, 255)      # Amber / Yellow
COLOR_DANGER       = (0, 120, 255)      # Orange
COLOR_CRITICAL     = (40, 40, 240)      # Red
COLOR_PURPLE       = (220, 80, 180)     # Magenta / Purple for Drop
COLOR_CYAN         = (240, 200, 40)      # Cyan


class SenseStepVision:
    def __init__(self):
        self.mode = "AUTO"  # "AUTO" or "MANUAL"
        self.manual_override = None  # None or state string

    def set_manual_override(self, state):
        self.mode = "MANUAL"
        self.manual_override = state

    def set_auto_mode(self):
        self.mode = "AUTO"
        self.manual_override = None

    def detect_hazards(self, frame):
        """
        Analyzes the webcam frame using contour & edge density analysis
        to classify the dominant hazard direction (LEFT, CENTER, RIGHT, SAFE, CRITICAL).
        """
        h, w = frame.shape[:2]
        zone_w = w // 3

        # Convert to grayscale and apply Gaussian blur to smooth sensor noise
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blurred = cv2.GaussianBlur(gray, (7, 7), 0)

        # Canny edge detection & morphological dilation to unify object contours
        edges = cv2.Canny(blurred, 40, 130)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (11, 11))
        dilated = cv2.dilate(edges, kernel, iterations=2)

        # Focus analysis on walking space (middle & lower frame regions)
        roi_y_start = int(h * 0.25)
        roi_y_end = int(h * 0.90)
        dilated_roi = dilated[roi_y_start:roi_y_end, :]

        # Find contours in the active region
        contours, _ = cv2.findContours(dilated_roi, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        best_contour = None
        max_score = 0
        best_bbox = None

        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < MIN_OBSTACLE_AREA:
                continue

            x, y, cw, ch = cv2.boundingRect(cnt)
            # Offset y back to full frame coordinates
            y += roi_y_start

            # Proximity weighting: larger objects and objects lower down score higher
            center_y = y + ch // 2
            proximity_weight = (center_y / h) ** 1.5
            score = area * proximity_weight

            if score > max_score:
                max_score = score
                best_contour = cnt
                best_bbox = (x, y, cw, ch)

        # Default state
        hazard = "SAFE"
        direction = "NONE"
        detected_bbox = None

        if best_bbox is not None:
            bx, by, bw, bh = best_bbox
            detected_bbox = best_bbox
            cx = bx + bw // 2
            obstacle_area = bw * bh
            total_frame_area = w * h

            # Check if obstacle is overwhelmingly close (CRITICAL)
            if (obstacle_area / total_frame_area) >= CRITICAL_AREA_RATIO:
                hazard = "CRITICAL"
                direction = "CENTER"
            elif cx < zone_w:
                hazard = "LEFT"
                direction = "LEFT"
            elif cx < zone_w * 2:
                hazard = "CENTER"
                direction = "CENTER"
            else:
                hazard = "RIGHT"
                direction = "RIGHT"

        return hazard, direction, detected_bbox

    def get_haptic_description(self, hazard):
        """Returns the haptic output simulation string matching hardware behavior."""
        if hazard == "LEFT":
            return "LEFT HAPTIC: 2 PULSES"
        elif hazard == "CENTER":
            return "CENTER HAPTIC: CONTINUOUS"
        elif hazard == "RIGHT":
            return "RIGHT HAPTIC: 3 PULSES"
        elif hazard == "DROP":
            return "DROP HAPTIC: 3 PULSES"
        elif hazard == "CRITICAL":
            return "CRITICAL HAPTIC: CONTINUOUS"
        else:
            return "HAPTIC: OFF"

    def get_haptic_short_label(self, hazard):
        """Returns the short haptic code for the HUD."""
        if hazard in ("LEFT", "CENTER", "RIGHT", "DROP", "CRITICAL"):
            return hazard
        return "OFF"


def draw_hud_and_overlays(frame, vision, auto_hazard, auto_direction, auto_bbox, current_time):
    """
    Renders high-contrast visual zones, bounding boxes, transparent glassmorphism
    HUD telemetry, and animated virtual haptic vibration motor indicators.
    """
    h, w = frame.shape[:2]
    zone_w = w // 3

    # Determine final active hazard and direction (Manual vs Auto)
    if vision.mode == "MANUAL":
        active_hazard = vision.manual_override
        if active_hazard in ("LEFT", "CENTER", "RIGHT"):
            active_direction = active_hazard
        elif active_hazard == "CRITICAL":
            active_direction = "CENTER"
        else:
            active_direction = "NONE"
    else:
        active_hazard = auto_hazard
        active_direction = auto_direction

    haptic_desc = vision.get_haptic_description(active_hazard)
    haptic_short = vision.get_haptic_short_label(active_hazard)

    overlay = frame.copy()

    # ---------------------------------------------------------
    # 1. Zone Dividers & Highlighting
    # ---------------------------------------------------------
    # Vertical guideline markers
    cv2.line(overlay, (zone_w, 0), (zone_w, h), (180, 180, 180), 1)
    cv2.line(overlay, (zone_w * 2, 0), (zone_w * 2, h), (180, 180, 180), 1)

    # Highlight active directional column
    if active_hazard == "LEFT":
        cv2.rectangle(overlay, (0, 0), (zone_w, h), COLOR_WARNING, -1)
    elif active_hazard in ("CENTER", "CRITICAL"):
        col = COLOR_CRITICAL if active_hazard == "CRITICAL" else COLOR_SAFE
        cv2.rectangle(overlay, (zone_w, 0), (zone_w * 2, h), col, -1)
    elif active_hazard == "RIGHT":
        cv2.rectangle(overlay, (zone_w * 2, 0), (w, h), COLOR_CYAN, -1)
    elif active_hazard == "DROP":
        # Highlight ground hazard region across the bottom
        cv2.rectangle(overlay, (0, int(h * 0.75)), (w, h), COLOR_PURPLE, -1)

    # Blend highlighted zone with 15% opacity
    cv2.addWeighted(overlay, 0.16, frame, 0.84, 0, frame)

    # Zone labels at top
    font = cv2.FONT_HERSHEY_SIMPLEX
    cv2.putText(frame, "LEFT ZONE", (zone_w // 2 - 50, 30), font, 0.55, (220, 220, 220), 1, cv2.LINE_AA)
    cv2.putText(frame, "CENTER ZONE", (zone_w + zone_w // 2 - 60, 30), font, 0.55, (220, 220, 220), 1, cv2.LINE_AA)
    cv2.putText(frame, "RIGHT ZONE", (zone_w * 2 + zone_w // 2 - 55, 30), font, 0.55, (220, 220, 220), 1, cv2.LINE_AA)

    # Draw detected obstacle bounding box in auto mode
    if vision.mode == "AUTO" and auto_bbox is not None and active_hazard != "SAFE":
        bx, by, bw, bh = auto_bbox
        cv2.rectangle(frame, (bx, by), (bx + bw, by + bh), (0, 255, 255), 2)
        cv2.putText(frame, f"OBSTACLE ({active_hazard})", (bx, max(by - 8, 20)), font, 0.55, (0, 255, 255), 2, cv2.LINE_AA)

    # ---------------------------------------------------------
    # 2. Main Telemetry HUD Card (Top Left)
    # ---------------------------------------------------------
    hud_x, hud_y = 20, 50
    hud_w, hud_h = 320, 230

    hud_bg = frame.copy()
    cv2.rectangle(hud_bg, (hud_x, hud_y), (hud_x + hud_w, hud_y + hud_h), COLOR_BG_HUD, -1)
    cv2.addWeighted(hud_bg, 0.82, frame, 0.18, 0, frame)
    cv2.rectangle(frame, (hud_x, hud_y), (hud_x + hud_w, hud_y + hud_h), (80, 95, 110), 1)

    # HUD Header
    cv2.putText(frame, "SENSESTEP", (hud_x + 18, hud_y + 30), font, 0.85, (0, 230, 255), 2, cv2.LINE_AA)
    cv2.line(frame, (hud_x + 18, hud_y + 40), (hud_x + hud_w - 18, hud_y + 40), (70, 85, 100), 1)

    # Telemetry Entries
    line_y = hud_y + 68
    cv2.putText(frame, "Hazard    :", (hud_x + 18, line_y), font, 0.55, COLOR_TEXT_MUTED, 1, cv2.LINE_AA)

    hazard_color = COLOR_SAFE
    if active_hazard in ("CRITICAL", "DROP"):
        hazard_color = COLOR_CRITICAL
    elif active_hazard in ("LEFT", "RIGHT", "CENTER"):
        hazard_color = COLOR_WARNING

    cv2.putText(frame, active_hazard, (hud_x + 115, line_y), font, 0.65, hazard_color, 2, cv2.LINE_AA)

    line_y += 28
    cv2.putText(frame, "Direction :", (hud_x + 18, line_y), font, 0.55, COLOR_TEXT_MUTED, 1, cv2.LINE_AA)
    cv2.putText(frame, active_direction, (hud_x + 115, line_y), font, 0.65, COLOR_TEXT_PRIMARY, 2, cv2.LINE_AA)

    line_y += 28
    cv2.putText(frame, "Haptic    :", (hud_x + 18, line_y), font, 0.55, COLOR_TEXT_MUTED, 1, cv2.LINE_AA)
    cv2.putText(frame, haptic_short, (hud_x + 115, line_y), font, 0.65, (0, 230, 255), 2, cv2.LINE_AA)

    cv2.line(frame, (hud_x + 18, line_y + 12), (hud_x + hud_w - 18, line_y + 12), (70, 85, 100), 1)

    line_y += 34
    # Haptic Feedback Simulation Line
    cv2.putText(frame, haptic_desc, (hud_x + 18, line_y), font, 0.50, (255, 230, 80), 1, cv2.LINE_AA)

    # Mode Badge (Auto vs Manual)
    line_y += 28
    if vision.mode == "AUTO":
        cv2.putText(frame, "[MODE: AUTO VISION]", (hud_x + 18, line_y), font, 0.50, COLOR_SAFE, 2, cv2.LINE_AA)
    else:
        cv2.putText(frame, f"[MODE: MANUAL ({vision.manual_override})]", (hud_x + 18, line_y), font, 0.50, (40, 160, 255), 2, cv2.LINE_AA)

    # ---------------------------------------------------------
    # 3. Virtual Haptic Motor Simulation Indicators (Blinking LEDs)
    # ---------------------------------------------------------
    # Calculates real-time pulse waveforms matching the ESP32 firmware
    millis = int(current_time * 1000)

    left_motor_on = False
    center_motor_on = False
    right_motor_on = False
    drop_motor_on = False

    if active_hazard == "LEFT":
        phase = millis % 600
        left_motor_on = (phase < 100) or (200 <= phase < 300)
    elif active_hazard in ("CENTER", "CRITICAL"):
        center_motor_on = True
    elif active_hazard == "RIGHT":
        phase = millis % 900
        right_motor_on = (phase < 100) or (200 <= phase < 300) or (400 <= phase < 500)
    elif active_hazard == "DROP":
        phase = millis % 900
        drop_motor_on = (phase < 100) or (200 <= phase < 300) or (400 <= phase < 500)

    # Draw motor indicators at top-right
    v_hud_x = w - 240
    v_hud_y = 50
    cv2.rectangle(frame, (v_hud_x, v_hud_y), (v_hud_x + 220, v_hud_y + 115), COLOR_BG_HUD, -1)
    cv2.rectangle(frame, (v_hud_x, v_hud_y), (v_hud_x + 220, v_hud_y + 115), (70, 85, 100), 1)
    cv2.putText(frame, "VIRTUAL MOTORS", (v_hud_x + 35, v_hud_y + 22), font, 0.48, (200, 210, 220), 1, cv2.LINE_AA)

    motors = [
        ("L", v_hud_x + 35, v_hud_y + 60, left_motor_on, (0, 220, 255)),
        ("C", v_hud_x + 85, v_hud_y + 60, center_motor_on, (50, 230, 50)),
        ("R", v_hud_x + 135, v_hud_y + 60, right_motor_on, (255, 180, 40)),
        ("D", v_hud_x + 185, v_hud_y + 60, drop_motor_on, (40, 40, 240)),
    ]

    for label, cx, cy, is_on, lit_color in motors:
        col = lit_color if is_on else (55, 60, 65)
        cv2.circle(frame, (cx, cy), 14, col, -1)
        cv2.circle(frame, (cx, cy), 14, (120, 130, 140), 1)
        # Glow ring when active
        if is_on:
            cv2.circle(frame, (cx, cy), 18, lit_color, 2)
        cv2.putText(frame, label, (cx - 5, cy + 5), font, 0.45, (255, 255, 255) if is_on else (140, 140, 140), 1, cv2.LINE_AA)

    cv2.putText(frame, "LEFT   CTR   RGHT   DROP", (v_hud_x + 22, v_hud_y + 98), font, 0.38, COLOR_TEXT_MUTED, 1, cv2.LINE_AA)

    # ---------------------------------------------------------
    # 4. Sensor Blocked / Privacy Shutter Notification Banner
    # ---------------------------------------------------------
    # Check if physical camera is returning pitch-black frames (common when HP shutter is closed)
    mean_val = float(np.mean(frame))
    if mean_val < 3.0:
        alert_w, alert_h = 620, 100
        alert_x = (w - alert_w) // 2
        alert_y = int(h * 0.40)
        card = frame.copy()
        cv2.rectangle(card, (alert_x, alert_y), (alert_x + alert_w, alert_y + alert_h), (20, 25, 40), -1)
        cv2.addWeighted(card, 0.90, frame, 0.10, 0, frame)
        cv2.rectangle(frame, (alert_x, alert_y), (alert_x + alert_w, alert_y + alert_h), (0, 180, 255), 2)
        cv2.putText(frame, "[!] CAMERA LENS IS COVERED / MUTED", (alert_x + 20, alert_y + 30), font, 0.62, (0, 220, 255), 2, cv2.LINE_AA)
        cv2.putText(frame, "* Slide open the physical privacy switch on the top bezel", (alert_x + 20, alert_y + 55), font, 0.46, (230, 230, 230), 1, cv2.LINE_AA)
        cv2.putText(frame, "* Or press Camera Mute key (F10 / Fn+F10) on keyboard", (alert_x + 20, alert_y + 75), font, 0.46, (230, 230, 230), 1, cv2.LINE_AA)
        cv2.putText(frame, "Press [V] anytime for Virtual Simulation Mode", (alert_x + 20, alert_y + 92), font, 0.40, (80, 240, 100), 1, cv2.LINE_AA)

    # ---------------------------------------------------------
    # 5. Bottom Navigation / Keyboard Cheat Sheet Bar
    # ---------------------------------------------------------
    bar_h = 36
    cv2.rectangle(frame, (0, h - bar_h), (w, h), (15, 18, 22), -1)
    controls_text = "[A] Auto | [V] Virtual | [L] Left | [C] Center | [R] Right | [D] Drop | [X] Critical | [S] Safe | [Q] Quit"
    cv2.putText(frame, controls_text, (w // 2 - 380, h - 12), font, 0.44, (200, 210, 220), 1, cv2.LINE_AA)


def open_camera():
    """
    Attempts to connect to camera using cv2.CAP_DSHOW on Windows,
    which fixes the Windows Media Foundation (MSMF) -1072873822 error.
    """
    # 1. Try DirectShow on camera 0 first, then 1
    for index in (0, 1):
        cap = cv2.VideoCapture(index, cv2.CAP_DSHOW)
        if cap.isOpened():
            ret, test_frame = cap.read()
            if ret and test_frame is not None:
                print(f"Connected to webcam (device {index}) via DirectShow backend.", flush=True)
                return cap
            cap.release()

    # 2. Try default backend on camera 0 and 1
    for index in (0, 1):
        cap = cv2.VideoCapture(index)
        if cap.isOpened():
            ret, test_frame = cap.read()
            if ret and test_frame is not None:
                print(f"Connected to webcam (device {index}) via default backend.", flush=True)
                return cap
            cap.release()

    return None


def generate_synthetic_frame(w, h, t):
    """
    Generates a simulated camera test pattern with walking corridor
    and an animated obstacle crossing left/center/right zones.
    """
    canvas = np.zeros((h, w, 3), dtype=np.uint8)
    # Subtle background floor gradient
    for y in range(h):
        val = int(25 + 25 * (y / h))
        canvas[y, :] = (val, val + 2, val + 6)

    # Simulated walking corridor grid
    cv2.line(canvas, (w // 3, 0), (w // 3, h), (70, 75, 80), 1)
    cv2.line(canvas, (2 * w // 3, 0), (2 * w // 3, h), (70, 75, 80), 1)
    cv2.line(canvas, (0, int(h * 0.75)), (w, int(h * 0.75)), (60, 65, 70), 1)

    # Simulated moving obstacle (smooth oscillating box)
    osc = int((np.sin(t * 1.5) + 1.0) / 2.0 * (w - 240)) + 60
    cv2.rectangle(canvas, (osc, int(h * 0.40)), (osc + 120, int(h * 0.85)), (50, 180, 230), -1)
    cv2.rectangle(canvas, (osc, int(h * 0.40)), (osc + 120, int(h * 0.85)), (255, 255, 255), 2)
    cv2.putText(canvas, "TEST OBSTACLE", (osc + 5, int(h * 0.38)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 255), 1, cv2.LINE_AA)

    cv2.putText(canvas, "[VIRTUAL CORRIDOR MODE - PRESS 'V' TO SWITCH TO WEBCAM]", (20, h - 50), cv2.FONT_HERSHEY_SIMPLEX, 0.50, (0, 200, 255), 1, cv2.LINE_AA)
    return canvas


def main():
    print("=" * 65, flush=True)
    print("      SenseStep - Real-World Camera Hazard Demonstration      ", flush=True)
    print("=" * 65, flush=True)
    print("Opening laptop webcam via DirectShow...", flush=True)

    cap = open_camera()
    using_synthetic = False

    if cap is None:
        print("\n[NOTICE] Physical webcam hardware is in use by another app or unavailable.", flush=True)
        print("Starting in Virtual Demonstration Mode automatically.", flush=True)
        print("All HUD overlays, haptic simulations, and keyboard overrides are active!\n", flush=True)
        using_synthetic = True
    else:
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_HEIGHT)

    cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_AUTOSIZE)
    # Bring window to foreground
    try:
        cv2.setWindowProperty(WINDOW_NAME, cv2.WND_PROP_TOPMOST, 1)
    except Exception:
        pass

    vision = SenseStepVision()

    print("\nDemonstration interface running.", flush=True)
    print("Press [Q] in the video window to exit.", flush=True)
    print("Keyboard shortcuts:", flush=True)
    print("  [V] Toggle Virtual Test Corridor / Webcam feed", flush=True)
    print("  [A] Auto computer vision mode", flush=True)
    print("  [L] Left  [C] Center  [R] Right  [D] Drop  [X] Critical  [S] Safe\n", flush=True)

    consecutive_read_failures = 0
    checked_dark = False

    while True:
        current_time = time.time()

        if using_synthetic or cap is None:
            frame = generate_synthetic_frame(FRAME_WIDTH, FRAME_HEIGHT, current_time)
        else:
            ret, frame = cap.read()
            if not ret or frame is None:
                consecutive_read_failures += 1
                if consecutive_read_failures > 10:
                    print("[WARN] Lost camera connection. Switching to Virtual Mode.")
                    using_synthetic = True
                    continue
                time.sleep(0.02)
                continue
            else:
                consecutive_read_failures = 0
                # Flip horizontally for natural mirror-like viewing
                frame = cv2.flip(frame, 1)

                if not checked_dark and np.mean(frame) < 3.0:
                    print("\n" + "!" * 65)
                    print("[NOTICE] Camera hardware is ACTIVE, but video feed is SOLID BLACK:")
                    print("  1. HP Physical Camera Shutter: Slide the small physical lever")
                    print("     above the laptop screen to uncover the lens.")
                    print("  2. Camera Mute Key: Press the camera key (F10 or Fn+F10) on your keyboard.")
                    print("  3. Press [V] in the video window anytime to run Virtual Corridor Mode.")
                    print("!" * 65 + "\n")
                    checked_dark = True

        # Run automated computer vision hazard detection
        auto_hazard, auto_direction, auto_bbox = vision.detect_hazards(frame)

        # Render HUD, zones, and simulated haptic outputs
        draw_hud_and_overlays(frame, vision, auto_hazard, auto_direction, auto_bbox, current_time)

        cv2.imshow(WINDOW_NAME, frame)

        # Check for keyboard input (1 ms delay)
        key = cv2.waitKey(1) & 0xFF

        if key in (ord('q'), ord('Q'), 27):  # Q or ESC to quit
            print("Exiting demonstration.")
            break
        elif key in (ord('v'), ord('V')):
            using_synthetic = not using_synthetic
            status = "VIRTUAL TEST CORRIDOR" if using_synthetic else "LIVE WEBCAM"
            print(f"[MODE] Toggled feed to: {status}")
        elif key in (ord('a'), ord('A')):
            vision.set_auto_mode()
            print("[MODE] Switched to AUTO computer-vision detection.")
        elif key in (ord('l'), ord('L')):
            vision.set_manual_override("LEFT")
            print("[OVERRIDE] Forced LEFT Obstacle.")
        elif key in (ord('c'), ord('C')):
            vision.set_manual_override("CENTER")
            print("[OVERRIDE] Forced CENTER Obstacle.")
        elif key in (ord('r'), ord('R')):
            vision.set_manual_override("RIGHT")
            print("[OVERRIDE] Forced RIGHT Obstacle.")
        elif key in (ord('d'), ord('D')):
            vision.set_manual_override("DROP")
            print("[OVERRIDE] Forced DROP / POTHOLE Hazard.")
        elif key in (ord('x'), ord('X')):
            vision.set_manual_override("CRITICAL")
            print("[OVERRIDE] Forced CRITICAL Front Collision.")
        elif key in (ord('s'), ord('S')):
            vision.set_manual_override("SAFE")
            print("[OVERRIDE] Forced SAFE (Clear Path).")

    if cap is not None:
        cap.release()
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()

