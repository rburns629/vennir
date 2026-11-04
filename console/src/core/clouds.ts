// SPDX-License-Identifier: MIT
/**
 * Which installs a product is for: its clouds (product.yaml's, else its
 * team.yaml's) against this install's (config.installCloud, which vennir
 * sets). One that isn't for this install is listed, marked, never checked
 * (readiness.ts) and never run: a run naming it is refused here, before
 * anything is submitted.
 */
import { Code } from "@connectrpc/connect";
import { ApiError } from "../apiError.js";
import { config } from "../config.js";

/** Whether a product with these clouds is for this install: either unset, or this one's among them. */
export function runsHere(clouds: readonly string[]): boolean {
  return clouds.length === 0 || config.installCloud === "" || clouds.includes(config.installCloud);
}

/** "aws", "aws and azure", "aws, azure and gcp". */
export function cloudList(clouds: readonly string[]): string {
  return clouds.length <= 1 ? (clouds[0] ?? "") : `${clouds.slice(0, -1).join(", ")} and ${clouds.at(-1) ?? ""}`;
}

/** Refuses a run naming a product that isn't for this install. */
export function ensureRunsHere(product: { name: string; clouds: readonly string[] }): void {
  if (runsHere(product.clouds)) return;
  throw new ApiError(
    412,
    "NOT_FOR_THIS_INSTALL",
    `${product.name} is for ${cloudList(product.clouds)} installs; this install is on ${config.installCloud}.`,
    Code.FailedPrecondition,
    { product: product.name },
  );
}
