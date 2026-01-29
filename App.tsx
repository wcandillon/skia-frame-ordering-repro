/**
 * Optimized Skia Atlas Demo
 *
 * This version uses the Atlas API for high-performance rendering:
 * - Single draw call for all tiles using Atlas
 * - All transforms computed on the UI thread (worklet)
 * - No JS re-renders during animation
 *
 * Original issue: https://github.com/Shopify/react-native-skia/issues/3426
 */

import React, { useMemo } from 'react';
import { View, StyleSheet, Dimensions, Text } from 'react-native';
import {
  Canvas,
  Atlas,
  useImage,
  rect,
  useRSXformBuffer,
  SkRect,
} from '@shopify/react-native-skia';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  useSharedValue,
  withTiming,
  Easing,
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

// Biome types - indices match the vertical position in atlas
const BIOME_PLAINS = 0;
const BIOME_DESERT = 1;
const BIOME_DEAD = 2;

type TileData = { x: number; y: number; biome: number };

// Generate hex grid with biome zones
function generateTiles(): TileData[] {
  const result: TileData[] = [];

  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      // Calculate hex position (offset odd rows - matching hexMath.ts hexToScreen)
      const isOddRow = row % 2 !== 0;
      const offsetX = isOddRow ? Math.round(HEX_HORIZONTAL_SPACING / 2) : 0;
      const x = Math.round(col * HEX_HORIZONTAL_SPACING + offsetX);
      const y = Math.round(row * HEX_VERTICAL_SPACING);

      // Assign biome based on position (creates distinct zones)
      let biome: number;
      const distFromCenter = Math.sqrt(
        Math.pow(col - GRID_SIZE / 2, 2) + Math.pow(row - GRID_SIZE / 2, 2)
      );

      if (distFromCenter < GRID_SIZE / 4) {
        biome = BIOME_DEAD;      // Center is dead/volcanic
      } else if (distFromCenter < GRID_SIZE / 2) {
        biome = BIOME_DESERT;    // Middle ring is desert
      } else {
        biome = BIOME_PLAINS;    // Outer area is plains
      }

      result.push({ x, y, biome });
    }
  }

  return result;
}

export default function App() {
  // Load the atlas image (all 3 biomes stacked vertically: plains, desert, dead)
  const atlasImage = useImage(require('./assets/atlas.png'));

  // Generate tiles once - this is static data
  const tiles = useMemo(() => generateTiles(), []);
  const tileCount = tiles.length;

  // Pre-compute sprite rectangles for each tile based on biome
  // Each sprite references a region in the atlas image
  const sprites = useMemo((): SkRect[] => {
    return tiles.map((tile) => {
      // Each biome is stacked vertically in the atlas
      const srcY = tile.biome * HEX_TILE_HEIGHT;
      return rect(0, srcY, HEX_TILE_WIDTH, HEX_TILE_HEIGHT);
    });
  }, [tiles]);

  // Pre-compute base positions for each tile (static, won't change)
  const tilePositions = useMemo(() => {
    return tiles.map((tile) => ({ x: tile.x, y: tile.y }));
  }, [tiles]);

  // Shared values for scroll position
  const scrollX = useSharedValue(MAP_WIDTH / 2 - SCREEN_WIDTH / 2);
  const scrollY = useSharedValue(MAP_HEIGHT / 2 - SCREEN_HEIGHT / 2);

  // For gesture tracking
  const startScrollX = useSharedValue(0);
  const startScrollY = useSharedValue(0);

  // RSXform buffer - transforms computed entirely on UI thread
  // This is the key optimization: no JS re-renders needed!
  const transforms = useRSXformBuffer(tileCount, (val, i) => {
    'worklet';
    const pos = tilePositions[i];
    // RSXform: set(cos(rotation), sin(rotation), tx, ty)
    // For no rotation, cos(0)=1, sin(0)=0
    const tx = pos.x - scrollX.value;
    const ty = pos.y - scrollY.value;
    val.set(1, 0, tx, ty);
  });

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

  // Pan gesture with momentum - runs entirely on UI thread
  const panGesture = Gesture.Pan()
    .onStart(() => {
      'worklet';
      cancelAnimation(scrollX);
      cancelAnimation(scrollY);
      startScrollX.value = scrollX.value;
      startScrollY.value = scrollY.value;
    })
    .onUpdate((event) => {
      'worklet';
      const newX = startScrollX.value - event.translationX;
      const newY = startScrollY.value - event.translationY;
      const clamped = clampScroll(newX, newY);
      scrollX.value = clamped.x;
      scrollY.value = clamped.y;
    })
    .onEnd((event) => {
      'worklet';
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

      // withTiming momentum - all on UI thread
      scrollX.value = withTiming(targetX, {
        duration,
        easing: Easing.out(Easing.cubic),
      });

      scrollY.value = withTiming(targetY, {
        duration,
        easing: Easing.out(Easing.cubic),
      });
    });

  // Loading state
  if (!atlasImage) {
    return (
      <View style={styles.loading}>
        <Text style={styles.loadingText}>Loading atlas...</Text>
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={styles.container}>
      <GestureDetector gesture={panGesture}>
        <View style={styles.canvasContainer}>
          <Canvas style={styles.canvas}>
            {/* Single Atlas draw call for all 2500 tiles */}
            <Atlas
              image={atlasImage}
              sprites={sprites}
              transforms={transforms}
            />
          </Canvas>

          {/* Debug info */}
          <View style={styles.debugOverlay}>
            <Text style={styles.debugText}>
              Atlas mode: {tileCount} tiles in 1 draw call
            </Text>
            <Text style={styles.debugText}>
              All transforms computed on UI thread (worklet)
            </Text>
            <Text style={styles.debugHint}>
              No JS re-renders during animation
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
