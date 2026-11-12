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
