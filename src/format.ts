/**
 * Interprets `plandown-format.md`: task types, their property schemas and link types.
 * Each `# [Type] Description` heading declares a type; its YAML block is the property schema;
 * each `<Link type>:` list declares a link type whose entries `[Target] Reverse` name the allowed
 * target types and the reverse link type the target sees; the target declares it too only to create the link from its side.
 * The `[*]` heading is no type: its properties belong to every type.
 */
import type { Diagnostic, ParsedFile } from './markdown.js';

export const FORMAT_FILE = 'plandown-format.md';
export const SUBTASK = 'Subtask';
export const PARENT = 'Parent';
export const META = '$meta';
export const BASE = '*';

export const PROP_TYPES = ['string', 'number', 'boolean', 'date', 'datetime'] as const;
export type PropType = typeof PROP_TYPES[number];

export interface PropSchema { type: PropType; enum?: (string | number)[]; description?: string }

export interface TaskType {
  name: string;
  description: string;
  color?: string;                                 // `$meta.color`: any CSS color, applied by the GUI
  props: Record<string, PropSchema>;
  links: Record<string, Record<string, string>>;  // links[linkType][targetType] = reverse link type
}

export interface Format { types: Record<string, TaskType> }

/** Reverse link type of `fromType --link--> toType`, or null when the format does not allow the link. */
export function linkReverse(f: Format, fromType: string, link: string, toType: string): string | null {
  if (link === SUBTASK) return PARENT;
  if (link === PARENT) return SUBTASK;
  return f.types[fromType]?.links[link]?.[toType] ?? null;
}

export function parseFormat(pf: ParsedFile): { format: Format; diagnostics: Diagnostic[] } {
  const types: Record<string, TaskType> = {};
  const diagnostics = [...pf.diagnostics];
  const err = (line: number, message: string) => diagnostics.push({ file: pf.file, line, severity: 'error', message });
  const lineOf = new Map<string, number>();  // `${type}\0${link}\0${target}` → entry line, for cross-check messages

  // Declarations: types from headings (bullets are link entries, not types); `[*]` first, so redeclarations of its properties are seen
  const heads = pf.nodes.filter(n => n.kind === 'heading').sort((a, b) => +(b.type === BASE) - +(a.type === BASE));
  for (const node of heads) {
    const base = node.type === BASE ? {} : types[BASE]?.props ?? {};
    if (types[node.type]) { err(node.line, `Task type [${node.type}] is declared twice`); continue; }
    const t: TaskType = { name: node.type, description: node.title, props: {}, links: {} };
    types[node.type] = t;

    for (const [key, v] of Object.entries(node.props?.data ?? {})) {
      // `$meta` holds type settings, not a property; the `$` keeps it apart from any property name
      if (key === META) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) { err(node.props!.start, `"${META}" must be a map of type settings`); continue; }
        for (const [mk, mv] of Object.entries(v)) {
          if (mk === 'color' && typeof mv === 'string') t.color = mv;
          else err(node.props!.start, mk === 'color' ? `"${META}.color" must be a CSS color string` : `Unknown type setting "${META}.${mk}"`);
        }
        continue;
      }
      const s =(typeof v === 'string' ? { type: v } : v) as Partial<PropSchema> | null;
      if (Object.hasOwn(base, key)) err(node.props!.start, `Property "${key}" is declared by [${BASE}] for every type and cannot be redeclared`);
      else if (!s || typeof s !== 'object' || !PROP_TYPES.includes(s.type as PropType)) err(node.props!.start, `Property "${key}": type must be one of ${PROP_TYPES.join(', ')}`);
      else t.props[key] = { type: s.type!, ...(Array.isArray(s.enum) && { enum: s.enum }), ...(typeof s.description === 'string' && { description: s.description }) };
    }

    for (const list of node.lists) {
      if (node.type === BASE) { err(list.items[0].line, `[${BASE}] declares properties only, not links`); continue; }
      if (list.label === null) { err(list.items[0].line, 'A list in the format file needs a "<Link type>:" line above it'); continue; }
      if (list.label === SUBTASK || list.label === PARENT) { err(list.labelLine, `"${list.label}" is a built-in link type`); continue; }
      const entries = (t.links[list.label] ??= {});
      for (const item of list.items) {
        if (item.type in entries) err(item.line, `Link "${list.label}" of [${t.name}] lists [${item.type}] twice`);
        entries[item.type] = item.title;
        lineOf.set(`${t.name}\0${list.label}\0${item.type}`, item.line);
      }
    }
  }

  // `[*]` is no type (so no link target either): its properties go first in every type
  const base = types[BASE]?.props ?? {};
  delete types[BASE];
  for (const t of Object.values(types)) t.props = { ...base, ...t.props };

  // Cross-check: the target may omit the flipped declaration (one-directional: created only from this side), but must not contradict it
  for (const t of Object.values(types))
    for (const [link, entries] of Object.entries(t.links))
      for (const [target, reverse] of Object.entries(entries)) {
        const line = lineOf.get(`${t.name}\0${link}\0${target}`)!;
        if (!types[target]) err(line, `Link "${link}" of [${t.name}] targets unknown task type [${target}]`);
        else if ((types[target].links[reverse]?.[t.name] ?? link) !== link)
          err(line, `Link "${link}" of [${t.name}] names reverse "${reverse}", but [${target}] declares "${reverse}:" with the entry "[${t.name}] ${types[target].links[reverse][t.name]}"`);
      }

  return { format: { types }, diagnostics };
}
