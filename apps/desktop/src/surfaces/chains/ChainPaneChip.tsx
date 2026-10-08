import type { Chain, ChainStep } from "@kalcode/protocol";
import { Badge, Button } from "@kalcode/ui/components";
import { ArrowUpRight, Link2 } from "lucide-react";
import { Popover } from "radix-ui";
import { memo, useState } from "react";
import { focusChain } from "../../runtime/chains/focus.ts";
import { type ChainsValue, useOptionalChains } from "../../runtime/chains/useChains.tsx";
import { useOptionalUiIntents } from "../../runtime/uiIntents.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import styles from "./ChainPaneChip.module.css";
import { ChainRail } from "./ChainRail.tsx";
import { CHAIN_PHASE_META, INTENT_LABEL, STEP_PHASE_META } from "./model.ts";

/**
 * A step agent's pane header chip: "Chain · Review 2/4" with its phase dot. It subscribes to the
 * chains store on its own, so a chain update re-renders this chip, never the pane or its terminal.
 * The popover shows the compact rail; a node opens that step's agent.
 */
export const ChainPaneChip = memo(function ChainPaneChip({ threadId }: { threadId: string }) {
  const chains = useOptionalChains();
  const [open, setOpen] = useState(false);
  const ref = chains?.chainForOperation(threadId) ?? null;
  if (!chains || !ref) return null;
  const { chain, step } = ref;
  const meta = STEP_PHASE_META[step.phase];
  const n = step.position + 1;
  const total = chain.steps.length;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={styles.chip}
          data-tone={meta.tone}
          data-chain-chip={chain.id}
          aria-label={`Chain ${chain.name}: ${INTENT_LABEL[step.intent]}, step ${n} of ${total}, ${meta.label.toLowerCase()}. Show chain`}
        >
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.chipText} aria-hidden="true">
            Chain · {INTENT_LABEL[step.intent]} {n}/{total}
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={styles.popover} side="bottom" align="end" sideOffset={6} collisionPadding={12}>
          {open ? <ChainPopoverBody chain={chain} step={step} chains={chains} onDone={() => setOpen(false)} /> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});

function ChainPopoverBody({
  chain,
  step,
  chains,
  onDone,
}: {
  chain: Chain;
  step: ChainStep;
  chains: ChainsValue;
  onDone: () => void;
}) {
  const { navigate } = useNavigation();
  const uiIntents = useOptionalUiIntents();
  const meta = CHAIN_PHASE_META[chain.phase];
  return (
    <div className={styles.body} data-chain-popover={chain.id}>
      <div className={styles.head}>
        <span className={styles.glyph} aria-hidden="true">
          <Link2 />
        </span>
        <div className={styles.titles}>
          <p className={styles.title}>{chain.name}</p>
          <p className={styles.goal}>{chain.goal}</p>
        </div>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </div>
      <ChainRail
        chain={chain}
        operationsById={chains.operationsById}
        variant="compact"
        selectedKey={step.key}
        stepActionLabel="Open agent"
        onStep={(target) => {
          if (target.key === step.key) return;
          const agentId = chains.operationsById.get(target.operationId)?.threadId ?? target.operationId;
          onDone();
          void uiIntents?.focus({ kind: "agent", agentId, workspaceId: chain.workspaceId });
        }}
      />
      <div className={styles.foot}>
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowUpRight />}
          onClick={() => {
            onDone();
            navigate("dashboard");
            focusChain(chain.id);
          }}
        >
          Open in Activity
        </Button>
      </div>
    </div>
  );
}
