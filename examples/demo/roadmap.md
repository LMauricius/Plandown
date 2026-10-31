# [Task] Game-ready 3D engine
---
Priority: 1
effort: 4
---
Make VitraeEngine ready for both graphics research and production.

## [Task] Animation system
---
Due-date: 2026-12-01
effort: 16
spent: 3.5
---
Skeletal, mesh-morphing and dynamic (IK) animation in one modular system.

- [Task] High-level design of animation system
  ---
  spent: 0
  ---
  This **needs** description.

- [Task] Programming interface for the system
- [Task] Implementation of a modular system

Blocked by:
- [Task] Smart scene graph

## [Task] Smart scene graph
The scene is a flat list of props; the engine builds the optimal structure.

- [Task] Stabilize the SQueLe core API
  ---
  effort: 6
  done: true
  ---
  The query library everything else builds on.
- [Task] Design a prop and LoD structure

# [Bug] Shadow acne on EAA shadows
---
Severity: high
---
Visible at grazing angles after the port.

Discovered during:
- [Task] Port EAA shadows
