import {
    FusionAlgorithm,
    FusionDebugState,
    MIN_CALIBRATION_SPEED,
    MIN_SENSOR_ACCEL,
    SENSOR_SYNC_SLOP,
    Vector3,
} from '../../types';
import { normalizeGear } from '../../gearUtils';

/*
 * ──────────────────────────────────────────────────────────────────────────────
 * Algorithm 6: EKF Rewind-Replay (V6)
 *
 * An Extended Kalman Filter with Out-of-Sequence Measurement (OOSM) handling
 * via a circular buffer / rewind-replay strategy.
 *
 * State vector:  x = [ velocity (m/s),  accel_bias (m/s²) ]
 * Covariance:    P  (2×2)
 *
 * Prediction:    On each accelerometer sample, integrate velocity with bias-
 *                corrected acceleration and propagate covariance.
 *
 * Correction:    When a delayed BLE speed packet arrives, the filter rewinds
 *                to the packet's capture time via the circular buffer, applies
 *                the Kalman measurement update, then replays all subsequent
 *                buffered IMU samples forward to the present.
 *
 * ZUPT:          Zero-Velocity Update — detects stationary via acceleration
 *                variance over a sliding window and injects a zero-velocity
 *                measurement to prevent drift.
 * ──────────────────────────────────────────────────────────────────────────────
 */

// ─── 2×2 matrix helpers (row-major [a,b,c,d]) ──────────────────────────────

type Mat2 = [number, number, number, number];

function mat2Mul(a: Mat2, b: Mat2): Mat2 {
    return [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
    ];
}

function mat2Add(a: Mat2, b: Mat2): Mat2 {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
}

function mat2Transpose(m: Mat2): Mat2 {
    return [m[0], m[2], m[1], m[3]];
}

// ─── Buffer entry ───────────────────────────────────────────────────────────

interface BufferEntry {
    timestamp: number;
    /** State BEFORE this prediction step */
    x: [number, number]; // [velocity, bias]
    P: Mat2;
    /** Acceleration sample that drove this prediction */
    accel: Vector3;
    /** dt used for this prediction step (seconds) */
    dt: number;
}

// ─── Algorithm ──────────────────────────────────────────────────────────────

export class EkfRewindReplayAlgorithm implements FusionAlgorithm {
    public name = 'EKF Rewind-Replay (V6)';
    private params: any = {};

    // ── EKF state ───────────────────────────────────────────────────────────
    private x: [number, number] = [0, 0]; // [velocity, bias]
    private P: Mat2 = [1, 0, 0, 1];       // initial uncertainty

    // ── Calibration (shared approach with other strategies) ──────────────
    private forwardVector: Vector3 | null = null;
    private speedConversionFactor = 0.44704;
    private isCalibrated = false;
    private directionSign = 1;

    // ── Buffers ─────────────────────────────────────────────────────────────
    private buffer: BufferEntry[] = [];
    private lastMotionTimestamp: number | null = null;
    private lastBleSpeedRaw = 0;

    // Calibration helpers (BLE speed history for forward-vector estimation)
    private bleSpeedHistory: { speed: number; time: number }[] = [];
    private recentAccels: { vec: Vector3; time: number }[] = [];

    // ── ZUPT state ──────────────────────────────────────────────────────────
    private zuptActive = false;
    private recentAccelMagnitudes: { mag: number; time: number }[] = [];

    // ── Misc ────────────────────────────────────────────────────────────────
    private lastEffectiveAccel = 0;

    // ── Tuning getters ──────────────────────────────────────────────────────

    private get processNoiseAccel(): number {
        return this.params.processNoiseAccel ?? 0.5;
    }
    private get processNoiseBias(): number {
        return this.params.processNoiseBias ?? 0.001;
    }
    private get measurementNoise(): number {
        return this.params.measurementNoise ?? 1.0;
    }
    private get zuptVarianceThreshold(): number {
        return this.params.zuptVarianceThreshold ?? 0.05;
    }
    private get zuptWindowMs(): number {
        return this.params.zuptWindowMs ?? 1000;
    }
    private get bufferDurationMs(): number {
        return this.params.bufferDurationMs ?? 5000;
    }
    private get accelOffset(): number {
        return Math.max(0, Math.min(0.10, this.params.accelOffset ?? 0.02));
    }
    private get highPassThreshold(): number {
        return Math.max(0, Math.min(0.10, this.params.highPassThreshold ?? 0.05));
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  FusionAlgorithm interface
    // ═══════════════════════════════════════════════════════════════════════

    reset() {
        this.x = [0, 0];
        this.P = [1, 0, 0, 1];
        this.forwardVector = null;
        this.speedConversionFactor = 0.44704;
        this.isCalibrated = false;
        this.directionSign = 1;
        this.buffer = [];
        this.lastMotionTimestamp = null;
        this.lastBleSpeedRaw = 0;
        this.bleSpeedHistory = [];
        this.recentAccels = [];
        this.zuptActive = false;
        this.recentAccelMagnitudes = [];
        this.lastEffectiveAccel = 0;
        this.lastZuptCorrectionTime = 0;
    }

    setParams(params: any) {
        this.params = params || {};
    }

    setGear(gear: string | null) {
        const normalized = normalizeGear(gear);
        this.directionSign = normalized === 'R' ? -1 : 1;
    }

    pushMotion(accel: Vector3, timestamp: number) {
        // Store for calibration
        this.recentAccels.push({ vec: accel, time: timestamp });
        const accelCutoff = timestamp - 3000;
        while (this.recentAccels.length > 0 && this.recentAccels[0].time < accelCutoff) {
            this.recentAccels.shift();
        }

        // Compute dt
        const dt = this.lastMotionTimestamp == null
            ? 0
            : (timestamp - this.lastMotionTimestamp) / 1000;
        this.lastMotionTimestamp = timestamp;

        if (dt <= 0 || dt > 0.5) return; // Skip bad intervals

        // ── Record ZUPT magnitude ───────────────────────────────────────
        const mag = Math.sqrt(accel.x * accel.x + accel.y * accel.y + accel.z * accel.z);
        this.recentAccelMagnitudes.push({ mag, time: timestamp });
        const zuptCutoff = timestamp - this.zuptWindowMs;
        while (this.recentAccelMagnitudes.length > 0 && this.recentAccelMagnitudes[0].time < zuptCutoff) {
            this.recentAccelMagnitudes.shift();
        }

        // ── Snapshot state BEFORE prediction (for replay) ───────────────
        const entry: BufferEntry = {
            timestamp,
            x: [this.x[0], this.x[1]],
            P: [...this.P] as Mat2,
            accel: { ...accel },
            dt,
        };

        // ── EKF Predict ─────────────────────────────────────────────────
        const forwardAccel = this.projectForwardAccel(accel);
        this.lastEffectiveAccel = forwardAccel;
        this.ekfPredict(forwardAccel, dt);

        // ── ZUPT check ──────────────────────────────────────────────────
        this.checkZupt(timestamp);

        // ── Store in circular buffer ────────────────────────────────────
        this.buffer.push(entry);
        const bufCutoff = timestamp - this.bufferDurationMs;
        while (this.buffer.length > 0 && this.buffer[0].timestamp < bufCutoff) {
            this.buffer.shift();
        }
    }

    pushBle(rawSpeed: number, arrivalTime: number, latencyMs: number) {
        if (rawSpeed == null || isNaN(rawSpeed)) return;

        const captureTime = arrivalTime - latencyMs;

        this.lastBleSpeedRaw = rawSpeed;
        this.bleSpeedHistory.push({ speed: rawSpeed, time: captureTime });
        if (this.bleSpeedHistory.length > 5) {
            this.bleSpeedHistory.shift();
        }

        // ── Calibrate forward vector if needed ──────────────────────────
        if (!this.isCalibrated) {
            this.attemptCalibration();
        }

        // ── OOSM Rewind-Replay ──────────────────────────────────────────
        const bleSpeedMps = rawSpeed * this.speedConversionFactor;

        if (this.buffer.length === 0) {
            // No buffer yet — just hard-set velocity
            this.x[0] = bleSpeedMps;
            return;
        }

        // Find the buffer entry closest to captureTime
        let rewindIdx = this.findClosestBufferIndex(captureTime);

        // Rewind: restore state to just before that entry
        const rewindEntry = this.buffer[rewindIdx];
        this.x = [rewindEntry.x[0], rewindEntry.x[1]];
        this.P = [...rewindEntry.P] as Mat2;

        // Apply Kalman measurement update at the rewind point
        this.ekfCorrect(bleSpeedMps);

        // Replay: re-predict forward from rewindIdx to present
        for (let i = rewindIdx; i < this.buffer.length; i++) {
            const entry = this.buffer[i];
            const forwardAccel = this.projectForwardAccel(entry.accel);
            this.ekfPredict(forwardAccel, entry.dt);

            // Update the buffer entry's post-correction state for future rewinds
            entry.x = [this.x[0], this.x[1]];
            entry.P = [...this.P] as Mat2;
        }
    }

    update(_dt: number): number {
        // Speed is maintained by pushMotion; update() just reads it
        return this.emitSpeed();
    }

    getDebugState(): FusionDebugState {
        // Always show live instantaneous sensor magnitude
        let displayAccel = this.lastEffectiveAccel;
        if (this.recentAccels.length > 0) {
            const latest = this.recentAccels[this.recentAccels.length - 1].vec;
            displayAccel = Math.sqrt(latest.x * latest.x + latest.y * latest.y + latest.z * latest.z);
        }

        return {
            algorithmName: this.name,
            bleSpeed: this.lastBleSpeedRaw,
            fusedSpeed: this.emitSpeed(),
            isCalibrated: this.isCalibrated,
            conversionFactor: this.speedConversionFactor,
            accelerationMps2: displayAccel,
            accelBias: this.x[1],
            isZupt: this.zuptActive,
            bufferLength: this.buffer.length,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  EKF Core Math
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * EKF Prediction Step
     *
     * State transition:
     *   velocity_new = velocity + (a_forward - bias) * dt
     *   bias_new     = bias  (random walk)
     *
     * F = [ 1  -dt ]      (Jacobian of state transition)
     *     [ 0   1  ]
     *
     * Q = [ q_accel*dt²   0       ]  (process noise)
     *     [ 0             q_bias  ]
     */
    private ekfPredict(forwardAccel: number, dt: number) {
        const vel = this.x[0];
        const bias = this.x[1];

        // State prediction
        const correctedAccel = forwardAccel - bias;
        this.x[0] = Math.max(0, vel + correctedAccel * dt);
        // bias stays the same (random walk model)

        // Covariance prediction: P = F * P * F^T + Q
        const F: Mat2 = [1, -dt, 0, 1];
        const Ft = mat2Transpose(F);
        const FP = mat2Mul(F, this.P);
        const FPFt = mat2Mul(FP, Ft);

        const qAccel = this.processNoiseAccel * dt * dt;
        const qBias = this.processNoiseBias * dt;
        const Q: Mat2 = [qAccel, 0, 0, qBias];

        this.P = mat2Add(FPFt, Q);
    }

    /**
     * EKF Measurement Update (Correction)
     *
     * We observe velocity directly:
     *   z = ble_speed_mps
     *   H = [ 1  0 ]   (we measure velocity, not bias)
     *   R = measurement_noise
     *
     * Innovation:  y = z - H*x = z - velocity
     * Kalman gain: K = P * H^T * (H*P*H^T + R)^{-1}
     * State:       x = x + K*y
     * Covariance:  P = (I - K*H) * P
     */
    private ekfCorrect(measuredVelocityMps: number) {
        // H = [1, 0], so H*x = x[0], H*P*H^T = P[0][0]
        const innovation = measuredVelocityMps - this.x[0];
        const S = this.P[0] + this.measurementNoise; // scalar: H*P*H^T + R

        if (Math.abs(S) < 1e-12) return; // numerical safety

        // Kalman gain K (2×1): K = P * H^T / S = [P[0,0]/S, P[1,0]/S]
        const K0 = this.P[0] / S;
        const K1 = this.P[2] / S;

        // State update
        this.x[0] = Math.max(0, this.x[0] + K0 * innovation);
        this.x[1] = this.x[1] + K1 * innovation;

        // Covariance update: P = (I - K*H) * P
        // (I - K*H) = [ 1-K0  0 ]
        //             [ -K1   1 ]
        const IKH: Mat2 = [1 - K0, 0, -K1, 1];
        this.P = mat2Mul(IKH, this.P);

        // Ensure P stays symmetric and positive
        this.P[1] = (this.P[1] + this.P[2]) / 2;
        this.P[2] = this.P[1];
        if (this.P[0] < 0) this.P[0] = 1e-6;
        if (this.P[3] < 0) this.P[3] = 1e-6;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  ZUPT (Zero Velocity Update)
    // ═══════════════════════════════════════════════════════════════════════

    private lastZuptCorrectionTime = 0;

    private checkZupt(timestamp: number) {
        if (this.recentAccelMagnitudes.length < 10) {
            this.zuptActive = false;
            return;
        }

        // Compute variance of acceleration magnitude
        let sum = 0;
        for (const entry of this.recentAccelMagnitudes) {
            sum += entry.mag;
        }
        const mean = sum / this.recentAccelMagnitudes.length;

        let varSum = 0;
        for (const entry of this.recentAccelMagnitudes) {
            const diff = entry.mag - mean;
            varSum += diff * diff;
        }
        const variance = varSum / this.recentAccelMagnitudes.length;

        // ZUPT requires BOTH low acceleration variance AND velocity already near zero.
        // Without the velocity gate, ZUPT would falsely fire during constant-speed
        // cruising (low accel variance but nonzero velocity).
        const velocityNearZero = this.x[0] < 0.5; // m/s
        this.zuptActive = variance < this.zuptVarianceThreshold && velocityNearZero;

        if (this.zuptActive) {
            // Rate-limit: only apply correction once per ZUPT window, not every frame.
            // At 60Hz, unchecked ZUPT would apply 60 corrections/sec, overwhelming
            // BLE corrections that arrive at ~1Hz.
            if (timestamp - this.lastZuptCorrectionTime < this.zuptWindowMs) {
                return;
            }
            this.lastZuptCorrectionTime = timestamp;

            // Use much higher measurement noise than BLE (10x) so ZUPT corrections
            // have lower authority than real speed measurements.
            const savedR = this.params.measurementNoise ?? 1.0;
            this.params.measurementNoise = savedR * 10;
            this.ekfCorrect(0);
            this.params.measurementNoise = savedR;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Helpers
    // ═══════════════════════════════════════════════════════════════════════

    private projectForwardAccel(accel: Vector3): number {
        if (!this.forwardVector) return 0;

        const fx = this.forwardVector.x;
        const fy = this.forwardVector.y;
        const fz = this.forwardVector.z;

        let sensorForwardAccel = (accel.x * fx) + (accel.y * fy) + (accel.z * fz);

        // Apply offset correction (subtract bias)
        if (sensorForwardAccel > 0) {
            sensorForwardAccel = Math.max(0, sensorForwardAccel - this.accelOffset);
        } else {
            sensorForwardAccel = Math.min(0, sensorForwardAccel + this.accelOffset);
        }

        // High-pass filter: dead zone for small accelerations
        if (Math.abs(sensorForwardAccel) < this.highPassThreshold) {
            return 0;
        }

        return sensorForwardAccel * this.directionSign;
    }

    private emitSpeed(): number {
        const velocityMps = Math.max(0, this.x[0]);
        return velocityMps / this.speedConversionFactor;
    }

    private findClosestBufferIndex(targetTime: number): number {
        let bestIdx = 0;
        let bestDiff = Math.abs(this.buffer[0].timestamp - targetTime);

        for (let i = 1; i < this.buffer.length; i++) {
            const diff = Math.abs(this.buffer[i].timestamp - targetTime);
            if (diff < bestDiff) {
                bestDiff = diff;
                bestIdx = i;
            }
        }

        return bestIdx;
    }

    // ── Forward-vector calibration (shared logic) ───────────────────────

    private attemptCalibration() {
        if (this.bleSpeedHistory.length < 2) return;
        if (this.recentAccels.length < 5) return;

        const latest = this.bleSpeedHistory[this.bleSpeedHistory.length - 1];
        const prev = this.bleSpeedHistory[0];

        const speedDeltaRaw = latest.speed - prev.speed;
        const timeDelta = (latest.time - prev.time) / 1000;
        if (timeDelta <= 0.5) return;

        const rawAccel = (speedDeltaRaw / timeDelta) * this.directionSign;

        if (rawAccel > 1.0 && latest.speed > MIN_CALIBRATION_SPEED) {
            let sumX = 0, sumY = 0, sumZ = 0, count = 0;
            const effectiveEnd = latest.time + SENSOR_SYNC_SLOP;

            for (const item of this.recentAccels) {
                if (item.time >= prev.time && item.time <= effectiveEnd) {
                    sumX += item.vec.x;
                    sumY += item.vec.y;
                    sumZ += item.vec.z;
                    count++;
                }
            }
            if (count < 5) return;

            const avgX = sumX / count;
            const avgY = sumY / count;
            const avgZ = sumZ / count;
            const magnitude = Math.sqrt(avgX * avgX + avgY * avgY + avgZ * avgZ);

            if (!Number.isFinite(magnitude) || magnitude <= MIN_SENSOR_ACCEL) return;

            this.forwardVector = {
                x: (avgX / magnitude) * this.directionSign,
                y: (avgY / magnitude) * this.directionSign,
                z: (avgZ / magnitude) * this.directionSign,
            };

            const newFactor = magnitude / rawAccel;
            if (newFactor > 0.2 && newFactor < 0.6) {
                this.speedConversionFactor = newFactor;
                this.isCalibrated = true;
            }
        }
    }
}
