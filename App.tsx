/**
 * Minimal Reproduction: Skia Frame Ordering Bug
 *
 * Issue: https://github.com/Shopify/react-native-skia/issues/3426
 *
 * Problem: When finger is released and animation continues with withTiming/withDecay,
 * frames render out of order causing visual "jumps" or "rewinds".
 *
 * How to reproduce:
 * 1. Touch and drag the grid - motion is perfectly smooth
 * 2. Release finger with some velocity (flick gesture)
 * 3. Watch the momentum animation - frames appear to render out of order
 *    (e.g., instead of 1,2,3,4,5,6,7 you see 1,2,3,4,1,6,7)
 *
 * Key observation: Motion is smooth while finger is touching.
 * Stuttering/frame-rewind only happens after finger is released.
 */

import React, { useState, useCallback, useMemo } from 'react';
import { View, StyleSheet, Dimensions, Text } from 'react-native';
import { Canvas, Group, Image, useImage } from '@shopify/react-native-skia';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  useSharedValue,
  useDerivedValue,
  withTiming,
  Easing,
  runOnJS,
  cancelAnimation,
} from 'react-native-reanimated';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Hex tile dimensions (matching the app's hexMath.ts)
const HEX_TILE_WIDTH = 70;
const HEX_TILE_HEIGHT = 80;
const HEX_HORIZONTAL_SPACING = 68.8; // ~70 * 0.98 for slight overlap
const HEX_VERTICAL_SPACING = 59.5;   // 80 * 0.75 for proper hex stacking

const GRID_SIZE = 50; // 50x50 grid of hex tiles
const MAP_WIDTH = GRID_SIZE * HEX_HORIZONTAL_SPACING + HEX_TILE_WIDTH;
const MAP_HEIGHT = GRID_SIZE * HEX_VERTICAL_SPACING + HEX_TILE_HEIGHT;

// Biome types
type Biome = 'plains' | 'desert' | 'dead';

// Generate hex grid with biome zones
function generateTiles(): { x: number; y: number; biome: Biome }[] {
  const result: { x: number; y: number; biome: Biome }[] = [];

  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      // Calculate hex position (offset odd rows - matching hexMath.ts hexToScreen)
      const isOddRow = row % 2 !== 0;
      const offsetX = isOddRow ? Math.round(HEX_HORIZONTAL_SPACING / 2) : 0;
      const x = Math.round(col * HEX_HORIZONTAL_SPACING + offsetX);
      const y = Math.round(row * HEX_VERTICAL_SPACING);

      // Assign biome based on position (creates distinct zones)
      let biome: Biome;
      const distFromCenter = Math.sqrt(
        Math.pow(col - GRID_SIZE / 2, 2) + Math.pow(row - GRID_SIZE / 2, 2)
      );

      if (distFromCenter < GRID_SIZE / 4) {
        biome = 'dead';      // Center is dead/volcanic
      } else if (distFromCenter < GRID_SIZE / 2) {
        biome = 'desert';    // Middle ring is desert
      } else {
        biome = 'plains';    // Outer area is plains
      }

      result.push({ x, y, biome });
    }
  }

  return result;
}

export default function App() {
  const [updateCount, setUpdateCount] = useState(0);
  const [tick, setTick] = useState(0);

  // Simulate march progress updates - this is what makes the bug visible!
  // The real app has a 250ms interval updating march progress during scroll
  React.useEffect(() => {
    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 250); // Match the real app's MarchRenderer interval
    return () => clearInterval(interval);
  }, []);

  // Load tile images
  const plainsImage = useImage(require('./assets/plains.png'));
  const desertImage = useImage(require('./assets/desert.png'));
  const deadImage = useImage(require('./assets/dead.png'));

  // Generate tiles once
  const tiles = useMemo(() => generateTiles(), []);

  // Shared values for scroll position
  const scrollX = useSharedValue(MAP_WIDTH / 2 - SCREEN_WIDTH / 2);
  const scrollY = useSharedValue(MAP_HEIGHT / 2 - SCREEN_HEIGHT / 2);

  // For gesture tracking
  const startScrollX = useSharedValue(0);
  const startScrollY = useSharedValue(0);

  // Transform for the Group - derived from scroll values
  const transform = useDerivedValue(() => [
    { translateX: -scrollX.value },
    { translateY: -scrollY.value },
  ]);

  // Clamp scroll to valid bounds
  const clampScroll = (x: number, y: number) => {
    'worklet';
    const maxScrollX = Math.max(0, MAP_WIDTH - SCREEN_WIDTH);
    const maxScrollY = Math.max(0, MAP_HEIGHT - SCREEN_HEIGHT);
    return {
      x: Math.max(0, Math.min(x, maxScrollX)),
      y: Math.max(0, Math.min(y, maxScrollY)),
    };
  };

  // Trigger a small state update (makes the bug more visible)
  const triggerStateUpdate = useCallback(() => {
    setUpdateCount(c => c + 1);
  }, []);

  // Pan gesture with momentum
  const panGesture = Gesture.Pan()
    .onStart(() => {
      cancelAnimation(scrollX);
      cancelAnimation(scrollY);
      startScrollX.value = scrollX.value;
      startScrollY.value = scrollY.value;
    })
    .onUpdate((event) => {
      const newX = startScrollX.value - event.translationX;
      const newY = startScrollY.value - event.translationY;
      const clamped = clampScroll(newX, newY);
      scrollX.value = clamped.x;
      scrollY.value = clamped.y;

      // Trigger state updates during drag (makes bug more visible)
      runOnJS(triggerStateUpdate)();
    })
    .onEnd((event) => {
      cancelAnimation(scrollX);
      cancelAnimation(scrollY);

      const velocityX = -event.velocityX;
      const velocityY = -event.velocityY;

      const maxScrollX = Math.max(0, MAP_WIDTH - SCREEN_WIDTH);
      const maxScrollY = Math.max(0, MAP_HEIGHT - SCREEN_HEIGHT);

      // Calculate momentum - higher multiplier = more travel after release
      const MOMENTUM_MULTIPLIER = 0.3;
      const momentumX = velocityX * MOMENTUM_MULTIPLIER;
      const momentumY = velocityY * MOMENTUM_MULTIPLIER;

      const targetX = Math.max(0, Math.min(maxScrollX, scrollX.value + momentumX));
      const targetY = Math.max(0, Math.min(maxScrollY, scrollY.value + momentumY));

      const distance = Math.sqrt(momentumX * momentumX + momentumY * momentumY);
      const duration = Math.min(1200, Math.max(400, distance * 0.8));

      // withTiming momentum (issue still occurs)
      scrollX.value = withTiming(targetX, {
        duration,
        easing: Easing.out(Easing.cubic),
      });

      scrollY.value = withTiming(targetY, {
        duration,
        easing: Easing.out(Easing.cubic),
      });
    });

  // Get image for biome
  const getImageForBiome = (biome: Biome) => {
    switch (biome) {
      case 'plains': return plainsImage;
      case 'desert': return desertImage;
      case 'dead': return deadImage;
    }
  };

  // Loading state
  if (!plainsImage || !desertImage || !deadImage) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>Loading tiles...</Text>
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={styles.container}>
      <GestureDetector gesture={panGesture}>
        <View style={styles.canvasContainer}>
          <Canvas style={styles.canvas}>
            <Group transform={transform}>
              {/* Render hex grid of terrain tiles */}
              {tiles.map((tile, index) => {
                const image = getImageForBiome(tile.biome);
                if (!image) return null;
                return (
                  <Image
                    key={index}
                    image={image}
                    x={tile.x}
                    y={tile.y}
                    width={HEX_TILE_WIDTH}
                    height={HEX_TILE_HEIGHT}
                  />
                );
              })}
            </Group>
          </Canvas>

          {/* Debug info */}
          <View style={styles.debugOverlay}>
            <Text style={styles.debugText}>
              Drag updates: {updateCount} | Tick: {tick}
            </Text>
            <Text style={styles.debugText}>
              Flick to scroll - watch for stuttering after release
            </Text>
            <Text style={styles.debugHint}>
              State updates every 250ms (like march progress)
            </Text>
          </View>
        </View>
      </GestureDetector>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  canvasContainer: {
    flex: 1,
  },
  canvas: {
    flex: 1,
  },
  loading: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#fff',
    fontSize: 18,
  },
  debugOverlay: {
    position: 'absolute',
    top: 50,
    left: 10,
    right: 10,
    backgroundColor: 'rgba(0,0,0,0.8)',
    padding: 12,
    borderRadius: 8,
  },
  debugText: {
    color: '#fff',
    fontSize: 14,
    fontFamily: 'monospace',
  },
  debugHint: {
    color: '#f1c40f',
    fontSize: 12,
    fontFamily: 'monospace',
    marginTop: 4,
  },
});
