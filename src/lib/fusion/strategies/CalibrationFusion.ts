import { Vector3, FusionDebugState } from '../types';
import { TimeRealignedFusionAlgorithm } from './TimeRealignedFusion';

/*
 * Algorithm 5: Calibration Fusion (V5)
 * Detailed recording and smart BLE calibration with configurable acceleration parameters.
 * 
 * Parameters:
 * - lookbackMs (0-1000, default 400): Fixed lookback for BLE timestamp adjustment
 * - accelOffset (0.00-0.10, default 0.02): Bias offset for accelerometer at rest
 * - highPassThreshold (0.00-0.10, default 0.05): Filter threshold for small accelerations
 */
export class CalibrationFusionAlgorithm extends TimeRealignedFusionAlgorithm {
    public name = 'Calibration Fusion (V5)';

    // Recording buffers for calibration analysis
    private accelHistory: { vec: Vector3; scalar: number; time: number }[] = [];
    private bleHistoryRaw: { speed: number; time: number }[] = []; // No lookback
    private speedHistory: { speed: number; time: number; source: 'ble' | 'accel' | 'ble-calibration' }[] = [];

    // Last filtered acceleration for smart calibration
    private lastFilteredAccel: number = 0;

    protected onReset() {
        super.onReset();
        this.accelHistory = [];
        this.bleHistoryRaw = [];
        this.speedHistory = [];
        this.lastFilteredAccel = 0;
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
        // Call parent to maintain recentAccels
        super.pushMotion(accel, timestamp);

        // Calculate scalar magnitude
        const scalar = Math.sqrt(accel.x * accel.x + accel.y * accel.y + accel.z * accel.z);

        // Record with scalar for debugging
        this.accelHistory.push({ vec: accel, scalar, time: timestamp });

        // Prune old entries (keep 3 seconds)
        const cutoff = timestamp - 3000;
        while (this.accelHistory.length > 0 && this.accelHistory[0].time < cutoff) {
            this.accelHistory.shift();
        }

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

        const estimatedAtTime = this.getEstimatedSpeedAt(captureTime);
        const bleSpeedMps = rawSpeed * this.speedConversionFactor;

        let diff = 0;
        if (estimatedAtTime !== null) {
            diff = bleSpeedMps - estimatedAtTime;
        } else {
            diff = bleSpeedMps - this.currentSpeedMps;
        }

        // Smart calibration: only apply feedback if direction matches
        if (this.shouldApplyCalibration(bleSpeedMps)) {
            this.applyCalibrationFeedback(bleSpeedMps, captureTime, arrivalTime);
        }

        // Record calculated speed when BLE arrives
        this.speedHistory.push({
            speed: this.emitSpeed(),
            time: arrivalTime,
            source: 'ble'
        });
        this.pruneSpeedHistory(arrivalTime);
    }

    protected computeInstantAcceleration(): number {
        if (!this.forwardVector || this.recentAccels.length === 0) return 0;

        const latest = this.recentAccels[this.recentAccels.length - 1].vec;
        const fx = this.forwardVector.x;
        const fy = this.forwardVector.y;
        const fz = this.forwardVector.z;

        // Sensor forward acceleration
        let sensorForwardAccel = (latest.x * fx) + (latest.y * fy) + (latest.z * fz);

        // Apply offset correction (subtract bias)
        if (sensorForwardAccel > 0) {
            sensorForwardAccel = Math.max(0, sensorForwardAccel - this.accelOffset);
        } else {
            sensorForwardAccel = Math.min(0, sensorForwardAccel + this.accelOffset);
        }

        // High-pass filter: ignore small accelerations
        if (Math.abs(sensorForwardAccel) < this.highPassThreshold) {
            this.lastFilteredAccel = 0;
            return 0;
        }

        this.lastFilteredAccel = sensorForwardAccel;
        return sensorForwardAccel;
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
     * 2. Replay all accelerations from captureTime to now
     * 3. Update speedHistory with recalculated values
     */
    private applyCalibrationFeedback(bleSpeedMps: number, captureTime: number, now: number) {
        // Find accelerations after captureTime
        const accelsAfterCapture = this.accelHistory.filter(a => a.time >= captureTime);

        // Start from BLE speed at captureTime
        let replayedSpeed = bleSpeedMps;

        // Sort by time to ensure correct order
        accelsAfterCapture.sort((a, b) => a.time - b.time);

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
                // Compute filtered acceleration for this reading
                const filteredAccel = this.computeAccelForReplay(accel.vec);
                replayedSpeed += filteredAccel * dt;
                if (replayedSpeed < 0) replayedSpeed = 0;

                // Record the recalculated speed
                this.speedHistory.push({
                    speed: replayedSpeed / this.speedConversionFactor,
                    time: accel.time,
                    source: 'ble-calibration'
                });
            }
            prevTime = accel.time;
        }

        // Update current speed to the final replayed value
        this.currentSpeedMps = replayedSpeed;
    }

    /**
     * Compute filtered acceleration for a specific vector (used in replay)
     */
    private computeAccelForReplay(vec: Vector3): number {
        if (!this.forwardVector) return 0;

        const fx = this.forwardVector.x;
        const fy = this.forwardVector.y;
        const fz = this.forwardVector.z;

        let sensorForwardAccel = (vec.x * fx) + (vec.y * fy) + (vec.z * fz);

        // Apply offset correction
        if (sensorForwardAccel > 0) {
            sensorForwardAccel = Math.max(0, sensorForwardAccel - this.accelOffset);
        } else {
            sensorForwardAccel = Math.min(0, sensorForwardAccel + this.accelOffset);
        }

        // High-pass filter
        if (Math.abs(sensorForwardAccel) < this.highPassThreshold) {
            return 0;
        }

        return sensorForwardAccel;
    }

    private pruneSpeedHistory(now: number) {
        const cutoff = now - 3000;
        while (this.speedHistory.length > 0 && this.speedHistory[0].time < cutoff) {
            this.speedHistory.shift();
        }
    }

    getDebugState(): FusionDebugState {
        const base = super.getDebugState();
        return {
            ...base,
            algorithmName: `Calibration (lb:${this.lookbackMs} off:${this.accelOffset.toFixed(2)} hp:${this.highPassThreshold.toFixed(2)})`
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
}
