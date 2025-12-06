export interface Vector3 {
    x: number;
    y: number;
    z: number;
}

export type SpeedUpdateCallback = (speed: number) => void;
export type CalibrationCallback = (isCalibrated: boolean) => void;

const PREDICTION_INTERVAL_MS = 20; // 50Hz update rate for smooth UI
const MIN_CALIBRATION_SPEED = 5; // Raw units (e.g. 5 MPH)
const MIN_SENSOR_ACCEL = 0.5; // m/s^2, significant motion required
const FILTER_GAIN_BLE = 0.15; // Trust BLE correction
const SPEED_DECAY = 0.995;

export class FusionEngine {
    private currentSpeedMps: number = 0;
    private lastUpdateTime: number = 0;

    private forwardVector: Vector3 | null = null;
    private speedConversionFactor: number = 0.44704; // Default to MPH -> m/s
    private isCalibrated: boolean = false;

    // Buffers for calibration
    private recentAccels: { vec: Vector3; time: number }[] = [];
    private bleSpeedHistory: { speed: number; time: number }[] = [];

    private onSpeedUpdate: SpeedUpdateCallback;
    private onCalibrationChange: CalibrationCallback | null = null;
    private timer: NodeJS.Timeout | null = null;

    constructor(onSpeedUpdate: SpeedUpdateCallback, onCalibrationChange?: CalibrationCallback) {
        this.onSpeedUpdate = onSpeedUpdate;
        this.onCalibrationChange = onCalibrationChange || null;
    }

    public start() {
        this.lastUpdateTime = Date.now();
        this.timer = setInterval(this.tick, PREDICTION_INTERVAL_MS);
    }

    public stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    public resetCalibration() {
        this.forwardVector = null;
        this.speedConversionFactor = 0.44704;
        this.isCalibrated = false;
        this.recentAccels = [];
        this.notifyCalibration(false);
    }

    public handleMotionUpdate(accel: Vector3) {
        const now = Date.now();
        this.recentAccels.push({ vec: accel, time: now });

        // Prune old accels (> 2s)
        const cutoff = now - 2000;
        while (this.recentAccels.length > 0 && this.recentAccels[0].time < cutoff) {
            this.recentAccels.shift();
        }

        if (!this.forwardVector) {
            this.attemptCalibration();
        }
    }

    public addBleMeasurement(rawSpeed: number) {
        if (rawSpeed == null || isNaN(rawSpeed)) return;

        const now = Date.now();
        this.bleSpeedHistory.push({ speed: rawSpeed, time: now });
        if (this.bleSpeedHistory.length > 5) {
            this.bleSpeedHistory.shift();
        }

        if (!this.forwardVector) {
            this.attemptCalibration();
        }

        const bleSpeedMps = rawSpeed * this.speedConversionFactor;

        // Apply correction
        const diff = bleSpeedMps - this.currentSpeedMps;

        // If diff is huge, jump immediately (reset)
        if (Math.abs(diff) > 5.0) {
            this.currentSpeedMps = bleSpeedMps;
        } else {
            this.currentSpeedMps += diff * FILTER_GAIN_BLE;
        }

        if (this.currentSpeedMps < 0) this.currentSpeedMps = 0;

        // Emit back in Raw Units!
        this.emitSpeed();
    }

    private tick = () => {
        const now = Date.now();
        const dt = (now - this.lastUpdateTime) / 1000;
        this.lastUpdateTime = now;

        if (!this.forwardVector || this.recentAccels.length === 0) {
            return;
        }

        const latest = this.recentAccels[this.recentAccels.length - 1].vec;

        // Project acceleration
        const forwardAccelMps2 = (latest.x * this.forwardVector.x) +
            (latest.y * this.forwardVector.y) +
            (latest.z * this.forwardVector.z);

        // Deadzone
        let effectiveAccel = 0;
        if (Math.abs(forwardAccelMps2) > 0.1) {
            effectiveAccel = forwardAccelMps2;
        }

        // Integrate
        this.currentSpeedMps += effectiveAccel * dt;
        this.currentSpeedMps *= SPEED_DECAY;

        if (this.currentSpeedMps < 0) this.currentSpeedMps = 0;

        this.emitSpeed();
    };

    private emitSpeed() {
        // Convert m/s back to Raw Units
        const rawSpeed = this.currentSpeedMps / this.speedConversionFactor;
        this.onSpeedUpdate(rawSpeed);
    }

    private attemptCalibration() {
        if (this.bleSpeedHistory.length < 2) return;

        const latest = this.bleSpeedHistory[this.bleSpeedHistory.length - 1];
        const prev = this.bleSpeedHistory[0];

        const speedDeltaRaw = latest.speed - prev.speed;
        const timeDelta = (latest.time - prev.time) / 1000;

        if (timeDelta <= 0.5) return; // Need at least 500ms window

        const rawAccel = speedDeltaRaw / timeDelta;

        // Condition: Significant acceleration reported by Vehicle
        // equivalent to > 0.5 m/s^2 approx
        if (rawAccel > 1.0 && latest.speed > MIN_CALIBRATION_SPEED) {
            // Find average phone accel vector in this window
            let sumX = 0, sumY = 0, sumZ = 0, count = 0;

            for (const item of this.recentAccels) {
                if (item.time >= prev.time && item.time <= latest.time) {
                    sumX += item.vec.x;
                    sumY += item.vec.y;
                    sumZ += item.vec.z;
                    count++;
                }
            }

            if (count < 5) return; // Not enough samples

            const avgX = sumX / count;
            const avgY = sumY / count;
            const avgZ = sumZ / count;
            const magnitude = Math.sqrt(avgX * avgX + avgY * avgY + avgZ * avgZ);

            if (magnitude > MIN_SENSOR_ACCEL) {
                // 1. Determine Forward Vector
                const newForward = {
                    x: avgX / magnitude,
                    y: avgY / magnitude,
                    z: avgZ / magnitude
                };
                this.forwardVector = newForward;

                // 2. Determine Scale Factor (Unit Detection)
                // SensorAccel (m/s^2) = RawAccel (units/s^2) * Factor
                // Factor = SensorAccel / RawAccel
                // SensorAccel here is roughly equal to 'magnitude' because we aligned with it.
                const newFactor = magnitude / rawAccel;

                // Sanity check factor
                // MPH: 0.447, KPH: 0.278
                // Allow some noise, but it should be close to one of these
                if (newFactor > 0.2 && newFactor < 0.6) {
                    this.speedConversionFactor = newFactor;
                    console.log(`[FusionEngine] Calibrated: K=${newFactor.toFixed(3)} (MPH≈0.45, KPH≈0.28)`);
                    this.isCalibrated = true;
                    this.notifyCalibration(true);
                }
            }
        }
    }

    private notifyCalibration(calibrated: boolean) {
        if (this.onCalibrationChange) {
            this.onCalibrationChange(calibrated);
        }
    }
}
