import {
    Vector3,
    FusionDebugState,
    FusionAlgorithm,
    MIN_CALIBRATION_SPEED,
    MIN_SENSOR_ACCEL,
    SPEED_DECAY,
    PROPORTIONAL_GAIN,
    SENSOR_SYNC_SLOP,
} from '../../types';
import { normalizeGear } from '../../gearUtils';

/*
 * Base Class for Inertial Physics & Calibration
 */
export abstract class BaseInertialAlgorithm implements FusionAlgorithm {
    public abstract name: string;
    protected params: any = {};

    protected currentSpeedMps: number = 0;
    protected lastBleSpeedRaw: number = 0;

    protected forwardVector: Vector3 | null = null;
    protected speedConversionFactor: number = 0.44704;
    protected isCalibrated: boolean = false;
    protected directionSign: number = 1; // +1 for drive/neutral, -1 for reverse

    protected recentAccels: { vec: Vector3; time: number }[] = [];
    protected bleSpeedHistory: { speed: number; time: number }[] = [];

    protected lastEffectiveAccel: number = 0;

    reset() {
        this.currentSpeedMps = 0;
        this.lastBleSpeedRaw = 0;
        this.forwardVector = null;
        this.speedConversionFactor = 0.44704;
        this.isCalibrated = false;
        this.directionSign = 1;
        this.recentAccels = [];
        this.bleSpeedHistory = [];
        this.lastEffectiveAccel = 0;
        this.onReset();
    }

    setParams(params: any) {
        this.params = params || {};
    }

    setGear(gear: string | null) {
        const normalized = normalizeGear(gear);
        this.directionSign = normalized === 'R' ? -1 : 1;
    }

    protected onReset() { }

    pushMotion(accel: Vector3, timestamp: number) {
        this.recentAccels.push({ vec: accel, time: timestamp });
        const cutoff = timestamp - 3000; // Keep slightly more history for lookback averaging
        while (this.recentAccels.length > 0 && this.recentAccels[0].time < cutoff) {
            this.recentAccels.shift();
        }
    }

    abstract pushBle(speed: number, arrivalTime: number, latencyMs: number): void;

    update(dt: number): number {
        if (!this.forwardVector || this.recentAccels.length === 0) {
            if (!this.isCalibrated && this.bleSpeedHistory.length > 0) {
                return this.lastBleSpeedRaw;
            }
            return this.emitSpeed();
        }

        const effectiveAccel = this.computeInstantAcceleration();
        this.lastEffectiveAccel = effectiveAccel;

        // Apply Physics
        this.currentSpeedMps += effectiveAccel * dt;
        this.currentSpeedMps *= SPEED_DECAY;

        if (this.currentSpeedMps < 0) this.currentSpeedMps = 0;

        this.onPostUpdate(dt);

        return this.emitSpeed();
    }

    protected onPostUpdate(dt: number) { }

    getDebugState(): FusionDebugState {
        // Always show the live instantaneous sensor magnitude for diagnostics.
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
            accelerationMps2: displayAccel
        };
    }

    protected emitSpeed(): number {
        return this.currentSpeedMps / this.speedConversionFactor;
    }

    // Physics Engine: Returns "True Forward Acceleration" (Sensor + Correction)
    protected computeInstantAcceleration(): number {
        if (!this.forwardVector || this.recentAccels.length === 0) return 0;

        const latest = this.recentAccels[this.recentAccels.length - 1].vec;
        const fx = this.forwardVector.x;
        const fy = this.forwardVector.y;
        const fz = this.forwardVector.z;

        // Sensor Accel (measures gravity as deceleration if uphill!)
        let sensorForwardAccel = (latest.x * fx) + (latest.y * fy) + (latest.z * fz);

        if (Math.abs(sensorForwardAccel) > 0.1) {
            return sensorForwardAccel * this.directionSign;
        }
        return 0;
    }

    /*
     * Feedback Loop
     * Now accepts 'captureTime' to perform acceleration-window matching.
     */
    protected applyFeedback(diff: number, rawBleMps: number, captureTime: number) {
        // Safety: If huge divergence, hard reset
        if (Math.abs(diff) > 5.0) {
            this.currentSpeedMps = rawBleMps;
            return;
        }

        // 1. Proportional Correction (Fast)
        // Corrects the integration drift of speed
        this.currentSpeedMps += diff * PROPORTIONAL_GAIN;

        // Clamp Speed
        if (this.currentSpeedMps < 0) this.currentSpeedMps = 0;
    }

    // Average sensor readings over a historical time window [start, end]
    private computeAverageSensorAccel(startTime: number, endTime: number): number | null {
        if (!this.forwardVector || this.recentAccels.length === 0) return null;

        let sum = 0;
        let count = 0;

        const fx = this.forwardVector.x;
        const fy = this.forwardVector.y;
        const fz = this.forwardVector.z;

        // Use SLOP to catch sensor data that arrived slightly 'late' (processed after BLE event backdate)
        const effectiveEnd = endTime + SENSOR_SYNC_SLOP;

        for (const item of this.recentAccels) {
            if (item.time >= startTime && item.time <= effectiveEnd) {
                const dot = (item.vec.x * fx) + (item.vec.y * fy) + (item.vec.z * fz);
                sum += dot;
                count++;
            }
        }

        // If we found data points
        if (count > 0) {
            return sum / count;
        }

        // Fallback: if no points in exact window (rare), take nearest?
        // Or assume constant.
        // For robustness, return null and skip update.
        return null;
    }

    protected attemptCalibration() {
        if (this.bleSpeedHistory.length < 2) return;

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

            if (magnitude > MIN_SENSOR_ACCEL) {
                this.forwardVector = {
                    x: (avgX / magnitude) * this.directionSign,
                    y: (avgY / magnitude) * this.directionSign,
                    z: (avgZ / magnitude) * this.directionSign
                };
                const newFactor = magnitude / rawAccel;
                if (newFactor > 0.2 && newFactor < 0.6) {
                    this.speedConversionFactor = newFactor;
                    this.isCalibrated = true;
                }
            }
        }
    }
}
