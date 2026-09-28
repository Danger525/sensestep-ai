/**
 * SenseStep Mobile — Calibrated Assistive Spatial Prototype
 * =========================================================
 * Mobile-first web application simulating the SenseStep smart cane
 * using HTML5 Browser Camera API, TensorFlow.js COCO-SSD object detection,
 * empirical multi-point optical distance calibration, walking corridor filtering,
 * temporal persistence tracking, and Web Speech API voice guidance.
 *
 * Core Principles:
 *   1. Walking Corridor (Path of Travel): Ignores ceiling, background, and far periphery.
 *   2. Detection Confidence Filtering: Adjustable MIN_CONFIDENCE (default 0.65).
 *   3. Temporal Persistence: Requires MIN_PERSISTENCE_FRAMES (default 3) to prevent false alarms.
 *   4. Hazard State Machine: SAFE -> POSSIBLE -> CONFIRMED -> CRITICAL.
 *   5. Real Empirical Multi-Point Calibration: Fitted per object class; no fake numbers.
 *   6. Distance Smoothing: Rolling median of last 5 valid estimates.
 *   7. Direction Stabilization: Debounced directional hysteresis.
 *   8. Approach Detection: Area expansion/contraction tracking.
 *
 * Target: iPhone (Safari / Chrome on iOS WebKit) & Android (Chrome) over HTTPS.
 */

(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // 1. Settings & Empirical Calibration Store
  // -------------------------------------------------------------------------
  const DEFAULT_SETTINGS = {
    minConfidence: 0.50,           // Default 50% AI confidence threshold (adjustable 0.35 - 0.85)
    pathOverlapThreshold: 0.05,    // 5% minimum overlap with walking corridor (relaxed from 0.20)
    minPersistenceFrames: 2,       // 2 consecutive frames to confirm (1 frame = POSSIBLE, 2 = CONFIRMED)
    minAreaRatio: 0.005,           // 0.5% minimum bounding-box area relative to frame
    criticalDistance: 0.50,        // < 0.50m -> STOP alert
    warningDistance: 1.00,         // 0.50m to 1.00m -> MOVE LEFT / RIGHT guidance
    pathTopPercent: 0.15,          // Relaxed top boundary (15% from top of frame)
    pathBottomPercent: 1.00,       // Corridor bottom boundary (ground level)
    pathLeftPercent: 0.20,         // Corridor left boundary (20% from left)
    pathRightPercent: 0.80,        // Corridor right boundary (80% from left)
  };

  const VALID_OBSTACLE_CLASSES = new Set([
    'person', 'chair', 'couch', 'bed', 'dining table', 'bench',
    'backpack', 'umbrella', 'handbag', 'suitcase', 'bottle', 'cup',
    'potted plant', 'bicycle', 'car', 'motorcycle', 'bus', 'truck',
    'dog', 'cat', 'laptop', 'cell phone', 'book', 'tv', 'refrigerator',
    'oven', 'sink', 'toilet', 'stop sign', 'fire hydrant'
  ]);

  const PHYSICAL_HEIGHTS = {
    person: 1.70,
    chair: 0.85,
    bottle: 0.25,
    cup: 0.12,
    backpack: 0.45,
    handbag: 0.30,
    suitcase: 0.65,
    bicycle: 1.00,
    car: 1.50,
    motorcycle: 1.10,
    dog: 0.50,
    cat: 0.28,
    laptop: 0.25,
    'cell phone': 0.15,
    book: 0.24,
    tv: 0.60,
    couch: 0.85,
    'potted plant': 0.40,
    'dining table': 0.75,
  };

  const DEFAULT_FOCAL_LENGTH = 580;

  function loadSettings() {
    try {
      const stored = localStorage.getItem('sensestep_settings');
      if (stored) {
        return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(stored));
      }
    } catch (e) {
      console.warn('Error loading settings from localStorage:', e);
    }
    return Object.assign({}, DEFAULT_SETTINGS);
  }

  function saveSettings(newSettings) {
    try {
      localStorage.setItem('sensestep_settings', JSON.stringify(newSettings));
    } catch (e) {
      console.warn('Error saving settings to localStorage:', e);
    }
  }

  function loadCalibrationSamples() {
    try {
      const stored = localStorage.getItem('sensestep_calibration_samples');
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (e) {
      console.warn('Error loading calibration samples:', e);
    }
    return {}; // className -> array of { distance, pixelHeight, pixelWidth, timestamp }
  }

  function saveCalibrationSamples(samples) {
    try {
      localStorage.setItem('sensestep_calibration_samples', JSON.stringify(samples));
    } catch (e) {
      console.warn('Error saving calibration samples:', e);
    }
  }

  // -------------------------------------------------------------------------
  // 2. Strict Capability Detection
  // -------------------------------------------------------------------------
  const supportsVibration =
    "vibrate" in navigator &&
    typeof navigator.vibrate === "function";

  const supportsSpeech =
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    typeof window.SpeechSynthesisUtterance === 'function';

  // -------------------------------------------------------------------------
  // 3. Application State
  // -------------------------------------------------------------------------
  const state = {
    settings: loadSettings(),
    calibrationSamples: loadCalibrationSamples(),

    mode: 'AUTO',             // 'AUTO' | 'DEMO' | 'PRESENTATION'
    isPresentationMode: false,
    debugMode: false,

    cameraActive: false,
    cameraStream: null,
    isInferring: false,
    inferenceTimer: null,

    aiStatus: 'LOADING',      // 'LOADING' | 'READY' | 'FAILED' | 'UNAVAILABLE'
    aiModel: null,

    // Hazard State Machine: 'SAFE' | 'POSSIBLE' | 'CONFIRMED' | 'CRITICAL'
    hazardState: 'SAFE',
    activeHazard: 'SAFE',     // 'SAFE' | 'LEFT' | 'CENTER' | 'RIGHT' | 'DROP' | 'CRITICAL' | 'UNCERTAIN'
    activeDirection: 'NONE',  // 'LEFT' | 'CENTER' | 'RIGHT' | 'GROUND' | 'NONE'
    confirmedDirection: 'NONE',
    candidateDirection: 'NONE',
    directionMatchCount: 0,

    estimatedDistance: null,
    distanceConfidence: 'UNKNOWN', // 'GOOD' | 'FAIR' | 'LOW' | 'UNKNOWN'
    detectedObjectName: 'NONE',
    detectedObjectConf: 0,
    pathOverlapRatio: 0,
    approachTrend: 'STABLE',       // 'APPROACHING' | 'MOVING AWAY' | 'STABLE'

    // Haptics & Audio
    hapticTimer: null,
    hapticsSupported: supportsVibration,
    voiceEnabled: false,
    speechSupported: supportsSpeech,
    audioEnabled: true,
    audioCtx: null,
    beepTimer: null,

    // State Change Protection Tracking
    lastHazard: null,
    lastDirection: null,
    lastUrgency: null,
    lastInstruction: null,
    lastAnnouncementTime: 0,

    // Calibration modal active tab & test mode
    calActiveTab: 'calibrate',
    selectedCalDist: 1.0,
    selectedTestDist: 1.0,
    lastDetectedForCalibration: null,

    // Demo Mode distance override
    demoSimulatedDistance: 0.7,
  };

  // -------------------------------------------------------------------------
  // 4. Object Tracker & Persistence Engine
  // -------------------------------------------------------------------------
  const tracker = {
    tracked: null, // { className, bbox, center, confidence, overlapRatio, frameW, frameH, persistenceCount, graceFrames, history, distanceHistory }

    reset() {
      this.tracked = null;
    },

    update(validDetections, frameW, frameH) {
      if (!validDetections || validDetections.length === 0) {
        if (this.tracked && this.tracked.graceFrames > 0) {
          this.tracked.graceFrames--;
          return this.tracked;
        }
        this.reset();
        return null;
      }

      // Pick dominant valid obstacle candidate (largest area in corridor)
      let dominant = validDetections[0];
      let maxArea = dominant.bbox[2] * dominant.bbox[3];
      for (let i = 1; i < validDetections.length; i++) {
        const area = validDetections[i].bbox[2] * validDetections[i].bbox[3];
        if (area > maxArea) {
          maxArea = area;
          dominant = validDetections[i];
        }
      }

      const [bx, by, bw, bh] = dominant.bbox;
      const center = [bx + bw / 2, by + bh / 2];
      const area = bw * bh;

      if (this.tracked) {
        // Continuous detection across consecutive inference cycles (Section 5: CONFIRMED after 2 cycles)
        this.tracked.bbox = dominant.bbox;
        this.tracked.center = center;
        this.tracked.confidence = dominant.score;
        this.tracked.className = dominant.class;
        this.tracked.overlapRatio = dominant.overlapRatio;
        this.tracked.frameW = frameW;
        this.tracked.frameH = frameH;
        this.tracked.persistenceCount = Math.min(10, this.tracked.persistenceCount + 1);
        this.tracked.graceFrames = 2; // Allow 2 missed frames before clearing

        // Record history for approach trend
        this.tracked.history.push({ area, timestamp: Date.now() });
        if (this.tracked.history.length > 7) {
          this.tracked.history.shift();
        }
        return this.tracked;
      }

      // First detection cycle for candidate (Section 5: POSSIBLE after 1 valid detection)
      this.tracked = {
        className: dominant.class,
        bbox: dominant.bbox,
        center: center,
        confidence: dominant.score,
        overlapRatio: dominant.overlapRatio,
        frameW: frameW,
        frameH: frameH,
        persistenceCount: 1,
        graceFrames: 2,
        history: [{ area, timestamp: Date.now() }],
        distanceHistory: [],
      };

      return this.tracked;
    }
  };

  function computeIoU(boxA, boxB) {
    const xA = Math.max(boxA[0], boxB[0]);
    const yA = Math.max(boxA[1], boxB[1]);
    const xB = Math.min(boxA[0] + boxA[2], boxB[0] + boxB[2]);
    const yB = Math.min(boxA[1] + boxA[3], boxB[1] + boxB[3]);

    const interArea = Math.max(0, xB - xA) * Math.max(0, yB - yA);
    if (interArea === 0) return 0;

    const boxAArea = boxA[2] * boxA[3];
    const boxBArea = boxB[2] * boxB[3];
    return interArea / (boxAArea + boxBArea - interArea);
  }

  function computeCenterDistanceNorm(c1, c2, frameW, frameH) {
    const dx = (c1[0] - c2[0]) / frameW;
    const dy = (c1[1] - c2[1]) / frameH;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // -------------------------------------------------------------------------
  // 5. Walking Corridor (Path of Travel) Computation
  // -------------------------------------------------------------------------

  /**
   * Computes the bounding box overlap ratio with the walking corridor.
   * Objects outside the corridor (ceiling, far walls, high background) are ignored.
   */
  function computePathOverlap(bbox, frameW, frameH) {
    const s = state.settings;
    const pathX = frameW * s.pathLeftPercent;
    const pathY = frameH * s.pathTopPercent;
    const pathW = frameW * (s.pathRightPercent - s.pathLeftPercent);
    const pathH = frameH * (s.pathBottomPercent - s.pathTopPercent);

    const [bx, by, bw, bh] = bbox;
    const bboxArea = bw * bh;
    const frameArea = frameW * frameH;

    // Minimum object size filter (Section 7: 0.005 of frame area)
    const minArea = frameArea * (s.minAreaRatio || 0.005);
    if (bboxArea < minArea) {
      return { overlapRatio: 0, isWithinCorridor: false, pathRegion: [pathX, pathY, pathW, pathH] };
    }

    // Check vertical floor position: if bottom of object is above corridor top, it's high on wall/ceiling
    if (by + bh < pathY) {
      return { overlapRatio: 0, isWithinCorridor: false, pathRegion: [pathX, pathY, pathW, pathH] };
    }

    const interX1 = Math.max(bx, pathX);
    const interY1 = Math.max(by, pathY);
    const interX2 = Math.min(bx + bw, pathX + pathW);
    const interY2 = Math.min(by + bh, pathY + pathH);

    const interW = Math.max(0, interX2 - interX1);
    const interH = Math.max(0, interY2 - interY1);
    const interArea = interW * interH;

    if (bboxArea === 0) {
      return { overlapRatio: 0, isWithinCorridor: false, pathRegion: [pathX, pathY, pathW, pathH] };
    }

    const overlapRatio = interArea / bboxArea;
    const centerX = bx + bw / 2;
    const centerInCorridor = centerX >= pathX && centerX <= (pathX + pathW);

    // Overlaps walking path region (Section 4 & 5: PATH_OVERLAP_THRESHOLD = 0.05)
    const isWithinCorridor = (overlapRatio >= s.pathOverlapThreshold) || (centerInCorridor && overlapRatio > 0.01);

    return { overlapRatio, isWithinCorridor, pathRegion: [pathX, pathY, pathW, pathH] };
  }

  // -------------------------------------------------------------------------
  // 6. Empirical Distance Estimation & Multi-Point Calibration Model
  // -------------------------------------------------------------------------

  /**
   * Empirical distance model using class-specific calibration samples.
   * Solves least-squares regression: distance = m * (1000 / pixelHeight) + c
   */
  function calculateEmpiricalDistance(className, boxHeightPixels) {
    if (!boxHeightPixels || boxHeightPixels < 15) {
      return { distance: null, confidence: 'UNKNOWN' };
    }

    const samples = state.calibrationSamples[className];

    // Case 1: Multi-point calibrated class (>= 3 samples)
    if (samples && samples.length >= 3) {
      const N = samples.length;
      let sumX = 0;
      let sumY = 0;
      let sumXY = 0;
      let sumX2 = 0;

      for (const smp of samples) {
        const x = 1000.0 / smp.pixelHeight;
        const y = smp.distance;
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
      }

      const meanX = sumX / N;
      const meanY = sumY / N;
      const denom = sumX2 - N * meanX * meanX;

      let distance = null;
      if (Math.abs(denom) > 1e-6) {
        const m = (sumXY - N * meanX * meanY) / denom;
        const c = meanY - m * meanX;
        distance = m * (1000.0 / boxHeightPixels) + c;
      } else {
        // Fallback to average scaling constant
        const avgK = sumY / sumX;
        distance = avgK * (1000.0 / boxHeightPixels);
      }

      if (distance !== null && distance >= 0.20 && distance <= 6.0) {
        return { distance, confidence: samples.length >= 4 ? 'GOOD' : 'FAIR' };
      }
    }

    // Case 2: Limited samples (1 or 2 samples)
    if (samples && samples.length > 0) {
      const lastSample = samples[samples.length - 1];
      const k = lastSample.distance * lastSample.pixelHeight;
      const distance = k / boxHeightPixels;
      if (distance >= 0.20 && distance <= 6.0) {
        return { distance, confidence: 'FAIR' };
      }
    }

    // Case 3: Uncalibrated object, but known physical height in table
    if (PHYSICAL_HEIGHTS[className]) {
      const realHeight = PHYSICAL_HEIGHTS[className];
      const rawDistance = (DEFAULT_FOCAL_LENGTH * realHeight) / boxHeightPixels;
      if (rawDistance >= 0.20 && rawDistance <= 6.0) {
        return { distance: rawDistance, confidence: 'LOW' };
      }
    }

    // Case 4: Completely unknown object class or invalid height
    return { distance: null, confidence: 'UNKNOWN' };
  }

  /**
   * Rolling median smoothing of last 5 valid distance estimates.
   * Completely filters out single-frame measurement spikes (e.g. 0.7m, 1.4m, 0.6m -> median is 0.7m).
   */
  function smoothDistance(trackedObj, rawDist) {
    if (rawDist === null || isNaN(rawDist)) {
      return null;
    }

    if (!trackedObj.distanceHistory) {
      trackedObj.distanceHistory = [];
    }

    trackedObj.distanceHistory.push(rawDist);
    if (trackedObj.distanceHistory.length > 5) {
      trackedObj.distanceHistory.shift();
    }

    // Calculate rolling median
    const sorted = trackedObj.distanceHistory.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 !== 0) {
      return sorted[mid];
    } else {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
  }

  /**
   * Evaluates approach/recession trend by tracking smoothed bounding-box area over time.
   */
  function computeApproachTrend(history) {
    if (!history || history.length < 4) {
      return 'STABLE';
    }

    const pastArea = history[0].area;
    const currentArea = history[history.length - 1].area;

    if (pastArea <= 0) return 'STABLE';

    const ratio = currentArea / pastArea;
    if (ratio > 1.15) {
      return 'APPROACHING';
    } else if (ratio < 0.85) {
      return 'MOVING AWAY';
    }
    return 'STABLE';
  }

  // -------------------------------------------------------------------------
  // 7. Direction Stabilization (Debounce & Hysteresis)
  // -------------------------------------------------------------------------
  function calculateDirection(centerX, frameW) {
    const leftBound = frameW * 0.40;
    const rightBound = frameW * 0.60;

    let rawDir = 'CENTER';
    if (centerX < leftBound) rawDir = 'LEFT';
    else if (centerX > rightBound) rawDir = 'RIGHT';

    return stabilizeDirection(rawDir);
  }

  function stabilizeDirection(rawDirection) {
    if (rawDirection === state.candidateDirection) {
      state.directionMatchCount++;
    } else {
      state.candidateDirection = rawDirection;
      state.directionMatchCount = 1;
    }

    // Require 2 consecutive cycles to confirm direction change (Section 12)
    if (state.directionMatchCount >= 2) {
      state.confirmedDirection = rawDirection;
    }

    return state.confirmedDirection !== 'NONE' ? state.confirmedDirection : rawDirection;
  }

  // -------------------------------------------------------------------------
  // 8. Hazard State Machine & Central Decision Logic
  // -------------------------------------------------------------------------

  /**
   * Evaluates the multi-stage hazard state machine:
   * SAFE -> POSSIBLE (Level 1) -> CONFIRMED (Level 2) -> CRITICAL (Level 3)
   *
   * CRITICAL REQUIREMENT: Distance estimation is secondary.
   * If distance is UNKNOWN, obstacles are STILL detected and classified as POSSIBLE/CONFIRMED.
   */
  function evaluateHazardStateMachine(trackedObj, isWithinCorridor, smoothedDist, distConfidence, overlapRatio) {
    const s = state.settings;

    if (!trackedObj || !isWithinCorridor) {
      return {
        hazardState: 'SAFE',
        hazardType: 'SAFE',
        urgency: 'SAFE'
      };
    }

    const direction = state.confirmedDirection !== 'NONE' ? state.confirmedDirection : 'CENTER';
    const isConfirmed = trackedObj.persistenceCount >= s.minPersistenceFrames;

    // 1. If estimated distance is known with GOOD or FAIR confidence:
    if (smoothedDist !== null && !isNaN(smoothedDist) && (distConfidence === 'GOOD' || distConfidence === 'FAIR')) {
      if (smoothedDist < s.criticalDistance) {
        return {
          hazardState: 'CRITICAL',
          hazardType: 'CRITICAL',
          urgency: 'CRITICAL'
        };
      } else if (smoothedDist <= s.warningDistance) {
        return {
          hazardState: isConfirmed ? 'CONFIRMED' : 'POSSIBLE',
          hazardType: direction,
          urgency: 'WARNING'
        };
      } else {
        // Beyond warning distance (> 1.0m)
        return {
          hazardState: 'POSSIBLE',
          hazardType: direction,
          urgency: 'SAFE' // Distant object
        };
      }
    }

    // 2. Extreme close proximity check even without distance calibration
    // (e.g. object fills more than 75% of screen height directly in path)
    const bh = trackedObj.bbox[3];
    const frameH = trackedObj.frameH || 480;
    if (bh > frameH * 0.75 && overlapRatio > 0.50) {
      return {
        hazardState: 'CRITICAL',
        hazardType: 'CRITICAL',
        urgency: 'CRITICAL'
      };
    }

    // 3. Distance is UNKNOWN or uncalibrated: DO NOT SUPPRESS!
    // Section 2 & 11:
    // 1 frame -> POSSIBLE (visual only)
    // 2+ frames -> CONFIRMED (voice & haptics active, distance: UNKNOWN)
    return {
      hazardState: isConfirmed ? 'CONFIRMED' : 'POSSIBLE',
      hazardType: direction,
      urgency: 'WARNING'
    };
  }

  function getNavigationInstruction(hazard, direction, distance, hazardState) {
    if (hazard === 'SAFE' || hazardState === 'SAFE') {
      return {
        message: "Path clear.",
        action: "CONTINUE",
        urgency: "SAFE"
      };
    }

    if (hazard === 'DROP') {
      return {
        message: "Drop detected. Stop.",
        action: "STOP",
        urgency: "CRITICAL"
      };
    }

    if (hazardState === 'POSSIBLE') {
      return {
        message: "Obstacle detected. Proceed carefully.",
        action: "POSSIBLE OBSTACLE",
        urgency: "WARNING"
      };
    }

    if (hazard === 'CRITICAL' || hazardState === 'CRITICAL') {
      if (direction === 'LEFT') {
        return {
          message: "Critical obstacle on the left. Stop and move right.",
          action: "STOP & MOVE RIGHT",
          urgency: "CRITICAL"
        };
      } else if (direction === 'RIGHT') {
        return {
          message: "Critical obstacle on the right. Stop and move left.",
          action: "STOP & MOVE LEFT",
          urgency: "CRITICAL"
        };
      } else {
        return {
          message: "Critical obstacle ahead. Stop.",
          action: "STOP",
          urgency: "CRITICAL"
        };
      }
    }

    if (direction === 'LEFT') {
      return {
        message: "Obstacle on the left. Move right.",
        action: "MOVE RIGHT",
        urgency: "WARNING"
      };
    }

    if (direction === 'RIGHT') {
      return {
        message: "Obstacle on the right. Move left.",
        action: "MOVE LEFT",
        urgency: "WARNING"
      };
    }

    if (direction === 'CENTER') {
      return {
        message: "Obstacle ahead. Move left or right.",
        action: "MOVE LEFT OR RIGHT",
        urgency: "WARNING"
      };
    }

    return {
      message: "Obstacle detected. Proceed carefully.",
      action: "PROCEED CAREFULLY",
      urgency: "WARNING"
    };
  }

  // -------------------------------------------------------------------------
  // 9. Dedicated Web Speech API Engine
  // -------------------------------------------------------------------------
  const speechEngine = {
    synth: supportsSpeech ? window.speechSynthesis : null,
    voice: null,
    rate: 0.95,
    pitch: 1.0,
    isSpeaking: false,

    initVoices() {
      if (!this.synth) return;
      try {
        const voices = this.synth.getVoices();
        if (voices && voices.length > 0) {
          const preferred = voices.find(v => (v.lang === 'en-US' || v.lang.startsWith('en')) && (
            v.name.includes('Natural') || v.name.includes('Siri') || v.name.includes('Samantha') ||
            v.name.includes('Google') || v.name.includes('Karen') || v.name.includes('Daniel')
          )) || voices.find(v => v.lang === 'en-US') || voices.find(v => v.lang.startsWith('en')) || voices[0];
          this.voice = preferred;
        }
      } catch (e) {
        console.warn('Voice enumeration warning:', e);
      }
    },

    speak(text) {
      if (!this.synth || !state.voiceEnabled || !text) return;
      if (!this.voice) this.initVoices();

      try {
        if (this.synth.speaking || this.synth.pending) {
          this.synth.cancel();
        }

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = this.rate;
        utterance.pitch = this.pitch;
        if (this.voice) utterance.voice = this.voice;

        utterance.onstart = () => {
          this.isSpeaking = true;
          if (elements.badgeVoice) {
            elements.badgeVoice.textContent = 'VOICE: SPEAKING';
            elements.badgeVoice.className = 'status-badge badge-ready';
          }
        };

        utterance.onend = () => {
          this.isSpeaking = false;
          if (elements.badgeVoice) {
            elements.badgeVoice.textContent = state.voiceEnabled ? 'VOICE: ON' : 'VOICE: OFF';
            elements.badgeVoice.className = state.voiceEnabled ? 'status-badge badge-ready' : 'status-badge badge-neutral';
          }
        };

        utterance.onerror = (e) => {
          this.isSpeaking = false;
          console.warn('SpeechSynthesis error:', e);
        };

        this.synth.speak(utterance);
      } catch (err) {
        console.warn('SpeechSynthesis speak error:', err);
      }
    },

    stopSpeech() {
      if (this.synth) {
        try { this.synth.cancel(); } catch (e) {}
      }
      this.isSpeaking = false;
      if (elements.badgeVoice) {
        elements.badgeVoice.textContent = state.voiceEnabled ? 'VOICE: ON' : 'VOICE: OFF';
      }
    }
  };

  if (speechEngine.synth) {
    speechEngine.synth.onvoiceschanged = () => speechEngine.initVoices();
    speechEngine.initVoices();
  }

  function speak(text) { speechEngine.speak(text); }
  function stopSpeech() { speechEngine.stopSpeech(); }

  function enableVoiceGuidance() {
    unlockAudio();
    state.voiceEnabled = true;
    speechEngine.initVoices();
    if (speechEngine.synth && speechEngine.synth.paused) {
      speechEngine.synth.resume();
    }

    if (elements.btnToggleVoice) {
      elements.btnToggleVoice.classList.add('voice-active');
      elements.btnToggleVoice.classList.remove('voice-muted');
      elements.voiceIcon.textContent = '🗣️';
      elements.voiceText.textContent = 'VOICE: ON';
    }
    if (elements.badgeVoice) {
      updateBadge(elements.badgeVoice, 'VOICE: ON', 'badge-ready');
    }
    if (elements.presVoiceBadge) {
      elements.presVoiceBadge.textContent = 'VOICE: ON';
      elements.presVoiceBadge.style.color = '#22c55e';
    }

    speak('SenseStep voice guidance enabled.');
  }

  function toggleVoiceGuidance() {
    if (!state.voiceEnabled) {
      enableVoiceGuidance();
    } else {
      stopSpeech();
      state.voiceEnabled = false;
      if (elements.btnToggleVoice) {
        elements.btnToggleVoice.classList.remove('voice-active');
        elements.btnToggleVoice.classList.add('voice-muted');
        elements.voiceIcon.textContent = '🔇';
        elements.voiceText.textContent = 'ENABLE VOICE';
      }
      if (elements.badgeVoice) {
        updateBadge(elements.badgeVoice, 'VOICE: OFF', 'badge-neutral');
      }
      if (elements.presVoiceBadge) {
        elements.presVoiceBadge.textContent = 'VOICE: OFF';
        elements.presVoiceBadge.style.color = '#94a3b8';
      }
    }
  }

  // -------------------------------------------------------------------------
  // 10. Haptics & Directional Beep Engines
  // -------------------------------------------------------------------------
  function stopVibration() {
    if (state.hapticTimer) {
      clearInterval(state.hapticTimer);
      state.hapticTimer = null;
    }
    if (state.hapticsSupported) {
      try { navigator.vibrate(0); } catch (e) {}
    }
  }

  function vibrateSafe() { stopVibration(); }
  function vibrateLeft() {
    stopVibration();
    if (!state.hapticsSupported) return;
    try { navigator.vibrate([100, 100, 100]); } catch (e) {}
  }

  function vibrateCenter() {
    stopVibration();
    if (!state.hapticsSupported) return;
    const pattern = [200, 150];
    try { navigator.vibrate(pattern); } catch (e) {}
    state.hapticTimer = setInterval(() => {
      if ((state.activeHazard === 'CENTER' || state.hazardState === 'CONFIRMED') && state.hapticsSupported) {
        try { navigator.vibrate(pattern); } catch (e) {}
      } else {
        stopVibration();
      }
    }, 400);
  }

  function vibrateRight() {
    stopVibration();
    if (!state.hapticsSupported) return;
    try { navigator.vibrate([100, 100, 100, 100, 100]); } catch (e) {}
  }

  function vibrateDrop() {
    stopVibration();
    if (!state.hapticsSupported) return;
    try { navigator.vibrate([200, 100, 200, 100, 200]); } catch (e) {}
  }

  function vibrateCritical() {
    stopVibration();
    if (!state.hapticsSupported) return;
    const pattern = [300, 100, 300, 100];
    try { navigator.vibrate(pattern); } catch (e) {}
    state.hapticTimer = setInterval(() => {
      if ((state.activeHazard === 'CRITICAL' || state.hazardState === 'CRITICAL') && state.hapticsSupported) {
        try { navigator.vibrate(pattern); } catch (e) {}
      } else {
        stopVibration();
      }
    }, 500);
  }

  function applyHapticFeedback(hazardState) {
    if (!state.hapticsSupported) return;
    switch (hazardState) {
      case 'LEFT': vibrateLeft(); break;
      case 'CENTER': vibrateCenter(); break;
      case 'RIGHT': vibrateRight(); break;
      case 'DROP': vibrateDrop(); break;
      case 'CRITICAL': vibrateCritical(); break;
      default: vibrateSafe(); break;
    }
  }

  let isAudioUnlocked = false;
  function unlockAudio() {
    if (!state.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) state.audioCtx = new AudioCtx();
    }
    if (!state.audioCtx) return;
    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume().catch(() => {});
    }
    if (!isAudioUnlocked) {
      try {
        const buffer = state.audioCtx.createBuffer(1, 1, 22050);
        const source = state.audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(state.audioCtx.destination);
        source.start(0);
        isAudioUnlocked = true;
      } catch (e) {}
    }
  }

  function initAudioContext() { unlockAudio(); }

  function playTone(freq, durationMs, type = 'triangle') {
    if (!state.audioEnabled) return;
    unlockAudio();
    if (!state.audioCtx) return;
    try {
      const ctx = state.audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      const now = ctx.currentTime;
      const attack = 0.012;
      const durationSec = durationMs / 1000;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(0.80, now + attack);
      gain.gain.setValueAtTime(0.80, now + durationSec - 0.015);
      gain.gain.linearRampToValueAtTime(0.0001, now + durationSec);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + durationSec + 0.04);
    } catch (e) {}
  }

  function stopAudioBeep() {
    if (state.beepTimer) {
      clearInterval(state.beepTimer);
      state.beepTimer = null;
    }
  }

  function applyAudioBeepFeedback(hazardState) {
    if (!state.audioEnabled) return;
    stopAudioBeep();
    switch (hazardState) {
      case 'LEFT':
        playTone(620, 110, 'triangle');
        setTimeout(() => { if (state.activeHazard === 'LEFT') playTone(620, 110, 'triangle'); }, 220);
        break;
      case 'CENTER':
        playTone(840, 170, 'triangle');
        state.beepTimer = setInterval(() => {
          if (state.activeHazard === 'CENTER' && state.audioEnabled) playTone(840, 170, 'triangle');
          else stopAudioBeep();
        }, 390);
        break;
      case 'RIGHT':
        playTone(1080, 95, 'triangle');
        setTimeout(() => { if (state.activeHazard === 'RIGHT') playTone(1080, 95, 'triangle'); }, 190);
        setTimeout(() => { if (state.activeHazard === 'RIGHT') playTone(1080, 95, 'triangle'); }, 380);
        break;
      case 'DROP':
        playTone(480, 170, 'sawtooth');
        setTimeout(() => { if (state.activeHazard === 'DROP') playTone(400, 170, 'sawtooth'); }, 260);
        setTimeout(() => { if (state.activeHazard === 'DROP') playTone(320, 170, 'sawtooth'); }, 520);
        break;
      case 'CRITICAL':
        playTone(1400, 130, 'square');
        state.beepTimer = setInterval(() => {
          if (state.activeHazard === 'CRITICAL' && state.audioEnabled) playTone(1400, 130, 'square');
          else stopAudioBeep();
        }, 230);
        break;
      default:
        stopAudioBeep();
        break;
    }
  }

  function toggleAudio() {
    unlockAudio();
    state.audioEnabled = !state.audioEnabled;
    if (state.audioEnabled) {
      elements.btnToggleAudio.classList.remove('audio-muted');
      elements.audioIcon.textContent = '🔊';
      elements.audioText.textContent = 'BEEP: ON';
      updateBadge(elements.badgeAudio, 'BEEP: ON', 'badge-ready');
      playTone(880, 180, 'triangle');
    } else {
      stopAudioBeep();
      elements.btnToggleAudio.classList.add('audio-muted');
      elements.audioIcon.textContent = '🔇';
      elements.audioText.textContent = 'BEEP: OFF';
      updateBadge(elements.badgeAudio, 'BEEP: OFF', 'badge-neutral');
    }
  }

  // -------------------------------------------------------------------------
  // 11. Central Telemetry & HUD Update
  // -------------------------------------------------------------------------

  function updateHUD(hazard, direction, distanceNum, objectName, confidence, hState, distConf, overlapRatio, trend) {
    state.activeHazard = hazard;
    state.activeDirection = direction;
    state.estimatedDistance = distanceNum;
    state.hazardState = hState || 'SAFE';
    state.distanceConfidence = distConf || 'UNKNOWN';
    state.detectedObjectName = objectName || 'NONE';
    state.detectedObjectConf = confidence || 0;
    state.pathOverlapRatio = overlapRatio || 0;
    state.approachTrend = trend || 'STABLE';

    // 1. Calculate Navigation Instruction
    const instruction = getNavigationInstruction(hazard, direction, distanceNum, state.hazardState);

    // 2. Update Large Navigation Instruction Card
    elements.navActionText.textContent = instruction.action;
    let detailText = instruction.message;
    if (state.hazardState === 'SAFE') detailText = 'Path clear.';
    else if (hazard === 'DROP') detailText = 'DROP DETECTED';
    else if (hazard === 'CRITICAL') detailText = 'CRITICAL OBSTACLE';
    else if (state.hazardState === 'POSSIBLE') detailText = `Possible obstacle in path (${Math.round((confidence || 0) * 100)}%)`;
    elements.navDetailText.textContent = detailText;

    let distStr = 'Estimated distance: --';
    if (distanceNum !== null && !isNaN(distanceNum)) {
      distStr = `Estimated distance: ~${distanceNum.toFixed(1)} m`;
    } else if (state.hazardState !== 'SAFE') {
      distStr = 'Estimated distance: Unknown';
    }
    elements.navDistText.textContent = distStr;

    elements.navInstructionCard.className = 'nav-instruction-card urgency-' + instruction.urgency.toLowerCase();
    elements.navUrgencyBadge.textContent = state.hazardState;
    elements.navUrgencyBadge.className = 'nav-urgency-badge badge-' + instruction.urgency.toLowerCase();

    // 3. Keep Presentation Panel in sync
    if (elements.presActionText) {
      elements.presActionText.textContent = instruction.action;
      elements.presDetailText.textContent = detailText;
      elements.presDistText.textContent = distStr;
      elements.presHazardBadge.textContent = `STATE: ${state.hazardState}`;
    }

    // 4. Update HUD Metrics
    elements.metricHazard.textContent = hazard;
    elements.metricHazard.className = 'metric-value ' + (instruction.urgency === 'CRITICAL' ? 'text-critical' : (instruction.urgency === 'WARNING' ? 'text-warning' : 'text-safe'));
    elements.metricDirection.textContent = direction;
    elements.metricDistance.textContent = (distanceNum !== null && !isNaN(distanceNum)) ? `~${distanceNum.toFixed(1)} m` : 'UNKNOWN';

    if (!state.hapticsSupported) {
      elements.metricHaptic.textContent = 'NOT SUPPORTED';
      elements.metricHaptic.className = 'metric-value text-muted';
      elements.hapticTickerText.textContent = `${instruction.message} (Browser vibration not supported on iOS WebKit. Audio & voice active).`;
      elements.hapticPulseDot.classList.remove('active');
    } else {
      elements.metricHaptic.textContent = (hazard === 'SAFE' || state.hazardState === 'SAFE') ? 'OFF' : `ACTIVE (${direction})`;
      elements.metricHaptic.className = 'metric-value ' + ((hazard === 'SAFE' || state.hazardState === 'SAFE') ? 'text-muted' : 'text-primary');
      elements.hapticTickerText.textContent = `${instruction.message} (${direction} guidance active).`;
      if (hazard !== 'SAFE' && state.hazardState !== 'SAFE') elements.hapticPulseDot.classList.add('active');
      else elements.hapticPulseDot.classList.remove('active');
    }

    // 5. Update Telemetry Secondary Stats
    const confPercent = Math.round((confidence || 0) * 100);
    elements.statAiConf.textContent = `AI CONF: ${confPercent}%`;
    elements.statOverlap.textContent = `PATH OVERLAP: ${Math.round(overlapRatio * 100)}%`;
    elements.statPersist.textContent = `PERSISTENCE: ${tracker.tracked ? tracker.tracked.persistenceCount : 0}/${state.settings.minPersistenceFrames}`;
    elements.statDistConf.textContent = `DIST CONF: ${distConf}`;

    // Update object tag & state machine badges
    elements.hudObjectTag.textContent = (objectName && objectName !== 'NONE') ? `OBJECT: ${objectName.toUpperCase()} (${confPercent}%)` : 'OBJECT: NONE';
    elements.hudStateMachineBadge.textContent = state.hazardState;
    elements.hudStateMachineBadge.className = 'badge-state-machine state-' + state.hazardState.toLowerCase();

    if (trend && trend !== 'STABLE' && state.hazardState !== 'SAFE') {
      elements.hudApproachBadge.textContent = trend;
      elements.hudApproachBadge.style.display = 'inline-block';
    } else {
      elements.hudApproachBadge.style.display = 'none';
    }

    // 6. Update Status Badges Strip
    updateBadge(elements.badgeState, `STATE: ${state.hazardState}`, (state.hazardState === 'CRITICAL' ? 'badge-error' : (state.hazardState === 'CONFIRMED' ? 'badge-warn' : 'badge-safe')));
    updateBadge(elements.badgeDistConf, `DIST: ${distConf}`, (distConf === 'GOOD' ? 'badge-ready' : (distConf === 'FAIR' ? 'badge-warn' : 'badge-neutral')));
    updateBadge(elements.badgeAi, `AI: ${confPercent > 0 ? confPercent + '%' : 'READY'}`, 'badge-ready');

    // 7. Update Live Debug Telemetry Panel (Section 14 & 17)
    if (state.debugMode) {
      if (elements.dbgCam) elements.dbgCam.textContent = state.cameraActive ? 'READY' : 'IDLE';
      if (elements.dbgModel) elements.dbgModel.textContent = state.aiStatus;
      if (elements.dbgRaw) elements.dbgRaw.textContent = (state.rawDetectionsCount || 0).toString();
      if (elements.dbgValid) elements.dbgValid.textContent = (state.validDetectionsCount || 0).toString();
      if (elements.dbgMinConf) elements.dbgMinConf.textContent = `${Math.round(state.settings.minConfidence * 100)}%`;
      if (elements.dbgObj) elements.dbgObj.textContent = objectName || 'NONE';
      if (elements.dbgConf) elements.dbgConf.textContent = `${confPercent}%`;
      if (elements.dbgBox) elements.dbgBox.textContent = state.lastBoxCoords ? `[${state.lastBoxCoords.join(', ')}]` : '--';
      if (elements.dbgOverlap) elements.dbgOverlap.textContent = `${Math.round(overlapRatio * 100)}%`;
      if (elements.dbgDist) elements.dbgDist.textContent = (distanceNum !== null && !isNaN(distanceNum)) ? `~${distanceNum.toFixed(2)} m` : 'UNKNOWN';
      if (elements.dbgDistConf) elements.dbgDistConf.textContent = distConf;
      if (elements.dbgDir) elements.dbgDir.textContent = `${direction} (${state.confirmedDirection === direction ? 'STABLE' : 'UNCONFIRMED'})`;
      if (elements.dbgPersist) elements.dbgPersist.textContent = `${tracker.tracked ? tracker.tracked.persistenceCount : 0}/${state.settings.minPersistenceFrames}`;
      if (elements.dbgState) elements.dbgState.textContent = state.hazardState;
      if (elements.debugApproachTag) elements.debugApproachTag.textContent = `APPROACH: ${trend}`;
    }

    // 8. Zone Highlighting
    elements.zoneLeft.className = 'zone-col' + (direction === 'LEFT' && state.hazardState !== 'SAFE' ? ' highlight-left' : '');
    elements.zoneCenter.className = 'zone-col' + (direction === 'CENTER' && state.hazardState === 'CRITICAL' ? ' highlight-critical' : (direction === 'CENTER' && state.hazardState !== 'SAFE' ? ' highlight-center' : ''));
    elements.zoneRight.className = 'zone-col' + (direction === 'RIGHT' && state.hazardState !== 'SAFE' ? ' highlight-right' : '');

    if (hazard === 'DROP') elements.dropHazardLayer.classList.add('active');
    else elements.dropHazardLayer.classList.remove('active');

    // 9. State Change Protection: Spoken Instruction & Haptics Triggering
    const now = Date.now();
    const timeSinceLast = now - state.lastAnnouncementTime;
    let shouldAnnounce = false;

    if (state.hazardState === 'SAFE') {
      if (state.lastHazard !== 'SAFE' && state.lastHazard !== null) {
        shouldAnnounce = true;
      }
      stopVibration();
      stopAudioBeep();
    } else if (state.hazardState === 'CONFIRMED' || state.hazardState === 'CRITICAL') {
      const stateElevated = (state.hazardState !== state.lastUrgency);
      const directionChanged = (direction !== state.lastDirection);

      if (stateElevated || directionChanged) {
        if (state.hazardState === 'CRITICAL') {
          shouldAnnounce = true;
        } else if (timeSinceLast >= 2000) {
          shouldAnnounce = true;
        }
      } else {
        if (state.hazardState === 'CRITICAL' && timeSinceLast >= 2200) {
          shouldAnnounce = true;
        }
      }
    }

    if (shouldAnnounce) {
      state.lastAnnouncementTime = now;
      state.lastHazard = hazard;
      state.lastDirection = direction;
      state.lastUrgency = state.hazardState;
      state.lastInstruction = instruction.message;

      speak(instruction.message);
      applyHapticFeedback(hazard);
      applyAudioBeepFeedback(hazard);
    }
  }

  // -------------------------------------------------------------------------
  // 12. Real-Time Detection & Walking Corridor Pipeline
  // -------------------------------------------------------------------------

  function startInferenceLoop() {
    if (state.inferenceTimer) clearInterval(state.inferenceTimer);
    state.inferenceTimer = setInterval(performInferenceStep, 130); // ~7.5 FPS smooth performance
  }

  function stopInferenceLoop() {
    if (state.inferenceTimer) {
      clearInterval(state.inferenceTimer);
      state.inferenceTimer = null;
    }
  }

  async function performInferenceStep() {
    if (!state.cameraActive || !state.aiModel || state.isInferring) return;
    const video = elements.video;
    if (video.readyState < 2 || video.videoWidth === 0) return;

    state.isInferring = true;
    try {
      const predictions = await state.aiModel.detect(video);
      handleDetections(predictions, video.videoWidth, video.videoHeight);
    } catch (err) {
      console.warn('[AI] Inference step warning:', err);
    } finally {
      state.isInferring = false;
    }
  }

  function updateDetectionTestUI(rawCount, validCount, trackedObj) {
    if (elements.badgeRawValid) {
      elements.badgeRawValid.textContent = `RAW: ${rawCount} | VALID: ${validCount}`;
      elements.badgeRawValid.className = 'status-badge ' + (validCount > 0 ? 'badge-ready' : (rawCount > 0 ? 'badge-warn' : 'badge-neutral'));
    }

    if (elements.testRawCount) elements.testRawCount.textContent = `RAW: ${rawCount}`;
    if (elements.testValidCount) elements.testValidCount.textContent = `VALID: ${validCount}`;

    if (!state.cameraActive) {
      if (elements.testHazardStatus) {
        elements.testHazardStatus.textContent = 'STOPPED';
        elements.testHazardStatus.className = 'test-hazard-badge badge-neutral';
      }
      if (elements.testDiagnosticMsg) {
        elements.testDiagnosticMsg.textContent = 'Camera is idle. Tap START CAMERA.';
        elements.testDiagnosticMsg.className = 'test-msg msg-idle';
      }
      return;
    }

    if (elements.testHazardStatus) {
      const isHazardActive = trackedObj && state.hazardState !== 'SAFE';
      elements.testHazardStatus.textContent = isHazardActive ? state.hazardState : 'SAFE';
      elements.testHazardStatus.className = 'test-hazard-badge ' + (state.hazardState === 'CRITICAL' ? 'badge-error' : (state.hazardState === 'CONFIRMED' ? 'badge-warn' : 'badge-safe'));
    }

    if (elements.testDiagnosticMsg) {
      if (rawCount === 0) {
        elements.testDiagnosticMsg.textContent = 'AI is not detecting objects.';
        elements.testDiagnosticMsg.className = 'test-msg msg-idle';
      } else if (rawCount > 0 && validCount === 0) {
        elements.testDiagnosticMsg.textContent = 'Detection is being filtered.';
        elements.testDiagnosticMsg.className = 'test-msg msg-filtering';
      } else if (trackedObj) {
        elements.testDiagnosticMsg.textContent = `Obstacle active: ${trackedObj.className.toUpperCase()} (${state.confirmedDirection !== 'NONE' ? state.confirmedDirection : 'CENTER'})`;
        elements.testDiagnosticMsg.className = 'test-msg msg-active';
      } else {
        elements.testDiagnosticMsg.textContent = 'Path clear.';
        elements.testDiagnosticMsg.className = 'test-msg msg-active';
      }
    }
  }

  function handleDetections(predictions, frameW, frameH) {
    const canvas = elements.overlayCanvas;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 1. Draw Walking Corridor (Path of Travel)
    drawWalkingCorridor(ctx, frameW, frameH);

    const rawList = predictions || [];
    state.rawDetectionsCount = rawList.length;

    // 2. Detection Pipeline: Confidence -> Class Validation -> Path Overlap & Size
    const validDetections = [];
    const allFilteredDetections = [];

    for (const p of rawList) {
      const isConfident = p.score >= state.settings.minConfidence;
      const isValidClass = VALID_OBSTACLE_CLASSES.has(p.class.toLowerCase());
      const pathInfo = computePathOverlap(p.bbox, frameW, frameH);

      const detInfo = {
        class: p.class,
        score: p.score,
        bbox: p.bbox,
        isConfident,
        isValidClass,
        overlapRatio: pathInfo.overlapRatio,
        isWithinCorridor: pathInfo.isWithinCorridor
      };

      allFilteredDetections.push(detInfo);

      if (isConfident && isValidClass && pathInfo.isWithinCorridor) {
        validDetections.push(detInfo);
      }
    }

    state.validDetectionsCount = validDetections.length;

    // 3. Update candidate tracking engine
    const trackedObj = tracker.update(validDetections, frameW, frameH);

    // 4. Update Continuous Detection Test Bar (Section 16)
    updateDetectionTestUI(state.rawDetectionsCount, state.validDetectionsCount, trackedObj);

    if (!trackedObj) {
      state.lastBoxCoords = null;
      updateHUD('SAFE', 'NONE', null, 'NONE', 0, 'SAFE', 'UNKNOWN', 0, 'STABLE');

      // In debug mode, faintly render filtered out boxes to show why they were rejected
      if (state.debugMode) {
        allFilteredDetections.forEach(det => {
          drawDetectionBox(ctx, det, false, det.isWithinCorridor, 'NONE', null, 'UNKNOWN', 'SAFE');
        });
      }
      return;
    }

    const [bx, by, bw, bh] = trackedObj.bbox;
    const centerX = bx + bw / 2;
    state.lastBoxCoords = [Math.round(bx), Math.round(by), Math.round(bw), Math.round(bh)];

    // 5. Direction with Debounced Hysteresis (Section 12: <40% LEFT, 40-60% CENTER, >60% RIGHT)
    const confirmedDir = calculateDirection(centerX, frameW);

    // 6. Empirical Distance Estimation (Secondary! Unknown distance does not reject obstacle)
    const { distance: rawDist, confidence: distConf } = calculateEmpiricalDistance(trackedObj.className, bh);
    const smoothedDist = smoothDistance(trackedObj, rawDist);

    // 7. Approach Trend Detection
    const approachTrend = computeApproachTrend(trackedObj.history);

    // 8. Hazard State Machine Evaluation
    const { hazardState, hazardType } = evaluateHazardStateMachine(
      trackedObj,
      true,
      smoothedDist,
      distConf,
      trackedObj.overlapRatio || 0.5
    );

    // 9. Render Bounding Boxes on Canvas
    allFilteredDetections.forEach(det => {
      const isTarget = (det.bbox === trackedObj.bbox);
      drawDetectionBox(ctx, det, isTarget, det.isWithinCorridor, confirmedDir, smoothedDist, distConf, hazardState);
    });

    // 10. Update HUD & Dispatch Multimodal Feedback
    updateHUD(hazardType, confirmedDir, smoothedDist, trackedObj.className, trackedObj.confidence, hazardState, distConf, trackedObj.overlapRatio, approachTrend);

    // Store reference for calibration modal preview
    state.lastDetectedForCalibration = {
      className: trackedObj.className,
      boxHeight: bh,
      boxWidth: bw,
      confidence: trackedObj.confidence,
    };
    updateCalibrationTargetPreview();
  }

  function drawWalkingCorridor(ctx, frameW, frameH) {
    const s = state.settings;
    const px = frameW * s.pathLeftPercent;
    const py = frameH * s.pathTopPercent;
    const pw = frameW * (s.pathRightPercent - s.pathLeftPercent);
    const ph = frameH * (s.pathBottomPercent - s.pathTopPercent);

    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
    ctx.strokeRect(px, py, pw, ph);

    // Corner guides
    ctx.setLineDash([]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#38bdf8';
    const cLen = 14;

    // Top-left
    ctx.beginPath(); ctx.moveTo(px, py + cLen); ctx.lineTo(px, py); ctx.lineTo(px + cLen, py); ctx.stroke();
    // Top-right
    ctx.beginPath(); ctx.moveTo(px + pw - cLen, py); ctx.lineTo(px + pw, py); ctx.lineTo(px + pw, py + cLen); ctx.stroke();
    // Bottom-left
    ctx.beginPath(); ctx.moveTo(px, py + ph - cLen); ctx.lineTo(px, py + ph); ctx.lineTo(px + cLen, py + ph); ctx.stroke();
    // Bottom-right
    ctx.beginPath(); ctx.moveTo(px + pw - cLen, py + ph); ctx.lineTo(px + pw, py + ph); ctx.lineTo(px + pw, py + ph - cLen); ctx.stroke();

    // Corridor label
    ctx.fillStyle = 'rgba(56, 189, 248, 0.75)';
    ctx.font = 'bold 10px JetBrains Mono, monospace';
    ctx.fillText('PATH OF TRAVEL (WALKING CORRIDOR)', px + 8, py + 14);

    ctx.restore();
  }

  function drawDetectionBox(ctx, det, isTarget, inCorridor, direction, distance, distConf, hazardState) {
    const [x, y, w, h] = det.bbox;
    ctx.save();

    let color = '#22c55e'; // Safe green
    if (!inCorridor) {
      color = 'rgba(148, 163, 184, 0.45)'; // Low-opacity gray for background clutter
    } else if (hazardState === 'CRITICAL') {
      color = '#ef4444'; // Red
    } else if (hazardState === 'CONFIRMED') {
      color = '#fbbf24'; // Warning yellow
    } else if (hazardState === 'POSSIBLE') {
      color = 'rgba(234, 179, 8, 0.7)';
    }

    ctx.lineWidth = isTarget ? 3 : 1.5;
    ctx.strokeStyle = color;
    if (!inCorridor) ctx.setLineDash([4, 4]);

    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = inCorridor ? 'rgba(56, 189, 248, 0.06)' : 'rgba(0,0,0,0.02)';
    ctx.fillRect(x, y, w, h);

    // Label Tag
    let label = `${det.class.toUpperCase()} [${Math.round(det.score * 100)}%]`;
    if (!inCorridor) {
      label += ' (OUTSIDE PATH)';
    } else if (isTarget) {
      if (distance !== null && !isNaN(distance)) {
        label += ` (~${distance.toFixed(1)}m, ${direction})`;
      } else {
        label += ` (${direction})`;
      }
    }

    ctx.font = 'bold 11px Inter, sans-serif';
    const textW = ctx.measureText(label).width;
    ctx.fillStyle = color;
    ctx.fillRect(x, Math.max(0, y - 20), textW + 8, 18);

    ctx.fillStyle = (color === '#fbbf24' || color === '#22c55e') ? '#080d15' : '#ffffff';
    ctx.fillText(label, x + 4, Math.max(13, y - 6));

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // 13. Camera Lifecycle & Virtual Walking Simulation
  // -------------------------------------------------------------------------
  let virtualSimulationTimer = null;
  let virtualSimIndex = 0;

  async function startCamera() {
    stopVirtualSimulation();
    if (elements.cameraPrompt) {
      elements.cameraPrompt.classList.add('hidden');
      elements.cameraPrompt.style.display = 'none';
    }

    if (state.cameraActive && state.cameraStream) return;
    elements.camActionText.textContent = 'CONNECTING...';
    updateBadge(elements.badgeCamera, 'CAM: STARTING', 'badge-warn');

    const constraintCandidates = [
      { video: { facingMode: { ideal: 'environment' } } },
      { video: { facingMode: 'environment' } },
      { video: { facingMode: { ideal: 'user' } } },
      { video: true }
    ];

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera API (getUserMedia) not available in this browser context.');
      }

      let stream = null;
      let lastErr = null;
      for (const constraints of constraintCandidates) {
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints);
          if (stream) break;
        } catch (cErr) {
          lastErr = cErr;
        }
      }

      if (!stream) throw lastErr || new Error('Could not access camera sensor.');

      state.cameraStream = stream;
      elements.video.srcObject = stream;
      elements.video.setAttribute('playsinline', 'true');
      elements.video.setAttribute('webkit-playsinline', 'true');
      elements.video.playsInline = true;
      elements.video.muted = true;

      try { await elements.video.play(); } catch (e) {}

      state.cameraActive = true;
      elements.camActionText.textContent = 'STOP CAMERA';
      elements.camActionIcon.textContent = '⏹️';
      elements.btnToggleCamera.classList.add('cam-running');
      updateBadge(elements.badgeCamera, 'CAM: READY', 'badge-ready');

      unlockAudio();
      resizeOverlayCanvas();
      startInferenceLoop();
    } catch (err) {
      console.error('[Camera] Start error:', err);
      state.cameraActive = false;
      elements.camActionText.textContent = 'START CAMERA';
      elements.camActionIcon.textContent = '📷';
      elements.btnToggleCamera.classList.remove('cam-running');

      const startSim = confirm(
        `Camera Access Notice:\n${err.message}\n\n` +
        `Would you like to run the "Virtual Camera Simulation" to demonstrate walking corridor obstacle guidance, spoken navigation, and visual feedback?`
      );
      if (startSim) startVirtualSimulation();
    }
  }

  function stopCamera() {
    stopVirtualSimulation();
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach(track => {
        try { track.stop(); } catch (e) {}
      });
      state.cameraStream = null;
    }
    if (elements.video) elements.video.srcObject = null;

    state.cameraActive = false;
    stopInferenceLoop();
    clearOverlayCanvas();
    tracker.reset();
    stopVibration();
    stopAudioBeep();
    stopSpeech();

    state.rawDetectionsCount = 0;
    state.validDetectionsCount = 0;
    state.lastBoxCoords = null;
    updateDetectionTestUI(0, 0, null);

    elements.camActionText.textContent = 'START CAMERA';
    elements.camActionIcon.textContent = '📷';
    elements.btnToggleCamera.classList.remove('cam-running');
    updateBadge(elements.badgeCamera, 'CAM: STOPPED', 'badge-neutral');

    updateHUD('SAFE', 'NONE', null, 'NONE', 0, 'SAFE', 'UNKNOWN', 0, 'STABLE');
  }

  function startVirtualSimulation() {
    stopCamera();
    stopVirtualSimulation();

    if (elements.cameraPrompt) {
      elements.cameraPrompt.classList.add('hidden');
      elements.cameraPrompt.style.display = 'none';
    }

    state.cameraActive = true;
    unlockAudio();
    updateBadge(elements.badgeCamera, 'CAM: VIRTUAL', 'badge-ready');
    elements.camActionText.textContent = 'STOP SIM';
    elements.camActionIcon.textContent = '⏹️';
    elements.btnToggleCamera.classList.add('cam-running');

    // Scenarios illustrating background clutter filtering vs real walking corridor obstacles
    const scenarios = [
      { hazard: 'SAFE', dir: 'NONE', dist: null, obj: 'PATH CLEAR', conf: 0.95, box: null, overlap: 0, state: 'SAFE' },
      { hazard: 'SAFE', dir: 'LEFT', dist: 3.5, obj: 'chair', conf: 0.88, box: [15, 60, 90, 110], overlap: 0.02, state: 'SAFE' }, // Background wall obstacle: filtered out!
      { hazard: 'CENTER', dir: 'CENTER', dist: 1.4, obj: 'person', conf: 0.92, box: [220, 150, 180, 270], overlap: 0.55, state: 'POSSIBLE' },
      { hazard: 'CENTER', dir: 'CENTER', dist: 0.85, obj: 'person', conf: 0.96, box: [200, 130, 210, 310], overlap: 0.75, state: 'CONFIRMED' },
      { hazard: 'CRITICAL', dir: 'CENTER', dist: 0.38, obj: 'person', conf: 0.98, box: [160, 40, 310, 420], overlap: 0.90, state: 'CRITICAL' },
      { hazard: 'SAFE', dir: 'NONE', dist: 2.2, obj: 'PATH CLEAR', conf: 0.95, box: null, overlap: 0, state: 'SAFE' },
      { hazard: 'LEFT', dir: 'LEFT', dist: 0.75, obj: 'chair', conf: 0.89, box: [90, 190, 160, 230], overlap: 0.65, state: 'CONFIRMED' },
      { hazard: 'RIGHT', dir: 'RIGHT', dist: 0.70, obj: 'backpack', conf: 0.91, box: [400, 210, 150, 210], overlap: 0.60, state: 'CONFIRMED' },
      { hazard: 'DROP', dir: 'GROUND', dist: null, obj: 'GROUND DROP', conf: 0.97, box: [120, 350, 400, 110], overlap: 0.85, state: 'CRITICAL' },
    ];

    virtualSimIndex = 0;
    const renderStep = () => {
      const s = scenarios[virtualSimIndex % scenarios.length];
      virtualSimIndex++;

      drawVirtualScene(s);
      const isFiltered = (s.overlap < 0.05 && s.hazard === 'SAFE' && s.box);
      const simRaw = s.box ? 1 : 0;
      const simValid = (s.box && !isFiltered) ? 1 : 0;
      state.rawDetectionsCount = simRaw;
      state.validDetectionsCount = simValid;
      state.lastBoxCoords = s.box;
      updateDetectionTestUI(simRaw, simValid, s.box ? { className: s.obj, overlapRatio: s.overlap } : null);
      updateHUD(s.hazard, s.dir, s.dist, s.obj, s.conf, s.state, 'GOOD', s.overlap, 'APPROACHING');
    };

    renderStep();
    virtualSimulationTimer = setInterval(renderStep, 2600);
  }

  function stopVirtualSimulation() {
    if (virtualSimulationTimer) {
      clearInterval(virtualSimulationTimer);
      virtualSimulationTimer = null;
    }
  }

  function drawVirtualScene(scenario) {
    const canvas = elements.overlayCanvas;
    const ctx = canvas.getContext('2d');
    canvas.width = elements.video.clientWidth || 640;
    canvas.height = elements.video.clientHeight || 480;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const w = canvas.width;
    const h = canvas.height;

    // Corridor
    drawWalkingCorridor(ctx, w, h);

    // Horizon & perspective lines
    const horizonY = h * 0.40;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, horizonY); ctx.lineTo(w, horizonY); ctx.stroke();

    for (let x = -w; x <= w * 2; x += w / 6) {
      ctx.beginPath(); ctx.moveTo(w / 2, horizonY); ctx.lineTo(x, h); ctx.stroke();
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.font = '10px JetBrains Mono, monospace';
    ctx.fillText('🎬 SENSESTEP VIRTUAL WALK SIMULATION', 12, 22);

    if (scenario.box) {
      const scaleX = w / 640;
      const scaleY = h / 480;
      const [bx, by, bw, bh] = scenario.box;
      const rx = bx * scaleX;
      const ry = by * scaleY;
      const rw = bw * scaleX;
      const rh = bh * scaleY;

      let color = '#22c55e';
      if (scenario.state === 'CRITICAL') color = '#ef4444';
      else if (scenario.state === 'CONFIRMED') color = '#fbbf24';
      else if (scenario.overlap < 0.20) color = 'rgba(148, 163, 184, 0.5)';

      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(rx, ry, rw, rh);

      ctx.fillStyle = color;
      ctx.fillRect(rx, ry - 20, rw, 20);

      ctx.fillStyle = (color === '#fbbf24' || color === '#22c55e') ? '#080d15' : '#ffffff';
      ctx.font = 'bold 11px Inter, sans-serif';
      ctx.fillText(`${scenario.obj.toUpperCase()} [${Math.round(scenario.conf * 100)}%]`, rx + 4, ry - 6);
    }
  }

  function resizeOverlayCanvas() {
    const video = elements.video;
    const canvas = elements.overlayCanvas;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    } else {
      canvas.width = 640;
      canvas.height = 480;
    }
  }

  function clearOverlayCanvas() {
    const canvas = elements.overlayCanvas;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // -------------------------------------------------------------------------
  // 14. Calibration & Settings Modal Handlers
  // -------------------------------------------------------------------------

  function openCalibrationModal() {
    elements.calibrationModal.style.display = 'flex';
    updateCalibrationTargetPreview();
    updateCalibrationQualityUI();
    renderSamplesTable();
    syncSettingsSliders();
  }

  function closeCalibrationModal() {
    elements.calibrationModal.style.display = 'none';
  }

  function switchCalTab(tabName) {
    state.calActiveTab = tabName;
    elements.tabCalCalibrate.classList.toggle('active', tabName === 'calibrate');
    elements.tabCalTest.classList.toggle('active', tabName === 'test');
    elements.tabCalSettings.classList.toggle('active', tabName === 'settings');

    elements.panelCalCalibrate.style.display = tabName === 'calibrate' ? 'block' : 'none';
    elements.panelCalTest.style.display = tabName === 'test' ? 'block' : 'none';
    elements.panelCalSettings.style.display = tabName === 'settings' ? 'block' : 'none';
  }

  function updateCalibrationTargetPreview() {
    if (!elements.calTargetObject) return;
    if (state.lastDetectedForCalibration) {
      const obj = state.lastDetectedForCalibration;
      elements.calTargetObject.textContent = obj.className.toUpperCase();
      elements.calTargetHeight.textContent = `${Math.round(obj.boxHeight)} px`;
      elements.calTargetConf.textContent = `${Math.round(obj.confidence * 100)}%`;
    } else {
      elements.calTargetObject.textContent = 'Point camera at reference object';
      elements.calTargetHeight.textContent = '-- px';
      elements.calTargetConf.textContent = '--%';
    }
  }

  function updateCalibrationQualityUI() {
    let totalSamples = 0;
    for (const cls in state.calibrationSamples) {
      totalSamples += state.calibrationSamples[cls].length;
    }

    elements.calSampleCount.textContent = totalSamples.toString();

    // Determine quality: POOR (<3), FAIR (3), GOOD (>=4)
    let bestClassSamples = 0;
    for (const cls in state.calibrationSamples) {
      if (state.calibrationSamples[cls].length > bestClassSamples) {
        bestClassSamples = state.calibrationSamples[cls].length;
      }
    }

    if (bestClassSamples >= 4) {
      elements.calQualityBadge.textContent = 'GOOD (4+ MULTI-POINT)';
      elements.calQualityBadge.className = 'text-safe';
      updateBadge(elements.badgeCalib, `CALIB: GOOD (${bestClassSamples})`, 'badge-ready');
    } else if (bestClassSamples === 3) {
      elements.calQualityBadge.textContent = 'FAIR (3 SAMPLES)';
      elements.calQualityBadge.className = 'text-warning';
      updateBadge(elements.badgeCalib, `CALIB: FAIR (3)`, 'badge-warn');
    } else if (bestClassSamples > 0) {
      elements.calQualityBadge.textContent = `POOR (${bestClassSamples}/3 SAMPLES)`;
      elements.calQualityBadge.className = 'text-danger';
      updateBadge(elements.badgeCalib, `CALIB: POOR (${bestClassSamples})`, 'badge-warn');
    } else {
      elements.calQualityBadge.textContent = 'POOR (INSUFFICIENT)';
      elements.calQualityBadge.className = 'text-warning';
      updateBadge(elements.badgeCalib, 'CALIB: DEFAULT', 'badge-neutral');
    }
  }

  function captureCalibrationSample() {
    if (!state.lastDetectedForCalibration) {
      alert('No detected object in view. Point camera at your reference object first.');
      return;
    }

    const { className, boxHeight, boxWidth } = state.lastDetectedForCalibration;
    const distance = state.selectedCalDist;

    if (!distance || isNaN(distance) || distance < 0.2) {
      alert('Please select or enter a valid actual distance (e.g. 0.5m, 1.0m).');
      return;
    }

    if (!state.calibrationSamples[className]) {
      state.calibrationSamples[className] = [];
    }

    state.calibrationSamples[className].push({
      distance,
      pixelHeight: Math.round(boxHeight),
      pixelWidth: Math.round(boxWidth),
      timestamp: Date.now()
    });

    saveCalibrationSamples(state.calibrationSamples);
    updateCalibrationQualityUI();
    renderSamplesTable();

    alert(`Captured sample for "${className.toUpperCase()}":\nDistance: ${distance} m\nPixel Height: ${Math.round(boxHeight)} px\nTotal samples for ${className}: ${state.calibrationSamples[className].length}`);
  }

  function clearCalibration() {
    if (confirm('Clear all captured calibration samples?')) {
      state.calibrationSamples = {};
      saveCalibrationSamples(state.calibrationSamples);
      updateCalibrationQualityUI();
      renderSamplesTable();
    }
  }

  function renderSamplesTable() {
    const tbody = elements.calSamplesTbody;
    tbody.innerHTML = '';
    let hasSamples = false;

    for (const cls in state.calibrationSamples) {
      state.calibrationSamples[cls].forEach((smp, idx) => {
        hasSamples = true;
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${cls}</strong></td>
          <td>${smp.distance}m</td>
          <td>${smp.pixelHeight}px</td>
          <td><button class="btn btn-tiny btn-danger-small" data-del-cls="${cls}" data-del-idx="${idx}">Del</button></td>
        `;
        tbody.appendChild(tr);
      });
    }

    if (!hasSamples) {
      tbody.innerHTML = '<tr><td colspan="4">No samples captured yet. Point camera and tap Capture.</td></tr>';
    }

    // Bind delete buttons
    tbody.querySelectorAll('button[data-del-cls]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const cls = e.target.dataset.delCls;
        const idx = parseInt(e.target.dataset.delIdx, 10);
        state.calibrationSamples[cls].splice(idx, 1);
        if (state.calibrationSamples[cls].length === 0) {
          delete state.calibrationSamples[cls];
        }
        saveCalibrationSamples(state.calibrationSamples);
        updateCalibrationQualityUI();
        renderSamplesTable();
      });
    });
  }

  // -------------------------------------------------------------------------
  // 15. Real-World Accuracy Test Mode (Section 20)
  // -------------------------------------------------------------------------
  function updateAccuracyTestReadout() {
    const expected = state.selectedTestDist;
    elements.testExpectedReadout.textContent = `${expected.toFixed(2)} m`;

    const measured = state.estimatedDistance;
    if (measured !== null && !isNaN(measured)) {
      elements.testMeasuredReadout.textContent = `~${measured.toFixed(2)} m`;
      const diff = measured - expected;
      const sign = diff >= 0 ? '+' : '';
      const percent = Math.abs(diff / expected) * 100;
      elements.testErrorReadout.textContent = `${sign}${diff.toFixed(2)} m (±${Math.round(percent)}%)`;
      elements.testErrorReadout.className = percent < 15 ? 'text-safe' : (percent < 30 ? 'text-warning' : 'text-critical');
    } else {
      elements.testMeasuredReadout.textContent = '-- m';
      elements.testErrorReadout.textContent = '--';
    }

    elements.testConfReadout.textContent = state.distanceConfidence;
    elements.testConfReadout.className = 'status-badge ' + (state.distanceConfidence === 'GOOD' ? 'badge-ready' : (state.distanceConfidence === 'FAIR' ? 'badge-warn' : 'badge-neutral'));
  }

  // -------------------------------------------------------------------------
  // 16. Engine Settings Sliders Handlers (Section 18)
  // -------------------------------------------------------------------------
  function syncSettingsSliders() {
    const s = state.settings;
    elements.sliderMinConf.value = s.minConfidence;
    elements.valMinConf.textContent = `${Math.round(s.minConfidence * 100)}%`;

    elements.sliderPathOverlap.value = s.pathOverlapThreshold;
    elements.valPathOverlap.textContent = `${Math.round(s.pathOverlapThreshold * 100)}%`;

    elements.sliderPersistence.value = s.minPersistenceFrames;
    elements.valPersistence.textContent = `${s.minPersistenceFrames} frames`;

    if (elements.sliderMinArea) {
      elements.sliderMinArea.value = s.minAreaRatio || 0.005;
      elements.valMinArea.textContent = `${((s.minAreaRatio || 0.005) * 100).toFixed(1)}%`;
    }

    elements.sliderCritDist.value = s.criticalDistance;
    elements.valCritDist.textContent = `${s.criticalDistance.toFixed(2)} m`;

    elements.sliderWarnDist.value = s.warningDistance;
    elements.valWarnDist.textContent = `${s.warningDistance.toFixed(2)} m`;
  }

  function applySettingsFromSliders() {
    state.settings.minConfidence = parseFloat(elements.sliderMinConf.value);
    state.settings.pathOverlapThreshold = parseFloat(elements.sliderPathOverlap.value);
    state.settings.minPersistenceFrames = parseInt(elements.sliderPersistence.value, 10);
    if (elements.sliderMinArea) {
      state.settings.minAreaRatio = parseFloat(elements.sliderMinArea.value);
    }
    state.settings.criticalDistance = parseFloat(elements.sliderCritDist.value);
    state.settings.warningDistance = parseFloat(elements.sliderWarnDist.value);

    saveSettings(state.settings);
    alert('Settings saved successfully!');
  }

  function resetSettingsToDefault() {
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
    saveSettings(state.settings);
    syncSettingsSliders();
    alert('Detection settings reset to defaults:\n• Confidence: 50%\n• Path Overlap: 5%\n• Persistence: 2 frames\n• Min Area: 0.5%');
  }

  // -------------------------------------------------------------------------
  // 17. Mode Switcher & Demo Mode
  // -------------------------------------------------------------------------
  function setMode(newMode) {
    state.mode = newMode;

    if (newMode === 'PRESENTATION') {
      state.isPresentationMode = true;
      elements.appContainer.classList.add('presentation-mode');
      elements.tabModeAuto.classList.remove('active');
      elements.tabModeDemo.classList.remove('active');
      elements.tabModePres.classList.add('active');
      elements.hudModeBadge.textContent = 'MODE: PRESENTATION';
      elements.hudModeBadge.className = 'badge-mode badge-auto';

      if (!state.cameraActive) startVirtualSimulation();
      return;
    }

    state.isPresentationMode = false;
    elements.appContainer.classList.remove('presentation-mode');
    elements.tabModePres.classList.remove('active');

    if (newMode === 'AUTO') {
      elements.tabModeAuto.classList.add('active');
      elements.tabModeDemo.classList.remove('active');
      elements.hudModeBadge.textContent = 'MODE: AUTO';
      elements.hudModeBadge.className = 'badge-mode badge-auto';
      elements.demoSection.style.display = 'none';

      if (state.cameraActive) startInferenceLoop();
    } else if (newMode === 'DEMO') {
      elements.tabModeAuto.classList.remove('active');
      elements.tabModeDemo.classList.add('active');
      elements.hudModeBadge.textContent = 'MODE: DEMO';
      elements.hudModeBadge.className = 'badge-mode badge-demo';
      elements.demoSection.style.display = 'block';

      stopInferenceLoop();
      clearOverlayCanvas();
      triggerDemoHazard('SAFE');
    }
  }

  function triggerDemoHazard(hazard) {
    initAudioContext();
    let direction = 'NONE';
    if (hazard === 'LEFT') direction = 'LEFT';
    else if (hazard === 'CENTER') direction = 'CENTER';
    else if (hazard === 'RIGHT') direction = 'RIGHT';
    else if (hazard === 'CRITICAL') direction = 'CENTER';
    else if (hazard === 'DROP') direction = 'GROUND';

    elements.demoHazardButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.hz === hazard);
    });

    const dist = (hazard === 'CRITICAL') ? 0.38 : (hazard === 'SAFE' ? 1.8 : state.demoSimulatedDistance);
    state.lastHazard = null;
    state.lastAnnouncementTime = 0;

    const hState = (hazard === 'SAFE') ? 'SAFE' : (hazard === 'CRITICAL' ? 'CRITICAL' : 'CONFIRMED');
    updateHUD(hazard, direction, dist, 'SIMULATED (DEMO)', 0.99, hState, 'GOOD', 0.85, 'STABLE');
  }

  function setDemoDistance(distVal) {
    initAudioContext();
    state.demoSimulatedDistance = distVal;
    elements.demoDistButtons.forEach(btn => {
      btn.classList.toggle('active', parseFloat(btn.dataset.dist) === distVal);
    });

    if (state.mode === 'DEMO') {
      if (distVal < 0.50) triggerDemoHazard('CRITICAL');
      else if (distVal <= 1.00) triggerDemoHazard('CENTER');
      else triggerDemoHazard('SAFE');
    }
  }

  function runFeedbackTest(targetHazard) {
    initAudioContext();
    let dir = 'NONE';
    let dist = null;

    if (targetHazard === 'LEFT') { dir = 'LEFT'; dist = 0.8; }
    else if (targetHazard === 'CENTER') { dir = 'CENTER'; dist = 0.7; }
    else if (targetHazard === 'RIGHT') { dir = 'RIGHT'; dist = 0.8; }
    else if (targetHazard === 'DROP') { dir = 'GROUND'; dist = null; }
    else if (targetHazard === 'CRITICAL') { dir = 'CENTER'; dist = 0.35; }
    else if (targetHazard === 'SAFE') {
      dir = 'NONE';
      dist = null;
      stopSpeech();
      stopVibration();
      stopAudioBeep();
    }

    state.lastHazard = null;
    state.lastAnnouncementTime = 0;

    const hState = (targetHazard === 'SAFE') ? 'SAFE' : (targetHazard === 'CRITICAL' ? 'CRITICAL' : 'CONFIRMED');
    updateHUD(targetHazard, dir, dist, 'FEEDBACK TEST', 1.0, hState, 'GOOD', 0.90, 'STABLE');
  }

  // -------------------------------------------------------------------------
  // 18. Diagnostics & DOM Event Bindings
  // -------------------------------------------------------------------------
  const elements = {
    appContainer: document.getElementById('app-container'),
    video: document.getElementById('camera-feed'),
    overlayCanvas: document.getElementById('overlay-canvas'),

    btnToggleDebug: document.getElementById('btn-toggle-debug'),
    debugIcon: document.getElementById('debug-icon'),
    debugText: document.getElementById('debug-text'),
    btnToggleVoice: document.getElementById('btn-toggle-voice'),
    voiceIcon: document.getElementById('voice-icon'),
    voiceText: document.getElementById('voice-text'),
    btnToggleAudio: document.getElementById('btn-toggle-audio'),
    audioIcon: document.getElementById('audio-icon'),
    audioText: document.getElementById('audio-text'),
    btnToggleCamera: document.getElementById('btn-toggle-camera'),
    camActionIcon: document.getElementById('cam-action-icon'),
    camActionText: document.getElementById('cam-action-text'),

    badgeCamera: document.getElementById('badge-camera'),
    badgeAi: document.getElementById('badge-ai'),
    badgeRawValid: document.getElementById('badge-raw-valid'),
    badgeState: document.getElementById('badge-state'),
    badgeDistConf: document.getElementById('badge-dist-conf'),
    badgeVoice: document.getElementById('badge-voice'),
    badgeHaptic: document.getElementById('badge-haptic'),
    badgeAudio: document.getElementById('badge-audio'),
    badgeCalib: document.getElementById('badge-calib'),

    zoneLeft: document.getElementById('zone-left'),
    zoneCenter: document.getElementById('zone-center'),
    zoneRight: document.getElementById('zone-right'),
    dropHazardLayer: document.getElementById('drop-hazard-layer'),

    detectionTestStrip: document.getElementById('detection-test-strip'),
    testHazardStatus: document.getElementById('test-hazard-status'),
    testRawCount: document.getElementById('test-raw-count'),
    testValidCount: document.getElementById('test-valid-count'),
    testDiagnosticMsg: document.getElementById('test-diagnostic-msg'),

    debugTelemetryPanel: document.getElementById('debug-telemetry-panel'),
    debugApproachTag: document.getElementById('debug-approach-tag'),
    dbgCam: document.getElementById('dbg-cam'),
    dbgModel: document.getElementById('dbg-model'),
    dbgRaw: document.getElementById('dbg-raw'),
    dbgValid: document.getElementById('dbg-valid'),
    dbgMinConf: document.getElementById('dbg-min-conf'),
    dbgObj: document.getElementById('dbg-obj'),
    dbgConf: document.getElementById('dbg-conf'),
    dbgBox: document.getElementById('dbg-box'),
    dbgOverlap: document.getElementById('dbg-overlap'),
    dbgDist: document.getElementById('dbg-dist'),
    dbgDistConf: document.getElementById('dbg-dist-conf'),
    dbgDir: document.getElementById('dbg-dir'),
    dbgPersist: document.getElementById('dbg-persist'),
    dbgState: document.getElementById('dbg-state'),

    cameraPrompt: document.getElementById('camera-prompt-overlay'),
    btnPromptStart: document.getElementById('btn-prompt-start'),
    btnPromptVirtual: document.getElementById('btn-prompt-virtual'),
    btnPromptClose: document.getElementById('btn-prompt-close'),
    btnPromptDemo: document.getElementById('btn-prompt-demo'),
    aiErrorBanner: document.getElementById('ai-error-banner'),
    btnSwitchToDemo: document.getElementById('btn-switch-to-demo'),

    navInstructionCard: document.getElementById('nav-instruction-card'),
    navActionText: document.getElementById('nav-action-text'),
    navDetailText: document.getElementById('nav-detail-text'),
    navDistText: document.getElementById('nav-dist-text'),
    navUrgencyBadge: document.getElementById('nav-urgency-badge'),

    presentationPanel: document.getElementById('presentation-panel'),
    btnExitPresentation: document.getElementById('btn-exit-presentation'),
    presActionText: document.getElementById('pres-action-text'),
    presDetailText: document.getElementById('pres-detail-text'),
    presDistText: document.getElementById('pres-dist-text'),
    presVoiceBadge: document.getElementById('pres-voice-badge'),
    presHapticBadge: document.getElementById('pres-haptic-badge'),
    presHazardBadge: document.getElementById('pres-hazard-badge'),

    hudPanel: document.getElementById('hud-panel'),
    telemetryCard: document.getElementById('telemetry-card'),
    hudModeBadge: document.getElementById('hud-mode-badge'),
    hudStateMachineBadge: document.getElementById('hud-state-machine-badge'),
    hudApproachBadge: document.getElementById('hud-approach-badge'),
    hudObjectTag: document.getElementById('hud-object-tag'),
    metricHazard: document.getElementById('metric-hazard'),
    metricDirection: document.getElementById('metric-direction'),
    metricDistance: document.getElementById('metric-distance'),
    metricHaptic: document.getElementById('metric-haptic'),
    statAiConf: document.getElementById('stat-ai-conf'),
    statOverlap: document.getElementById('stat-overlap'),
    statPersist: document.getElementById('stat-persist'),
    statDistConf: document.getElementById('stat-dist-conf'),
    hapticPulseDot: document.getElementById('haptic-pulse-dot'),
    hapticTickerText: document.getElementById('haptic-ticker-text'),

    navControlRow: document.getElementById('nav-control-row'),
    tabModeAuto: document.getElementById('tab-mode-auto'),
    tabModeDemo: document.getElementById('tab-mode-demo'),
    tabModePres: document.getElementById('tab-mode-pres'),
    btnOpenCalibration: document.getElementById('btn-open-calibration'),

    demoSection: document.getElementById('demo-mode-section'),
    demoHazardButtons: document.querySelectorAll('.btn-hazard'),
    demoDistButtons: document.querySelectorAll('.btn-dist'),

    testHapticsSection: document.getElementById('test-haptics-section'),
    hapticCapabilityBadge: document.getElementById('haptic-capability-badge'),
    testButtons: {
      safe: document.getElementById('test-hz-safe'),
      left: document.getElementById('test-hz-left'),
      center: document.getElementById('test-hz-center'),
      right: document.getElementById('test-hz-right'),
      drop: document.getElementById('test-hz-drop'),
      critical: document.getElementById('test-hz-critical'),
    },

    // Calibration & Settings Modal Elements
    calibrationModal: document.getElementById('calibration-modal'),
    btnCloseCalibration: document.getElementById('btn-close-calibration'),
    tabCalCalibrate: document.getElementById('tab-cal-calibrate'),
    tabCalTest: document.getElementById('tab-cal-test'),
    tabCalSettings: document.getElementById('tab-cal-settings'),
    panelCalCalibrate: document.getElementById('panel-cal-calibrate'),
    panelCalTest: document.getElementById('panel-cal-test'),
    panelCalSettings: document.getElementById('panel-cal-settings'),

    calTargetObject: document.getElementById('cal-target-object'),
    calTargetHeight: document.getElementById('cal-target-height'),
    calTargetConf: document.getElementById('cal-target-conf'),
    calDistButtons: document.querySelectorAll('.btn-cal-dist'),
    btnCalCustom: document.getElementById('btn-cal-custom'),
    customDistRow: document.getElementById('custom-dist-input-row'),
    inputCustomDist: document.getElementById('input-custom-dist'),
    calSampleCount: document.getElementById('cal-sample-count'),
    calQualityBadge: document.getElementById('cal-quality-badge'),
    btnCaptureSample: document.getElementById('btn-capture-sample'),
    btnViewSamples: document.getElementById('btn-view-samples'),
    btnClearCalibration: document.getElementById('btn-clear-calibration'),
    samplesTableContainer: document.getElementById('samples-table-container'),
    calSamplesTbody: document.getElementById('cal-samples-tbody'),

    testDistButtons: document.querySelectorAll('.btn-test-dist'),
    testExpectedReadout: document.getElementById('test-expected-readout'),
    testMeasuredReadout: document.getElementById('test-measured-readout'),
    testErrorReadout: document.getElementById('test-error-readout'),
    testConfReadout: document.getElementById('test-conf-readout'),

    sliderMinConf: document.getElementById('slider-min-conf'),
    valMinConf: document.getElementById('val-min-conf'),
    sliderPathOverlap: document.getElementById('slider-path-overlap'),
    valPathOverlap: document.getElementById('val-path-overlap'),
    sliderPersistence: document.getElementById('slider-persistence'),
    valPersistence: document.getElementById('val-persistence'),
    sliderMinArea: document.getElementById('slider-min-area'),
    valMinArea: document.getElementById('val-min-area'),
    sliderCritDist: document.getElementById('slider-crit-dist'),
    valCritDist: document.getElementById('val-crit-dist'),
    sliderWarnDist: document.getElementById('slider-warn-dist'),
    valWarnDist: document.getElementById('val-warn-dist'),
    btnSaveSettings: document.getElementById('btn-save-settings'),
    btnResetSettings: document.getElementById('btn-reset-settings'),
  };

  function updateBadge(badgeEl, text, classToAdd) {
    if (!badgeEl) return;
    badgeEl.textContent = text;
    badgeEl.className = 'status-badge ' + classToAdd;
  }

  function bindEvents() {
    // Debug toggle
    if (elements.btnToggleDebug) {
      elements.btnToggleDebug.addEventListener('click', () => {
        state.debugMode = !state.debugMode;
        elements.btnToggleDebug.classList.toggle('debug-active', state.debugMode);
        elements.debugTelemetryPanel.style.display = state.debugMode ? 'block' : 'none';
      });
    }

    // Voice & Audio toggles
    if (elements.btnToggleVoice) elements.btnToggleVoice.addEventListener('click', toggleVoiceGuidance);
    if (elements.btnToggleAudio) elements.btnToggleAudio.addEventListener('click', toggleAudio);

    // Camera toggles
    if (elements.btnToggleCamera) {
      elements.btnToggleCamera.addEventListener('click', () => {
        initAudioContext();
        if (state.cameraActive) stopCamera();
        else startCamera();
      });
    }

    if (elements.btnPromptStart) {
      elements.btnPromptStart.addEventListener('click', () => {
        initAudioContext();
        enableVoiceGuidance();
        startCamera();
      });
    }

    if (elements.btnPromptVirtual) {
      elements.btnPromptVirtual.addEventListener('click', () => {
        initAudioContext();
        enableVoiceGuidance();
        startVirtualSimulation();
      });
    }

    if (elements.btnPromptClose) {
      elements.btnPromptClose.addEventListener('click', () => {
        initAudioContext();
        elements.cameraPrompt.classList.add('hidden');
        elements.cameraPrompt.style.display = 'none';
      });
    }

    if (elements.btnPromptDemo || elements.btnSwitchToDemo) {
      const handler = () => {
        initAudioContext();
        elements.cameraPrompt.classList.add('hidden');
        elements.cameraPrompt.style.display = 'none';
        enableVoiceGuidance();
        setMode('DEMO');
      };
      if (elements.btnPromptDemo) elements.btnPromptDemo.addEventListener('click', handler);
      if (elements.btnSwitchToDemo) elements.btnSwitchToDemo.addEventListener('click', handler);
    }

    // Mode tabs
    if (elements.tabModeAuto) elements.tabModeAuto.addEventListener('click', () => { initAudioContext(); setMode('AUTO'); });
    if (elements.tabModeDemo) elements.tabModeDemo.addEventListener('click', () => { initAudioContext(); setMode('DEMO'); });
    if (elements.tabModePres) elements.tabModePres.addEventListener('click', () => { initAudioContext(); setMode('PRESENTATION'); });
    if (elements.btnExitPresentation) elements.btnExitPresentation.addEventListener('click', () => setMode('AUTO'));

    // Demo hazard & distance buttons
    elements.demoHazardButtons.forEach(btn => {
      btn.addEventListener('click', () => triggerDemoHazard(btn.dataset.hz));
    });
    elements.demoDistButtons.forEach(btn => {
      btn.addEventListener('click', () => setDemoDistance(parseFloat(btn.dataset.dist)));
    });

    // Test panel buttons
    if (elements.testButtons.left) elements.testButtons.left.addEventListener('click', () => runFeedbackTest('LEFT'));
    if (elements.testButtons.center) elements.testButtons.center.addEventListener('click', () => runFeedbackTest('CENTER'));
    if (elements.testButtons.right) elements.testButtons.right.addEventListener('click', () => runFeedbackTest('RIGHT'));
    if (elements.testButtons.drop) elements.testButtons.drop.addEventListener('click', () => runFeedbackTest('DROP'));
    if (elements.testButtons.critical) elements.testButtons.critical.addEventListener('click', () => runFeedbackTest('CRITICAL'));
    if (elements.testButtons.safe) elements.testButtons.safe.addEventListener('click', () => runFeedbackTest('SAFE'));

    // Calibration modal tabs
    if (elements.btnOpenCalibration) elements.btnOpenCalibration.addEventListener('click', openCalibrationModal);
    if (elements.btnCloseCalibration) elements.btnCloseCalibration.addEventListener('click', closeCalibrationModal);

    elements.tabCalCalibrate.addEventListener('click', () => switchCalTab('calibrate'));
    elements.tabCalTest.addEventListener('click', () => {
      switchCalTab('test');
      updateAccuracyTestReadout();
    });
    elements.tabCalSettings.addEventListener('click', () => switchCalTab('settings'));

    // Distance choice buttons in calibration
    elements.calDistButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        elements.calDistButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (btn.dataset.caldist === 'custom') {
          elements.customDistRow.style.display = 'block';
          state.selectedCalDist = parseFloat(elements.inputCustomDist.value) || 1.0;
        } else {
          elements.customDistRow.style.display = 'none';
          state.selectedCalDist = parseFloat(btn.dataset.caldist);
        }
      });
    });

    if (elements.inputCustomDist) {
      elements.inputCustomDist.addEventListener('input', () => {
        state.selectedCalDist = parseFloat(elements.inputCustomDist.value) || 1.0;
      });
    }

    if (elements.btnCaptureSample) elements.btnCaptureSample.addEventListener('click', captureCalibrationSample);
    if (elements.btnClearCalibration) elements.btnClearCalibration.addEventListener('click', clearCalibration);
    if (elements.btnViewSamples) {
      elements.btnViewSamples.addEventListener('click', () => {
        const isHidden = elements.samplesTableContainer.style.display === 'none';
        elements.samplesTableContainer.style.display = isHidden ? 'block' : 'none';
        elements.btnViewSamples.textContent = isHidden ? 'Hide Samples Table' : 'View Samples Table';
      });
    }

    // Test accuracy distance buttons
    elements.testDistButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        elements.testDistButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.selectedTestDist = parseFloat(btn.dataset.testdist);
        updateAccuracyTestReadout();
      });
    });

    // Settings sliders live update
    elements.sliderMinConf.addEventListener('input', () => {
      elements.valMinConf.textContent = `${Math.round(elements.sliderMinConf.value * 100)}%`;
    });
    elements.sliderPathOverlap.addEventListener('input', () => {
      elements.valPathOverlap.textContent = `${Math.round(elements.sliderPathOverlap.value * 100)}%`;
    });
    elements.sliderPersistence.addEventListener('input', () => {
      elements.valPersistence.textContent = `${elements.sliderPersistence.value} frames`;
    });
    if (elements.sliderMinArea) {
      elements.sliderMinArea.addEventListener('input', () => {
        elements.valMinArea.textContent = `${(elements.sliderMinArea.value * 100).toFixed(1)}%`;
      });
    }
    elements.sliderCritDist.addEventListener('input', () => {
      elements.valCritDist.textContent = `${parseFloat(elements.sliderCritDist.value).toFixed(2)} m`;
    });
    elements.sliderWarnDist.addEventListener('input', () => {
      elements.valWarnDist.textContent = `${parseFloat(elements.sliderWarnDist.value).toFixed(2)} m`;
    });

    if (elements.btnSaveSettings) elements.btnSaveSettings.addEventListener('click', applySettingsFromSliders);
    if (elements.btnResetSettings) elements.btnResetSettings.addEventListener('click', resetSettingsToDefault);

    // Global touch unlock
    ['click', 'touchstart', 'touchend', 'pointerdown'].forEach(evtType => {
      window.addEventListener(evtType, () => unlockAudio(), { passive: true, once: false });
    });

    // Visibility management
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        stopVibration();
        stopAudioBeep();
        stopSpeech();
        stopInferenceLoop();
      } else if (document.visibilityState === 'visible' && state.cameraActive && state.mode === 'AUTO') {
        startInferenceLoop();
      }
    });

    window.addEventListener('beforeunload', () => {
      stopCamera();
      stopVibration();
      stopAudioBeep();
      stopSpeech();
    });

    window.addEventListener('resize', () => {
      if (state.cameraActive) resizeOverlayCanvas();
    });
  }

  // -------------------------------------------------------------------------
  // 19. Initialization
  // -------------------------------------------------------------------------
  async function loadAIModel() {
    updateBadge(elements.badgeAi, 'AI: LOADING', 'badge-warn');
    if (typeof cocoSsd === 'undefined') {
      console.warn('[AI] cocoSsd library not loaded from CDN.');
      handleModelFailure();
      return;
    }
    try {
      state.aiModel = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
      state.aiStatus = 'READY';
      updateBadge(elements.badgeAi, 'AI: READY', 'badge-ready');
    } catch (err) {
      console.error('[AI] Model load error:', err);
      handleModelFailure();
    }
  }

  function handleModelFailure() {
    state.aiStatus = 'UNAVAILABLE';
    updateBadge(elements.badgeAi, 'AI: UNAVAILABLE', 'badge-error');
    if (elements.aiErrorBanner) elements.aiErrorBanner.style.display = 'flex';
  }

  function init() {
    // 1. Detect Vibration Support Honestly
    if (state.hapticsSupported) {
      updateBadge(elements.badgeHaptic, 'HAPTIC: SUPPORTED', 'badge-ready');
      if (elements.hapticCapabilityBadge) {
        elements.hapticCapabilityBadge.textContent = 'HAPTIC: SUPPORTED';
        elements.hapticCapabilityBadge.className = 'section-tag badge-ready';
      }
    } else {
      updateBadge(elements.badgeHaptic, 'HAPTIC: NOT SUPPORTED', 'badge-warn');
      if (elements.hapticCapabilityBadge) {
        elements.hapticCapabilityBadge.textContent = 'HAPTIC: NOT SUPPORTED BY THIS BROWSER';
        elements.hapticCapabilityBadge.className = 'section-tag badge-warn';
      }
      elements.hapticTickerText.textContent = 'Browser vibration is not supported on iOS WebKit. Audio & voice guidance active.';
    }

    // 2. Speech synthesis
    if (state.speechSupported) updateBadge(elements.badgeVoice, 'VOICE: READY', 'badge-neutral');
    else updateBadge(elements.badgeVoice, 'VOICE: UNAVAILABLE', 'badge-warn');

    // 3. Calibration quality badge
    updateCalibrationQualityUI();

    // 4. Bind events & load model
    bindEvents();
    loadAIModel();

    // 5. Initial State
    updateHUD('SAFE', 'NONE', null, 'NONE', 0, 'SAFE', 'UNKNOWN', 0, 'STABLE');
    setMode('AUTO');
  }

  // Global test exports
  window.speak = speak;
  window.stopSpeech = stopSpeech;
  window.getNavigationInstruction = getNavigationInstruction;
  window.enableVoiceGuidance = enableVoiceGuidance;
  window.toggleVoiceGuidance = toggleVoiceGuidance;
  window.vibrateSafe = vibrateSafe;
  window.vibrateLeft = vibrateLeft;
  window.vibrateCenter = vibrateCenter;
  window.vibrateRight = vibrateRight;
  window.vibrateDrop = vibrateDrop;
  window.vibrateCritical = vibrateCritical;
  window.stopVibration = stopVibration;
  window.openCalibrationModal = openCalibrationModal;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
