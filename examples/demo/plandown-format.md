# [*] Properties every task type has
    $meta:
      roles:
        done: done
        effort: effort
        spent: spent
        timer: started
    done:
      type: boolean
      description: The task is finished
    effort:
      type: number
      description: Estimated effort in hours
    spent:
      type: number
      description: Logged time in hours
    started:
      type: datetime
      description: Start of the running timer

# [Task] A unit of planned work
    $meta:
      color: '#2f6fbf'
    Due-date:
      type: date
      description: The day the task must be finished.
    Priority:
      type: number
      enum: [1, 2, 3]

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
    $meta:
      color: crimson
    Severity:
      type: string
      enum: [low, medium, high]
    Fix-in-release:
      type: string
      description: Version that must ship the fix.

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
