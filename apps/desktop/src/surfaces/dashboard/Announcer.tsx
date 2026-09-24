import { useDashboardAnnouncements } from "./data/DashboardData.tsx";

/**
 * Screen-reader announcements for Dashboard changes: new approval requests are assertive (a
 * thread is blocked on the user); decision and action results are polite.
 */
export function Announcer() {
  const { urgent, polite } = useDashboardAnnouncements();
  return (
    <>
      <div className="visually-hidden" aria-live="assertive" aria-atomic="true" data-testid="announce-urgent">
        {urgent ? <p key={urgent.id}>{urgent.text}</p> : null}
      </div>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="announce-polite">
        {polite ? <p key={polite.id}>{polite.text}</p> : null}
      </div>
    </>
  );
}
