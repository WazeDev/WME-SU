# WME Straighten Up!

**WME Straighten Up!** is a Waze Map Editor script that provides two powerful tools for cleaning up street geometry: **Straighten** and **Simplify**. Both tools help you refine road layouts by working with segment geometry nodes, but they use very different approaches for different scenarios.

---

## Overview

| Feature | Straighten | Simplify |
|---------|-----------|----------|
| **Purpose** | Force segments onto a perfect straight line between endpoints | Remove redundant geometry nodes while preserving natural curves |
| **Geometry Changes** | Removes all intermediate nodes; creates perfectly straight path | Removes only unnecessary nodes; maintains original shape |
| **Junction Nodes** | Moves junction nodes to align them with the straightened path | Leaves junction nodes untouched |
| **Use Case** | Correct badly warped segments; align parallel roads | Clean up mapping artifacts; reduce excessive detail nodes |
| **Aggressiveness** | Very aggressive; significantly alters geometry | Conservative; preserves path character |

---

## Straighten Function

### What It Does

The **Straighten** function forces one or more connected segments to align along a perfectly straight line between their two endpoints. It:

1. **Removes all intermediate geometry nodes** from selected segments
2. **Moves junction nodes** to align them with the straight line path
3. Ensures all segments lie on a single geometric line

### When to Use Straighten

- You have segments that should be straight but have accumulated geometry errors or warping over time
- Road geometry has mapping artifacts that make a naturally straight road look curved
- You're aligning multiple segments that should form a single, perfectly straight corridor
- You need to enforce strict geometric alignment (e.g., parallel roads that should have identical bearings)

### Example

```
Before: Road has 8 geometry nodes, slightly curved
        Junction A ────────⌢────────── Junction B

After:  Road has 2 geometry nodes (endpoints only), perfectly straight
        Junction A ─────────────────── Junction B
```

### Validation Checks

Before straightening, the script checks for:

- **>10 segments selected** — Confirms mass edit intent
- **Segments not connected** — Warns if segments don't form a continuous path
- **Different street names** — Warns if segments have conflicting names
- **Micro dog legs** — Detects geometry nodes near junctions that affect turn instructions
- **Large junction moves** — Warns if moving a junction node >5m

---

## Simplify Function

### What It Does

The **Simplify** function intelligently removes redundant geometry nodes from segments **without straightening them**. It:

1. Uses the **Ramer-Douglas-Peucker algorithm** to reduce node count based on deviation distance
2. Preserves the original path shape and curvature
3. Removes nodes that deviate less than your chosen tolerance from the path
4. Leaves junction nodes untouched (no junction moves)

### When to Use Simplify

- Road geometry has too many detail nodes from aerial imagery or over-mapping
- Segments have accumulated many redundant nodes over time
- You want to clean up geometry without changing the road's natural curves
- You're reducing data density in a complex area (many small nodes)
- Survey nodes or GPS traces created excessive intermediate nodes

### Tolerance Settings

Choose how aggressively nodes are removed:

| Tolerance | Effect | Use Case |
|-----------|--------|----------|
| **1m** (default) | Minimal removal; preserves fine detail | Carefully maintained areas; detailed curves |
| **3m** | Moderate removal; good balance | General cleanup; most urban streets |
| **5m** | Aggressive removal; reduces complexity | Suburban/rural roads; heavily mapped areas |
| **10m** | Very aggressive; major simplification | Regional overview; extreme detail reduction |

Higher tolerance = more nodes removed.

### Example

```
Before: 12 nodes, curved road with mapping detail
After:  4 nodes, same curve preserved, less detail
Result: Road still curves naturally, just cleaner
```

### Validation Checks

Before simplifying, the script checks for:

- **>10 segments selected** — Confirms mass edit intent
- **Micro dog legs** — Detects geometry nodes near junctions that affect turn instructions

---

## How to Use

### Installation

1. Install from GreasyFork: [WME Straighten Up!](https://greasyfork.org/scripts/388349-wme-straighten-up)
2. Use a userscript manager (Tampermonkey, Greasemonkey, etc.)
3. Buttons appear automatically in WME Segment Edit panel

### Straighten Workflow

1. In WME, select one or more **connected segments** to straighten
2. Click the **"Straighten"** button in the Segment Edit panel
3. Review any confirmation dialogs (safety checks)
4. Confirm if prompted about micro dog legs or junction moves
5. Done! Script updates geometry and shows confirmation

### Simplify Workflow

**First time or changing tolerance:**
1. Click WME Straighten Up! settings (gear icon on WME toolbar)
2. Go to **"Simplify Options"** section
3. Select tolerance: **1m**, **3m**, **5m**, or **10m**
4. Close settings (your choice is saved)

**Each time you simplify:**
1. In WME, select one or more segments to simplify
2. Click the **"Simplify"** button in the Segment Edit panel
3. If micro dog legs detected, confirm removal or cancel
4. Done! Script removes redundant nodes and shows how many

---

## Configuration & Settings

Access settings via the **WME Straighten Up!** settings panel (gear icon).

### Straighten Settings

| Setting | Options | Default | Purpose |
|---------|---------|---------|---------|
| **Sanity Check (>10 segments)** | Error, Warning, Pass | Warning | Require confirmation for mass edits |
| **Non-Continuous Selection** | Error, Warning, Pass | Warning | Warn if segments aren't connected |
| **Conflicting Names** | Error, Warning, No Warning | Warning | Warn if segment names differ |
| **Long Junction Move** | Error, Warning, Pass | Warning | Warn if junctions move >5m |
| **Micro Dog Legs** | Error, Warning, Pass | Warning | Warn before removing nodes near junctions |

### Simplify Settings

| Setting | Options | Default | Purpose |
|---------|---------|---------|---------|
| **Simplify Tolerance** | 1m, 3m, 5m, 10m | 1m | How aggressively to remove nodes |
| **Sanity Check (>10 segments)** | Error, Warning, Pass | Warning | Require confirmation for mass edits |
| **Micro Dog Legs** | Error, Warning, Pass | Warning | Warn before removing nodes near junctions |

---

## Edge Cases & Limitations

### Straighten
- **Single-segment straightening** — Works, but rarely needed (single segments already defined by endpoints)
- **Segments with <3 nodes** — Cannot be straightened (already minimal)
- **Non-connected path** — May produce unexpected results if segments don't form a continuous line
- **Junction moves > 5m** — Flagged as potential error (may indicate poor input geometry)

### Simplify
- **Segments with <3 nodes** — Skipped (nothing to simplify)
- **Very tight curves** — May be over-simplified if tolerance is too high (reduce to 1m)
- **Turn instructions** — Simplification may affect turn routing if micro dog legs are removed
- **Micro dog leg nodes** — Will be detected and warned before removal

---

## Troubleshooting

### "No segments selected" error
- Make sure you've selected at least one segment before clicking the button
- Segments must be selected in the WME Segment Edit panel

### "Sanity check: You selected many segments"
- You've selected >10 segments
- Confirm in the dialog if you want to proceed with the mass edit

### "Non-continuous segments" warning (Straighten only)
- You've selected segments that aren't all connected to each other
- For Straighten: select only segments that form a connected path
- For Simplify: this isn't an issue (processes each segment independently)

### "Conflicting names" warning (Straighten only)
- The selected segments have different street names
- This could create mapping errors
- Verify all segments should have the same name, or select fewer segments

### Straighten didn't work / segments look the same
- Check that you selected multiple segments (not just one)
- Verify they were actually connected (form a continuous path)
- The segments may already be perfectly straight

### Simplify removed too many nodes / not enough
- **Too many removed?** Use a smaller tolerance (1m instead of 10m)
- **Not enough removed?** Use a larger tolerance (5m or 10m instead of 1m)
- Change the tolerance setting and try again

### "Micro dog legs detected" warning
- The segment has geometry nodes very close (< 2m) to junctions
- Removing them could alter turn instructions (e.g., Keep Right → Turn Right)
- These may be intentional placements to force specific routing
- **Option 1:** Accept the warning to remove them anyway
- **Option 2:** Use Turn Instruction Override (TIO) or Voice Instruction Override (VIO) instead
- **Option 3:** Cancel and leave them as-is

---

## Data Safety

Both functions **only modify segment geometry** — they do not change:
- Street names
- Road types
- Turn restrictions
- Speed limits
- Lane guidance
- Any other segment properties

All changes are performed via the WME SDK and immediately saved to WME. Use **Ctrl+Z** (browser undo) to revert if needed.

---

## Credits

- Original script concept by **jonny3D**, **impulse200**, and **dBsooner**
- Modern enhancements and Simplify function by **JS55CT**

---

## License

GPLv3

---

## Feedback & Issues

- Report issues or suggest features: [GreasyFork Comments](https://greasyfork.org/scripts/388349-wme-straighten-up/comments)
