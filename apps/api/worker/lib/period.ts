/**
 * KalVoice Request allowance cycles (docs/BILLING.md §7).
 *
 * Every account has monthly cycles counted from an anchor instant (UTC):
 *   - an active paid (billing) subscription decides the tier → the subscription's start
 *     (`entitlement_grants.granted_at` of that billing grant, which Z13 sets to the Stripe
 *     billing-cycle anchor);
 *   - otherwise (Free, OWNER, operator paid-tier grants) → the account's creation time.
 *
 * Cycle k runs from anchor + k months to anchor + (k + 1) months. A day that does not exist in a
 * month is clamped to that month's last day (anchor Jan 31 → Feb 28/29 → Mar 31 → Apr 30), always
 * computed from the anchor so the day never drifts. Usage is counted by the time a request was
 * recorded, so changing tier mid-cycle never erases or duplicates requests.
 */

export interface Period {
  start: Date;
  end: Date;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** `anchor` plus `months` calendar months, day clamped, time of day kept (UTC). */
export function addMonthsClamped(anchor: Date, months: number): Date {
  const totalMonths = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth() + months;
  const year = Math.floor(totalMonths / 12);
  const month = totalMonths - year * 12;
  const day = Math.min(anchor.getUTCDate(), daysInMonth(year, month));
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/** The cycle containing `now`. `now` before the anchor falls in the first cycle. */
export function periodContaining(anchor: Date, now: Date): Period {
  if (now.getTime() < anchor.getTime()) {
    return { start: anchor, end: addMonthsClamped(anchor, 1) };
  }
  let months = (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (now.getUTCMonth() - anchor.getUTCMonth());
  while (months > 0 && addMonthsClamped(anchor, months).getTime() > now.getTime()) months--;
  while (addMonthsClamped(anchor, months + 1).getTime() <= now.getTime()) months++;
  return { start: addMonthsClamped(anchor, months), end: addMonthsClamped(anchor, months + 1) };
}
