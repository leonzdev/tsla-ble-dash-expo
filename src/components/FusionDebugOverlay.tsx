import React from 'react';
import { Text, View, StyleSheet, Platform } from 'react-native';
import { useFusedSpeed } from '@hooks/useFusedSpeed';

export function FusionDebugOverlay() {
    const { debugState } = useFusedSpeed();

    if (!debugState) return null;

    return (
        <View style={styles.debugOverlay}>
            <Text style={styles.debugText}>ALGO: {debugState.algorithmName}</Text>
            <Text style={styles.debugText}>BLE: {debugState.bleSpeed?.toFixed(1)}</Text>
            <Text style={styles.debugText}>FUSED: {debugState.fusedSpeed?.toFixed(1)}</Text>
            <Text style={styles.debugText}>ACCEL: {debugState.accelerationMps2?.toFixed(2)}</Text>
            <Text style={styles.debugText}>SCALE: {debugState.conversionFactor?.toFixed(3)}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    debugOverlay: {
        position: 'absolute',
        top: 40,
        left: 20,
        backgroundColor: 'rgba(0,0,0,0.7)',
        padding: 8,
        borderRadius: 8,
    },
    debugText: {
        color: '#0f0',
        fontSize: 12,
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
});
