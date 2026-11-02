// SPDX-License-Identifier: MIT
/**
 * What a failed step's error means, what to do, whether retrying it is safe,
 * and whom to ask (failure help from the owner). The owning team's own
 * words come first: product.yaml's errors for its codes, team.yaml's help
 * for where to ask. The platform explains its own codes (the kernel's and
 * the cluster policies'). Whether a retry is safe is the product's
 * idempotent flag (R3), not a guess.
 */
import type { ErrorHelp } from "./db/schema.js";

/** The platform's own error codes, in words for the person whose run failed. */
export const PLATFORM_ERRORS: Record<string, ErrorHelp> = {
  INPUT_INVALID: { means: "Its inputs didn't fit the product's input schema, so it never started.", do: "Fix the inputs and run it again." },
  OUTPUT_INVALID: { means: "It finished, but its outputs didn't fit the product's output schema.", do: "Ask the product's team: their action returned something it doesn't promise." },
  MISSING_UPSTREAM_OUTPUT: { means: "A step it depends on finished without the output this step takes.", do: "Ask the team of the step before it." },
  TASK_TIMEOUT: { means: "It ran longer than its timeout and was stopped." },
  TASK_NOT_STARTED: { means: "It never started: the cluster had no room for it (no node could be added, or a quota was reached).", do: "Retry it; if it keeps happening, an admin can check the cloud's quotas." },
  POD_TERMINATED_UNEXPECTEDLY: { means: "Its container stopped before reporting a result: its Pod was evicted (its node short of memory or disk), preempted, or lost with its node. The message says which." },
  EXECUTOR_START_FAILED: { means: "The cluster couldn't start it." },
  JOB_NOT_FOUND: { means: "Its Job disappeared from the cluster before it reported a result." },
  IMAGE_NOT_FOUND: { means: "Its image isn't in the registry.", do: "Ask the product's team to publish it." },
  IMAGE_PULL_FAILED: { means: "The cluster couldn't download its image." },
  IMAGE_USER_NOT_ALLOWED: { means: "Its image runs as a user the cluster can't confirm isn't root (a named USER, or root).", do: "Ask the product's team to end its Dockerfile with a numeric USER, such as USER 65532:65532." },
  RESOURCES_NOT_ALLOWED: { means: "The step asks for more memory or CPU than its team may ever use.", do: "Ask an admin to raise the team's resource limits (its Settings tab), or ask the product's team for a smaller size." },
  IMAGE_NOT_ALLOWED: { means: "Its image isn't from a source this install allows.", do: "An admin can allow the source on the Admin page." },
  IMAGE_NOT_PINNED: { means: "Its image wasn't pinned to a digest, so the cluster refused it." },
  IMAGE_SCAN_FAILED: { means: "Its image failed the security scan.", do: "Ask the product's team to rebuild it with the fixes." },
  IMAGE_NOT_SIGNED: { means: "Its image isn't signed by the catalog's CI.", do: "Ask the product's team to publish it through their catalog's CI." },
  IDENTITY_NOT_ALLOWED: { means: "It asked for an identity or secrets its product isn't registered for." },
  DISPATCH_REJECTED: { means: "The cluster refused to run it in that team's namespace." },
  TEAM_RETIRED: { means: "Its team was retired while the run was going, so it never started.", do: "An admin can un-retire the team (Teams page), then retry it." },
  OUTPUT_CONTAINS_CREDENTIAL: { means: "Its outputs held something that looked like a credential, so they were discarded.", do: "Ask the product's team: outputs must never echo a secret." },
  PRODUCT_RESULT_MISSING: { means: "It ended without writing its result." },
  PRODUCT_RESULT_INVALID: { means: "It wrote a result the platform couldn't read." },
  UNSUPPORTED_ACTION: { means: "The product doesn't have that action." },
  APPROVAL_DECLINED: { means: "A maintainer of its team declined it, so it never ran.", do: "Ask them why, then run it again." },
  APPROVAL_EXPIRED: { means: "Nobody approved or declined it in time, so it never ran.", do: "Retry it to ask again, and tell its team." },
};

export interface FailureHelp {
  means: string;
  do: string;
  /** The owning team's words (product.yaml), rather than the platform's. */
  fromOwner: boolean;
  /** "safe" when its product is idempotent, "unsafe" when it isn't, "unknown" otherwise. */
  retry: "safe" | "unsafe" | "unknown";
  team: string;
  contact: string;
  chat: string;
  url: string;
}

/** Help for a step that failed with `code`, run by `product` of `team`. */
export function failureHelp(
  code: string,
  product: { idempotent: boolean; errorHelp: Record<string, ErrorHelp> } | undefined,
  team: { name: string; contact: string | null; helpChat: string | null; helpUrl: string | null } | undefined,
): FailureHelp {
  const owner = product?.errorHelp[code];
  const known = owner ?? PLATFORM_ERRORS[code];
  return {
    means: known?.means ?? "",
    do: known?.do ?? "",
    fromOwner: owner !== undefined,
    retry: product === undefined ? "unknown" : product.idempotent ? "safe" : "unsafe",
    team: team?.name ?? "",
    contact: team?.contact ?? "",
    chat: team?.helpChat ?? "",
    url: team?.helpUrl ?? "",
  };
}
