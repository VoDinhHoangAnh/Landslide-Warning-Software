# Danger Zones Button — Design Spec

**Date:** 2026-05-18
**Status:** Approved, ready for implementation plan
**Scope:** Single feature — one button + slider on the map toolbar that filters and highlights dangerous slope units.

---

## 1. Problem

The app currently has a "Slope Units → Factor of Safety" toggle inside the right sidebar (`src/App.jsx:1368-1414`). When enabled, every slope unit polygon in Lao Cai is colored by its pre-computed `fos` value from `public/lao_cai_slope_units.geojson`. In practice:

- The map shows thousands of polygons at once.
- The vast majority are stable (green/blue, FoS ≥ 1.5).
- The dangerous ones (red/orange, FoS < 1.2) are visually drowned out.
- Users wanting to answer "which areas are dangerous?" have to dig into the sidebar, pick a radio button, then visually hunt for red.

## 2. Goal

Provide a one-click, prominent UI surface that **isolates and shows only dangerous slope units**, with a user-controlled threshold slider.

## 3. Non-goals

- Recomputing FoS at runtime (pre-computed values in the geojson are authoritative).
- A ranked top-N dashboard list with fly-to (deferred — YAGNI for v1).
- Persisting the toggle/threshold across page reloads.
- Replacing or removing the existing sidebar Slope Units panel.
- Loading skeletons or transition animations.

## 4. UI

A new toolbar control rendered alongside the existing map overlay buttons (e.g., Inspector, Search) — approximately at `src/App.jsx:1654` area.

**States:**

```
OFF (default):
    [ ⚠ Danger Zones ]

ON:
    [ ⚠ Danger Zones · 1,247 ]   [━━●━━━━ FoS ≤ 1.50 ]
```

- Single button toggles the feature on/off.
- When ON, an inline range slider appears next to the button.
- A badge inside the button shows the live count of slope units matching the current threshold.
- Slider range: `0` to `maxFos` (computed once from the loaded geojson; sensible fallback if data load fails).
- Slider step: `0.05`.
- Initial threshold when first turned on: `1.5` (matches the MARGINAL boundary in `getFosRisk`, `src/utils/slopeStability.js:203-209`).
- Button is **disabled** until `maxFos > 0` (i.e., geojson loaded and parsed).

## 5. Behavior

**On button enable:**
1. Apply a Mapbox filter `['<=', ['get', 'fos'], dangerThreshold]` to both `slope-units-fill` and `slope-units-outline` layers.
2. Apply the existing FoS color gradient (already defined at `src/App.jsx:983-991`) to `slope-units-fill`.
3. Set `fill-opacity: 0.6` and `line-opacity: 0.8`.
4. Update `dangerCount` state.

**On slider drag:**
- Re-apply the filter with the new threshold.
- Recompute `dangerCount` from the cached features array.
- Map re-renders incrementally (Mapbox handles this natively, no extra work).

**On button disable:**
1. Clear the filter on both layers (`setFilter(layerId, null)`).
2. If the sidebar Slope Units toggle is OFF, hide the layers (opacity 0); otherwise let the existing sidebar `useEffect` repaint them.

## 6. Interaction with existing sidebar Slope Units

The sidebar panel (`src/App.jsx:1368-1414`) and the new Danger Zones button share the same Mapbox layer pair. The existing sidebar `useEffect` (`src/App.jsx:935-996`) sets paint properties on `slope-units-fill` whenever `showSlopeUnits` or `slopeUnitColor` changes.

**Conflict-resolution rule:** When `showDangerZones === true`, the Danger Zones effect owns the layer's filter and paint. The existing sidebar effect must short-circuit (early return) so it doesn't overwrite the filter mid-session. The sidebar effect's dependency array gains `showDangerZones` so it re-runs and restores the user's prior sidebar paint settings when Danger Zones is turned off.

This avoids race conditions without removing or rewriting the existing panel.

## 7. State

All state lives in the existing `App` component in `src/App.jsx`. No new files, no new components extracted.

```js
const [showDangerZones, setShowDangerZones] = useState(false);
const [dangerThreshold, setDangerThreshold] = useState(1.5);
const [maxFos, setMaxFos] = useState(0);
const [dangerCount, setDangerCount] = useState(0);
const slopeUnitsFeaturesRef = useRef([]);  // cached for count recompute
```

## 8. Data flow

```
Mount
  └─ fetch('/lao_cai_slope_units.geojson') (one-time, parallel to Mapbox source load)
     └─ slopeUnitsFeaturesRef.current = features
     └─ setMaxFos(Math.max(...features.map(f => f.properties.fos).filter(v => typeof v === 'number')))

User clicks button (setShowDangerZones(true))
  └─ useEffect [showDangerZones, dangerThreshold]:
       - setFilter('slope-units-fill',    ['<=', ['get','fos'], dangerThreshold])
       - setFilter('slope-units-outline', ['<=', ['get','fos'], dangerThreshold])
       - setPaintProperty fill-color = FoS gradient
       - setPaintProperty fill-opacity = 0.6
       - setPaintProperty line-opacity = 0.8
       - setDangerCount(filtered features count)

User drags slider (setDangerThreshold(v))
  └─ same useEffect re-runs, only filter + count change

User clicks button again (setShowDangerZones(false))
  └─ useEffect clears filter
  └─ Sidebar Slope Units useEffect re-runs (dependency includes showDangerZones)
     - If sidebar showSlopeUnits is true → restores its own paint
     - Else → hides layer (opacity 0)
```

## 9. Edge cases

| Case | Handling |
|---|---|
| GeoJSON not loaded yet | Button disabled (`maxFos === 0`) |
| Feature has `fos === null` or non-numeric | Mapbox filter `<=` naturally excludes; count uses `typeof f.properties.fos === 'number'` |
| Threshold yields zero matches | Show `0` in badge; show a small inline hint next to the slider ("Hạ ngưỡng để thấy vùng" / "Lower threshold to see zones") |
| Style not loaded when effect fires | Guard with `map.current?.isStyleLoaded() && map.current.getLayer('slope-units-fill')` (existing pattern at `src/App.jsx:769, 824`) |
| Slider value exceeds maxFos | Clamp in onChange with `Math.min(parseFloat(e.target.value), maxFos)` |
| Fetch fails | `maxFos` stays at 0 → button stays disabled. Acceptable; the main app already depends on the same geojson. |

## 10. Code structure & scope

**Files touched:**
- `src/App.jsx` — only this file changes.

**Approximate additions:** ~80 lines (state, fetch effect, danger zones effect, sidebar effect guard, JSX for button + slider).

**No new dependencies.** No new components extracted (the feature is small and tightly coupled to map state already living in `App`).

## 11. Testing

Per project CLAUDE.md guidance ("for UI/frontend changes, start the dev server and use the feature in a browser"):

- Run `npm run dev`, open the app.
- Verify the button is disabled until the slope-units geojson finishes loading.
- Verify the badge count matches the number of red/orange polygons rendered on the map.
- Verify dragging the slider live-updates both the visible polygons and the badge count.
- Verify turning the button OFF restores the prior map state:
  - If the sidebar Slope Units panel was off → map clears slope units.
  - If the sidebar was showing `mean_slope` color → map returns to mean_slope coloring.
- Verify the feature works at multiple zoom levels and that filter does not break Inspector hover / Search.

## 12. Out of scope (future work)

- Top-N ranked list with fly-to actions.
- Multi-criteria filter (FoS + slope angle + rainfall).
- Exporting the filtered set to CSV/GeoJSON.
- Persisting threshold preference across sessions.
- Animated entrance for newly-visible polygons.
