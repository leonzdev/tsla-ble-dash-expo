import React, { useMemo } from 'react';
import { Text, StyleSheet } from 'react-native';
import { useVehicleStore } from '@state/vehicleStore';
import { useFusedSpeed } from '@hooks/useFusedSpeed';

interface LatencyProps {
    theme: {
        latencyShadow: string;
    };
}

export function LatencyReadout({ theme }: LatencyProps) {
    const latencyMs = useVehicleStore((state) => state.lastLatencyMs);
    const { isCalibrated } = useFusedSpeed(); // Only subscribes to fused state for calibration dot

    const latencyText = useMemo(() => {
        if (latencyMs == null || Number.isNaN(latencyMs)) {
            return 'Latency --';
        }
        return `Latency ${Math.round(latencyMs)} ms`;
    }, [latencyMs]);

    const latencyColor = useMemo(() => {
        if (latencyMs == null || Number.isNaN(latencyMs)) {
            return '#94a3b8';
        }
        if (latencyMs < 300) {
            return '#22c55e';
        }
        if (latencyMs < 800) {
            return '#facc15';
        }
        return '#f87171';
    }, [latencyMs]);

    return (
        <Text style={[styles.latency, { color: latencyColor, textShadowColor: theme.latencyShadow }]}>
            {latencyText} {isCalibrated ? '•' : ''}
        </Text>
    );
}

const styles = StyleSheet.create({
    latency: {
        fontSize: 16,
        fontWeight: '700',
        letterSpacing: 1.25,
        textTransform: 'uppercase',
        textShadowRadius: 2,
        textShadowOffset: { width: 0, height: 1 },
    },
});
