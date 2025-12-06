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
}

export type SpeedUpdateCallback = (speed: number) => void;
export type CalibrationCallback = (isCalibrated: boolean) => void;

/*
 * Strategy Interface
 */
export interface FusionAlgorithm {
    name: string;
    reset(): void;
    pushMotion(accel: Vector3, timestamp: number): void;
    // Updated signature: now takes arrivalTime and latencyMs explicitly
    pushBle(speed: number, arrivalTime: number, latencyMs: number): void;
    update(dt: number): number;
    getDebugState(): FusionDebugState;
}

const MIN_CALIBRATION_SPEED = 5;
const MIN_SENSOR_ACCEL = 0.5;
const FILTER_GAIN_BLE = 0.15;
const SPEED_DECAY = 0.9995;

/*
 * Base Class for Inertial Physics & Calibration
 */
abstract class BaseInertialAlgorithm implements FusionAlgorithm {
    public abstract name: string;

    protected currentSpeedMps: number = 0;
    protected lastBleSpeedRaw: number = 0;

    protected forwardVector: Vector3 | null = null;
    protected speedConversionFactor: number = 0.44704;
    protected isCalibrated: boolean = false;

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
        this.onReset();
    }

    protected onReset() { }

    pushMotion(accel: Vector3, timestamp: number) {
        this.recentAccels.push({ vec: accel, time: timestamp });
        const cutoff = timestamp - 2000;
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

    protected computeInstantAcceleration(): number {
        if (!this.forwardVector || this.recentAccels.length === 0) return 0;

        const latest = this.recentAccels[this.recentAccels.length - 1].vec;
        const fx = this.forwardVector.x;
        const fy = this.forwardVector.y;
        const fz = this.forwardVector.z;

        const forwardAccelMps2 = (latest.x * fx) + (latest.y * fy) + (latest.z * fz);
        if (Math.abs(forwardAccelMps2) > 0.1) {
            return forwardAccelMps2;
        }
        return 0;
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
            for (const item of this.recentAccels) {
                if (item.time >= prev.time && item.time <= latest.time) {
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
        // V1 Logic: Compare against CURRENT state, ignore latency
        const diff = bleSpeedMps - this.currentSpeedMps;

        if (Math.abs(diff) > 5.0) {
            this.currentSpeedMps = bleSpeedMps;
        } else {
            this.currentSpeedMps += diff * FILTER_GAIN_BLE;
        }

        if (this.currentSpeedMps < 0) this.currentSpeedMps = 0;
    }
}

/*
 * Algorithm 2: Time-Realigned Fusion (V2)
 */
class TimeRealignedFusionAlgorithm extends BaseInertialAlgorithm {
    public name = 'Time-Realigned Fusion (V2)';

    protected outputHistory: { speedMps: number; time: number }[] = [];

    protected onReset() {
        this.outputHistory = [];
    }

    protected onPostUpdate(dt: number) {
        this.recordHistory(this.currentSpeedMps, Date.now());
    }

    pushBle(rawSpeed: number, arrivalTime: number, latencyMs: number) {
        if (rawSpeed == null || isNaN(rawSpeed)) return;

        // Capture time is simply arrival minus the reported latency
        const captureTime = arrivalTime - latencyMs;

        this.lastBleSpeedRaw = rawSpeed;
        this.bleSpeedHistory.push({ speed: rawSpeed, time: captureTime });
        if (this.bleSpeedHistory.length > 5) {
            this.bleSpeedHistory.shift();
        }

        if (!this.isCalibrated) {
            this.attemptCalibration();
        }

        // V2 Logic: Compare against HISTORICAL state at capture time
        const estimatedAtTime = this.getEstimatedSpeedAt(captureTime);
        const bleSpeedMps = rawSpeed * this.speedConversionFactor;

        let diff = 0;
        if (estimatedAtTime !== null) {
            diff = bleSpeedMps - estimatedAtTime;
        } else {
            diff = bleSpeedMps - this.currentSpeedMps;
        }

        this.applyCorrection(diff, bleSpeedMps);
    }

    protected applyCorrection(diff: number, rawBleMps: number) {
        if (Math.abs(diff) > 5.0) {
            this.currentSpeedMps = rawBleMps;
        } else {
            this.currentSpeedMps += diff * FILTER_GAIN_BLE;
        }
        if (this.currentSpeedMps < 0) this.currentSpeedMps = 0;
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

    private latencyHistory: number[] = [];

    protected onReset() {
        super.onReset();
        this.latencyHistory = [];
    }

    pushBle(rawSpeed: number, arrivalTime: number, latencyMs: number) {
        if (rawSpeed == null || isNaN(rawSpeed)) return;

        // 1. Buffer Latency
        this.latencyHistory.push(latencyMs);
        if (this.latencyHistory.length > 10) {
            this.latencyHistory.shift();
        }

        // 2. Compute Median Latency
        const sorted = [...this.latencyHistory].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const medianLatency = sorted.length % 2 !== 0
            ? sorted[mid]
            : (sorted[mid - 1] + sorted[mid]) / 2;

        // 3. Use Median for Capture Time
        const captureTime = arrivalTime - medianLatency;

        // 4. Standard V2 Logic from here down
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

        this.applyCorrection(diff, bleSpeedMps);
    }
}


/*
 * Algorithm 4: Passthrough
 */
class PassthroughAlgorithm implements FusionAlgorithm {
    public name = 'Passthrough (BLE Only)';
    private lastSpeed: number = 0;

    reset() { }

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
            accelerationMps2: 0
        };
    }
}

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

    private constructor() {
        this.algorithm = new InertialFusionAlgorithm();
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

    public setAlgorithm(type: 'fusion' | 'passthrough' | 'time-realigned' | 'median-latency') {
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
            case 'fusion':
            default:
                this.algorithm = new InertialFusionAlgorithm();
                break;
        }
        this.notifySpeed(0);
    }

    public getDebugState() {
        return this.algorithm.getDebugState();
    }

    private start() {
        if (this.timer) return;
        this.lastUpdateTime = Date.now();
        this.timer = setInterval(this.tick, 20); // 50Hz
    }

    private stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    public resetCalibration() {
        this.algorithm.reset();
        this.notifyCalibration(false);
    }

    public handleMotionUpdate(accel: Vector3) {
        this.algorithm.pushMotion(accel, Date.now());
    }

    public addBleMeasurement(speed: number, latencyMs?: number) {
        const now = Date.now();
        const latency = latencyMs ?? 0;
        // Passed explicitly to algorithm now
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
