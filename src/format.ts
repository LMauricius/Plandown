/**
 * Interprets `plandown-format.md`: task types, their property schemas and link types.
 * Each `# [Type] Description` heading declares a type; its YAML block is the property schema;
 * each `<Link type>:` list declares a link type whose entries `[Target] Reverse` name the allowed
 * target types and the reverse link type the target sees; the target declares it too only to create the link from its side.
 * The `[*]` heading is no type: its properties belong to every type.
 * `$meta.roles` maps the roles Plandown acts on (done checkbox, hour rollups, timer) to property names; roles a type
 * leaves unset fall back to same-named properties, as the fallback format's (Plandown's built-in one) `[*]` names them.
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

/** Roles Plandown gives behavior to, with the property type each needs. `timer` holds the running timer's start. */
export const ROLES = { done: 'boolean', effort: 'number', spent: 'number', timer: 'datetime' } as const;
export type Role = keyof typeof ROLES;
export type Roles = Partial<Record<Role, string>>;

export interface TaskType {
  name: string;
  description: string;
  color?: string;                                 // `$meta.color`: any CSS color, applied by the GUI
  props: Record<string, PropSchema>;
  roles: Roles;                                   // role → property name; an unset role disables its feature for the type
  links: Record<string, Record<string, string>>;  // links[linkType][targetType] = reverse link type
}

export interface Format {
  types: Record<string, TaskType>;
  roles: Roles;   // the `[*]` roles: the fallback other formats take from this one
}

/** Value of `t`'s property playing `role`; undefined when its type lacks the role. */
export function roleValue(f: Format, t: { type: string; props: Record<string, unknown> }, role: Role): unknown {
  const k = f.types[t.type]?.roles[role];
  return k === undefined ? undefined : t.props[k];
}

/** Reverse link type of `fromType --link--> toType`, or null when the format does not allow the link. */
export function linkReverse(f: Format, fromType: string, link: string, toType: string): string | null {
  if (link === SUBTASK) return PARENT;
  if (link === PARENT) return SUBTASK;
  return f.types[fromType]?.links[link]?.[toType] ?? null;
}

/** `fallback`: roles of the format this one falls back to (the built-in one's `format.roles`). */
export function parseFormat(pf: ParsedFile, fallback: Roles = {}): { format: Format; diagnostics: Diagnostic[] } {
  const types: Record<string, TaskType> = {};
  const diagnostics = [...pf.diagnostics];
  const err = (line: number, message: string) => diagnostics.push({ file: pf.file, line, severity: 'error', message });
  const lineOf = new Map<string, number>();  // `${type}\0${link}\0${target}` → entry line, for cross-check messages
  const at = new Map<string, number>();      // type → its property block's line (else heading line), for role messages

  // Declarations: types from headings (bullets are link entries, not types); `[*]` first, so redeclarations of its properties are seen
  const heads = pf.nodes.filter(n => n.kind === 'heading').sort((a, b) => +(b.type === BASE) - +(a.type === BASE));
  for (const node of heads) {
    const base = node.type === BASE ? {} : types[BASE]?.props ?? {};
    if (types[node.type]) { err(node.line, `Task type [${node.type}] is declared twice`); continue; }
    const t: TaskType = { name: node.type, description: node.title, props: {}, roles: {}, links: {} };
    types[node.type] = t;
    at.set(t.name, node.props?.start ?? node.line);
    let roles: object = {};

    for (const [key, v] of Object.entries(node.props?.data ?? {})) {
      // `$meta` holds type settings, not a property; the `$` keeps it apart from any property name
      if (key === META) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) { err(node.props!.start, `"${META}" must be a map of type settings`); continue; }
        for (const [mk, mv] of Object.entries(v)) {
          if (mk === 'color' && typeof mv === 'string') t.color = mv;
          else if (mk === 'roles' && mv && typeof mv === 'object' && !Array.isArray(mv)) roles = mv;
          else err(node.props!.start, mk === 'color' ? `"${META}.color" must be a CSS color string` : mk === 'roles' ? `"${META}.roles" must map roles to property names` : `Unknown type setting "${META}.${mk}"`);
        }
        continue;
      }
      const s =(typeof v === 'string' ? { type: v } : v) as Partial<PropSchema> | null;
      if (Object.hasOwn(base, key)) err(node.props!.start, `Property "${key}" is declared by [${BASE}] for every type and cannot be redeclared`);
      else if (!s || typeof s !== 'object' || !PROP_TYPES.includes(s.type as PropType)) err(node.props!.start, `Property "${key}": type must be one of ${PROP_TYPES.join(', ')}`);
      else t.props[key] = { type: s.type!, ...(Array.isArray(s.enum) && { enum: s.enum }), ...(typeof s.description === 'string' && { description: s.description }) };
    }

    // Roles name a property this section sees (a type sees `[*]`'s too) of the type the role needs
    const seen = { ...base, ...t.props };
    for (const [r, k] of Object.entries(roles)) {
      const need = Object.hasOwn(ROLES, r) ? ROLES[r as Role] : null;
      if (!need) err(node.props!.start, `Unknown role "${r}"; roles are ${Object.keys(ROLES).join(', ')}`);
      else if (typeof k !== 'string' || !Object.hasOwn(seen, k)) err(node.props!.start, `Role "${r}" must name a property of [${t.name}]`);
      else if (seen[k].type !== need) err(node.props!.start, `Role "${r}" needs a ${need} property; "${k}" is a ${seen[k].type}`);
      else t.roles[r as Role] = k;
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

  // `[*]` is no type (so no link target either): its properties go first in every type, its roles under the type's own
  const base = types[BASE] ?? { props: {}, roles: {} };
  delete types[BASE];
  for (const t of Object.values(types)) {
    t.props = { ...base.props, ...t.props };
    t.roles = { ...base.roles, ...t.roles };
    // One role per property (`effort` and `spent` share a type); checked after merging, as a type may move a `[*]` role
    const byProp = new Map<string, Role>();
    for (const [r, k] of Object.entries(t.roles) as [Role, string][]) {
      if (byProp.has(k)) { err(at.get(t.name)!, `Property "${k}" of [${t.name}] plays both roles "${byProp.get(k)}" and "${r}"`); delete t.roles[r]; }
      else byProp.set(k, r);
    }
    // Fallback: an unset role goes to the same-named property the fallback names, if it fits and plays no other role
    for (const [r, k] of Object.entries(fallback) as [Role, string][])
      if (!t.roles[r] && !byProp.has(k) && Object.hasOwn(t.props, k) && t.props[k].type === ROLES[r]) { t.roles[r] = k; byProp.set(k, r); }
  }

  // Cross-check: the target may omit the flipped declaration (one-directional: created only from this side), but must not contradict it
  for (const t of Object.values(types))
    for (const [link, entries] of Object.entries(t.links))
      for (const [target, reverse] of Object.entries(entries)) {
        const line = lineOf.get(`${t.name}\0${link}\0${target}`)!;
        if (!types[target]) err(line, `Link "${link}" of [${t.name}] targets unknown task type [${target}]`);
        else if ((types[target].links[reverse]?.[t.name] ?? link) !== link)
          err(line, `Link "${link}" of [${t.name}] names reverse "${reverse}", but [${target}] declares "${reverse}:" with the entry "[${t.name}] ${types[target].links[reverse][t.name]}"`);
      }

  return { format: { types, roles: base.roles }, diagnostics };
}
