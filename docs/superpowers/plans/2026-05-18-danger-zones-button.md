# Danger Zones Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggleable "Danger Zones" button + threshold slider on the map that filters and colors `slope-units` polygons by their pre-computed Factor of Safety (FoS), isolating dangerous areas from the visual noise of stable ones.

**Architecture:** All changes are contained in `src/App.jsx`. We add four pieces of state, one fetch-on-mount effect to build a features cache and compute `maxFos`, one filter/paint effect for the new feature, an early-return guard in the existing sidebar Slope Units effect so the two don't fight over the same Mapbox layer, and a new floating overlay UI on the map (button + slider + count badge).

**Tech Stack:** React 19, Mapbox GL JS 3.20, Vite 8, Tailwind 4. No test framework in this project — verification is via ESLint and manual browser QA (per project CLAUDE.md guidance).

**Spec:** `docs/superpowers/specs/2026-05-18-danger-zones-button-design.md`

---

## Pre-flight

- [ ] **Step 0.1: Confirm baseline builds + lints cleanly**

```bash
cd C:\Users\024792\Downloads\landslide
npm run lint
```

Expected: exits 0, no errors. (Warnings about `react-refresh/only-export-components` etc. may exist — they are baseline and should not change.)

- [ ] **Step 0.2: Confirm dev server starts**

```bash
npm run dev:fe
```

Open `http://localhost:5173` (or whichever port Vite logs), confirm map loads with Lao Cai layers. Stop the server (Ctrl+C). No commit — this is just a smoke check.

---

## Task 1: Add state declarations

**Files:**
- Modify: `src/App.jsx:402-404` (insert after the existing "Slope units" state block)

- [ ] **Step 1.1: Add four new `useState` declarations and a features ref**

Locate this existing block at `src/App.jsx:402-404`:

```jsx
  // Slope units
  const [showSlopeUnits, setShowSlopeUnits] = useState(false);
  const [slopeUnitColor, setSlopeUnitColor] = useState('fos');
```

Replace it with:

```jsx
  // Slope units
  const [showSlopeUnits, setShowSlopeUnits] = useState(false);
  const [slopeUnitColor, setSlopeUnitColor] = useState('fos');

  // Danger Zones (FoS filter overlay on slope-units layer)
  const [showDangerZones, setShowDangerZones] = useState(false);
  const [dangerThreshold, setDangerThreshold] = useState(1.5);
  const [maxFos, setMaxFos] = useState(0);
  const [dangerCount, setDangerCount] = useState(0);
  const slopeUnitsFeaturesRef = useRef([]);
```

- [ ] **Step 1.2: Verify the file still parses**

```bash
npm run lint
```

Expected: exits 0. No new errors. (If you see "useRef is not defined", check that `useRef` is already imported at the top of `App.jsx` — it is, alongside `useState` and `useEffect`.)

- [ ] **Step 1.3: Commit**

```bash
git add src/App.jsx
git commit -m "feat(danger-zones): add state for FoS filter overlay"
```

---

## Task 2: Fetch slope-units features once on mount, compute maxFos

**Files:**
- Modify: `src/App.jsx` (add a new `useEffect` near the other top-level data-loading effects; placement: directly after the existing "Slope units visualization" effect that ends near `src/App.jsx:996`)

- [ ] **Step 2.1: Add the fetch effect**

Locate the closing of the slope-units visualization effect at roughly `src/App.jsx:996`:

```jsx
    map.current.setPaintProperty('slope-units-fill', 'fill-color', colorMaps[slopeUnitColor] || colorMaps.mean_slope);
    map.current.setPaintProperty('slope-units-fill', 'fill-opacity', 0.5);
  }, [showSlopeUnits, slopeUnitColor]);
```

Immediately after that closing `}, [...]);`, add this new effect:

```jsx
  // Danger Zones: fetch slope-units geojson once, cache features + compute max FoS
  useEffect(() => {
    let cancelled = false;
    fetch('/lao_cai_slope_units.geojson')
      .then(r => r.json())
      .then(geojson => {
        if (cancelled) return;
        const feats = geojson?.features || [];
        slopeUnitsFeaturesRef.current = feats;
        const fosValues = feats
          .map(f => f?.properties?.fos)
          .filter(v => typeof v === 'number' && Number.isFinite(v));
        if (fosValues.length > 0) {
          setMaxFos(Math.max(...fosValues));
        }
      })
      .catch(err => {
        console.error('Danger Zones: failed to load slope-units geojson', err);
      });
    return () => { cancelled = true; };
  }, []);
```

- [ ] **Step 2.2: Verify lint**

```bash
npm run lint
```

Expected: exits 0.

- [ ] **Step 2.3: Manual browser check — confirm maxFos is computed**

Run `npm run dev:fe`, open the app, and in DevTools console paste this temporarily into the React DevTools or add a `console.log('maxFos', maxFos)` line near the JSX (then remove it). Confirm a numeric value (something between ~3 and ~99) gets logged after the geojson loads. Remove any temporary logs before committing.

(Stable alternative: open Network tab in DevTools, see `/lao_cai_slope_units.geojson` 200 OK on page load. The compute logic is simple enough that the lint pass + a visible network fetch is sufficient evidence.)

- [ ] **Step 2.4: Commit**

```bash
git add src/App.jsx
git commit -m "feat(danger-zones): fetch slope-units features and compute maxFos"
```

---

## Task 3: Add Danger Zones filter/paint effect

**Files:**
- Modify: `src/App.jsx` (add a new `useEffect` directly after the Task 2 fetch effect)

- [ ] **Step 3.1: Add the filter effect**

Directly after the fetch effect from Task 2, add:

```jsx
  // Danger Zones: apply filter + FoS color when toggled on
  useEffect(() => {
    if (!map.current || !map.current.isStyleLoaded()) return;
    if (!map.current.getLayer('slope-units-fill')) return;

    if (!showDangerZones) {
      map.current.setFilter('slope-units-fill', null);
      map.current.setFilter('slope-units-outline', null);
      // If the sidebar Slope Units panel is also OFF, hide the layer.
      // If it's ON, its own effect (which re-runs because showDangerZones is in its deps)
      // will repaint it.
      if (!showSlopeUnits) {
        map.current.setPaintProperty('slope-units-fill', 'fill-opacity', 0);
        map.current.setPaintProperty('slope-units-outline', 'line-opacity', 0);
      }
      return;
    }

    const fosColor = [
      'interpolate', ['linear'], ['get', 'fos'],
      0.5, '#d7191c',
      0.8, '#e85285',
      1.0, '#fdae61',
      1.2, '#ffffbf',
      1.5, '#abdda4',
      3.0, '#2b83ba'
    ];
    const filterExpr = ['<=', ['get', 'fos'], dangerThreshold];

    map.current.setFilter('slope-units-fill', filterExpr);
    map.current.setFilter('slope-units-outline', filterExpr);
    map.current.setPaintProperty('slope-units-fill', 'fill-color', fosColor);
    map.current.setPaintProperty('slope-units-fill', 'fill-opacity', 0.6);
    map.current.setPaintProperty('slope-units-outline', 'line-opacity', 0.8);
    map.current.setPaintProperty('slope-units-outline', 'line-width', 1.2);

    const count = slopeUnitsFeaturesRef.current.filter(
      f => typeof f?.properties?.fos === 'number' && f.properties.fos <= dangerThreshold
    ).length;
    setDangerCount(count);
  }, [showDangerZones, dangerThreshold, showSlopeUnits]);
```

Note: `showSlopeUnits` is in the dep array so that turning Slope Units on/off while Danger Zones is off correctly re-evaluates the hide branch.

- [ ] **Step 3.2: Verify lint**

```bash
npm run lint
```

Expected: exits 0. (If a "react-hooks/exhaustive-deps" warning fires about `slopeUnitsFeaturesRef.current` not being in deps — that's expected and acceptable; refs intentionally don't trigger effects.)

- [ ] **Step 3.3: Commit**

```bash
git add src/App.jsx
git commit -m "feat(danger-zones): add filter+paint effect for slope-units layer"
```

---

## Task 4: Guard existing sidebar Slope Units effect

**Files:**
- Modify: `src/App.jsx:935-996` (the existing slope-units visualization effect)

The existing effect currently fights for control of `slope-units-fill`'s paint and filter. We need it to defer to Danger Zones when that's active, and to re-run whenever `showDangerZones` changes (so it can restore its own paint when Danger Zones turns off).

- [ ] **Step 4.1: Read the current effect**

Re-read `src/App.jsx:935-996` so you have the existing code in your head before editing.

- [ ] **Step 4.2: Add early-return guard at top of effect**

Find this block (currently at `src/App.jsx:935-944`):

```jsx
  // Slope units visualization
  useEffect(() => {
    if (!map.current || !map.current.isStyleLoaded()) return;
    if (!map.current.getLayer('slope-units-fill')) return;

    if (!showSlopeUnits) {
      map.current.setPaintProperty('slope-units-fill', 'fill-color', 'rgba(0,0,0,0)');
      map.current.setPaintProperty('slope-units-fill', 'fill-opacity', 1);
      map.current.setPaintProperty('slope-units-outline', 'line-opacity', 0);
      return;
    }
```

Replace it with:

```jsx
  // Slope units visualization
  useEffect(() => {
    if (!map.current || !map.current.isStyleLoaded()) return;
    if (!map.current.getLayer('slope-units-fill')) return;

    // Danger Zones owns the layer while it's on. Skip this effect.
    if (showDangerZones) return;

    // Danger Zones may have left a filter behind — clear it before repainting.
    map.current.setFilter('slope-units-fill', null);
    map.current.setFilter('slope-units-outline', null);

    if (!showSlopeUnits) {
      map.current.setPaintProperty('slope-units-fill', 'fill-color', 'rgba(0,0,0,0)');
      map.current.setPaintProperty('slope-units-fill', 'fill-opacity', 1);
      map.current.setPaintProperty('slope-units-outline', 'line-opacity', 0);
      return;
    }
```

- [ ] **Step 4.3: Add `showDangerZones` to the effect's dependency array**

The effect currently ends with `}, [showSlopeUnits, slopeUnitColor]);` at `src/App.jsx:996`. Change that closing line to:

```jsx
  }, [showSlopeUnits, slopeUnitColor, showDangerZones]);
```

- [ ] **Step 4.4: Verify lint**

```bash
npm run lint
```

Expected: exits 0.

- [ ] **Step 4.5: Commit**

```bash
git add src/App.jsx
git commit -m "fix(slope-units): defer to Danger Zones when it owns the layer"
```

---

## Task 5: Add the floating overlay UI (button + slider + badge)

**Files:**
- Modify: `src/App.jsx` (insert JSX inside the existing map container `<div>`, around `src/App.jsx:1681-1691`)

- [ ] **Step 5.1: Locate the map container JSX**

Find this block at roughly `src/App.jsx:1681-1691`:

```jsx
      {/* Map Container */}
      <div className="absolute top-0 right-0 h-full" style={{ width: 'calc(100vw - 20rem)' }}>
        <div ref={mapContainer} className="w-full h-full" />
        
        {/* Crosshair when active */}
        {isInspectorActive && (
          <div className="absolute top-1/2 left-1/2 w-4 h-4 -mt-2 -ml-2 pointer-events-none z-10 flex items-center justify-center opacity-50 mix-blend-difference">
             <div className="absolute w-full h-[1px] bg-black"></div>
             <div className="absolute h-full w-[1px] bg-black"></div>
          </div>
        )}
      </div>
```

- [ ] **Step 5.2: Insert the Danger Zones overlay after the crosshair**

Add this block just before the closing `</div>` of the map container (i.e., after the crosshair block):

```jsx
        {/* Danger Zones overlay */}
        <div className="absolute top-4 left-4 z-20 flex items-center gap-2 bg-white/95 backdrop-blur-sm rounded-lg shadow-lg border border-slate-200 px-3 py-2">
          <button
            onClick={() => setShowDangerZones(!showDangerZones)}
            disabled={maxFos === 0}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-bold uppercase tracking-wider transition-colors ${
              showDangerZones
                ? 'bg-rose-600 text-white hover:bg-rose-700 shadow-sm'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            } ${maxFos === 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
            title={maxFos === 0 ? 'Loading slope units…' : 'Toggle Danger Zones filter'}
          >
            <span aria-hidden="true">⚠</span>
            <span>Danger Zones</span>
            {showDangerZones && (
              <span className="ml-1 px-1.5 py-0.5 rounded bg-white/25 text-[10px] font-mono">
                {dangerCount.toLocaleString()}
              </span>
            )}
          </button>
          {showDangerZones && (
            <div className="flex items-center gap-2 pl-2 border-l border-slate-200">
              <input
                type="range"
                min={0}
                max={maxFos}
                step={0.05}
                value={dangerThreshold}
                onChange={(e) => setDangerThreshold(Math.min(parseFloat(e.target.value), maxFos))}
                className="w-40 accent-rose-600"
              />
              <span className="text-[11px] font-mono text-slate-700 tabular-nums w-20">
                FoS ≤ {dangerThreshold.toFixed(2)}
              </span>
              {dangerCount === 0 && (
                <span className="text-[10px] text-amber-600 font-semibold">
                  Lower threshold to see zones
                </span>
              )}
            </div>
          )}
        </div>
```

- [ ] **Step 5.3: Verify lint**

```bash
npm run lint
```

Expected: exits 0.

- [ ] **Step 5.4: Commit**

```bash
git add src/App.jsx
git commit -m "feat(danger-zones): add overlay UI (button + threshold slider)"
```

---

## Task 6: Manual browser QA

This is the actual test pass for the project, per CLAUDE.md ("For UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete").

- [ ] **Step 6.1: Start the dev server**

```bash
npm run dev:fe
```

Open the URL Vite logs (usually `http://localhost:5173`).

- [ ] **Step 6.2: Verify button is disabled before geojson load**

Hard-reload the page (Ctrl+Shift+R) and watch the top-left of the map. The "⚠ Danger Zones" button should appear immediately but be visibly disabled (opacity 40%, cursor not-allowed) for ~1 second until the slope-units geojson finishes loading, then become enabled.

If it never enables, check the Network tab for `/lao_cai_slope_units.geojson` — must be 200 OK.

- [ ] **Step 6.3: Verify ON state — filter + count match visually**

Click the button. Expected:
- Button turns rose-red, label gets a count badge (e.g., "1,247").
- Slider appears, showing "FoS ≤ 1.50" by default.
- Map fills in slope units colored red/pink/orange/yellow/green according to FoS — only units with FoS ≤ 1.50.

Visually scan the map: there should be **no blue polygons** (blue is FoS > 1.5, which is filtered out).

- [ ] **Step 6.4: Verify slider updates filter + count live**

Drag the slider left toward 0. Expected:
- Visible polygons shrink (fewer units pass the filter).
- Badge count drops in real time.
- At threshold below the lowest FoS in the data, count reaches `0` and the inline "Lower threshold to see zones" hint appears.

Drag the slider right toward `maxFos`. Expected:
- More polygons appear (including stable ones, color shifts toward blue).
- Badge count rises toward the total number of slope units.

- [ ] **Step 6.5: Verify OFF state restores prior view**

Sub-case A: sidebar Slope Units was OFF.
1. With Danger Zones ON, click the button to turn it OFF.
2. Expected: all slope-units polygons disappear from the map (back to the default no-overlay state).

Sub-case B: sidebar Slope Units was ON.
1. Open the right sidebar, scroll to "Slope Units", toggle it ON, pick the "Mean Slope (°)" radio.
2. The map paints slope units with the mean-slope gradient. Confirm this works.
3. Click the Danger Zones button to turn it ON. Expected: layer repaints to FoS filter view.
4. Click Danger Zones OFF. Expected: layer repaints back to mean-slope gradient (the sidebar's selection).

- [ ] **Step 6.6: Verify no regressions in adjacent features**

- Toggle Inspector ON, hover over the map. Sidebar inspector data still appears.
- Use the Search box to search a coordinate. Search marker drops, sidebar shows extracted data.
- Use the batch extraction (draw polygon → Start Extraction) — verify a CSV downloads.

Any failures here mean Danger Zones broke something else. Stop and investigate before continuing.

- [ ] **Step 6.7: Stop the dev server**

Ctrl+C in the terminal running `npm run dev:fe`.

No commit at this step — QA verifies prior commits.

---

## Task 7: Final lint and self-check

- [ ] **Step 7.1: Run lint one final time**

```bash
npm run lint
```

Expected: exits 0. No new errors or warnings beyond the project baseline.

- [ ] **Step 7.2: Re-read the diff**

```bash
git log --oneline main..HEAD
git diff main..HEAD -- src/App.jsx
```

Skim the diff. Confirm:
- No leftover `console.log` from Task 2.3 debugging.
- No commented-out code.
- No unrelated changes.

- [ ] **Step 7.3: (If a worktree was used) Surface final state**

If working in a git worktree, ensure the branch is clean and ready to merge / push per the worktree skill's exit flow. Otherwise (working on `main` directly), the commits from Tasks 1–5 are the deliverable.

---

## Verification checklist (mirrors spec §11)

After Tasks 1–7 are complete, all of these should be true:

- [ ] Button is disabled until slope-units geojson loads.
- [ ] Button toggles the feature on/off.
- [ ] Slider's max is the actual highest FoS in the geojson (not a hardcoded value).
- [ ] Slider step is `0.05`.
- [ ] Badge count matches the number of visible polygons.
- [ ] Inline "Lower threshold to see zones" hint appears only when count is 0.
- [ ] Turning Danger Zones OFF restores the sidebar Slope Units state correctly (whether it was OFF or showing a non-FoS color).
- [ ] Inspector, Search, and Batch Extraction still work.
- [ ] `npm run lint` exits 0.
