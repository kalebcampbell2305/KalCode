import type { ProviderAccount, ThreadSummary, Workspace } from "@kalcode/protocol";
import { Button, ObjectContextMenu, type ObjectMenuItem, TextInput, useToast } from "@kalcode/ui/components";
import { Archive, ArchiveRestore, Copy, FolderInput, Pencil, UserRound } from "lucide-react";
import { Dialog } from "radix-ui";
import {
  cloneElement,
  createContext,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { toKalCodeError } from "../../ipc/errors.ts";
import { useEvents, useRuntime } from "../../runtime/RuntimeProvider.tsx";
import { useFavoriteMenuItems } from "../../shell/favorites/FavoriteActions.tsx";
import { accountInlineLabel, sortAccounts } from "../providers/accountIdentity.ts";
import { threadActions } from "./model.ts";
import styles from "./RebindThreadDialog.module.css";
import { RebindThreadDialog } from "./RebindThreadDialog.tsx";
import { accountStatus, rebindBlocker, threadAccountLabel } from "./useThreadAccount.ts";

interface MenuData {
  workspaces: Workspace[];
  accounts: ProviderAccount[];
}
const ThreadMenuData = createContext<MenuData>({ workspaces: [], accounts: [] });

/** Read once per list, before interaction; opening a menu never waits for IPC. */
export function ThreadMenuDataProvider({ children }: { children: ReactNode }) {
  const { client } = useRuntime();
  const { events } = useEvents();
  const [data, setData] = useState<MenuData>({ workspaces: [], accounts: [] });
  const revision = events.find((event) =>
    /^(workspace\.|provider\.(connected|disconnected)|settings\.changed)/.test(event.type),
  )?.seq;
  // biome-ignore lint/correctness/useExhaustiveDependencies: workspace/account changes invalidate these cached choices.
  useEffect(() => {
    let active = true;
    void Promise.allSettled([client.listWorkspaces(), client.listProviderAccounts()]).then(([workspaces, accounts]) => {
      if (!active) return;
      setData({
        workspaces: workspaces.status === "fulfilled" ? workspaces.value : [],
        accounts: accounts.status === "fulfilled" ? sortAccounts(accounts.value) : [],
      });
    });
    return () => {
      active = false;
    };
  }, [client, revision]);
  return <ThreadMenuData.Provider value={data}>{children}</ThreadMenuData.Provider>;
}

export function ThreadContextMenu({
  thread,
  archived = thread.archivedAt !== null,
  children,
  onChanged,
  onDuplicated,
}: {
  thread: ThreadSummary;
  archived?: boolean;
  children: ReactElement;
  onChanged?: () => void;
  onDuplicated?: (thread: ThreadSummary) => void;
}) {
  const { client } = useRuntime();
  const { accounts, workspaces } = useContext(ThreadMenuData);
  const toast = useToast();
  const [rename, setRename] = useState(false);
  const [name, setName] = useState(thread.name);
  const [target, setTarget] = useState<ProviderAccount | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const invoker = useRef<HTMLElement | null>(null);
  const inputId = useId();
  const blocker = rebindBlocker(thread, archived);
  const safe = blocker === null && thread.runtimeKind !== "interactive_pty";
  const returnFocus = () => {
    if (invoker.current?.isConnected) invoker.current.focus({ preventScroll: true });
  };
  const child = children as ReactElement<HTMLAttributes<HTMLElement>>;
  const trigger = cloneElement(child, {
    onContextMenuCapture: (event) => {
      invoker.current = event.currentTarget;
      child.props.onContextMenuCapture?.(event);
    },
    onKeyDownCapture: (event) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) invoker.current = event.currentTarget;
      child.props.onKeyDownCapture?.(event);
    },
  });

  const run = async (action: string, call: () => Promise<ThreadSummary>, duplicate = false) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const next = await call();
      setRename(false);
      setTarget(null);
      onChanged?.();
      if (duplicate) onDuplicated?.(next);
      toast.show({ tone: "success", title: action, description: next.name });
    } catch (error) {
      toast.show({ tone: "danger", title: "Thread action failed", description: toKalCodeError(error).message });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  const favoriteItems = useFavoriteMenuItems(
    { kind: "thread", id: thread.id, workspaceId: thread.workspaceId },
    thread.name,
  );
  const items: ObjectMenuItem[] = [
    {
      id: "rename",
      label: "Rename",
      icon: <Pencil />,
      onSelect: () => {
        setName(thread.name);
        setRename(true);
      },
    },
  ];
  if (safe) {
    items.push({
      id: "duplicate",
      label: "Duplicate",
      icon: <Copy />,
      onSelect: () => void run("Thread duplicated", () => client.duplicateThread(thread.id), true),
    });
  }
  const destinations = workspaces.filter((workspace) => workspace.available && workspace.id !== thread.workspaceId);
  if (
    safe &&
    thread.canMoveWorkspace === true &&
    thread.status !== "paused" &&
    thread.status !== "waiting_for_dependency" &&
    !thread.worktreeId &&
    destinations.length > 0
  ) {
    items.push({
      id: "move",
      label: "Move to workspace",
      icon: <FolderInput />,
      children: destinations.map((workspace) => ({
        id: workspace.id,
        label: workspace.name,
        onSelect: () => void run("Thread moved", () => client.moveThread(thread.id, workspace.id)),
      })),
    });
  }
  const alternatives = accounts.filter(
    (account) =>
      account.providerId === thread.providerId &&
      account.id !== thread.providerAccountId &&
      account.archivedAt === null &&
      accountStatus(account.authenticationState).usable,
  );
  if (safe && alternatives.length > 0) {
    items.push({
      id: "rebind",
      label: "Rebind account",
      icon: <UserRound />,
      children: alternatives.map((account) => ({
        id: account.id,
        label: accountInlineLabel(account),
        onSelect: () => setTarget(account),
      })),
    });
  }
  items.push(...favoriteItems);
  if (archived || threadActions(thread, archived).archive) {
    items.push({ id: "archive-separator", separator: true });
    items.push(
      archived
        ? {
            id: "restore",
            label: "Restore thread",
            icon: <ArchiveRestore />,
            onSelect: () => void run("Thread restored", () => client.unarchiveThread(thread.id)),
          }
        : {
            id: "archive",
            label: "Archive",
            icon: <Archive />,
            tone: "danger",
            onSelect: () => void run("Thread archived", () => client.archiveThread(thread.id)),
          },
    );
  }
  return (
    <>
      <ObjectContextMenu label={`Actions for ${thread.name}`} items={busy ? [] : items}>
        {trigger}
      </ObjectContextMenu>
      <Dialog.Root
        open={rename}
        onOpenChange={(open) => {
          if (!submitting.current) setRename(open);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content
            className={styles.dialog}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              returnFocus();
            }}
          >
            <Dialog.Title className={styles.title}>Rename thread</Dialog.Title>
            <Dialog.Description className={styles.body}>
              Give {thread.name} a name you can find again.
            </Dialog.Description>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (name.trim()) void run("Thread renamed", () => client.renameThread(thread.id, name.trim()));
              }}
            >
              <label className="visually-hidden" htmlFor={inputId}>
                Thread name
              </label>
              <TextInput
                id={inputId}
                value={name}
                onChange={(event) => setName(event.target.value)}
                onFocus={(event) => event.target.select()}
                maxLength={80}
                disabled={busy}
              />
              <div className={styles.actions}>
                <Dialog.Close asChild>
                  <Button variant="ghost" disabled={busy}>
                    Cancel
                  </Button>
                </Dialog.Close>
                <Button type="submit" variant="primary" busy={busy} disabled={busy || !name.trim()}>
                  Save name
                </Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <RebindThreadDialog
        returnFocus={returnFocus}
        open={target !== null}
        from={threadAccountLabel(thread)}
        to={target ? accountInlineLabel(target) : ""}
        busy={busy}
        blocker={blocker}
        signInRequired={false}
        onCancel={() => setTarget(null)}
        onSignIn={() => {}}
        onConfirm={() => {
          if (target && !blocker)
            void run("Thread account changed", () => client.rebindThreadAccount(thread.id, target.id));
        }}
      />
    </>
  );
}
