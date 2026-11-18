import { describe, expect, it } from "vitest";
import { addMonthsClamped, dueRuns, nextRun } from "./recurring";

describe("Wiederkehrende Rechnungen: Terminregeln", () => {
  it("hält den Ankertag über kurze Monate und Schaltjahre", () => {
    expect(addMonthsClamped("2027-01-31", 1, 31)).toBe("2027-02-28");
    expect(addMonthsClamped("2027-02-28", 1, 31)).toBe("2027-03-31");
    expect(addMonthsClamped("2028-01-31", 1, 31)).toBe("2028-02-29");
    expect(addMonthsClamped("2027-11-15", 3, 15)).toBe("2028-02-15");
    expect(nextRun("2027-12-01", "MONTHLY", 1)).toBe("2028-01-01");
    expect(nextRun("2028-02-29", "YEARLY", 29)).toBe("2029-02-28");
  });
  it("liefert alle fälligen Läufe bis heute, höchstens `max`, nicht über das Enddatum", () => {
    const base = { nextRunOn: "2027-01-15", interval: "MONTHLY" as const, anchorDay: 15 };
    expect(dueRuns({ ...base, today: "2027-01-14" })).toEqual([]);
    expect(dueRuns({ ...base, today: "2027-01-15" })).toEqual(["2027-01-15"]);
    expect(dueRuns({ ...base, today: "2027-04-20" })).toEqual(["2027-01-15", "2027-02-15", "2027-03-15", "2027-04-15"]);
    expect(dueRuns({ ...base, today: "2027-04-20", endsOn: "2027-02-28" })).toEqual(["2027-01-15", "2027-02-15"]);
    expect(dueRuns({ ...base, today: "2030-01-01" })).toHaveLength(12);
    expect(dueRuns({ ...base, today: "2030-01-01", max: 2 })).toHaveLength(2);
  });
});
