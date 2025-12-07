export interface Vector3 {
    x: number;
    y: number;
    z: number;
}

export interface FusionDebugState {
    bleSpeed: number;
    fusedSpeed: number;
    algorithmName: string;
    isCalibrated: boolean;
    conversionFactor: number;
    accelerationMps2?: number;
    gradePercent?: number;
}

export type SpeedUpdateCallback = (speed: number) => void;
export type CalibrationCallback = (isCalibrated: boolean) => void;

/*
 * Strategy Interface
 */
export interface FusionAlgorithm {
    name: string;
    reset(): void;
    setParams(params: any): void;
    pushMotion(accel: Vector3, timestamp: number): void;
    pushBle(speed: number, arrivalTime: number, latencyMs: number): void;
    update(dt: number): number;
    getDebugState(): FusionDebugState;
}

const MIN_CALIBRATION_SPEED = 5;
const MIN_SENSOR_ACCEL = 0.5;
const FILTER_GAIN_BLE = 0.15;
const SPEED_DECAY = 0.9995;

// Slope Correction Constants
const BIAS_LEARNING_RATE = 0.05; // Low-pass filter alpha for bias
const PROPORTIONAL_GAIN = 0.15;
const SENSOR_SYNC_SLOP = 200; // Tolerance for sensor timestamp mismatch

/*
 * Base Class for Inertial Physics & Calibration
 */
abstract class BaseInertialAlgorithm implements FusionAlgorithm {
    public abstract name: string;
    protected params: any = {};

    protected currentSpeedMps: number = 0;
    protected lastBleSpeedRaw: number = 0;

    protected forwardVector: Vector3 | null = null;
    protected speedConversionFactor: number = 0.44704;
    protected isCalibrated: boolean = false;

    // Slope Correction State
    protected accelBias: number = 0;
    protected prevCorrectionPoint: { speedMps: number; time: number } | null = null;

    protected recentAccels: { vec: Vector3; time: number }[] = [];
    protected bleSpeedHistory: { speed: number; time: number }[] = [];

    protected lastEffectiveAccel: number = 0;

    reset() {
        this.currentSpeedMps = 0;
        this.lastBleSpeedRaw = 0;
        this.forwardVector = null;
        this.speedConversionFactor = 0.44704;
        this.isCalibrated = false;
        this.recentAccels = [];
        this.bleSpeedHistory = [];
        this.lastEffectiveAccel = 0;
        this.accelBias = 0;
        this.prevCorrectionPoint = null;
        this.onReset();
    }

    setParams(params: any) {
        this.params = params || {};
        // If slope correction disabled, reset bias
        if (!this.params.slopeCorrectionEnabled) {
            this.accelBias = 0;
            this.prevCorrectionPoint = null;
        }
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
        let displayAccel = this.lastEffectiveAccel;
        if (!this.isCalibrated && this.recentAccels.length > 0) {
            const latest = this.recentAccels[this.recentAccels.length - 1].vec;
            displayAccel = Math.sqrt(latest.x * latest.x + latest.y * latest.y + latest.z * latest.z);
        }

        return {
            algorithmName: this.name + (this.params.slopeCorrectionEnabled ? ' (+Slope)' : ''),
            bleSpeed: this.lastBleSpeedRaw,
            fusedSpeed: this.emitSpeed(),
            isCalibrated: this.isCalibrated,
            conversionFactor: this.speedConversionFactor,
            accelerationMps2: displayAccel,
            gradePercent: (this.accelBias / 9.81) * 100
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

        // Correct for Bias: TrueAccel = SensorAccel + Bias
        // (Bias represents the missing 'g * sin(slope)' component)
        let trueAccel = sensorForwardAccel;
        if (this.params.slopeCorrectionEnabled) {
            trueAccel += this.accelBias;
        }

        if (Math.abs(trueAccel) > 0.1) {
            return trueAccel;
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
            if (this.params.slopeCorrectionEnabled) {
                // Soft reset bias, don't zero it completely as we might still be on the hill
                this.accelBias *= 0.5;
            }
            this.prevCorrectionPoint = { speedMps: rawBleMps, time: captureTime };
            return;
        }

        // 1. Proportional Correction (Fast)
        // Corrects the integration drift of speed
        this.currentSpeedMps += diff * PROPORTIONAL_GAIN;

        // 2. Slope/Bias Correction (Slow)
        if (this.params.slopeCorrectionEnabled) {
            this.updateSlopeBias(rawBleMps, captureTime);
        }

        // Clamp Speed
        if (this.currentSpeedMps < 0) this.currentSpeedMps = 0;
    }

    /*
     * V5.1 Logic: Acceleration-Based Bias Learning
     */
    private updateSlopeBias(currentSpeedMps: number, currentTime: number) {
        const prev = this.prevCorrectionPoint;
        // Update previous point for next time
        this.prevCorrectionPoint = { speedMps: currentSpeedMps, time: currentTime };

        if (!prev) return;

        const dtMs = currentTime - prev.time;
        // Require at least 200ms window to be significant
        if (dtMs < 200) return;

        const dtSec = dtMs / 1000;

        // True Average Accel (from BLE)
        const bleAccel = (currentSpeedMps - prev.speedMps) / dtSec;

        // Sensor Average Accel (what we thought happened)
        const sensorAccel = this.computeAverageSensorAccel(prev.time, currentTime);
        if (sensorAccel === null) return; // Not enough data

        // The error implies Bias. 
        // The error implies Bias.
        // We defined TrueAccel = SensorAccel + Bias.
        // So BleAccel ~= SensorAccel + Bias.
        // => BiasTarget = BleAccel - SensorAccel.
        const biasTarget = bleAccel - sensorAccel;

        // Apply Low Pass Filter to Bias
        // bias = old + alpha * (target - old)
        this.accelBias += BIAS_LEARNING_RATE * (biasTarget - this.accelBias);

        // Clamp Bias (limit to ~ +/- 3 m/s^2 or ~17 deg slope)
        if (this.accelBias > 3.0) this.accelBias = 3.0;
        if (this.accelBias < -3.0) this.accelBias = -3.0;
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
        const rawAccel = speedDeltaRaw / timeDelta;

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
                    x: avgX / magnitude,
                    y: avgY / magnitude,
                    z: avgZ / magnitude
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

/*
 * Algorithm 1: Inertial Fusion (V1)
 */
class InertialFusionAlgorithm extends BaseInertialAlgorithm {
    public name = 'Sensor Fusion V1';

    pushBle(rawSpeed: number, arrivalTime: number, latencyMs: number) {
        if (rawSpeed == null || isNaN(rawSpeed)) return;

        this.lastBleSpeedRaw = rawSpeed;
        this.bleSpeedHistory.push({ speed: rawSpeed, time: arrivalTime });
        if (this.bleSpeedHistory.length > 5) {
            this.bleSpeedHistory.shift();
        }

        if (!this.isCalibrated) {
            this.attemptCalibration();
        }

        const bleSpeedMps = rawSpeed * this.speedConversionFactor;
        const diff = bleSpeedMps - this.currentSpeedMps;

        // V1 uses 'arrivalTime' as capture time (no latency comp)
        this.applyFeedback(diff, bleSpeedMps, arrivalTime);
    }
}

/*
 * Algorithm 2: Time-Realigned Fusion (V2)
 */
class TimeRealignedFusionAlgorithm extends BaseInertialAlgorithm {
    public name = 'Time-Realigned Fusion (V2)';

    protected outputHistory: { speedMps: number; time: number }[] = [];

    protected onReset() {
        super.onReset();
        this.outputHistory = [];
    }

    protected onPostUpdate(dt: number) {
        this.recordHistory(this.currentSpeedMps, Date.now());
    }

    pushBle(rawSpeed: number, arrivalTime: number, latencyMs: number) {
        if (rawSpeed == null || isNaN(rawSpeed)) return;

        const captureTime = arrivalTime - latencyMs;

        this.lastBleSpeedRaw = rawSpeed;
        this.bleSpeedHistory.push({ speed: rawSpeed, time: captureTime });
        if (this.bleSpeedHistory.length > 5) {
            this.bleSpeedHistory.shift();
        }

        if (!this.isCalibrated) {
            this.attemptCalibration();
        }

        const estimatedAtTime = this.getEstimatedSpeedAt(captureTime);
        const bleSpeedMps = rawSpeed * this.speedConversionFactor;

        let diff = 0;
        if (estimatedAtTime !== null) {
            diff = bleSpeedMps - estimatedAtTime;
        } else {
            diff = bleSpeedMps - this.currentSpeedMps;
        }

        this.applyFeedback(diff, bleSpeedMps, captureTime);
    }

    protected recordHistory(speedMps: number, time: number) {
        this.outputHistory.push({ speedMps, time });
        const cutoff = time - 2000;
        while (this.outputHistory.length > 0 && this.outputHistory[0].time < cutoff) {
            this.outputHistory.shift();
        }
    }

    protected getEstimatedSpeedAt(time: number): number | null {
        if (this.outputHistory.length === 0) return null;
        let closest = this.outputHistory[0];
        let minDiff = Math.abs(closest.time - time);

        for (let i = 1; i < this.outputHistory.length; i++) {
            const item = this.outputHistory[i];
            const diff = Math.abs(item.time - time);
            if (diff < minDiff) {
                minDiff = diff;
                closest = item;
            }
        }
        if (minDiff > 500) return null;
        return closest.speedMps;
    }
}

/*
 * Algorithm 3: Median Latency Fusion (V3)
 */
class MedianLatencyFusionAlgorithm extends TimeRealignedFusionAlgorithm {
    public name = 'Median Latency Fusion (V3)';

    protected latencyHistory: number[] = [];

    protected onReset() {
        super.onReset();
        this.latencyHistory = [];
    }

    pushBle(rawSpeed: number, arrivalTime: number, latencyMs: number) {
        if (rawSpeed == null || isNaN(rawSpeed)) return;

        this.latencyHistory.push(latencyMs);
        if (this.latencyHistory.length > 10) {
            this.latencyHistory.shift();
        }

        const sorted = [...this.latencyHistory].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const medianLatency = sorted.length % 2 !== 0
            ? sorted[mid]
            : (sorted[mid - 1] + sorted[mid]) / 2;

        const captureTime = arrivalTime - medianLatency;

        this.lastBleSpeedRaw = rawSpeed;
        this.bleSpeedHistory.push({ speed: rawSpeed, time: captureTime });
        if (this.bleSpeedHistory.length > 5) {
            this.bleSpeedHistory.shift();
        }

        if (!this.isCalibrated) {
            this.attemptCalibration();
        }

        const estimatedAtTime = this.getEstimatedSpeedAt(captureTime);
        const bleSpeedMps = rawSpeed * this.speedConversionFactor;

        let diff = 0;
        if (estimatedAtTime !== null) {
            diff = bleSpeedMps - estimatedAtTime;
        } else {
            diff = bleSpeedMps - this.currentSpeedMps;
        }

        this.applyFeedback(diff, bleSpeedMps, captureTime);
    }
}

/*
 * Algorithm 4: Fixed Lookback Fusion (V4)
 */
class FixedLookbackFusionAlgorithm extends TimeRealignedFusionAlgorithm {
    public name = 'Fixed Lookback (V4)';

    pushBle(rawSpeed: number, arrivalTime: number, latencyMs: number) {
        if (rawSpeed == null || isNaN(rawSpeed)) return;

        const lookback = this.params.lookbackMs ?? 400;
        const captureTime = arrivalTime - lookback;

        this.lastBleSpeedRaw = rawSpeed;
        this.bleSpeedHistory.push({ speed: rawSpeed, time: captureTime });
        if (this.bleSpeedHistory.length > 5) {
            this.bleSpeedHistory.shift();
        }

        if (!this.isCalibrated) {
            this.attemptCalibration();
        }

        const estimatedAtTime = this.getEstimatedSpeedAt(captureTime);
        const bleSpeedMps = rawSpeed * this.speedConversionFactor;

        let diff = 0;
        if (estimatedAtTime !== null) {
            diff = bleSpeedMps - estimatedAtTime;
        } else {
            diff = bleSpeedMps - this.currentSpeedMps;
        }

        this.applyFeedback(diff, bleSpeedMps, captureTime);
    }

    getDebugState(): FusionDebugState {
        const base = super.getDebugState();
        return {
            ...base,
            algorithmName: `Fixed Lookback (${this.params.lookbackMs ?? 400}ms)` + (this.params.slopeCorrectionEnabled ? ' (+Slope)' : '')
        };
    }
}

/*
 * Algorithm 6 (Passthrough)
 */
class PassthroughAlgorithm implements FusionAlgorithm {
    public name = 'Passthrough (BLE Only)';
    private lastSpeed: number = 0;

    reset() { }
    setParams(params: any) { }

    pushMotion(accel: Vector3, timestamp: number) { }

    pushBle(speed: number, arrivalTime: number, latencyMs: number) {
        this.lastSpeed = speed;
    }

    update(dt: number): number {
        return this.lastSpeed;
    }

    getDebugState(): FusionDebugState {
        return {
            algorithmName: this.name,
            bleSpeed: this.lastSpeed,
            fusedSpeed: this.lastSpeed,
            isCalibrated: true,
            conversionFactor: 1.0,
            accelerationMps2: 0,
            gradePercent: 0
        };
    }
}

import { DeviceMotion } from 'expo-sensors';

/*
 * Engine Manager (Singleton)
 */
export class FusionEngine {
    private static instance: FusionEngine;
    private algorithm: FusionAlgorithm;
    private speedListeners: Set<SpeedUpdateCallback> = new Set();
    private calibrationListeners: Set<CalibrationCallback> = new Set();
    private timer: NodeJS.Timeout | null = null;
    private lastUpdateTime: number = 0;
    private motionSubscription: any = null; // Subscription type

    private constructor() {
        this.algorithm = new InertialFusionAlgorithm();
        DeviceMotion.setUpdateInterval(20);
    }

    public static getInstance(): FusionEngine {
        if (!FusionEngine.instance) {
            FusionEngine.instance = new FusionEngine();
        }
        return FusionEngine.instance;
    }

    public subscribe(callback: SpeedUpdateCallback): () => void {
        this.speedListeners.add(callback);
        if (this.speedListeners.size === 1) {
            this.start();
        }
        return () => {
            this.speedListeners.delete(callback);
            if (this.speedListeners.size === 0) {
                this.stop();
            }
        };
    }

    public subscribeCalibration(callback: CalibrationCallback): () => void {
        this.calibrationListeners.add(callback);
        return () => {
            this.calibrationListeners.delete(callback);
        };
    }

    public setAlgorithm(type: 'fusion' | 'passthrough' | 'time-realigned' | 'median-latency' | 'fixed-lookback', params?: any) {
        this.algorithm.reset();

        switch (type) {
            case 'passthrough':
                this.algorithm = new PassthroughAlgorithm();
                break;
            case 'time-realigned':
                this.algorithm = new TimeRealignedFusionAlgorithm();
                break;
            case 'median-latency':
                this.algorithm = new MedianLatencyFusionAlgorithm();
                break;
            case 'fixed-lookback':
                this.algorithm = new FixedLookbackFusionAlgorithm();
                break;
            case 'fusion':
            default:
                this.algorithm = new InertialFusionAlgorithm();
                break;
        }
        if (params) {
            this.algorithm.setParams(params);
        }
        this.notifySpeed(0);
    }

    public setAlgorithmParams(params: any) {
        this.algorithm.setParams(params);
    }

    public getDebugState() {
        return this.algorithm.getDebugState();
    }

    private start() {
        if (this.timer) return;

        // Start Timer
        this.lastUpdateTime = Date.now();
        this.timer = setInterval(this.tick, 20); // 50Hz

        // Start Sensors
        this.startSensors();
    }

    private stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.stopSensors();
    }

    private startSensors() {
        if (this.motionSubscription) return;

        DeviceMotion.requestPermissionsAsync().then(({ status }) => {
            if (status === 'granted') {
                this.motionSubscription = DeviceMotion.addListener((event) => {
                    if (event.acceleration) {
                        this.handleMotionUpdate(event.acceleration);
                    }
                });
            }
        });
    }

    private stopSensors() {
        if (this.motionSubscription) {
            this.motionSubscription.remove();
            this.motionSubscription = null;
        }
    }

    public resetCalibration() {
        this.algorithm.reset();
        this.notifyCalibration(false);
    }

    private handleMotionUpdate(accel: Vector3) {
        this.algorithm.pushMotion(accel, Date.now());
    }

    public addBleMeasurement(speed: number, latencyMs?: number) {
        const now = Date.now();
        const latency = latencyMs ?? 0;
        this.algorithm.pushBle(speed, now, latency);
    }

    private tick = () => {
        const now = Date.now();
        const dt = (now - this.lastUpdateTime) / 1000;
        this.lastUpdateTime = now;

        const newSpeed = this.algorithm.update(dt);
        this.notifySpeed(newSpeed);
        this.notifyCalibration(this.algorithm.getDebugState().isCalibrated);
    };

    private notifySpeed(speed: number) {
        for (const listener of this.speedListeners) {
            listener(speed);
        }
    }

    private notifyCalibration(isCalibrated: boolean) {
        for (const listener of this.calibrationListeners) {
            listener(isCalibrated);
        }
    }
}
