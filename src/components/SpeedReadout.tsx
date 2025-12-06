import React from 'react';
import { Text, StyleSheet, Platform, View } from 'react-native';
import { useFusedSpeed } from '@hooks/useFusedSpeed';

interface SpeedReadoutProps {
    fontSize: number;
    theme: {
        speedText: string;
    };
}

export function SpeedReadout({ fontSize, theme }: SpeedReadoutProps) {
    const { speed, isCalibrated } = useFusedSpeed();

    const activeColor = isCalibrated ? theme.speedText : theme.speedText;

    const formatSpeed = (val: number) => {
        const rounded = Math.max(0, Math.round(val));
        return String(rounded).padStart(2, '0');
    };

    return (
        <Text
            style={[styles.speed, { fontSize, color: activeColor, opacity: isCalibrated ? 1 : 0.7 }]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.2}
        >
            {formatSpeed(speed)}
        </Text>
    );
}

const styles = StyleSheet.create({
    speed: {
        fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
        fontVariant: ['tabular-nums'],
        fontWeight: '200',
        letterSpacing: -6,
        textAlign: 'right',
    },
});
