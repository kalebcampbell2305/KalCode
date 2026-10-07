import { type Chain, FEATURE_PLACEMENT, featureIncluded, type ThreadSummary } from "@kalcode/protocol";
import { Badge, Button } from "@kalcode/ui/components";
import { Link2 } from "lucide-react";
import { Dialog } from "radix-ui";
import { useId } from "react";
import { useOptionalAccount } from "../../account/AccountProvider.tsx";
import { planTier, tierName } from "../../ipc/account.ts";
import { HUB_SECTIONS } from "../../shell/AccountHub.tsx";
import { useNavigation } from "../../shell/navigation.tsx";
import { focusSection } from "../dashboard/useNow.ts";
import { ChainComposer } from "./ChainComposer.tsx";
import styles from "./ChainComposerDialog.module.css";

/** The lowest plan with chains, from the one placement table (never hard-coded copy). */
export const CHAINS_PLAN = tierName(FEATURE_PLACEMENT.provider_handoff);
export const CHAINS_PLAN_BOUNDARY = `Handoff chains are included with ${CHAINS_PLAN} and above.`;

/** Whether the signed-in plan includes chains (true when no account is mounted, as in Handoff). */
export function useChainsIncluded(): boolean {
  const account = useOptionalAccount();
  return account ? featureIncluded(planTier(account.snapshot), "provider_handoff") : true;
}

/** The plan boundary line with the way to see plans, shared by every chain entry point. */
export function ChainsPlanGate({ onLeave }: { onLeave: () => void }) {
  const { navigate } = useNavigation();
  return (
    <div className={styles.planGate} role="note">
      <span>
        <Badge tone="accent">{CHAINS_PLAN}</Badge>
        {CHAINS_PLAN_BOUNDARY}
      </span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          onLeave();
          navigate("settings");
          requestAnimationFrame(() => requestAnimationFrame(() => focusSection(HUB_SECTIONS.account)));
        }}
      >
        View plans
      </Button>
    </div>
  );
}

export interface ChainComposerDialogProps {
  open: boolean;
  workspaceId: string | null;
  workspaceName?: string | null;
  source?: ThreadSummary | null;
  onStarted: (chain: Chain) => void;
  onClose: () => void;
}

/** The composer on its own (Activity, the command palette). Inside Hand off it is the Chain tab. */
export function ChainComposerDialog({
  open,
  workspaceId,
  workspaceName,
  source,
  onStarted,
  onClose,
}: ChainComposerDialogProps) {
  const id = useId();
  const included = useChainsIncluded();
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog} aria-describedby={`${id}-description`}>
          <div className={styles.head}>
            <span className={styles.headIcon} aria-hidden="true">
              <Link2 />
            </span>
            <div className={styles.headCopy}>
              <Dialog.Title className={styles.title}>New handoff chain</Dialog.Title>
              <Dialog.Description id={`${id}-description`} className={styles.description}>
                Pass one piece of work through real coding agents, step by step
                {workspaceName ? (
                  <>
                    {" "}
                    in <strong>{workspaceName}</strong>
                  </>
                ) : null}
                . Each step gets the goal and the earlier steps' reports, never raw terminal history.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button size="sm" variant="ghost">
                Close
              </Button>
            </Dialog.Close>
          </div>
          {included ? null : <ChainsPlanGate onLeave={onClose} />}
          <ChainComposer
            workspaceId={workspaceId}
            source={source ?? null}
            featureAvailable={included}
            onStarted={onStarted}
            onCancel={onClose}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
