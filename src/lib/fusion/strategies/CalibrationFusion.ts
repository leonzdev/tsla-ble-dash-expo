import {
    FusionAlgorithm,
    FusionDebugState,
    MIN_CALIBRATION_SPEED,
    MIN_SENSOR_ACCEL,
    SENSOR_SYNC_SLOP,
    Vector3,
} from '../types';
import { normalizeGear } from '../gearUtils';

/*
 * Algorithm 5: Calibration Fusion (V5)
 * Detailed recording and smart BLE calibration with configurable acceleration parameters.
 *
 * Design notes:
 * - Event-driven: integrates speed on pushMotion/pushBle; update() is read-only.
 * - No SPEED_DECAY: maintains speed when effectiveAccel ≈ 0 (risk: drift during long BLE gaps).
 *
 * Parameters:
 * - lookbackMs (0-1000, default 400): Fixed lookback for BLE timestamp adjustment
 * - accelOffset (0.00-0.10, default 0.02): Bias offset for accelerometer at rest
 * - highPassThreshold (0.00-0.10, default 0.05): Filter threshold for small accelerations
 */
export class CalibrationFusionAlgorithm implements FusionAlgorithm {
    public name = 'Calibration Fusion (V5)';
    private params: any = {};

    private currentSpeedMps = 0;
    private lastBleSpeedRaw = 0;

    private forwardVector: Vector3 | null = null;
    private speedConversionFactor = 0.44704;
    private isCalibrated = false;
    private directionSign = 1; // +1 for drive/neutral, -1 for reverse

    private lastMotionTimestamp: number | null = null;

    // Recording buffers for calibration analysis
    private accelHistory: { vec: Vector3; scalar: number; time: number }[] = [];
    private bleHistoryRaw: { speed: number; time: number }[] = []; // No lookback
    private bleSpeedHistory: { speed: number; time: number }[] = [];
    private speedHistory: { speed: number; time: number; source: 'ble' | 'accel' | 'ble-calibration' }[] = [];

    // Last filtered acceleration for smart calibration / debug
    private lastFilteredAccel = 0;
    private lastEffectiveAccel = 0;

    reset() {
        this.currentSpeedMps = 0;
        this.lastBleSpeedRaw = 0;
        this.forwardVector = null;
        this.speedConversionFactor = 0.44704;
        this.isCalibrated = false;
        this.lastMotionTimestamp = null;
        this.accelHistory = [];
        this.bleHistoryRaw = [];
        this.bleSpeedHistory = [];
        this.speedHistory = [];
        this.lastFilteredAccel = 0;
        this.lastEffectiveAccel = 0;
    }

    setParams(params: any) {
        this.params = params || {};
    }

    setGear(gear: string | null) {
        const normalized = normalizeGear(gear);
        this.directionSign = normalized === 'R' ? -1 : 1;
    }

    private get lookbackMs(): number {
        return Math.max(0, Math.min(1000, this.params.lookbackMs ?? 400));
    }

    private get accelOffset(): number {
        return Math.max(0, Math.min(0.10, this.params.accelOffset ?? 0.02));
    }

    private get highPassThreshold(): number {
        return Math.max(0, Math.min(0.10, this.params.highPassThreshold ?? 0.05));
    }

    pushMotion(accel: Vector3, timestamp: number) {
        // Record accel for replay/calibration/debug
        const scalar = Math.sqrt(accel.x * accel.x + accel.y * accel.y + accel.z * accel.z);
        this.accelHistory.push({ vec: accel, scalar, time: timestamp });

        // Prune old entries (keep 3 seconds)
        const cutoff = timestamp - 3000;
        while (this.accelHistory.length > 0 && this.accelHistory[0].time < cutoff) {
            this.accelHistory.shift();
        }

        // Integrate speed on motion updates (event-driven)
        const dt = this.lastMotionTimestamp == null ? 0 : (timestamp - this.lastMotionTimestamp) / 1000;
        this.lastMotionTimestamp = timestamp;

        let effectiveAccel = 0;
        if (dt > 0 && this.forwardVector) {
            effectiveAccel = this.computeFilteredForwardAccel(accel, true);
            this.currentSpeedMps += effectiveAccel * dt;
            if (this.currentSpeedMps < 0) this.currentSpeedMps = 0;
        } else {
            this.lastFilteredAccel = 0;
        }

        this.lastEffectiveAccel = effectiveAccel;

        // Record calculated speed when acceleration arrives
        this.speedHistory.push({
            speed: this.emitSpeed(),
            time: timestamp,
            source: 'accel'
        });
        this.pruneSpeedHistory(timestamp);
    }

    pushBle(rawSpeed: number, arrivalTime: number, latencyMs: number) {
        if (rawSpeed == null || isNaN(rawSpeed)) return;

        // Record raw BLE without lookback for analysis
        this.bleHistoryRaw.push({ speed: rawSpeed, time: arrivalTime });
        const cutoff = arrivalTime - 3000;
        while (this.bleHistoryRaw.length > 0 && this.bleHistoryRaw[0].time < cutoff) {
            this.bleHistoryRaw.shift();
        }

        // Use fixed lookback (not the passed latencyMs)
        const captureTime = arrivalTime - this.lookbackMs;

        this.lastBleSpeedRaw = rawSpeed;
        this.bleSpeedHistory.push({ speed: rawSpeed, time: captureTime });
        if (this.bleSpeedHistory.length > 5) {
            this.bleSpeedHistory.shift();
        }

        if (!this.isCalibrated) {
            this.attemptCalibration();
        }

        const bleSpeedMps = rawSpeed * this.speedConversionFactor;

        // Smart calibration: only apply feedback if direction matches
        if (this.shouldApplyCalibration(bleSpeedMps)) {
            this.applyCalibrationFeedback(bleSpeedMps, captureTime);
        }

        // Record calculated speed when BLE arrives
        this.speedHistory.push({
            speed: this.emitSpeed(),
            time: arrivalTime,
            source: 'ble'
        });
        this.pruneSpeedHistory(arrivalTime);
    }

    update(dt: number): number {
        // Read-only: speed is updated on pushMotion/pushBle.
        return this.emitSpeed();
    }

    getDebugState(): FusionDebugState {
        let displayAccel = this.lastEffectiveAccel;
        if (!this.isCalibrated && this.accelHistory.length > 0) {
            displayAccel = this.accelHistory[this.accelHistory.length - 1].scalar;
        }

        return {
            algorithmName: `Calibration (lb:${this.lookbackMs} off:${this.accelOffset.toFixed(2)} hp:${this.highPassThreshold.toFixed(2)})`,
            bleSpeed: this.lastBleSpeedRaw,
            fusedSpeed: this.emitSpeed(),
            isCalibrated: this.isCalibrated,
            conversionFactor: this.speedConversionFactor,
            accelerationMps2: displayAccel
        };
    }

    // Expose history for external calibration analysis
    getCalibrationData() {
        return {
            accelHistory: [...this.accelHistory],
            bleHistoryRaw: [...this.bleHistoryRaw],
            speedHistory: [...this.speedHistory],
            lastFilteredAccel: this.lastFilteredAccel
        };
    }

    private emitSpeed(): number {
        return this.currentSpeedMps / this.speedConversionFactor;
    }

    private pruneSpeedHistory(now: number) {
        const cutoff = now - 3000;
        while (this.speedHistory.length > 0 && this.speedHistory[0].time < cutoff) {
            this.speedHistory.shift();
        }
    }

    private attemptCalibration() {
        if (this.bleSpeedHistory.length < 2) return;
        if (this.accelHistory.length < 5) return;

        const latest = this.bleSpeedHistory[this.bleSpeedHistory.length - 1];
        const prev = this.bleSpeedHistory[0];

        const speedDeltaRaw = latest.speed - prev.speed;
        const timeDelta = (latest.time - prev.time) / 1000;
        if (timeDelta <= 0.5) return;

        const rawAccel = speedDeltaRaw / timeDelta;
        if (rawAccel <= 1.0 || latest.speed <= MIN_CALIBRATION_SPEED) return;

        let sumX = 0, sumY = 0, sumZ = 0, count = 0;
        const effectiveEnd = latest.time + SENSOR_SYNC_SLOP;

        for (const item of this.accelHistory) {
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

        // Store a "vehicle-forward" axis: flip based on gear so reverse acceleration doesn't invert the axis.
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

    private computeFilteredForwardAccel(vec: Vector3, updateLastFiltered: boolean): number {
        if (!this.forwardVector) {
            if (updateLastFiltered) this.lastFilteredAccel = 0;
            return 0;
        }

        const fx = this.forwardVector.x;
        const fy = this.forwardVector.y;
        const fz = this.forwardVector.z;

        // Sensor forward acceleration (in vehicle-forward axis)
        let sensorForwardAccel = (vec.x * fx) + (vec.y * fy) + (vec.z * fz);

        // Apply offset correction (subtract bias)
        if (sensorForwardAccel > 0) {
            sensorForwardAccel = Math.max(0, sensorForwardAccel - this.accelOffset);
        } else {
            sensorForwardAccel = Math.min(0, sensorForwardAccel + this.accelOffset);
        }

        // High-pass filter: ignore small accelerations
        if (Math.abs(sensorForwardAccel) < this.highPassThreshold) {
            if (updateLastFiltered) this.lastFilteredAccel = 0;
            return 0;
        }

        // Convert from vehicle-forward axis to travel-direction acceleration using gear sign.
        const signedAccel = sensorForwardAccel * this.directionSign;
        if (updateLastFiltered) this.lastFilteredAccel = signedAccel;
        return signedAccel;
    }

    private shouldApplyCalibration(bleSpeedMps: number): boolean {
        const threshold = this.highPassThreshold;

        if (this.lastFilteredAccel > threshold) {
            // Accelerating: only calibrate if BLE is higher
            return bleSpeedMps > this.currentSpeedMps;
        } else if (this.lastFilteredAccel < -threshold) {
            // Decelerating: only calibrate if BLE is lower
            return bleSpeedMps < this.currentSpeedMps;
        }

        // Steady state: always calibrate
        return true;
    }

    /**
     * Custom calibration feedback:
     * 1. Set speed at captureTime to bleSpeedMps
     * 2. Replay all accelerations from captureTime forward
     * 3. Update speedHistory with recalculated values
     */
    private applyCalibrationFeedback(bleSpeedMps: number, captureTime: number) {
        // Find accelerations after captureTime
        const accelsAfterCapture = this.accelHistory.filter(a => a.time >= captureTime);
        accelsAfterCapture.sort((a, b) => a.time - b.time);

        // Start from BLE speed at captureTime
        let replayedSpeed = bleSpeedMps;

        // Update speedHistory: remove entries from captureTime onwards
        this.speedHistory = this.speedHistory.filter(s => s.time < captureTime);

        // Add the calibrated BLE speed entry
        this.speedHistory.push({
            speed: replayedSpeed / this.speedConversionFactor,
            time: captureTime,
            source: 'ble-calibration'
        });

        // Replay accelerations forward
        let prevTime = captureTime;
        for (const accel of accelsAfterCapture) {
            const dt = (accel.time - prevTime) / 1000;
            if (dt > 0) {
                const filteredAccel = this.computeFilteredForwardAccel(accel.vec, false);
                replayedSpeed += filteredAccel * dt;
                if (replayedSpeed < 0) replayedSpeed = 0;

                this.speedHistory.push({
                    speed: replayedSpeed / this.speedConversionFactor,
                    time: accel.time,
                    source: 'ble-calibration'
                });
            }
            prevTime = accel.time;
        }

        this.currentSpeedMps = replayedSpeed;
    }
}
