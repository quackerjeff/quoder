import type { ModelRef } from "@opencode-ai/sdk/v2";

import type { OpenCodeAgentOption, OpenCodeModelOption } from "../opencode-adapter.js";

export type SelectionResult<T> =
  | { readonly kind: "selected"; readonly value: T }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous"; readonly matches: readonly T[] };

const normalized = (value: string): string => value.trim().toLowerCase();

export function resolveModelSelection(
  query: string,
  models: readonly OpenCodeModelOption[],
): SelectionResult<ModelRef> {
  const needle = normalized(query);
  if (needle === "") return { kind: "missing" };
  const exact = models.filter((model) => normalized(`${model.providerID}/${model.id}`) === needle);
  const matches = exact.length > 0
    ? exact
    : models.filter((model) => [model.providerID, model.id, model.name, `${model.providerID}/${model.id}`]
      .some((candidate) => normalized(candidate).includes(needle)));
  if (matches.length === 0) return { kind: "missing" };
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      matches: matches.map(({ providerID, id }) => ({ providerID, id })),
    };
  }
  const model = matches[0];
  if (model === undefined) return { kind: "missing" };
  return { kind: "selected", value: { providerID: model.providerID, id: model.id } };
}

export function resolveAgentSelection(
  query: string,
  agents: readonly OpenCodeAgentOption[],
): SelectionResult<string> {
  const needle = normalized(query);
  if (needle === "") return { kind: "missing" };
  const exact = agents.filter((agent) => normalized(agent.id) === needle);
  const matches = exact.length > 0
    ? exact
    : agents.filter((agent) => normalized(agent.id).includes(needle));
  if (matches.length === 0) return { kind: "missing" };
  if (matches.length > 1) return { kind: "ambiguous", matches: matches.map(({ id }) => id) };
  const agent = matches[0];
  return agent === undefined ? { kind: "missing" } : { kind: "selected", value: agent.id };
}
