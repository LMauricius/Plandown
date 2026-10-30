# [Task] A unit of planned work
---
Due-date: date
Priority:
  type: number
  enum: [1, 2, 3]
---

Blocks:
- [Task] Blocked by
- [Bug] Blocked by

Blocked by:
- [Task] Blocks
- [Bug] Blocks

Related:
- [Task] Related
- [Bug] Related

Revealed:
- [Bug] Discovered during

# [Bug] A defect to fix
---
Severity:
  type: string
  enum: [low, medium, high]
Fix-in-release: string
---

Blocks:
- [Task] Blocked by
- [Bug] Blocked by

Blocked by:
- [Task] Blocks
- [Bug] Blocks

Related:
- [Task] Related
- [Bug] Related

Discovered during:
- [Task] Revealed
- [Bug] Revealed

Revealed:
- [Bug] Discovered during
