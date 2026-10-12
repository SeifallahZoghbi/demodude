// TEMPLATE — copy to src/demo/moveDefs.ts and replace every TODO.
//
// The moves the demo exposes, as the tool definitions the demo service hands to Claude verbatim
// (docs/protocol.md "moves.json"). Descriptions are written for the model, not for people: say
// what the move does, what each argument means, and when to use it. Keep the set small (under 15).
//
// DOM-free on purpose: a build script imports this under Node to write moves.json (see
// `toMovesJson` at the bottom), and src/demo/moves.ts implements one runner per entry.
//
// STRICT-SCHEMA RULE: the service sets `strict: true` on every tool, which accepts only a subset
// of JSON Schema. Do NOT use minimum/maximum, minLength/maxLength, pattern, format, default or
// similar keywords. State ranges and formats in the description ("0 to 60") and validate inside
// the move. Every object needs `additionalProperties: false` and a `required` list (empty is fine).
// `toMovesJson` refuses to emit a schema that breaks this rule.

export interface MoveDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
}

// TODO: the screens the AI may navigate to. Each is a route or a tab in your app; snake_case,
// stable, never renamed (renaming breaks saved sessions).
export const SCREENS = ["home", "list", "detail", "settings"] as const;
export type Screen = (typeof SCREENS)[number];

// TODO: everything `point_at` may target: the `data-demo="<target>"` attributes you have put on
// the real screens. The value is the screen the target lives on (null = visible on every screen,
// like a top-bar link), so `point_at` can navigate there first.
export const TARGET_SCREEN = {
  nav_home: null,
  nav_list: null,
  nav_settings: null,
  list_row_1: "list",
  detail_title: "detail",
  detail_save: "detail",
  settings_toggle: "settings",
} as const satisfies Record<string, Screen | null>;
export type Target = keyof typeof TARGET_SCREEN;
export const POINT_TARGETS = Object.keys(TARGET_SCREEN) as Target[];

// TODO: the subset of targets that do something when clicked.
export const CLICK_TARGETS = ["nav_home", "nav_list", "nav_settings", "list_row_1", "detail_save", "settings_toggle"] as const satisfies readonly Target[];
export type ClickTarget = (typeof CLICK_TARGETS)[number];

export const MOVE_DEFS: MoveDef[] = [
  // The three generic moves every app has. Keep their names: the guide's prompts assume them.
  {
    name: "go_to_screen",
    description:
      "Navigate to a screen. Use this before pointing at or clicking anything on that screen. " +
      "Going to the screen you are already on is a no-op. Returns one line describing what is now visible. " +
      // TODO: one clause per screen, so the model knows what each one shows.
      "home is the landing page; list is the register of records; detail is one open record; settings is the preferences page.",
    input_schema: {
      type: "object",
      properties: { screen: { type: "string", enum: [...SCREENS] } },
      required: ["screen"],
      additionalProperties: false,
    },
  },
  {
    name: "point_at",
    description:
      "Scroll to an element and hover the cursor over it with a highlight ring, without clicking. " +
      "If the target lives on another screen, the demo navigates there first. " +
      // TODO: one clause per target (or group of targets), so the model can choose between them.
      "nav_* are the top-bar links; list_row_1 is the first record in the list; detail_title and detail_save are on the open record; settings_toggle is on Settings.",
    input_schema: {
      type: "object",
      properties: { target: { type: "string", enum: [...POINT_TARGETS] } },
      required: ["target"],
      additionalProperties: false,
    },
  },
  {
    name: "click",
    description:
      "Move the cursor to an element and click it. Only the clickable targets are listed. " +
      // TODO: say what each click does, and name the dedicated move to prefer where one exists.
      "list_row_1 opens the record; detail_save saves it (prefer set_field, which saves too); settings_toggle flips the preference.",
    input_schema: {
      type: "object",
      properties: { target: { type: "string", enum: [...CLICK_TARGETS] } },
      required: ["target"],
      additionalProperties: false,
    },
  },

  // TODO: app-specific moves. Three patterns worth copying:

  // 1. A value-setting move: type into a field and save. Validate the range in the move, not here.
  {
    name: "set_field",
    description:
      "On Detail (navigates there first if needed), type a new value into the amount field and save. " +
      "value is a plain number from 0 to 100 (values outside that range are refused). Returns the recomputed total.",
    input_schema: {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
      additionalProperties: false,
    },
  },

  // 2. A long "simulated processing" move: staged progress over several seconds. Say how long it
  //    takes and that nothing else should be called meanwhile. Must honour demo:stop (every await
  //    through ctx.signal) and finish well under the service's 45 s limit.
  {
    name: "simulate_processing",
    description:
      "On Home (navigates there first if needed): starts the demo job and plays its staged progress over about eight seconds, " +
      "then opens the finished result on Detail. Takes about ten seconds; do not call anything else until it returns.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },

  // 3. A choice between a few named things (an enum argument).
  {
    name: "open_record",
    description: "On List (navigates there first if needed), open one record on Detail. Returns the record's headline fields.",
    input_schema: {
      type: "object",
      properties: { record: { type: "string", enum: ["REC-001", "REC-002", "REC-003"] } },
      required: ["record"],
      additionalProperties: false,
    },
  },

  // The reset every app has. Say what "initial" looks like so the model can describe it.
  {
    name: "reset_demo",
    description: "Restore every fixture to its initial state (TODO: name the notable initial values) and go back to the Home screen.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
];

export const MOVE_NAMES = MOVE_DEFS.map((m) => m.name);

// The keywords strict mode rejects. Found anywhere inside a schema, they make toMovesJson throw,
// so the mistake surfaces at build time instead of as a refused tool at run time.
const STRICT_FORBIDDEN = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "format", "default",
  "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties",
]);

function assertStrict(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertStrict(v, `${path}[${i}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    // Keys under `properties` are field names, not keywords.
    if (path.endsWith(".properties")) {
      assertStrict(obj[key], `${path}.${key}`);
      continue;
    }
    if (STRICT_FORBIDDEN.has(key)) throw new Error(`${path}.${key}: not allowed in a strict tool schema — state it in the description instead`);
    assertStrict(obj[key], `${path}.${key}`);
  }
  if (obj["type"] === "object") {
    if (obj["additionalProperties"] !== false) throw new Error(`${path}: objects need additionalProperties: false`);
    if (!Array.isArray(obj["required"])) throw new Error(`${path}: objects need a required list (empty is fine)`);
  }
}

/**
 * The moves.json text. Write it with a two-line script, e.g. demo/write-moves.ts:
 *   import { writeFileSync } from "node:fs";
 *   import { toMovesJson } from "../src/demo/moveDefs.ts";
 *   writeFileSync("demo/moves.json", toMovesJson());
 * then point starter/bundle.ts at that folder with --src.
 */
export function toMovesJson(defs: readonly MoveDef[] = MOVE_DEFS): string {
  const names = new Set<string>();
  for (const def of defs) {
    if (!/^[a-z][a-z0-9_]*$/.test(def.name)) throw new Error(`move '${def.name}': names are snake_case`);
    if (names.has(def.name)) throw new Error(`move '${def.name}' is defined twice`);
    names.add(def.name);
    if (def.description.trim() === "") throw new Error(`move '${def.name}' has no description`);
    assertStrict(def.input_schema, `${def.name}.input_schema`);
  }
  return JSON.stringify(defs, null, 2) + "\n";
}
