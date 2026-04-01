import * as p from "@clack/prompts";
import pc from "picocolors";
import { handleCancel } from "./log.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const BACK = Symbol("wizard-back");

export type StepResult<T> = T | typeof BACK;

export function back<T>(): StepResult<T> {
  return BACK;
}

function isBack<T>(result: StepResult<T>): result is typeof BACK {
  return result === BACK;
}

export interface WizardField<T> {
  id: string;
  section: string;
  run: (state: T) => Promise<StepResult<T>>;
  review: (state: T) => [label: string, value: string];
  /** Skip prompting during forward pass (field still shows in review) */
  skip?: (state: T) => boolean;
  /** Hide from review table entirely (field is not applicable) */
  hidden?: (state: T) => boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskSecret(value: string): string {
  if (!value || value.length < 8) return value ? "••••" : pc.dim("(empty)");
  return value.slice(0, 4) + "••••" + value.slice(-4);
}

export { maskSecret };

function uniqueSections<T>(fields: WizardField<T>[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const f of fields) {
    if (!seen.has(f.section)) {
      seen.add(f.section);
      result.push(f.section);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Step-by-step navigation within a subset of fields.
// Ctrl+C = go back one non-skipped field.
// Returns false if the user backed out past the first field in the subset.
// ---------------------------------------------------------------------------

async function runFieldSlice<T>(
  fields: WizardField<T>[],
  state: { current: T },
  opts?: { ignoreSkip?: boolean },
): Promise<boolean> {
  let step = 0;

  const shouldSkip = (f: WizardField<T>, s: T) =>
    f.hidden?.(s) || (!opts?.ignoreSkip && f.skip?.(s));

  while (step < fields.length) {
    const field = fields[step];

    if (shouldSkip(field, state.current)) {
      step++;
      continue;
    }

    const result = await field.run(state.current);

    if (isBack(result)) {
      let prev = step - 1;
      while (prev >= 0 && shouldSkip(fields[prev], state.current)) {
        prev--;
      }
      if (prev < 0) return false;
      step = prev;
      continue;
    }

    state.current = result;
    step++;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function stepWizard<T>(
  fields: WizardField<T>[],
  initialState: T,
): Promise<T> {
  const state = { current: initialState };

  // ── Initial forward pass with per-field back ─────────────────────────
  const completed = await runFieldSlice(fields, state);
  if (!completed) handleCancel();

  // ── Review / edit loop ───────────────────────────────────────────────
  const sections = uniqueSections(fields);

  while (true) {
    const reviewLines: string[] = [];

    for (const section of sections) {
      const sectionFields = fields.filter((f) => f.section === section);
      const visibleFields = sectionFields.filter(
        (f) => !f.hidden?.(state.current),
      );
      if (visibleFields.length === 0) continue;

      reviewLines.push(pc.bold(pc.cyan(section)));
      for (const field of visibleFields) {
        const [label, value] = field.review(state.current);
        reviewLines.push(`  ${pc.dim(label + ":")} ${value}`);
      }
      reviewLines.push("");
    }

    p.note(reviewLines.join("\n"), "Configuration Review");

    const visibleSections = sections.filter((s) =>
      fields.some((f) => f.section === s && !f.hidden?.(state.current)),
    );

    const action = await p.select({
      message: "How would you like to proceed?",
      options: [
        {
          value: "_confirm",
          label: "Confirm and proceed",
          hint: "start bootstrap",
        },
        ...visibleSections.map((s) => ({
          value: s,
          label: `Edit: ${s}`,
        })),
        { value: "_cancel", label: "Cancel" },
      ],
    });

    if (p.isCancel(action)) handleCancel();
    if (action === "_confirm") break;
    if (action === "_cancel") handleCancel();

    const sectionFields = fields.filter(
      (f) => f.section === (action as string),
    );
    await runFieldSlice(sectionFields, state, { ignoreSkip: true });
  }

  return state.current;
}
