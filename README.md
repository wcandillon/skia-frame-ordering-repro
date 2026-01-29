# Skia Frame Ordering Bug Reproduction

Minimal reproduction for [react-native-skia issue #3426](https://github.com/Shopify/react-native-skia/issues/3426)

## Problem

When finger is released and animation continues with `withTiming` or `withDecay`, frames render **out of order** causing visual "jumps" or "rewinds".

**Expected:** Frames render as `1, 2, 3, 4, 5, 6, 7`
**Actual:** Frames render as `1, 2, 3, 4, 1, 6, 7` (frame shows old transform)

## Key Observation

- Motion is **perfectly smooth while finger is touching and moving**
- Stuttering/frame-rewind **only happens after finger is released**
- FPS stays stable - it's not frame drops, it's frame reordering

## Setup

```bash
npm install
npx expo prebuild
npx expo run:ios   # or run:android
```

## How to Reproduce

1. **Touch and drag** the grid - motion is perfectly smooth
2. **Release finger with velocity** (flick gesture) to start momentum animation
3. **Watch carefully** - frames appear to render out of order during momentum
4. **Touch again while animating** - motion becomes smooth again

## Stack

- `@shopify/react-native-skia`: 2.2.12
- `react-native-reanimated`: 4.1.1
- `react-native-gesture-handler`: 2.28.0
- React Native: 0.81.5
- Expo SDK: 54
- New Architecture: Enabled

## Code Structure

The reproduction is a single `App.tsx` with:

1. **Skia Canvas** with a Group using `transform` derived value
2. **Pan gesture** with momentum animation after finger release
3. **250ms interval** triggering React state updates (simulates march progress updates)
4. **50x50 hex grid** of terrain tiles

## Key Factor

The bug becomes visible when **both** of these happen simultaneously:
- UI thread running Skia transform animation (momentum scroll)
- JS thread triggering React re-renders (state updates)

The cross-thread timing conflict causes frames to render out of order.

## Workarounds Tried (No Fix)

1. ❌ `cancelAnimation()` before applying new animations
2. ❌ Replacing `withDecay` with `withTiming`
3. ❌ Using Skia Matrix vs transform array
4. ❌ Disabling React state updates

## Related Issues

- #3426 - Performance Regression: Smooth pan becomes stuttery after finger release
- #3327 - Performance tanks with animated transform
- #2136 - Laggy animations with translateX

## Notes from Investigation

The issue started appearing in **Skia versions after 1.9.0**. On 1.9.0 everything is smooth.
