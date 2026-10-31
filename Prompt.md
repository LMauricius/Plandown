Make a Typescript Task management/todo app that relies entirely on a folder with .md files for
  its timeline storage. Keep in mind that we will later make a VSCode extension that uses this TS app! For now make it a
  standalone library, but we will have it open in VSCode later.

  It must have a GUI that allows editing the individual tasks - their titles and descriptions, along with any
  parameters. It will also have a task dependency graph, and features to keep track of effort and time allocation to
  tasks.

  In a single file, every title or bullet point that starts with `[<TaskType>]` will become a separate task in the app.
  Multiple .md files can be interwoven, with main titles being top-level tasks.

  Immediately after the tasks title user can specify properties in the YAML format.
  It starts and ends with '---', right after the title/subtitle.

  A task can have subtasks. Bullet points that are tasks, and have no text immediately before the bullet list, will be
  considered 'subtasks' (with the title as the point's text), and be a "Linked task" of Link type "Subtask" to the the
  parent. Additional Link types are possible, and must have a line immediately above the list of format `<Link type>:`.
  Subtitles are always considered sub-tasks. The subtask has its parent linked as a "Parent" Link type.

  Task types, link types and property schemas are specified in a `plandown-format.md` file.

  Each `[<Task type]` before a task name introduces a new Task type
  Properties for a task of a particular Task type are declared with a YAML schema in the property block.
  Each text before a list of tasks introduces a link type possible to use with this Task type.
  - The Task type of each of its entries declares which task types can be linked with this one.
  - The name of each task entry declares the opposite relation Link type from this one, for this Task type. That Task
  type must also declare this Link type.
   Link type can be a reflexive relation. Except for reflexive entries, each Task type entry within a Link type
  declaration must have a flipped Link type. By default we have a Link type Subtask<->Parent task.

  Make a Database.md file describing all this to a user.
  Make an Usage.md file describing how to use the GUI.