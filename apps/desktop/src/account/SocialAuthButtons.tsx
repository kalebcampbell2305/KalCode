import { Button } from "@kalcode/ui/components";
import styles from "./Account.module.css";
import type { SocialProvider } from "./AccountProvider.tsx";

export function SocialAuthButtons({
  busy,
  startSocial,
}: {
  busy: boolean;
  startSocial(provider: SocialProvider): Promise<void>;
}) {
  return (
    <fieldset className={styles.socialActions}>
      <legend className={styles.srOnly}>Social sign in</legend>
      <Button size="lg" disabled={busy} onClick={() => void startSocial("google")}>
        Continue with Google
      </Button>
      <Button size="lg" disabled={busy} onClick={() => void startSocial("microsoft")}>
        Continue with Microsoft
      </Button>
    </fieldset>
  );
}
