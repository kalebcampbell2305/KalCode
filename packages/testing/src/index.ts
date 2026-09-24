/**
 * @kalcode/testing — typed, deterministic fixtures for KalCode's shared contracts.
 *
 * Two ways to use it:
 * - `createFixtures({ seed })` returns an isolated context (own ids, clock and event sequence).
 *   Prefer this in tests: one context per test keeps data independent of test order.
 * - The top-level `build*` functions share a default context; call `resetFixtures()` in
 *   `beforeEach` when a file relies on exact ids or sequence numbers.
 */
import type {
  ApprovalRequest,
  Correlation,
  EventEnvelope,
  EventPayload,
  NormalizedAction,
  PolicyDecision,
  ProviderCapabilities,
  ProviderDetection,
  ThreadError,
  ThreadMessage,
  ThreadSummary,
} from "@kalcode/protocol";
import {
  type ActionKindName,
  type ActionOf,
  createFixtures,
  type EventType,
  type FixtureOptions,
  type Fixtures,
  type PayloadOf,
} from "./builders.ts";

export {
  type ActionKindName,
  type ActionOf,
  createFixtures,
  defaultScopesFor,
  type EventType,
  type FixtureOptions,
  type Fixtures,
  type PayloadOf,
  PROVIDER_NAMES,
  type WorkspaceRef,
  withOverrides,
} from "./builders.ts";
export * from "./constants.ts";
export {
  createClock,
  createIdFactory,
  createRandom,
  DEFAULT_EPOCH,
  type FixtureClock,
  type IdFactory,
  isUuidV7,
  isValidId,
} from "./deterministic.ts";
export { approvalFlood, busyWorkspace, eventStream, failures, type Scenario, samplePayloads } from "./scenarios.ts";

let shared: Fixtures = createFixtures();

/** Resets the shared default context (ids, clock, event sequence) used by the top-level builders. */
export function resetFixtures(options?: FixtureOptions): Fixtures {
  shared = createFixtures(options);
  return shared;
}

/** The shared default context. */
export function fixtures(): Fixtures {
  return shared;
}

export const buildThreadSummary = (overrides?: Partial<ThreadSummary>): ThreadSummary =>
  shared.buildThreadSummary(overrides);
export const buildThreadError = (overrides?: Partial<ThreadError>): ThreadError => shared.buildThreadError(overrides);
export const buildThreadMessage = (overrides?: Partial<ThreadMessage>): ThreadMessage =>
  shared.buildThreadMessage(overrides);
export const buildActionKind = <K extends ActionKindName>(
  kind: K,
  overrides?: Partial<Omit<ActionOf<K>, "kind">>,
): ActionOf<K> => shared.buildActionKind(kind, overrides);
export const buildNormalizedAction = (overrides?: Partial<NormalizedAction>): NormalizedAction =>
  shared.buildNormalizedAction(overrides);
export const buildPolicyDecision = (overrides?: Partial<PolicyDecision>): PolicyDecision =>
  shared.buildPolicyDecision(overrides);
export const buildApprovalRequest = (overrides?: Partial<ApprovalRequest>): ApprovalRequest =>
  shared.buildApprovalRequest(overrides);
export const buildCorrelation = (overrides?: Partial<Correlation>): Correlation => shared.buildCorrelation(overrides);
export const buildEventEnvelope = (
  payload: EventPayload,
  overrides?: Parameters<Fixtures["buildEventEnvelope"]>[1],
): EventEnvelope => shared.buildEventEnvelope(payload, overrides);
export const buildEvent = <T extends EventType>(
  type: T,
  payload: PayloadOf<T>,
  overrides?: Parameters<Fixtures["buildEventEnvelope"]>[1],
): EventEnvelope => shared.buildEvent(type, payload, overrides);
export const buildProviderDetection = (overrides?: Partial<ProviderDetection>): ProviderDetection =>
  shared.buildProviderDetection(overrides);
export const buildProviderCapabilities = (overrides?: Partial<ProviderCapabilities>): ProviderCapabilities =>
  shared.buildProviderCapabilities(overrides);
