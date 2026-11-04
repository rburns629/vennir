// SPDX-License-Identifier: MIT
/** OrderService (proto/vennir/console/v1/order.proto): core/orders.ts over Connect. */
import type { ServiceImpl } from "@connectrpc/connect";
import { Type } from "@sinclair/typebox";
import { MAX_CART, placeOrder, previewOrder, type OrderChoice, type OrderInput } from "../../core/orders.js";
import type { OrderService } from "../../gen/vennir/console/v1/order_pb.js";
import { callerOf, logOf } from "../context.js";
import { check } from "../validate.js";
import { executionState, viaKernel } from "./execution.js";

const Name = Type.String({ minLength: 1, maxLength: 253 });

function input(i: OrderInput) {
  switch (i.kind) {
    case "step":
      return { kind: i.kind, step: i.step, output: i.output };
    case "parameter":
      return { kind: i.kind, parameter: i.parameter };
    case "resource":
      return { kind: i.kind, resourceId: i.resourceId, value: i.value };
    default:
      return { kind: i.kind };
  }
}

/** The request's choices, as core/orders.ts takes them: only the fields set. */
function choicesOf(list: { step: string; input: string; fromStep: string; fromOutput: string; resourceId: string; addNew: boolean }[]): OrderChoice[] {
  return list.map((c) => ({
    step: c.step,
    input: c.input,
    ...(c.fromStep ? { fromStep: c.fromStep, fromOutput: c.fromOutput } : {}),
    ...(c.resourceId ? { resourceId: c.resourceId } : {}),
    ...(c.addNew ? { addNew: true } : {}),
  }));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const choice = (c: OrderChoice) => ({
  step: c.step,
  input: c.input,
  fromStep: c.fromStep ?? "",
  fromOutput: c.fromOutput ?? "",
  resourceId: c.resourceId ?? "",
  addNew: c.addNew ?? false,
  label: c.label ?? "",
});

export function orderService(): ServiceImpl<typeof OrderService> {
  return {
    async previewOrder(req, ctx) {
      const { team, actions } = check(
        { team: Name, actions: Type.Array(Name, { maxItems: MAX_CART }) },
        { team: req.team, actions: req.actions },
      );
      const { steps, problems, suggestions } = await previewOrder(callerOf(ctx), { team, actions, choices: choicesOf(req.choices) });
      return {
        steps: steps.map((s) => ({ ...s, inputs: Object.fromEntries(Object.entries(s.inputs).map(([k, v]) => [k, input(v)])) })),
        problems: problems.map((p) => ({ ...p, options: p.options.map(choice) })),
        suggestions: suggestions.map((s) => ({ ...s, provider: s.provider ?? "", existing: s.existing.map(choice) })),
      };
    },

    async placeOrder(req, ctx) {
      const { team, actions, requestId } = check(
        { team: Name, actions: Type.Array(Name, { minItems: 1, maxItems: MAX_CART }), requestId: Type.Optional(Name) },
        { team: req.team, actions: req.actions, requestId: req.requestId || undefined },
      );
      const values = Object.fromEntries(Object.entries(req.values ?? {}).filter(([, v]) => isObject(v))) as Record<string, Record<string, unknown>>;
      const result = await viaKernel(ctx, () =>
        placeOrder(callerOf(ctx), { team, actions, choices: choicesOf(req.choices), values, parameters: req.parameters ?? {}, requestId }, logOf(ctx)),
      );
      return { executionId: result.executionId, state: executionState(result.state) };
    },
  };
}
