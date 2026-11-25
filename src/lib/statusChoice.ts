/**
 * Which status the project-status select should hold: the user's pick while it is still on offer,
 * otherwise the first option. After a move the options change, so a stale pick (the status the project
 * just left) falls back to the first new option. No imports: this is used by a client component.
 */
export const pickNext = (picked: string, choices: readonly string[]): string =>
  choices.includes(picked) ? picked : (choices[0] ?? "");
